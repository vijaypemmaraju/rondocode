/* ---------------------------------------------------------------------------
 * A VIRTUAL CoreMIDI source, which is the one thing the browser build cannot
 * do and the whole reason a DAW cares that this is a desktop app.
 *
 * WebMIDI can only open ports that already exist, so in a browser rondocode can
 * drive hardware but cannot BE an instrument. A virtual source publishes a port
 * named "rondocode" into CoreMIDI itself: Ableton, Logic, Bitwig and friends
 * list it alongside real hardware, so a track can record from it or be driven
 * live by it with no loopback driver (no IAC bus to configure, nothing to
 * install).
 *
 * Bound with direct FFI rather than a crate. The surface is four exported
 * symbols, and MIDIPacketListInit/Add are used deliberately in place of hand-
 * laying out MIDIPacketList: that struct's packing has differed across Apple
 * architectures, and getting it subtly wrong yields corrupt timestamps rather
 * than a compile error.
 * ------------------------------------------------------------------------- */

use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};
use std::os::raw::c_void;
use std::sync::Mutex;

type OSStatus = i32;
type MIDIObjectRef = u32;
type MIDIClientRef = MIDIObjectRef;
type MIDIEndpointRef = MIDIObjectRef;
type MIDITimeStamp = u64;
type ByteCount = usize;

#[link(name = "CoreMIDI", kind = "framework")]
extern "C" {
    fn MIDIClientCreate(
        name: CFStringRef,
        notify_proc: *const c_void,
        notify_ref_con: *mut c_void,
        out_client: *mut MIDIClientRef,
    ) -> OSStatus;
    fn MIDISourceCreate(
        client: MIDIClientRef,
        name: CFStringRef,
        out_src: *mut MIDIEndpointRef,
    ) -> OSStatus;
    fn MIDIReceived(src: MIDIEndpointRef, pktlist: *const u8) -> OSStatus;
    fn MIDIPacketListInit(pktlist: *mut u8) -> *mut u8;
    fn mach_absolute_time() -> u64;
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
    fn MIDIPacketListAdd(
        pktlist: *mut u8,
        list_size: ByteCount,
        cur_packet: *mut u8,
        time: MIDITimeStamp,
        n_data: ByteCount,
        data: *const u8,
    ) -> *mut u8;
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

/// mach ticks per nanosecond, as the numer/denom rational the kernel reports.
/// Constant for the life of the process, so it is read once.
fn timebase() -> (u32, u32) {
    use std::sync::OnceLock;
    static TB: OnceLock<(u32, u32)> = OnceLock::new();
    *TB.get_or_init(|| {
        let mut info = MachTimebaseInfo::default();
        let ok = unsafe { mach_timebase_info(&mut info) } == 0;
        if ok && info.numer != 0 && info.denom != 0 {
            (info.numer, info.denom)
        } else {
            (1, 1) // Apple silicon and x86 both report 1/1 today; a safe identity
        }
    })
}

/// A CoreMIDI host timestamp `delay_ms` in the future.
///
/// MIDITimeStamp is mach_absolute_time UNITS, not nanoseconds — on some
/// hardware those differ, which is what the timebase rational corrects.
/// ticks = ns * denom / numer.
fn host_time_after(delay_ms: f64) -> MIDITimeStamp {
    let now = unsafe { mach_absolute_time() };
    // NOT `delay_ms <= 0.0`, which clippy suggests: a NaN delay compares false
    // against everything, so `<=` would fall through and schedule a note at
    // `now + (NaN as u64)`. Negating `> 0.0` sends NaN down the same path as
    // zero, which is the only sane reading of "when should this play".
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(delay_ms > 0.0) {
        return 0; // 0 means "as soon as possible" to CoreMIDI
    }
    let (numer, denom) = timebase();
    let ns = delay_ms * 1_000_000.0;
    let ticks = ns * f64::from(denom) / f64::from(numer);
    now.saturating_add(ticks as u64)
}

/// One published virtual source. Kept alive for the process lifetime: CoreMIDI
/// tears the port down when the client is released, and a DAW that has armed a
/// track against it should not see it blink out between messages.
pub struct VirtualPort {
    _client: MIDIClientRef,
    source: MIDIEndpointRef,
    pub name: String,
}

// MIDIObjectRef is an opaque u32 handle; CoreMIDI itself is thread-safe for
// MIDIReceived, so the handle may cross threads.
unsafe impl Send for VirtualPort {}

static PORT: Mutex<Option<VirtualPort>> = Mutex::new(None);

/// Publish (or re-use) a virtual MIDI source under `name`.
pub fn open(name: &str) -> Result<String, String> {
    let mut guard = PORT.lock().map_err(|_| "midi port lock poisoned".to_string())?;
    if let Some(p) = guard.as_ref() {
        // already published — re-opening is a no-op rather than a second port,
        // which would show up as a duplicate device in every DAW's list
        return Ok(p.name.clone());
    }
    let cf_client = CFString::new(&format!("{name} client"));
    let cf_src = CFString::new(name);
    let mut client: MIDIClientRef = 0;
    let mut source: MIDIEndpointRef = 0;
    let status = unsafe {
        MIDIClientCreate(
            cf_client.as_concrete_TypeRef(),
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut client,
        )
    };
    if status != 0 {
        return Err(format!("MIDIClientCreate failed: OSStatus {status}"));
    }
    let status = unsafe { MIDISourceCreate(client, cf_src.as_concrete_TypeRef(), &mut source) };
    if status != 0 {
        return Err(format!("MIDISourceCreate failed: OSStatus {status}"));
    }
    *guard = Some(VirtualPort { _client: client, source, name: name.to_string() });
    Ok(name.to_string())
}

/// True when a virtual source is currently published.
pub fn is_open() -> bool {
    PORT.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Send raw MIDI bytes out of the virtual source, NOW (timestamp 0 means
/// "as soon as possible" to CoreMIDI). `bytes` may hold several messages.
pub fn send(bytes: &[u8]) -> Result<(), String> {
    send_after(bytes, 0.0)
}

/// Send `bytes` so they LAND `delay_ms` from now.
///
/// This is the difference between a recording that is in time and one that is
/// systematically early: CoreMIDI will hold a packet until its timestamp, so
/// scheduling here is sample-accurate where deferring with a JS timer was only
/// accurate to timer jitter.
pub fn send_after(bytes: &[u8], delay_ms: f64) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    if bytes.len() > 256 {
        // one packet's data cap; callers send note/cc/clock messages, so this
        // is a caller bug rather than something to silently truncate
        return Err(format!("midi payload too large: {} bytes (max 256)", bytes.len()));
    }
    let guard = PORT.lock().map_err(|_| "midi port lock poisoned".to_string())?;
    let port = guard.as_ref().ok_or("no virtual MIDI port is open")?;
    // 1 KB is ample for a single packet and keeps the buffer on the stack
    let mut buf = [0u8; 1024];
    unsafe {
        let pkt = MIDIPacketListInit(buf.as_mut_ptr());
        let when = host_time_after(delay_ms);
        let pkt = MIDIPacketListAdd(buf.as_mut_ptr(), buf.len(), pkt, when, bytes.len(), bytes.as_ptr());
        if pkt.is_null() {
            return Err("MIDIPacketListAdd rejected the payload".to_string());
        }
        let status = MIDIReceived(port.source, buf.as_ptr());
        if status != 0 {
            return Err(format!("MIDIReceived failed: OSStatus {status}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* These call CoreMIDI for real. That is the point: MIDIClientCreate,
     * MIDISourceCreate and MIDIReceived all return a non-zero OSStatus if the
     * FFI signatures or the packet buffer are wrong, so a green run here is
     * evidence the port genuinely published rather than that the code compiled. */

    #[test]
    fn publishes_a_virtual_source_and_sends_to_it() {
        let name = open("rondocode test").expect("virtual source should publish");
        assert_eq!(name, "rondocode test");
        assert!(is_open());

        // note on / note off, middle C, channel 1
        send(&[0x90, 60, 100]).expect("note on should reach CoreMIDI");
        send(&[0x80, 60, 0]).expect("note off should reach CoreMIDI");
        // a clock byte: what a DAW syncs to
        send(&[0xF8]).expect("clock should reach CoreMIDI");
        // several messages in one call
        send(&[0x90, 64, 90, 0x80, 64, 0]).expect("multi-message packet should send");
    }

    #[test]
    fn opening_twice_keeps_one_port() {
        // a second port would show up as a duplicate device in every DAW
        let a = open("rondocode test").expect("first open");
        let b = open("something else").expect("second open");
        assert_eq!(a, b, "re-opening must not publish a second source");
    }

    #[test]
    fn refuses_an_oversized_payload_instead_of_truncating() {
        open("rondocode test").expect("open");
        let big = vec![0x90u8; 300];
        let err = send(&big).expect_err("should refuse");
        assert!(err.contains("too large"), "unexpected error: {err}");
    }

    #[test]
    fn a_future_timestamp_is_ahead_of_now_and_scales_with_the_delay() {
        // the whole point: CoreMIDI holds the packet until this instant, so it
        // must be genuinely in the future and proportional to the delay asked
        let now = unsafe { mach_absolute_time() };
        let t10 = host_time_after(10.0);
        let t100 = host_time_after(100.0);
        assert!(t10 > now, "10ms must be in the future");
        let d10 = (t10 - now) as f64;
        let d100 = (t100 - now) as f64;
        // ~10x apart, generously toleranced for the time between the two reads
        assert!(d100 / d10 > 5.0 && d100 / d10 < 20.0, "ratio was {}", d100 / d10);
    }

    #[test]
    fn a_zero_or_past_delay_means_as_soon_as_possible() {
        // 0 is CoreMIDI's "now"; a negative delay is a late event, which must
        // go out immediately rather than wrapping into the far future
        assert_eq!(host_time_after(0.0), 0);
        assert_eq!(host_time_after(-5.0), 0);
        // and NaN is "now" too, not `now + garbage`: a bad delay must not
        // schedule a note somewhere unreachable in the future
        assert_eq!(host_time_after(f64::NAN), 0);
    }

    #[test]
    fn ten_milliseconds_is_about_ten_milliseconds_in_nanoseconds() {
        let (numer, denom) = timebase();
        let ticks = host_time_after(10.0) - unsafe { mach_absolute_time() };
        let ns = ticks as f64 * f64::from(numer) / f64::from(denom);
        // within a millisecond of 10ms, allowing for the two clock reads
        assert!((ns - 10_000_000.0).abs() < 1_000_000.0, "got {ns} ns");
    }

    #[test]
    fn a_scheduled_send_reaches_coremidi() {
        open("rondocode test").expect("open");
        send_after(&[0x90, 60, 100], 25.0).expect("scheduled note should be accepted");
        send_after(&[0x80, 60, 0], 50.0).expect("scheduled note-off should be accepted");
    }

    #[test]
    fn empty_send_is_a_no_op() {
        assert!(send(&[]).is_ok());
    }
}

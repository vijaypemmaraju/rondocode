//! Publish the virtual source, then enumerate what CoreMIDI reports to ANY
//! client. If "rondocode" appears here it is a real system MIDI device, and
//! FL Studio / Ableton / Logic all read this same list.
use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};
use std::os::raw::c_void;

type OSStatus = i32;
type MIDIObjectRef = u32;

#[link(name = "CoreMIDI", kind = "framework")]
extern "C" {
    fn MIDIClientCreate(name: CFStringRef, p: *const c_void, r: *mut c_void, out: *mut MIDIObjectRef) -> OSStatus;
    fn MIDISourceCreate(client: MIDIObjectRef, name: CFStringRef, out: *mut MIDIObjectRef) -> OSStatus;
    fn MIDIGetNumberOfSources() -> usize;
    fn MIDIGetSource(i: usize) -> MIDIObjectRef;
    fn MIDIObjectGetStringProperty(obj: MIDIObjectRef, prop: CFStringRef, out: *mut CFStringRef) -> OSStatus;
}

fn name_of(obj: MIDIObjectRef) -> String {
    let key = CFString::new("name");
    let mut out: CFStringRef = std::ptr::null();
    let st = unsafe { MIDIObjectGetStringProperty(obj, key.as_concrete_TypeRef(), &mut out) };
    if st != 0 || out.is_null() { return "<unnamed>".into() }
    unsafe { CFString::wrap_under_get_rule(out) }.to_string()
}

fn main() {
    // `--list` inspects only. Publishing our OWN port while looking for the
    // app's would make the check always succeed, which is worse than no check.
    let list_only = std::env::args().any(|a| a == "--list");
    if !list_only {
        let mut client: MIDIObjectRef = 0;
        let mut src: MIDIObjectRef = 0;
        let cn = CFString::new("rondocode client");
        let sn = CFString::new("rondocode");
        unsafe {
            MIDIClientCreate(cn.as_concrete_TypeRef(), std::ptr::null(), std::ptr::null_mut(), &mut client);
            MIDISourceCreate(client, sn.as_concrete_TypeRef(), &mut src);
        }
    }
    let n = unsafe { MIDIGetNumberOfSources() };
    println!("CoreMIDI sources visible to every client ({n}):");
    let mut found = false;
    for i in 0..n {
        let nm = name_of(unsafe { MIDIGetSource(i) });
        if nm.contains("rondocode") { found = true }
        println!("  [{i}] {nm}");
    }
    println!("\nrondocode visible system-wide: {found}");
}

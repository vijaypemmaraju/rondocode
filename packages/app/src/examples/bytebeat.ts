import { decompile } from '@rondocode/rondo'
import type { Example } from './index'

// Original arranged tracks. Keep every formula and every section editable.
const sketches: Example[] = [
  {
    name: 'bytebeat — neon circuit',
    code: `// NEON CIRCUIT — 24 bars of neon electro: chip arps, rubber bass, glass chords.
// Four-bar launch → eight-bar drive → four-bar breakdown → eight-bar lift.
// Bytebeat clocks follow note.freq * 32: each 32-tick waveform is one note.
const circuit = synth(({ bytebeat, note, gate, adsr, svf }) =>
  svf(bytebeat('((t & 31) * 7) ^ ((t >> 7) & 31)', { rate: note.freq.mul(32) }), 4200)
    .mul(adsr(gate, { a: 0.003, d: 0.12, s: 0.25, r: 0.08 })).mul(0.55),
  ({ input, delay }) => input.add(delay(input, 0.1875, 0.35).mul(0.28)))
const rubber = synth(({ bytebeat, note, gate, adsr, ladder }) => {
  const env = adsr(gate, { a: 0.004, d: 0.18, s: 0.3, r: 0.06 })
  return ladder(bytebeat('(t & 31) * 8', { rate: note.freq.mul(32) }), env.range(180, 1900), { res: 0.35 }).mul(env).mul(0.95)
})
const glass = synth(({ bytebeat, note, gate, adsr }) =>
  bytebeat('sin(t*PI/16 + 0.7*sin(t*PI/8)) * 0.65', { rate: note.freq.mul(32), mode: 'float' })
    .mul(adsr(gate, { a: 0.015, d: 0.5, s: 0.15, r: 0.35 })).mul(0.3),
  ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.72, damp: 0.5 }), 0.25))
const kick = synth(({ sine, gate, adsr }) =>
  sine(adsr(gate, { a: 0.001, d: 0.06, s: 0, r: 0.02 }).pow(2).range(48, 150))
    .mul(adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.04 })).mul(0.95))
const spark = synth(({ bytebeat, gate, adsr, svf }) =>
  svf(bytebeat('(t*29) ^ (t>>2) ^ (t*13)', { rate: 12000 }), 4200, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.045, s: 0, r: 0.02 })).mul(0.23))
const arp = n('0 7 3 10 7 12 [10 7] <3 14>').scale('a minor').sound('circuit').dur(0.6)
  .every(4, x => x.rev()).every(8, x => x.fast(2))
const bassline = note('<a1 f1 c2 g1> [~ <a2 f2 c3 g2>] <a1 f1 c2 g1> [~ <e2 c2 g2 d2>]').sound('rubber').dur(0.65)
const chords = chord('<Am F C G>').struct(mini('~ t ~ t')).sound('glass').dur(0.65)
const drums = note('c1*4').sound('kick')
const hats = note('~ c5 [c5 c5] c5 ~ c5 c5 [c5 c5 c5]').sound('spark').gain('<0.6 0.85 0.7 1>')
const drive = stack(arp, bassline, chords, drums, hats)
p('neon', arrange([4, stack(arp, bassline, drums)], [8, drive],
  [4, stack(chords, arp.slow(2), hats.gain(0.4))], [8, stack(drive, arp.add(7).gain(0.23))]))
sidechain('kick', { depth: 0.55, release: 140, duck: { rubber: 0.7, glass: 0.8, circuit: 0.25 } })
setCps(0.625)
masterCompress({ threshold: -12, ratio: 2.5, attack: 15, release: 130, makeup: 1 })
masterGain(-3.7)

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv - 0.5) * vec2f(res.x / res.y, 1.0);
  let cell = floor((p + vec2f(time * 0.025, 0.0)) * 26.0);
  let grid = abs(fract((p + vec2f(time * 0.025, 0.0)) * 26.0) - 0.5);
  let bits = f32((u32(abs(cell.x)) ^ u32(abs(cell.y) + time * 2.0)) & 7u) / 7.0;
  let trace = 1.0 - smoothstep(0.025, 0.075, min(grid.x, grid.y));
  let scan = exp(-18.0 * abs(fract(uv.y - time * 0.12) - 0.5));
  let wave = 1.0 - smoothstep(0.002, 0.014, abs(uv.y - 0.5 - waveform(uv.x) * 0.22));
  let bars = spectrum(uv.x) * 0.35;
  let eq = (1.0 - smoothstep(bars, bars + 0.01, uv.y)) * 0.4;
  let horizon = max(0.06, abs(p.y + 0.08));
  let road = vec2f(p.x / horizon, 0.3 / horizon + time * 0.8);
  let lanes = abs(fract(road * vec2f(2.0, 1.0)) - 0.5);
  let highway = (1.0 - smoothstep(0.01, 0.05, min(lanes.x, lanes.y))) * smoothstep(0.0, 0.3, -p.y);
  let portal = exp(-55.0 * abs(length(p * vec2f(1.0, 1.3)) - 0.3 - hit_kick * 0.02));
  let phrase = 0.5 + 0.5 * sin(cycle * 0.2618);
  let col = vec3f(0.015, 0.025, 0.065)
    + vec3f(0.25, 0.12, 0.65) * highway * (0.2 + bass * 0.5)
    + mix(vec3f(0.1, 0.8, 0.9), vec3f(0.9, 0.2, 0.6), phrase) * portal * (0.3 + hit_glass * 0.3)
    + vec3f(0.08, 0.8, 0.55) * trace * bits * (0.15 + scan * 0.65)
    + vec3f(1.0, 0.18, 0.55) * wave * 0.7
    + vec3f(0.15, 0.4, 0.9) * eq;
  return vec4f(col, 1.0);
}
\`)
`,
  },
  {
    name: 'bytebeat — bit rot',
    code: `// BIT ROT — 24 bars of industrial broken beat, metallic replies and clock dives.
// The gears clock is patterned per note. Edit the XOR formula for new teeth.
const gears = synth(({ bytebeat, gate, adsr, param, svf }) => {
  const clock = param('clock', 8192, { min: 2048, max: 16384 })
  const raw = bytebeat('((t * (2 + ((t >> 10) & 3))) ^ ((t >> 5) | (t >> 8))) & 255', { rate: clock })
  return svf(svf(raw, 80, { mode: 'hp' }), 2100)
    .mul(adsr(gate, { a: 0.004, d: 0.15, s: 0.5, r: 0.04 })).tanh().mul(0.6)
})
const debris = synth(({ bytebeat, gate, adsr, svf }) =>
  svf(bytebeat('(t * 37) ^ (t >> 3) ^ (t * 11)', { rate: 11000 }), 1200, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.1, s: 0, r: 0.025 })).mul(0.4))
const piston = synth(({ sine, gate, adsr }) =>
  sine(adsr(gate, { a: 0.001, d: 0.045, s: 0, r: 0.02 }).pow(2).range(43, 190))
    .mul(adsr(gate, { a: 0.001, d: 0.23, s: 0, r: 0.04 })).mul(1.4).tanh())
const undertow = synth(({ bytebeat, note, gate, adsr }) =>
  bytebeat('sin(t*PI/16)*0.8 + sin(t*PI/8)*0.15', { rate: note.freq.mul(32), mode: 'float' })
    .mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.8, r: 0.05 })).mul(0.65))
const oxide = synth(({ bytebeat, note, gate, adsr, svf }) =>
  svf(bytebeat('sin(t*PI/16 + 2*sin(t*PI/11))*0.65', { rate: note.freq.mul(32), mode: 'float' }), 700, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.18, s: 0, r: 0.12 })).mul(0.34),
  ({ input, delay }) => input.add(delay(input, 0.225, 0.48).mul(0.4)))
const broken = note('c1 ~ [~ c1] c1 ~ c1 [~ c1] ~').sound('piston').every(4, x => x.fast(2))
const snare = note('~ c3 ~ [c3 c3]').sound('debris').every(4, x => x.rev())
const teeth = note('c2 [~ c2] c2 ~ [c2 c2] ~ c2 [~ c2]').sound('gears').dur(0.45)
  .ctrl('clock', '<8192 6144 12288 4096>').every(4, x => x.rev())
const sub = note('<d1 d1 f1 c1> ~ <d2 a1 f2 c2> ~').sound('undertow').dur(0.9)
const metal = note('~ <d4 f4> ~ a4 ~ [c5 a4] ~ <f4 eb4>').sound('oxide').dur(0.25)
const full = stack(broken, snare, teeth, sub, metal)
p('machine', arrange([4, stack(broken, teeth, sub)], [8, full],
  [4, stack(teeth.slow(2).ctrl('clock', 3072), metal, snare.gain(0.4))],
  [8, stack(full, metal.fast(2).gain(0.25))]))
sidechain('piston', { depth: 0.65, release: 170, duck: { undertow: 0.9, gears: 0.5, oxide: 0.2 } })
setCps(0.65)
masterCompress({ threshold: -12, ratio: 3, attack: 10, release: 150, makeup: 1 })
masterGain(-0.3)

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  let r = length(p);
  let a = atan2(p.y, p.x);
  let teeth = sin(a * 24.0 + time * 0.6) * 0.025;
  let edge = 0.48 + teeth + spectrum(fract(a / 6.2831853 + 0.5)) * 0.3;
  let gear = 1.0 - smoothstep(0.006, 0.025, abs(r - edge));
  let orbit = 1.0 - smoothstep(0.003, 0.012, abs(r - 0.78 - waveform(fract(a / 6.2831853 + 0.5)) * 0.06));
  let sweep = pow(max(0.0, cos(a - time * 0.8)), 28.0) * exp(-r * 2.0);
  let grain = 0.5 + 0.5 * sin(floor(uv.y * 220.0) * 17.0);
  var machinery = vec3f(0.0);
  for (var i = 0; i < 5; i = i + 1) {
    let fi = f32(i);
    let turn = a * (12.0 + fi * 4.0) + time * (0.3 + fi * 0.07) * select(-1.0, 1.0, i % 2 == 0);
    let radius = 0.18 + fi * 0.17 + sin(turn) * 0.018 + hit_piston * 0.015;
    let ring = exp(-100.0 * abs(r - radius));
    let segments = 0.25 + 0.75 * pow(max(0.0, cos(turn * 0.5)), 4.0);
    machinery += mix(vec3f(0.65, 0.18, 0.03), vec3f(0.1, 0.48, 0.65), fi / 4.0) * ring * segments * 0.5;
  }
  let fracture = exp(-180.0 * abs(p.y - waveform(uv.x) * 0.15 - sin(p.x * 8.0 + time) * 0.04));
  let col = vec3f(0.04, 0.015, 0.012) + machinery
    + vec3f(0.7, 0.75, 0.85) * fracture * (0.2 + hit_oxide * 0.35)
    + vec3f(1.0, 0.36, 0.06) * (gear * 0.7 + sweep * 0.3)
    + vec3f(0.15, 0.65, 0.8) * orbit * (0.35 + hit_debris * 0.4)
    + vec3f(0.08, 0.025, 0.01) * grain;
  return vec4f(col, 1.0);
}
\`)
`,
  },
  {
    name: 'bytebeat — orbital bloom',
    code: `// ORBITAL BLOOM — 24 bars of luminous floatbeat, orbiting bells and a deep pulse.
// Dry sound stays present; reverb is blended underneath instead of replacing it.
// Each 32-tick floatbeat waveform follows note pitch. No samples required.
const bloom = synth(({ bytebeat, note, gate, adsr, svf }) =>
  svf(bytebeat('sin(t*PI/16 + 0.6*sin(t*PI/8))*0.55 + sin(t*PI/8)*0.2 + sin(t*PI/4)*0.1',
    { rate: note.freq.mul(32), mode: 'float' }), 3500)
    .mul(adsr(gate, { a: 0.18, d: 0.3, s: 0.8, r: 0.6 })).mul(0.62),
  ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.82, damp: 0.55 }), 0.24))
const satellite = synth(({ bytebeat, note, gate, adsr, pan }) =>
  pan(bytebeat('sin(t*PI/16 + sin(t*PI/7)*exp(-t/7000))*0.75',
    { rate: note.freq.mul(32), mode: 'float' })
    .mul(adsr(gate, { a: 0.004, d: 0.32, s: 0.1, r: 0.3 })).mul(0.38), 0.7),
  ({ input, delay, reverb }) => input.add(delay(input, 0.375, 0.4).mul(0.3))
    .mix(reverb(input, { roomSize: 0.7, damp: 0.4 }), 0.18))
const gravity = synth(({ bytebeat, note, gate, adsr }) =>
  bytebeat('sin(t*PI/16)*0.8 + sin(t*PI/8)*0.15', { rate: note.freq.mul(32), mode: 'float' })
    .mul(adsr(gate, { a: 0.015, d: 0.2, s: 0.75, r: 0.12 })).mul(0.7))
const pulse = synth(({ sine, gate, adsr }) =>
  sine(adsr(gate, { a: 0.001, d: 0.07, s: 0, r: 0.02 }).pow(2).range(48, 125))
    .mul(adsr(gate, { a: 0.003, d: 0.24, s: 0, r: 0.06 })).mul(0.8))
const dust = synth(({ bytebeat, gate, adsr, svf, pan }) =>
  pan(svf(bytebeat('(t * 23) ^ (t * 59 >> 3)', { rate: 14000 }), 5500, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.04, s: 0, r: 0.025 })).mul(0.12), 0.25))
const canopy = chord('<Am7 Fmaj7 Cmaj7 G>').sound('bloom').dur(0.9)
const stars = n('0 ~ 7 12 ~ 10 7 <3 14>').scale('a minor').sound('satellite').dur(0.5)
  .every(4, x => x.rev())
const roots = note('<a1 f1 c2 g1> ~ <e2 c2 g2 d2> ~').sound('gravity').dur(0.85)
const heartbeat = note('c1 ~ [~ c1] ~ c1 ~ c1 ~').sound('pulse')
const shimmer = note('~ c5 ~ c5 [c5 c5] ~ c5 ~').sound('dust').gain('<0.7 1 0.8 0.6>')
const orbit = stack(canopy, stars, roots, heartbeat, shimmer)
p('orbit', arrange([4, stack(canopy, stars, roots)], [8, orbit],
  [4, stack(canopy, stars.slow(2))], [8, stack(orbit, stars.add(7).gain(0.3))]))
sidechain('pulse', { depth: 0.35, release: 240, duck: { bloom: 0.8, gravity: 0.7, satellite: 0.2 } })
setCps(0.5)
masterCompress({ threshold: -12, ratio: 2, attack: 25, release: 200, makeup: 1 })
masterGain(-5.5)

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  let r = length(p);
  let a = atan2(p.y, p.x);
  let petal = 0.46 + sin(a * 6.0 + time * 0.18) * (0.09 + bass * 0.12);
  let bloom = exp(-45.0 * abs(r - petal - waveform(fract(a / 6.2831853 + 0.5)) * 0.06));
  let halo = exp(-18.0 * abs(r - 0.78 - spectrum(fract(a / 6.2831853 + 0.5)) * 0.18));
  let hue = 0.5 + 0.5 * cos(vec3f(0.0, 2.1, 4.2) + a + time * 0.12);
  let core = exp(-r * r * 8.0) * (0.12 + level * 0.25);
  var petals = vec3f(0.0);
  for (var i = 0; i < 6; i = i + 1) {
    let fi = f32(i);
    let twist = a + time * (0.035 + fi * 0.008);
    let radius = 0.18 + fi * 0.105 + sin(twist * (5.0 + fi) + fi) * 0.045;
    let line = exp(-85.0 * abs(r - radius - bass * 0.025));
    petals += (0.5 + 0.5 * cos(vec3f(0.1, 2.0, 4.0) + fi * 0.7 + cycle * 0.06)) * line * 0.27;
  }
  let orbitAngle = time * 0.25;
  let moon = vec2f(cos(orbitAngle), sin(orbitAngle)) * 0.78;
  let satellite = exp(-300.0 * dot(p - moon, p - moon)) * (0.3 + hit_satellite * 0.5);
  let stars = pow(max(0.0, sin(p.x * 87.0 + sin(p.y * 41.0)) * cos(p.y * 97.0)), 32.0);
  let col = vec3f(0.025, 0.015, 0.07) + petals
    + vec3f(0.7, 0.9, 1.0) * (satellite + stars * 0.16) + hue * bloom * 0.75
    + vec3f(0.3, 0.45, 0.9) * halo * 0.35 + vec3f(0.5, 0.2, 0.75) * core;
  return vec4f(col, 1.0);
}
\`)
`,
  },
]

// Derive the Rondo twins so formulas and shaders cannot drift between modes.
export const BYTEBEAT_EXAMPLES: Example[] = sketches.map(example => ({
  ...example, rondo: decompile(example.code),
}))

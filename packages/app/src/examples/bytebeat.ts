import { compile } from '@rondocode/rondo'
import type { Example } from './index'

// Rondo owns the sections; derive JavaScript so both editors play the same track.
const tracks = [
  {
    name: "bytebeat — neon circuit",
    rondo: `# NEON CIRCUIT — 24 bars of neon electro: chip arps, rubber bass, glass chords.
# Four-bar launch → eight-bar drive → four-bar breakdown → eight-bar lift.
# Bytebeat clocks follow note.freq * 32: each 32-tick waveform is one note.

synth circuit
  bytebeat "((t & 31) * 7) ^ ((t >> 7) & 31)" rate:note * 32
  svf 4200
  * adsr 0.003 0.12 0.25 0.08
  * 0.55
  post
    + amp * 0.28
    amp = delay input 0.1875 0.35

synth rubber
  bytebeat "(t & 31) * 8" rate:note * 32
  ladder sig res:0.35
  * env
  * 0.95
  env = adsr 0.004 0.18 0.3 0.06
  sig = env -> 180..1900

synth glass
  bytebeat "sin(t*PI/16 + 0.7*sin(t*PI/8)) * 0.65" rate:note * 32 mode:float
  * adsr 0.015 0.5 0.15 0.35
  * 0.3
  post
    reverb room:0.72 damp:0.5 mix:0.25

synth kick
  sine freq
  * adsr 0.001 0.22 0 0.04
  * 0.95
  freq = adsr 0.001 0.06 0 0.02 ^ 2 -> 48..150

synth spark
  bytebeat "(t*29) ^ (t>>2) ^ (t*13)" rate:12000
  svf 4200 mode:hp
  * adsr 0.001 0.045 0 0.02
  * 0.23

section launch 4
  play part0 synth:circuit
    0 7 3 10 7 12 [10 7] <3 14>
    scale: a-min
    dur: 0.6
    every 4: rev
    every 8: fast 2
  play part1 synth:rubber
    <a1 f1 c2 g1> [~ <a2 f2 c3 g2>] <a1 f1 c2 g1> [~ <e2 c2 g2 d2>]
    dur: 0.65
  play part2 synth:kick
    c1*4

section drive 8
  play part0 synth:circuit
    0 7 3 10 7 12 [10 7] <3 14>
    scale: a-min
    dur: 0.6
    every 4: rev
    every 8: fast 2
  play part1 synth:rubber
    <a1 f1 c2 g1> [~ <a2 f2 c3 g2>] <a1 f1 c2 g1> [~ <e2 c2 g2 d2>]
    dur: 0.65
  play part2 synth:glass
    <Am F C G>
    struct ~ t ~ t
    dur: 0.65
  play part3 synth:kick
    c1*4
  play part4 synth:spark
    ~ c5 [c5 c5] c5 ~ c5 c5 [c5 c5 c5]
    gain: <0.6 0.85 0.7 1>

section breakdown 4
  play part0 synth:glass
    <Am F C G>
    struct ~ t ~ t
    dur: 0.65
  play part1 synth:circuit
    0 7 3 10 7 12 [10 7] <3 14>
    scale: a-min
    dur: 0.6
    every 4: rev
    every 8: fast 2
    slow 2
  play part2 synth:spark
    ~ c5 [c5 c5] c5 ~ c5 c5 [c5 c5 c5]
    gain: <0.6 0.85 0.7 1>
    gain: 0.4

section return 8
  play part0 synth:circuit
    0 7 3 10 7 12 [10 7] <3 14>
    scale: a-min
    dur: 0.6
    every 4: rev
    every 8: fast 2
  play part1 synth:rubber
    <a1 f1 c2 g1> [~ <a2 f2 c3 g2>] <a1 f1 c2 g1> [~ <e2 c2 g2 d2>]
    dur: 0.65
  play part2 synth:glass
    <Am F C G>
    struct ~ t ~ t
    dur: 0.65
  play part3 synth:kick
    c1*4
  play part4 synth:spark
    ~ c5 [c5 c5] c5 ~ c5 c5 [c5 c5 c5]
    gain: <0.6 0.85 0.7 1>
  play part5 synth:circuit
    0 7 3 10 7 12 [10 7] <3 14>
    scale: a-min
    dur: 0.6
    every 4: rev
    every 8: fast 2
    add 7
    gain: 0.23

song launch drive breakdown return

sidechain kick depth:0.55 release:140 rubber:0.7 glass:0.8 circuit:0.25

cps 0.625

master threshold:-12 ratio:2.5 attack:15 release:130 makeup:1

level -3.7

visual
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
`,
  },
  {
    name: "bytebeat — bit rot",
    rondo: `# BIT ROT — 24 bars of industrial broken beat, metallic replies and clock dives.
# The gears clock is patterned per note. Edit the XOR formula for new teeth.

synth gears
  raw
  svf 80 mode:hp
  svf 2100
  * adsr 0.004 0.15 0.5 0.04
  tanh
  * 0.6
  clock = knob 8192 2048..16384
  raw = bytebeat "((t * (2 + ((t >> 10) & 3))) ^ ((t >> 5) | (t >> 8))) & 255" rate:clock

synth debris
  bytebeat "(t * 37) ^ (t >> 3) ^ (t * 11)" rate:11000
  svf 1200 mode:hp
  * adsr 0.001 0.1 0 0.025
  * 0.4

synth piston
  sine freq
  * adsr 0.001 0.23 0 0.04
  * 1.4
  tanh
  freq = adsr 0.001 0.045 0 0.02 ^ 2 -> 43..190

synth undertow
  bytebeat "sin(t*PI/16)*0.8 + sin(t*PI/8)*0.15" rate:note * 32 mode:float
  * adsr 0.01 0.1 0.8 0.05
  * 0.65

synth oxide
  bytebeat "sin(t*PI/16 + 2*sin(t*PI/11))*0.65" rate:note * 32 mode:float
  svf 700 mode:hp
  * adsr 0.001 0.18 0 0.12
  * 0.34
  post
    + amp * 0.4
    amp = delay input 0.225 0.48

section launch 4
  play part0 synth:piston
    c1 ~ [~ c1] c1 ~ c1 [~ c1] ~
    every 4: fast 2
  play part1 synth:gears
    c2 [~ c2] c2 ~ [c2 c2] ~ c2 [~ c2]
    dur: 0.45
    clock: <8192 6144 12288 4096>
    every 4: rev
  play part2 synth:undertow
    <d1 d1 f1 c1> ~ <d2 a1 f2 c2> ~
    dur: 0.9

section drive 8
  play part0 synth:piston
    c1 ~ [~ c1] c1 ~ c1 [~ c1] ~
    every 4: fast 2
  play part1 synth:debris
    ~ c3 ~ [c3 c3]
    every 4: rev
  play part2 synth:gears
    c2 [~ c2] c2 ~ [c2 c2] ~ c2 [~ c2]
    dur: 0.45
    clock: <8192 6144 12288 4096>
    every 4: rev
  play part3 synth:undertow
    <d1 d1 f1 c1> ~ <d2 a1 f2 c2> ~
    dur: 0.9
  play part4 synth:oxide
    ~ <d4 f4> ~ a4 ~ [c5 a4] ~ <f4 eb4>
    dur: 0.25

section breakdown 4
  play part0 synth:gears
    c2 [~ c2] c2 ~ [c2 c2] ~ c2 [~ c2]
    dur: 0.45
    clock: <8192 6144 12288 4096>
    every 4: rev
    slow 2
    clock: 3072
  play part1 synth:oxide
    ~ <d4 f4> ~ a4 ~ [c5 a4] ~ <f4 eb4>
    dur: 0.25
  play part2 synth:debris
    ~ c3 ~ [c3 c3]
    every 4: rev
    gain: 0.4

section return 8
  play part0 synth:piston
    c1 ~ [~ c1] c1 ~ c1 [~ c1] ~
    every 4: fast 2
  play part1 synth:debris
    ~ c3 ~ [c3 c3]
    every 4: rev
  play part2 synth:gears
    c2 [~ c2] c2 ~ [c2 c2] ~ c2 [~ c2]
    dur: 0.45
    clock: <8192 6144 12288 4096>
    every 4: rev
  play part3 synth:undertow
    <d1 d1 f1 c1> ~ <d2 a1 f2 c2> ~
    dur: 0.9
  play part4 synth:oxide
    ~ <d4 f4> ~ a4 ~ [c5 a4] ~ <f4 eb4>
    dur: 0.25
  play part5 synth:oxide
    ~ <d4 f4> ~ a4 ~ [c5 a4] ~ <f4 eb4>
    dur: 0.25
    fast 2
    gain: 0.25

song launch drive breakdown return

sidechain piston depth:0.65 release:170 undertow:0.9 gears:0.5 oxide:0.2

cps 0.65

master threshold:-12 ratio:3 attack:10 release:150 makeup:1

level -0.3

visual
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
`,
  },
  {
    name: "bytebeat — orbital bloom",
    rondo: `# ORBITAL BLOOM — 24 bars of luminous floatbeat, orbiting bells and a deep pulse.
# Dry sound stays present; reverb is blended underneath instead of replacing it.
# Each 32-tick floatbeat waveform follows note pitch. No samples required.

synth bloom
  bytebeat "sin(t*PI/16 + 0.6*sin(t*PI/8))*0.55 + sin(t*PI/8)*0.2 + sin(t*PI/4)*0.1" rate:note * 32 mode:float
  svf 3500
  * adsr 0.18 0.3 0.8 0.6
  * 0.62
  post
    reverb room:0.82 damp:0.55 mix:0.24

synth satellite
  bytebeat "sin(t*PI/16 + sin(t*PI/7)*exp(-t/7000))*0.75" rate:note * 32 mode:float
  * adsr 0.004 0.32 0.1 0.3
  * 0.38
  pan 0.7
  post
    + amp * 0.3
    mix reverb input room:0.7 damp:0.4 0.18
    amp = delay input 0.375 0.4

synth gravity
  bytebeat "sin(t*PI/16)*0.8 + sin(t*PI/8)*0.15" rate:note * 32 mode:float
  * adsr 0.015 0.2 0.75 0.12
  * 0.7

synth pulse
  sine freq
  * adsr 0.003 0.24 0 0.06
  * 0.8
  freq = adsr 0.001 0.07 0 0.02 ^ 2 -> 48..125

synth dust
  bytebeat "(t * 23) ^ (t * 59 >> 3)" rate:14000
  svf 5500 mode:hp
  * adsr 0.001 0.04 0 0.025
  * 0.12
  pan 0.25

section launch 4
  play part0 synth:bloom
    <Am7 Fmaj7 Cmaj7 G>
    dur: 0.9
  play part1 synth:satellite
    0 ~ 7 12 ~ 10 7 <3 14>
    scale: a-min
    dur: 0.5
    every 4: rev
  play part2 synth:gravity
    <a1 f1 c2 g1> ~ <e2 c2 g2 d2> ~
    dur: 0.85

section drive 8
  play part0 synth:bloom
    <Am7 Fmaj7 Cmaj7 G>
    dur: 0.9
  play part1 synth:satellite
    0 ~ 7 12 ~ 10 7 <3 14>
    scale: a-min
    dur: 0.5
    every 4: rev
  play part2 synth:gravity
    <a1 f1 c2 g1> ~ <e2 c2 g2 d2> ~
    dur: 0.85
  play part3 synth:pulse
    c1 ~ [~ c1] ~ c1 ~ c1 ~
  play part4 synth:dust
    ~ c5 ~ c5 [c5 c5] ~ c5 ~
    gain: <0.7 1 0.8 0.6>

section breakdown 4
  play part0 synth:bloom
    <Am7 Fmaj7 Cmaj7 G>
    dur: 0.9
  play part1 synth:satellite
    0 ~ 7 12 ~ 10 7 <3 14>
    scale: a-min
    dur: 0.5
    every 4: rev
    slow 2

section return 8
  play part0 synth:bloom
    <Am7 Fmaj7 Cmaj7 G>
    dur: 0.9
  play part1 synth:satellite
    0 ~ 7 12 ~ 10 7 <3 14>
    scale: a-min
    dur: 0.5
    every 4: rev
  play part2 synth:gravity
    <a1 f1 c2 g1> ~ <e2 c2 g2 d2> ~
    dur: 0.85
  play part3 synth:pulse
    c1 ~ [~ c1] ~ c1 ~ c1 ~
  play part4 synth:dust
    ~ c5 ~ c5 [c5 c5] ~ c5 ~
    gain: <0.7 1 0.8 0.6>
  play part5 synth:satellite
    0 ~ 7 12 ~ 10 7 <3 14>
    scale: a-min
    dur: 0.5
    every 4: rev
    add 7
    gain: 0.3

song launch drive breakdown return

sidechain pulse depth:0.35 release:240 bloom:0.8 gravity:0.7 satellite:0.2

cps 0.5

master threshold:-12 ratio:2 attack:25 release:200 makeup:1

level -5.5

visual
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
`,
  },
]

export const BYTEBEAT_EXAMPLES: Example[] = tracks.map(example => {
  const result = compile(example.rondo)
  if (!result.ok) throw new Error(JSON.stringify(result.errors))
  return { ...example, code: result.code }
})

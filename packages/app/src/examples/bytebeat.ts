import { decompile } from '@rondocode/rondo'
import type { Example } from './index'

// Original formula sketches. Keep the formula visible and editable; each
// long note gives its clock enough time to unfold before restarting.
const sketches: Example[] = [
  {
    name: 'bytebeat — neon circuit',
    code: `// NEON CIRCUIT — a crunchy clockwork arpeggio and a scanning circuit grid.
// Run, then enable visuals. Edit the shifts (& masks) to rewrite the melody.
// t counts at 8192 Hz; this 16-cycle phrase restarts after 131072 ticks.
const circuit = synth(({ bytebeat, gate, adsr, svf }) =>
  svf(bytebeat('(t * (3 + ((t >> 12) & 3)) & 127) + ((t * 5 >> 2) & (t >> 7) & 63)',
    { rate: 8192 }), 35, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.01, d: 0.01, s: 1, r: 0.03 })).mul(0.55))
p('circuit', note('c3').sound('circuit').slow(16).dur(1))
setCps(1)
masterGain(-6)
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
  let col = vec3f(0.015, 0.025, 0.065)
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
    code: `// BIT ROT — jagged bass gears, broken-machine percussion, amber radar.
// The clock knob changes speed AND pitch. Try 4096, 8192, 12288.
const gears = synth(({ bytebeat, gate, adsr, param, svf }) => {
  const clock = param('clock', 8192, { min: 2048, max: 16384 })
  const raw = bytebeat('((t * (2 + ((t >> 13) & 3))) ^ ((t >> 5) | (t >> 8))) & 255', { rate: clock })
  return svf(svf(raw, 45, { mode: 'hp' }), 2600)
    .mul(adsr(gate, { a: 0.008, d: 0.01, s: 1, r: 0.02 })).mul(0.45)
})
const debris = synth(({ bytebeat, gate, adsr }) =>
  bytebeat('(t * 37) ^ (t >> 3) ^ (t * 11)', { rate: 6000 })
    .mul(adsr(gate, { a: 0.001, d: 0.065, s: 0, r: 0.025 })).mul(0.16))
p('gears', note('c2').sound('gears').slow(16).dur(1))
p('debris', note('~ c3 [~ c3] c3').sound('debris'))
setCps(0.75)
masterGain(-6)
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
  let col = vec3f(0.04, 0.015, 0.012)
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
    code: `// ORBITAL BLOOM — floatbeat: sine harmonics inside a slowly opening flower.
// float mode reads -1..1 directly. t is still integer ticks, even in float mode.
const bloom = synth(({ bytebeat, gate, adsr }) =>
  bytebeat('sin(t * PI / 64 + 2 * sin(t * PI / 16384)) * 0.38 + sin(t * PI / 96) * 0.22 + sin(t * PI / 128) * 0.18',
    { rate: 8192, mode: 'float' })
    .mul(adsr(gate, { a: 0.4, d: 0.1, s: 1, r: 0.5 })).mul(0.65),
  ({ input, reverb, delay }) => reverb(input.add(delay(input, 0.375, 0.3).mul(0.25)),
    { roomSize: 0.8, damp: 0.6 }).mul(0.7))
p('bloom', note('c3').sound('bloom').slow(16).dur(1))
setCps(0.5)
masterGain(-6)
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
  let col = vec3f(0.025, 0.015, 0.07) + hue * bloom * 0.75
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

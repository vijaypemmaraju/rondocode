/* Minimal AudioWorkletGlobalScope ambient declarations. Deliberately
 * hand-rolled instead of adding @types/audioworklet: the processor uses
 * exactly four globals, and this file keeps the app dependency-lean.
 *
 * This directory is its own tsconfig project (see ./tsconfig.json) with lib
 * ES2022 and NO DOM, and it is excluded from the app tsconfig — so these
 * globals never leak into main-thread typechecking, and DOM globals never
 * leak in here. MessagePort/MessageEvent are declared minimally because the
 * DOM lib (their usual source) is absent in this scope. */

/** Context sample rate (Hz), fixed for the lifetime of the scope. */
declare const sampleRate: number

/** Running frame counter of the context — the engine's `startFrame` timeline. */
declare const currentFrame: number

interface MessageEvent {
  readonly data: unknown
}

interface MessagePort {
  postMessage(message: unknown): void
  onmessage: ((ev: MessageEvent) => void) | null
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean
  },
): void

// Reusable pieces from safari-120hz-lab, as React components and hooks.
// See docs/FINDINGS.md for what each one is for, how it was validated, and
// where it pays off.

export { ScrollPad } from './ScrollPad'
export type { ScrollPadAxis, ScrollPadMove, ScrollPadProps, ScrollPadRelease } from './ScrollPad'
export { useScrollSampler } from './useScrollSampler'
export type { ScrollSample, ScrollSamplerOptions } from './useScrollSampler'
export { useWorkerCanvas } from './useWorkerCanvas'
export type { WorkerCanvas, WorkerCanvasOptions, WorkerCanvasStats } from './useWorkerCanvas'
export { SwipeableSheet } from './SwipeableSheet'
export type { SwipeableSheetProps } from './SwipeableSheet'
export { InputMeter } from './InputMeter'
export type { InputMeterProps } from './InputMeter'
export { useSpring } from './useSpring'
export type { SpringHandle, SpringSpec } from './useSpring'
export { useDisplayBoost } from './useDisplayBoost'
export { ScrollKeep } from './ScrollKeep'
// Worker side of useWorkerCanvas: import { defineCanvasWorker } from './canvasWorker' inside the worker file.

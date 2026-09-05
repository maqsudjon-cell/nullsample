/**
 * The DSP core.
 *
 * Everything here is generic machinery that knows nothing about genre. If a
 * change to how the product sounds requires editing anything under /core, the
 * boundary between /core and /presets is in the wrong place.
 */

export * from "./dmath.ts";
export * from "./rng.ts";
export * from "./buffer.ts";
export * from "./osc.ts";
export * from "./env.ts";
export * from "./filter.ts";
export * from "./shape.ts";
export * from "./delay.ts";
export * from "./reverb.ts";
export * from "./dynamics.ts";
export * from "./drums.ts";
export * from "./bass808.ts";
export * from "./formant.ts";

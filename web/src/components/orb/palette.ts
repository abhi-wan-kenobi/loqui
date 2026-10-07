import { Color } from "three";

/**
 * Colour ramps for the orb skins, sampled straight off the design refs.
 *
 * MESH — a diagonal gradient across the sphere: electric blue (top-left) →
 * violet (centre) → hot magenta/pink (bottom-right rim). Fed to the line shader
 * as three stops it interpolates along a screen-diagonal factor `t ∈ [0,1]`.
 *
 * STARDUST — cool indigo/blue core with a warm coral→orange band biased to the
 * lower rim, plus a small fraction of random warm flecks.
 *
 * RIBBONS — hot pink/magenta strand bundles whose inner edges run coral→orange
 * and whose pinch points (where strands converge) bloom toward pale pink-white.
 */

export const MESH_RAMP = {
  // t = 0 (upper-left) → 1 (lower-right)
  low: new Color(0x2b6bff), // electric blue
  mid: new Color(0x8b3bff), // violet
  high: new Color(0xff2fbf), // hot magenta
  rim: new Color(0xff4fd0), // rim-glow tint (lower-right)
  haloA: new Color(0x6a8cff), // halo dots, cool
  haloB: new Color(0xd94ff0), // halo dots, warm
} as const;

export const STARDUST_RAMP = {
  coreDeep: new Color(0x35459e), // indigo (interior / back)
  coreBlue: new Color(0x5f7cff), // blue
  coolHi: new Color(0xaac6ff), // cool highlight (front)
  warmMid: new Color(0xff5566), // coral / red
  warmHi: new Color(0xffa23c), // orange
} as const;

export const RIBBONS_RAMP = {
  magenta: new Color(0xd42ae0), // bundle body
  pink: new Color(0xff3cc8), // outer strands
  coral: new Color(0xff6a3d), // inner-edge warm strands
  violet: new Color(0x7a4dff), // listening (cool) push
  white: new Color(0xffd6f2), // pinch-point bloom
} as const;

/** Convenience: pack a Color into a flat [r,g,b] tuple. */
export const rgb = (c: Color): [number, number, number] => [c.r, c.g, c.b];

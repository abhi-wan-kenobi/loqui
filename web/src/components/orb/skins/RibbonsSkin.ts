import {
  Group,
  BufferGeometry,
  BufferAttribute,
  LineSegments,
  ShaderMaterial,
  AdditiveBlending,
  Color,
} from "three";
import type { Skin, FrameDrivers } from "../OrbEngine";
import { SIMPLEX_3D } from "../noise";
import { RIBBONS_RAMP } from "../palette";

/**
 * RIBBONS skin — three bundles of fine closed strands looping around the
 * centre, each a noise-warped ring. Within a bundle the strands fan apart along
 * some arcs and pinch together along others (the pinch points bloom pale
 * pink-white under additive blending), and the bundles weave through depth so
 * they cross over one another. All motion is computed in the vertex shader from
 * static per-vertex parameters; one draw call.
 */

const BUNDLES = 3;
// Strands per bundle × segments per strand, per quality step.
const QUALITY_STEPS: Array<[number, number]> = [
  [18, 240],
  [14, 180],
  [10, 120],
];

function buildRibbons(strands: number, segments: number): BufferGeometry {
  const verts = BUNDLES * strands * segments;
  const pos = new Float32Array(verts * 3);
  const theta = new Float32Array(verts);
  const strand = new Float32Array(verts);
  const bundle = new Float32Array(verts);
  // Max 3 × 18 × 240 = 12 960 vertices — fits 16-bit indices.
  const index = new Uint16Array(verts * 2);
  let v = 0;
  let e = 0;
  for (let b = 0; b < BUNDLES; b++) {
    for (let k = 0; k < strands; k++) {
      // -0.5 (inner edge) .. +0.5 (outer edge) across the bundle.
      const s = strands > 1 ? k / (strands - 1) - 0.5 : 0;
      const first = v;
      for (let i = 0; i < segments; i++) {
        const th = (i / segments) * Math.PI * 2;
        // Rest position is only used for bounds; the shader rebuilds it.
        pos[v * 3] = Math.cos(th);
        pos[v * 3 + 1] = Math.sin(th);
        pos[v * 3 + 2] = 0;
        theta[v] = th;
        strand[v] = s;
        bundle[v] = b;
        // Closed loop: segment i joins vertex i to i+1 (wrapping to the first).
        index[e++] = v;
        index[e++] = i === segments - 1 ? first : v + 1;
        v++;
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aTheta", new BufferAttribute(theta, 1));
  g.setAttribute("aStrand", new BufferAttribute(strand, 1));
  g.setAttribute("aBundle", new BufferAttribute(bundle, 1));
  g.setIndex(new BufferAttribute(index, 1));
  return g;
}

const vertex = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uScale;
uniform float uLevel;
attribute float aTheta;
attribute float aStrand;
attribute float aBundle;
varying float vStrand;
varying float vTheta;
varying float vFan;
varying float vDepth;
${SIMPLEX_3D}
void main(){
  float th = aTheta;
  float ph = aBundle * 2.0944;          // bundles 120° apart
  float t = uTime;
  vec2 c = vec2(cos(th), sin(th));

  // Bundle centreline: a ring warped by travelling lobes (a different lobe
  // count per bundle, so the loops never line up) plus looped simplex noise
  // (sampled on the unit circle, so it closes seamlessly).
  float n = snoise(vec3(c * 0.95, aBundle * 1.7 + t * 0.12));
  float lobes = sin((2.0 + aBundle) * th + ph + t * 0.25) * 0.13
              + sin(2.0 * th - ph * 1.3 - t * 0.18) * 0.07;
  float base = 1.0 + (aBundle - 1.0) * 0.07;

  // Fan: strands spread wide on some arcs, gather tight on others.
  float fan = 0.5 + 0.5 * sin(2.0 * th + ph * 1.7 + t * 0.2 + n * 1.5);
  fan *= fan;
  float spread = mix(0.04, 0.55, fan) * (1.0 + uAmp * 0.25 + uLevel * 0.4);

  // Twist: the bundle's cross-section turns between the radial direction
  // (strands fan out on screen) and depth (strands stack into a bright seam).
  // Integer multiple of theta so the loop closes without a seam.
  float tw = th + ph + t * 0.22;
  float off = aStrand * spread;
  float r = base + lobes + n * uAmp * 0.24 + off * cos(tw);
  // Weave through depth so bundles cross over each other.
  float z = sin(2.0 * th + ph + t * 0.3) * 0.35 + off * sin(tw);

  vec3 p = vec3(c * r, z) * (uScale * 0.8);
  vStrand = aStrand;
  vTheta = th;
  vFan = fan * abs(cos(tw));            // how far apart strands look on screen
  vDepth = z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const fragment = /* glsl */ `
precision highp float;
uniform vec3 uMagenta;
uniform vec3 uPink;
uniform vec3 uCoral;
uniform vec3 uViolet;
uniform vec3 uWhite;
uniform float uBright;
uniform float uWarm;
uniform float uCool;
uniform float uRimBoost;
uniform float uShimmer;
uniform float uShimmerPhase;
varying float vStrand;
varying float vTheta;
varying float vFan;
varying float vDepth;
void main(){
  // Outer strands hot pink, body magenta, inner edge coral.
  vec3 col = mix(uMagenta, uPink, smoothstep(-0.1, 0.5, vStrand));
  col = mix(col, uCoral, smoothstep(0.05, -0.5, vStrand) * 0.75);
  col = mix(col, uViolet, uCool * 0.55);
  col = mix(col, uCoral, uWarm * 0.3);
  // Pinch seams bloom toward pale pink-white.
  float pinch = 1.0 - vFan;
  col = mix(col, uWhite, pinch * 0.4);

  // Edge strands fainter; pinched strands dimmer each (they stack additively).
  float a = mix(1.0, 0.35, abs(vStrand) * 2.0);
  a *= mix(0.4, 1.0, vFan);
  // Strands behind the centre plane recede.
  a *= mix(0.45, 1.0, smoothstep(-0.4, 0.4, vDepth));
  a *= uBright * (0.75 + 0.35 * uRimBoost);

  // Thinking shimmer: a bright arc sweeping around the loop.
  float band = pow(max(0.0, cos(vTheta - uShimmerPhase)), 10.0);
  vec3 shimmer = band * uShimmer * 0.35 * vec3(0.9, 0.85, 1.0);

  gl_FragColor = vec4(col * a + shimmer, 1.0);
}
`;

export class RibbonsSkin implements Skin {
  readonly root = new Group();
  private lines!: LineSegments;
  private mat: ShaderMaterial;
  private q = 0;

  constructor(_pixelRatio: number) {
    this.mat = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.3 },
        uScale: { value: 1 },
        uLevel: { value: 0 },
        uBright: { value: 1 },
        uWarm: { value: 0 },
        uCool: { value: 0 },
        uRimBoost: { value: 0.4 },
        uShimmer: { value: 0 },
        uShimmerPhase: { value: 0 },
        uMagenta: { value: new Color().copy(RIBBONS_RAMP.magenta) },
        uPink: { value: new Color().copy(RIBBONS_RAMP.pink) },
        uCoral: { value: new Color().copy(RIBBONS_RAMP.coral) },
        uViolet: { value: new Color().copy(RIBBONS_RAMP.violet) },
        uWhite: { value: new Color().copy(RIBBONS_RAMP.white) },
      },
    });
    this.build(0);
  }

  private build(q: number): void {
    const [strands, segments] = QUALITY_STEPS[Math.min(q, QUALITY_STEPS.length - 1)];
    if (this.lines) {
      this.root.remove(this.lines);
      this.lines.geometry.dispose();
    }
    this.lines = new LineSegments(buildRibbons(strands, segments), this.mat);
    this.lines.frustumCulled = false;
    this.root.add(this.lines);
  }

  setQuality(q: number): void {
    if (q === this.q) return;
    this.q = q;
    this.build(q);
  }

  update(d: FrameDrivers): void {
    const u = this.mat.uniforms;
    u.uTime.value = d.time;
    u.uAmp.value = d.amp;
    u.uScale.value = d.scale;
    u.uLevel.value = d.level * (d.weights.listening + d.weights.speaking);
    u.uBright.value = d.brightness;
    u.uWarm.value = d.warmBias;
    u.uCool.value = d.coolBias;
    u.uRimBoost.value = d.rimBoost;
    u.uShimmer.value = d.shimmer;
    u.uShimmerPhase.value = d.shimmerPhase;

    // Loops turn in the screen plane with a gentle tumble.
    this.lines.rotation.z = d.rotation * 0.6;
    this.lines.rotation.x = Math.sin(d.time * 0.11) * 0.22;
    this.lines.rotation.y = Math.cos(d.time * 0.09) * 0.18;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}

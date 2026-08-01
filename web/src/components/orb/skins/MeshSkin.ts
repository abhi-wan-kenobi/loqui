import {
  Group,
  BufferGeometry,
  BufferAttribute,
  LineSegments,
  Points,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  Vector3,
} from "three";
import type { Skin, FrameDrivers } from "../OrbEngine";
import { SIMPLEX_3D } from "../noise";
import { MESH_RAMP } from "../palette";

/**
 * MESH skin — a lat/long wireframe grid sphere rippling under 3D simplex
 * displacement, coloured by a screen-diagonal blue→violet→magenta gradient with
 * an additive fresnel rim glow biased to the lower-right, wrapped in a sparse
 * drifting halo of twinkling dots. One draw call for the grid, one for the halo.
 */

// Grid density per quality step (longitude cells × latitude cells).
const GRID_STEPS: Array<[number, number]> = [
  [52, 34],
  [40, 26],
  [30, 20],
];
const HALO_STEPS = [340, 220, 140];

function buildGrid(lon: number, lat: number): BufferGeometry {
  const pts: number[] = [];
  const push = (v: Vector3) => pts.push(v.x, v.y, v.z);
  const at = (u: number, v: number, out: Vector3) => {
    // u ∈ [0,1) around, v ∈ [0,1] pole→pole.
    const theta = u * Math.PI * 2;
    const phi = v * Math.PI;
    const sp = Math.sin(phi);
    out.set(Math.cos(theta) * sp, Math.cos(phi), Math.sin(theta) * sp);
  };
  const a = new Vector3();
  const b = new Vector3();
  // Parallels (rings of latitude), skip the exact poles (v=0,1 degenerate).
  for (let j = 1; j < lat; j++) {
    const v = j / lat;
    for (let i = 0; i < lon; i++) {
      at(i / lon, v, a);
      at((i + 1) / lon, v, b);
      push(a);
      push(b);
    }
  }
  // Meridians (pole to pole).
  for (let i = 0; i < lon; i++) {
    const u = i / lon;
    for (let j = 0; j < lat; j++) {
      at(u, j / lat, a);
      at(u, (j + 1) / lat, b);
      push(a);
      push(b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
  return g;
}

function buildHalo(count: number): BufferGeometry {
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count); // per-dot phase/size seed
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    // Roughly a shell just outside the sphere, denser near the silhouette.
    v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, (Math.random() * 2 - 1) * 0.35).normalize();
    const r = 1.16 + Math.random() * 0.5;
    pos[i * 3] = v.x * r;
    pos[i * 3 + 1] = v.y * r;
    pos[i * 3 + 2] = v.z * r * 0.6;
    rnd[i] = Math.random();
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aRnd", new BufferAttribute(rnd, 1));
  return g;
}

const gridVertex = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uScale;
varying float vFacing;   // view-space normal.z (toward camera)
varying vec3  vViewN;    // view-space normal
varying float vAzimuth;  // local azimuth for the shimmer band
${SIMPLEX_3D}
void main(){
  vec3 dir = normalize(position);
  float n = fbm(position * 1.3 + vec3(0.0, uTime * 0.18, uTime * 0.12));
  float disp = n * uAmp * 0.55;
  vec3 p = position * (uScale * (1.0 + disp));
  vAzimuth = atan(position.z, position.x);
  vViewN = normalize(normalMatrix * dir);
  vFacing = vViewN.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const gridFragment = /* glsl */ `
precision highp float;
uniform vec3 uLow;
uniform vec3 uMid;
uniform vec3 uHigh;
uniform vec3 uRim;
uniform float uBright;
uniform float uWarm;
uniform float uCool;
uniform float uRimBoost;
uniform float uShimmer;
uniform float uShimmerPhase;
varying float vFacing;
varying vec3  vViewN;
varying float vAzimuth;
void main(){
  // Screen-diagonal gradient (top-left → bottom-right), stable under spin.
  float t = clamp(dot(vViewN, normalize(vec3(1.0, -1.0, 0.4))) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = t < 0.5 ? mix(uLow, uMid, t / 0.5) : mix(uMid, uHigh, (t - 0.5) / 0.5);
  col = mix(col, uHigh, uWarm * 0.4);
  col = mix(col, uLow, uCool * 0.28);

  // Depth fade: back-facing lines dim, front bright.
  float fade = mix(0.24, 1.0, smoothstep(-0.35, 0.85, vFacing));

  // Fresnel rim glow, boosted toward the lower-right.
  float fres = pow(1.0 - clamp(vFacing, 0.0, 1.0), 3.0);
  float lr = clamp(dot(normalize(vViewN.xy + 1e-4), vec2(0.707, -0.707)), 0.0, 1.0);
  float rim = fres * (0.35 + 0.65 * lr) * uRimBoost;

  // Thinking shimmer: a bright band sweeping around the sphere.
  float band = pow(max(0.0, cos(vAzimuth - uShimmerPhase)), 8.0);
  vec3 shimmer = band * uShimmer * vec3(0.8, 0.85, 1.0);

  vec3 outc = col * fade * uBright + uRim * rim + shimmer;
  gl_FragColor = vec4(outc, 1.0);
}
`;

const haloVertex = /* glsl */ `
uniform float uTime;
uniform float uPointScale;
attribute float aRnd;
varying float vTw;
varying float vGrad;
void main(){
  vec3 p = position;
  // slow drift
  p.x += sin(uTime * 0.3 + aRnd * 6.28) * 0.03;
  p.y += cos(uTime * 0.25 + aRnd * 6.28) * 0.03;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vTw = 0.45 + 0.55 * sin(uTime * (1.2 + aRnd) + aRnd * 12.0);
  vGrad = clamp(dot(normalize(position.xy + 1e-4), vec2(0.707, -0.707)) * 0.5 + 0.5, 0.0, 1.0);
  float world = 0.009 + aRnd * 0.014;        // ~2–5 device px dots
  gl_PointSize = world * uPointScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const haloFragment = /* glsl */ `
precision highp float;
uniform vec3 uHaloA;
uniform vec3 uHaloB;
uniform float uBright;
varying float vTw;
varying float vGrad;
void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.5, 0.0, d) * vTw * uBright;
  vec3 c = mix(uHaloA, uHaloB, vGrad);
  gl_FragColor = vec4(c * a, a);
}
`;

export class MeshSkin implements Skin {
  readonly root = new Group();
  private grid!: LineSegments;
  private halo!: Points;
  private gridMat: ShaderMaterial;
  private haloMat: ShaderMaterial;
  private haloGroup = new Group();
  private q = 0;

  constructor(pixelRatio: number) {
    this.gridMat = new ShaderMaterial({
      vertexShader: gridVertex,
      fragmentShader: gridFragment,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.3 },
        uScale: { value: 1 },
        uBright: { value: 1 },
        uWarm: { value: 0 },
        uCool: { value: 0 },
        uRimBoost: { value: 0.4 },
        uShimmer: { value: 0 },
        uShimmerPhase: { value: 0 },
        uLow: { value: new Color().copy(MESH_RAMP.low) },
        uMid: { value: new Color().copy(MESH_RAMP.mid) },
        uHigh: { value: new Color().copy(MESH_RAMP.high) },
        uRim: { value: new Color().copy(MESH_RAMP.rim) },
      },
    });
    this.haloMat = new ShaderMaterial({
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uPointScale: { value: 400 },
        uBright: { value: 1 },
        uHaloA: { value: new Color().copy(MESH_RAMP.haloA) },
        uHaloB: { value: new Color().copy(MESH_RAMP.haloB) },
      },
    });
    this.root.add(this.haloGroup);
    this.build(0);
  }

  private build(q: number): void {
    const [lon, lat] = GRID_STEPS[Math.min(q, GRID_STEPS.length - 1)];
    const halo = HALO_STEPS[Math.min(q, HALO_STEPS.length - 1)];
    if (this.grid) {
      this.root.remove(this.grid);
      this.grid.geometry.dispose();
    }
    if (this.halo) {
      this.haloGroup.remove(this.halo);
      this.halo.geometry.dispose();
    }
    this.grid = new LineSegments(buildGrid(lon, lat), this.gridMat);
    this.grid.frustumCulled = false;
    this.root.add(this.grid);
    this.halo = new Points(buildHalo(halo), this.haloMat);
    this.halo.frustumCulled = false;
    this.haloGroup.add(this.halo);
  }

  setQuality(q: number): void {
    if (q === this.q) return;
    this.q = q;
    this.build(q);
  }

  update(d: FrameDrivers): void {
    const u = this.gridMat.uniforms;
    u.uTime.value = d.time;
    u.uAmp.value = d.amp;
    u.uScale.value = d.scale;
    u.uBright.value = d.brightness;
    u.uWarm.value = d.warmBias;
    u.uCool.value = d.coolBias;
    u.uRimBoost.value = 0.35 + d.rimBoost;
    u.uShimmer.value = d.shimmer * 0.9;
    u.uShimmerPhase.value = d.shimmerPhase;

    this.haloMat.uniforms.uTime.value = d.time;
    this.haloMat.uniforms.uPointScale.value = d.pointScale;
    this.haloMat.uniforms.uBright.value = 0.5 + d.brightness * 0.6;

    // Sphere spins; halo drifts slower and counter-tilts a touch.
    this.grid.rotation.y = d.rotation;
    this.grid.rotation.x = Math.sin(d.time * 0.1) * 0.08;
    this.haloGroup.rotation.y = d.rotation * 0.4;
  }

  dispose(): void {
    this.grid.geometry.dispose();
    this.halo.geometry.dispose();
    this.gridMat.dispose();
    this.haloMat.dispose();
  }
}

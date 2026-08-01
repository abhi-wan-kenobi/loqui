import {
  Group,
  BufferGeometry,
  BufferAttribute,
  Points,
  ShaderMaterial,
  AdditiveBlending,
  Color,
} from "three";
import type { Skin, FrameDrivers } from "../OrbEngine";
import { SIMPLEX_3D, CURL_3D } from "../noise";
import { STARDUST_RAMP } from "../palette";

/**
 * STARDUST skin — a hollow point-cloud sphere. Cool indigo/blue core, with a
 * warm coral→orange band concentrated on the lower rim (computed in view space
 * so it stays "lit from below" under rotation) plus a few percent random warm
 * flecks. Curl-noise positional drift, additive size-attenuated points, one
 * draw call.
 */

const COUNT_STEPS = [6000, 3800, 2200];

function buildCloud(count: number): BufferGeometry {
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count);
  // Fibonacci sphere for even angular coverage.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const jitter = 1 + (Math.random() - 0.5) * 0.06; // slight shell thickness
    pos[i * 3] = Math.cos(theta) * r * jitter;
    pos[i * 3 + 1] = y * jitter;
    pos[i * 3 + 2] = Math.sin(theta) * r * jitter;
    rnd[i] = Math.random();
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aRnd", new BufferAttribute(rnd, 1));
  return g;
}

const vertex = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uScale;
uniform float uBright;
uniform float uWarm;
uniform float uLevel;
uniform float uPointScale;
uniform vec3 uCoreDeep;
uniform vec3 uCoreBlue;
uniform vec3 uCoolHi;
uniform vec3 uWarmMid;
uniform vec3 uWarmHi;
attribute float aRnd;
varying vec3 vColor;
varying float vAlpha;
${SIMPLEX_3D}
${CURL_3D}
void main(){
  vec3 dir = normalize(position);
  // Curl drift keeps points swimming without leaving the shell.
  vec3 flow = curlNoise(position * 0.9 + vec3(0.0, uTime * 0.12, 0.0));
  float driftAmt = 0.03 + uAmp * 0.06;
  vec3 p = position * uScale + flow * driftAmt;

  vec3 vn = normalize(normalMatrix * dir);
  float front = smoothstep(-0.6, 0.9, vn.z);

  // Warm band: lower rim (screen bottom + silhouette), plus random flecks.
  float rim = pow(1.0 - abs(vn.z), 1.4);
  float bottom = smoothstep(0.05, 0.85, -vn.y);
  float warm = clamp(bottom * (0.35 + 0.75 * rim) + uWarm * 0.3, 0.0, 1.0);
  float fleck = step(0.955, aRnd) * (0.55 + 0.45 * aRnd);
  warm = max(warm, fleck);

  vec3 cool = mix(uCoreDeep, uCoreBlue, front);
  cool = mix(cool, uCoolHi, front * front * 0.5);
  vec3 hot = mix(uWarmMid, uWarmHi, clamp(-vn.y, 0.0, 1.0));
  vColor = mix(cool, hot, smoothstep(0.15, 0.7, warm));

  // Higher floor so the cool core stays visible; state only dims it a little.
  float eb = 0.6 + 0.55 * uBright;
  float bright = mix(0.5, 1.15, front) * eb;
  bright *= 1.0 + rim * 0.5;   // silhouette ring reads brighter (like the ref)
  bright *= 0.8 + 0.5 * warm;  // warm rim reads hotter still
  vAlpha = bright;

  float world = (0.011 + aRnd * 0.013 + warm * 0.009) * (1.0 + uLevel * 0.4);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = world * uPointScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragment = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.5, 0.05, d) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}
`;

export class StardustSkin implements Skin {
  readonly root = new Group();
  private points!: Points;
  private mat: ShaderMaterial;
  private q = 0;

  constructor(pixelRatio: number) {
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
        uBright: { value: 1 },
        uWarm: { value: 0 },
        uLevel: { value: 0 },
        uPointScale: { value: 400 },
        uCoreDeep: { value: new Color().copy(STARDUST_RAMP.coreDeep) },
        uCoreBlue: { value: new Color().copy(STARDUST_RAMP.coreBlue) },
        uCoolHi: { value: new Color().copy(STARDUST_RAMP.coolHi) },
        uWarmMid: { value: new Color().copy(STARDUST_RAMP.warmMid) },
        uWarmHi: { value: new Color().copy(STARDUST_RAMP.warmHi) },
      },
    });
    this.build(0);
  }

  private build(q: number): void {
    const count = COUNT_STEPS[Math.min(q, COUNT_STEPS.length - 1)];
    if (this.points) {
      this.root.remove(this.points);
      this.points.geometry.dispose();
    }
    this.points = new Points(buildCloud(count), this.mat);
    this.points.frustumCulled = false;
    this.root.add(this.points);
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
    u.uBright.value = d.brightness;
    u.uWarm.value = d.warmBias;
    u.uLevel.value = d.level;
    u.uPointScale.value = d.pointScale;
    this.points.rotation.y = d.rotation * 0.6;
    this.points.rotation.x = Math.sin(d.time * 0.08) * 0.06;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

/**
 * Instanced sprite batch.
 *
 * One `InstancedMesh` per sheet, with the sprite frame selected per instance by
 * a UV offset attribute. This is the whole reason the game can hold 60 FPS:
 * 300 enemies plus 400 projectiles as individual meshes would be ~700 draw
 * calls, whereas this is one call per sheet.
 *
 * The attribute arrays are preallocated at capacity and only the first `count`
 * instances are drawn, which mirrors the projectile free-list in the sim --
 * allocation strategy and draw strategy are the same shape.
 */

import * as THREE from 'three';
import { WHITE } from './atlas.js';

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 aUvOffset;
  attribute vec2 aUvScale;
  attribute vec3 aTint;

  varying vec2 vUv;
  varying vec3 vTint;

  void main() {
    vUv = aUvOffset + uv * aUvScale;
    vTint = aTint;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D map;

  varying vec2 vUv;
  varying vec3 vTint;

  void main() {
    vec4 texel = texture2D(map, vUv);
    if (texel.a < 0.01) discard;
    gl_FragColor = vec4(texel.rgb * vTint, texel.a);
  }
`;

export class SpriteBatch {
  /**
   * @param {THREE.Texture} texture
   * @param {number} capacity maximum simultaneous instances
   * @param {number} renderOrder paint order; depth testing is disabled so
   *   renderOrder alone decides what covers what
   */
  constructor(texture, capacity, renderOrder = 0) {
    this.capacity = capacity;
    this.count = 0;
    this._dummy = new THREE.Object3D();

    const geometry = new THREE.PlaneGeometry(1, 1);

    this.uvOffset = new Float32Array(capacity * 2);
    this.uvScale = new Float32Array(capacity * 2);
    this.tint = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i += 1) {
      this.tint[i * 3] = 1;
      this.tint[i * 3 + 1] = 1;
      this.tint[i * 3 + 2] = 1;
    }

    geometry.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(this.uvOffset, 2));
    geometry.setAttribute('aUvScale', new THREE.InstancedBufferAttribute(this.uvScale, 2));
    geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.tint, 3));

    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.count = 0;
    this.mesh.visible = false;

    // InstancedMesh zero-fills instanceMatrix, and a zero matrix is degenerate:
    // it collapses every quad to a single point, so the draw call is issued and
    // rasterises precisely nothing. Seeding identity and marking the buffer
    // dynamic means a stale or never-issued upload can never silently erase
    // every instance again.
    const identity = new THREE.Matrix4();
    for (let i = 0; i < capacity; i += 1) this.mesh.setMatrixAt(i, identity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  begin() {
    this.count = 0;
  }

  /**
   * Queue one sprite.
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} angle radians, counter-clockwise in world space
   * @param {number} scale world units (1 = one tile)
   * @param {{u:number,v:number,du:number,dv:number}} uv
   * @param {number[]} tint linear rgb multiplier
   * @param {number|null} scaleY vertical scale when it must differ from `scale`
   *   (health bars are wide and thin); null means uniform.
   */
  push(x, y, angle, scale, uv, tint = WHITE, scaleY = null) {
    if (this.count >= this.capacity) return;

    const i = this.count;
    const dummy = this._dummy;
    dummy.position.set(x, y, 0);
    dummy.rotation.z = angle;
    dummy.scale.set(scale, scaleY === null ? scale : scaleY, 1);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(i, dummy.matrix);

    const o = i * 2;
    this.uvOffset[o] = uv.u;
    this.uvOffset[o + 1] = uv.v;
    this.uvScale[o] = uv.du;
    this.uvScale[o + 1] = uv.dv;

    const t = i * 3;
    this.tint[t] = tint[0];
    this.tint[t + 1] = tint[1];
    this.tint[t + 2] = tint[2];

    this.count = i + 1;
  }

  end() {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;

    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.geometry.attributes.aUvOffset.needsUpdate = true;
      this.mesh.geometry.attributes.aUvScale.needsUpdate = true;
      this.mesh.geometry.attributes.aTint.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Dynamic line segments, used for hitscan beams and tesla chains.
 *
 * NOTE: currently unused. It was replaced by stretched quads in the renderer
 * because `LineBasicMaterial.linewidth` is ignored by WebGL -- every line is
 * exactly one pixel wide whatever you ask for, which made the sniper's tracer
 * and the tesla's arcs effectively invisible on a busy board. Kept because it
 * is a correct, self-contained primitive and re-deriving it would be a waste.
 */
export class LineBatch {
  constructor(capacitySegments, renderOrder = 0) {
    this.capacity = capacitySegments;

    const positions = new Float32Array(capacitySegments * 2 * 3);
    const colors = new Float32Array(capacitySegments * 2 * 3);

    this.geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(positions, 3);
    this.colors = new THREE.BufferAttribute(colors, 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('color', this.colors);

    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.mesh = new THREE.LineSegments(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.count = 0;
    this._color = new THREE.Color();
  }

  begin() {
    this.count = 0;
  }

  /** @param {number} alpha 0..1 fade */
  segment(x0, y0, x1, y1, color, alpha = 1) {
    if (this.count >= this.capacity) return;
    const i = this.count * 6;
    const p = this.positions.array;
    p[i] = x0;
    p[i + 1] = y0;
    p[i + 2] = 0;
    p[i + 3] = x1;
    p[i + 4] = y1;
    p[i + 5] = 0;

    this._color.set(color);
    const c = this.colors.array;
    const r = this._color.r * alpha;
    const g = this._color.g * alpha;
    const b = this._color.b * alpha;
    c[i] = r;
    c[i + 1] = g;
    c[i + 2] = b;
    c[i + 3] = r;
    c[i + 4] = g;
    c[i + 5] = b;

    this.count += 1;
  }

  end() {
    this.geometry.setDrawRange(0, this.count * 2);
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.positions.needsUpdate = true;
      this.colors.needsUpdate = true;
    }
  }
}

/**
 * A fixed-size pool of short-lived decorative sprites.
 *
 * Deliberately separate from the simulation's effect list. `world.fx` is a
 * *gameplay* budget: it is small, and when it saturates the oldest entry is
 * dropped. Letting smoke share it would mean a busy wave fills the buffer with
 * atmosphere and quietly evicts the explosion that killed the enemy. Particles
 * live here instead, where filling the pool costs nothing but atmosphere --
 * which is a self-correcting failure rather than a misleading one.
 *
 * Records are recycled, never allocated: the pool is written once at startup
 * and every emit overwrites a record in a ring. A wave's worth of smoke
 * therefore produces no garbage for the collector to sweep mid-frame.
 *
 * Positions are in **tile space** (y-down), matching the simulation, and are
 * converted to world space only at draw time. So "up the screen" is negative y,
 * which is what the emission sites assume.
 */

import { SpriteBatch } from './batch.js';
import { Stage } from './stage.js';

/** One particle. Mutable and reused; never handed out to callers. */
class Particle {
  constructor() {
    this.alive = false;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.age = 0;
    this.life = 1;
    this.size0 = 1;
    this.size1 = 1;
    this.angle = 0;
    this.spin = 0;
    this.drag = 0;
    this.sprite = 'smoke';
    this.tint = null;
  }
}

export class ParticleSystem {
  /**
   * @param {THREE.Texture} texture the `fx` sheet, shared with the effect batches
   * @param {number} capacity pool size; emitting past it recycles the oldest
   * @param {number} layer `LAYER.*` render order for this system's batch
   */
  constructor(texture, capacity, layer) {
    this.capacity = capacity;
    this.pool = new Array(capacity);
    for (let i = 0; i < capacity; i += 1) this.pool[i] = new Particle();
    this._next = 0;
    /** Live count from the last update, for diagnostics. */
    this.live = 0;
    this.batch = new SpriteBatch(texture, capacity, layer);
  }

  /**
   * Spawn one particle.
   *
   * @param {{x:number, y:number, vx?:number, vy?:number, life?:number,
   *          size0?:number, size1?:number, sprite?:string, angle?:number,
   *          spin?:number, drag?:number, tint?:number[]|null}} opts
   */
  emit(opts) {
    const p = this.pool[this._next];
    this._next = (this._next + 1) % this.capacity;

    p.alive = true;
    p.x = opts.x;
    p.y = opts.y;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.age = 0;
    p.life = Math.max(0.016, opts.life ?? 0.6);
    p.size0 = opts.size0 ?? 0.3;
    p.size1 = opts.size1 ?? p.size0;
    p.angle = opts.angle ?? 0;
    p.spin = opts.spin ?? 0;
    p.drag = opts.drag ?? 0;
    p.sprite = opts.sprite ?? 'smoke';
    p.tint = opts.tint ?? null;
    return p;
  }

  /** Advance every live particle. `dt` is simulation time, so pause freezes. */
  update(dt) {
    if (dt <= 0) return;
    let live = 0;

    for (let i = 0; i < this.capacity; i += 1) {
      const p = this.pool[i];
      if (!p.alive) continue;

      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }

      if (p.drag > 0) {
        const damp = Math.max(0, 1 - p.drag * dt);
        p.vx *= damp;
        p.vy *= damp;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      live += 1;
    }

    this.live = live;
  }

  /**
   * Push every live particle into the batch.
   *
   * The frame comes from *normalised age*, not from elapsed time, so a puff
   * always plays its whole cycle whatever lifetime it was given -- a 0.4s wisp
   * and a 2s plume both start at the compact first frame and end dispersed.
   * Fading is free: the sprite sheets are drawn with alpha ramping down across
   * their frames, so the animation itself is the fade.
   *
   * Particle angles are stored in tile space like positions, so both flips --
   * y and the angle sense -- happen here and nowhere else.
   */
  sync(atlas) {
    const batch = this.batch;
    batch.begin();

    if (this.live > 0) {
      for (let i = 0; i < this.capacity; i += 1) {
        const p = this.pool[i];
        if (!p.alive) continue;

        const sprite = atlas.spriteDef('fx', p.sprite);
        if (!sprite) continue;

        const t = p.age / p.life;
        const frames = sprite.frames ?? 1;
        const frame = Math.min(frames - 1, Math.floor(t * frames));
        const uv = atlas.frame('fx', p.sprite, frame);
        if (!uv) continue;

        const [wx, wy] = Stage.worldFromTile(p.x, p.y);
        const size = p.size0 + (p.size1 - p.size0) * t;
        batch.push(wx, wy, -p.angle, size, uv, p.tint ?? undefined);
      }
    }

    batch.end();
  }

  /** Drop everything without touching the pool's allocation. */
  clear() {
    for (let i = 0; i < this.capacity; i += 1) this.pool[i].alive = false;
    this.live = 0;
  }

  dispose() {
    this.batch.dispose();
  }
}

/**
 * Floating damage numbers, level-ups and coin refunds.
 *
 * These come from `Fx.text` in the simulation. They are drawn with pooled DOM
 * nodes rather than in-world geometry: three.js has no text primitive, and a
 * DOM node is crunched by the browser's own text renderer, which is both
 * cheaper and far crisper than rasterising glyphs into a texture.
 *
 * The pool is fixed, so a burst of damage numbers can never allocate.
 */

const POOL_SIZE = 64;

export class FloatingText {
  constructor(container, stage) {
    this.stage = stage;
    this.pool = [];

    for (let i = 0; i < POOL_SIZE; i += 1) {
      const node = document.createElement('div');
      node.className = 'float-text';
      node.style.display = 'none';
      container.appendChild(node);
      this.pool.push({ node, active: false, x: 0, y: 0, t: 0, duration: 1 });
    }
    this.next = 0;
  }

  /** Emit one popup at a tile-space position. */
  emit(text, tileX, tileY, color, duration) {
    // Round-robin: the oldest popup is reused when the pool is exhausted.
    const slot = this.pool[this.next];
    this.next = (this.next + 1) % POOL_SIZE;

    slot.active = true;
    slot.x = tileX;
    slot.y = tileY;
    slot.t = 0;
    slot.duration = duration;
    slot.node.textContent = text;
    slot.node.style.color = color;
    slot.node.style.display = 'block';
  }

  /** Advance and reposition. Called once per rendered frame with real dt. */
  update(dt) {
    // Text scales with the viewport so it stays legible when the board is small.
    const scale = Math.max(0.75, Math.min(1.6, this.stage.viewportWidth / 1280));

    for (let i = 0; i < this.pool.length; i += 1) {
      const slot = this.pool[i];
      if (!slot.active) continue;

      slot.t += dt;
      const progress = slot.duration > 0 ? slot.t / slot.duration : 1;
      if (progress >= 1) {
        slot.active = false;
        slot.node.style.display = 'none';
        continue;
      }

      // Tile space is y-down; screenFromWorld takes y-up world space.
      const [sx, sy] = this.stage.screenFromWorld(slot.x, -slot.y);
      const rise = progress * 26 * scale;
      const fade = progress < 0.65 ? 1 : 1 - (progress - 0.65) / 0.35;

      const node = slot.node;
      node.style.transform =
        `translate(-50%, -50%) translate(${sx.toFixed(1)}px, ${(sy - rise).toFixed(1)}px)`;
      node.style.opacity = String(fade);
      node.style.fontSize = `${(13 * scale).toFixed(1)}px`;
    }
  }

  clear() {
    for (const slot of this.pool) {
      slot.active = false;
      slot.node.style.display = 'none';
    }
  }
}

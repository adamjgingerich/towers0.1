/**
 * Seeded PRNG.
 *
 * `Math.random()` cannot be seeded, and reproducible waves are the entire
 * reason the balance sweep is worth running -- so the sim carries its own
 * generator instead of reaching for the global one. Same discipline as the
 * Qt-free split: the simulation owns its own determinism.
 *
 * mulberry32: 32-bit state, good statistical quality, cheap enough to call
 * per-frame.
 */

export function mulberry32(seed) {
  // Thin wrapper so callers that just want a bare function can still get one,
  // while Rng remains the single implementation of the algorithm.
  const rng = new Rng(seed);
  return () => rng.next();
}

export class Rng {
  constructor(seed = 12345) {
    this._state = seed >>> 0;
  }

  /**
   * One mulberry32 step.
   *
   * Spelled out here rather than delegating to a closure so the generator's
   * whole state is a readable field -- see `state` below.
   */
  next() {
    const a = (this._state + 0x6d2b79f5) | 0;
    this._state = a;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * The whole generator state: mulberry32 is a single 32-bit counter.
   *
   * Save games carry this so a loaded run continues the *same* stream. Without
   * it, every wave after a load would re-roll its composition and difficulty.
   */
  get state() {
    return this._state;
  }

  set state(value) {
    this._state = (value ?? 0) >>> 0;
  }

  /** Inclusive on both ends, matching Python's `random.Random.randint`. */
  randint(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  choice(keys) {
    return keys[Math.floor(this.next() * keys.length)];
  }

  /** Weighted pick, matching `random.choices(keys, weights, k=1)[0]`. */
  weighted(keys, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i += 1) total += weights[i];
    if (total <= 0) return keys[0];

    let roll = this.next() * total;
    for (let i = 0; i < keys.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return keys[i];
    }
    return keys[keys.length - 1];
  }
}

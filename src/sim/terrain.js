/**
 * Terrain: a smooth height field over the map.
 *
 * Generated rather than authored, so every map gets its own mountain ranges for
 * free -- but seeded from the map text, so a level always looks and plays the
 * same on every reload and for every player.
 *
 * Value noise rather than white noise. White noise would give a checkerboard of
 * isolated bumps, which reads as static rather than as ground; interpolating
 * between the corners of a coarse lattice is what makes neighbouring tiles agree
 * with each other and produces ridges and valleys.
 *
 * Lives in src/sim because enemies and towers both read it. It touches no DOM.
 */

import { mulberry32 } from './rng.js';

/** FNV-1a, so the same map text always seeds the same terrain. */
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function smoothstep(t) {
  return t * t * (3.0 - 2.0 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** One random lattice per octave, each twice as fine as the last. */
function buildLattices(width, height, { resolution, octaves, persistence }, rand) {
  const lattices = [];
  let cells = Math.max(2, Math.round(resolution));
  let amplitude = 1.0;
  let total = 0.0;

  for (let octave = 0; octave < Math.max(1, octaves); octave += 1) {
    const cols = cells + 1;
    // Keep the lattice roughly square in tile space, or the ridges stretch.
    const rows = Math.max(2, Math.round((cells * height) / width)) + 1;
    const values = new Float32Array(cols * rows);
    for (let i = 0; i < values.length; i += 1) values[i] = rand();

    lattices.push({ cols, rows, values, amplitude });
    total += amplitude;
    amplitude *= persistence;
    cells *= 2;
  }

  return { lattices, total };
}

function sampleLattice(lattice, u, v) {
  const { cols, rows, values } = lattice;
  const fx = clamp(u, 0, 1) * (cols - 1);
  const fy = clamp(v, 0, 1) * (rows - 1);

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);

  const tx = smoothstep(fx - x0);
  const ty = smoothstep(fy - y0);

  const a = values[y0 * cols + x0];
  const b = values[y0 * cols + x1];
  const c = values[y1 * cols + x0];
  const d = values[y1 * cols + x1];

  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/** Index of the last band whose `min` the height reaches. */
function bandIndexFor(height, bands) {
  let index = 0;
  for (let i = 0; i < bands.length; i += 1) {
    if (height >= bands[i].min) index = i;
    else break;
  }
  return index;
}

export class Terrain {
  /**
   * @param {number} width tiles across
   * @param {number} height tiles down
   * @param {object} config parsed data/terrain.json
   * @param {string} mapText the map itself, used as the seed
   */
  constructor(width, height, config, mapText) {
    this.width = width;
    this.height = height;
    this.bands = config.bands;

    const rand = mulberry32(hashText(mapText));
    const { lattices, total } = buildLattices(width, height, config, rand);

    const heights = new Float32Array(width * height);
    let min = Infinity;
    let max = -Infinity;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0.0;
        for (const lattice of lattices) {
          sum += lattice.amplitude * sampleLattice(lattice, x / Math.max(1, width - 1), y / Math.max(1, height - 1));
        }
        const value = sum / total;
        heights[y * width + x] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }

    // Normalise to 0..1 so every map spans the full band range whatever the
    // noise produced. Without this a map could come out all-valley, and the
    // bands would mean something different on each level.
    const span = max - min;
    if (span > 1e-6) {
      for (let i = 0; i < heights.length; i += 1) heights[i] = (heights[i] - min) / span;
    } else {
      heights.fill(0.5);
    }

    this.heights = heights;

    this.bandIndices = new Uint8Array(width * height);
    for (let i = 0; i < heights.length; i += 1) {
      this.bandIndices[i] = bandIndexFor(heights[i], this.bands);
    }
  }

  /** Height in 0..1. Out-of-bounds reads clamp to the edge. */
  heightAt(tx, ty) {
    const x = clamp(Math.floor(tx), 0, this.width - 1);
    const y = clamp(Math.floor(ty), 0, this.height - 1);
    return this.heights[y * this.width + x];
  }

  /** Ground band covering a tile. */
  bandAt(tx, ty) {
    const x = clamp(Math.floor(tx), 0, this.width - 1);
    const y = clamp(Math.floor(ty), 0, this.height - 1);
    return this.bands[this.bandIndices[y * this.width + x]];
  }

  /** Ground band under a point in tile space -- enemies sit at fractional x/y. */
  bandAtPoint(x, y) {
    return this.bandAt(x, y);
  }

  /** How much of each band a map has, for balance checks. */
  bandShares() {
    const counts = new Array(this.bands.length).fill(0);
    for (let i = 0; i < this.bandIndices.length; i += 1) counts[this.bandIndices[i]] += 1;
    const total = this.bandIndices.length;
    return this.bands.map((band, i) => ({
      name: band.name,
      share: +(counts[i] / total).toFixed(3),
    }));
  }

  /**
   * Brightness multiplier for the tile layer.
   *
   * Height alone would be a flat wash, so the slope is lit from the upper left:
   * faces angled toward the light come out brighter than those turned away,
   * which is what reads as relief rather than as noise.
   */
  shadeAt(tx, ty) {
    const h = this.heightAt(tx, ty);
    const dx = this.heightAt(tx + 1, ty) - this.heightAt(tx - 1, ty);
    const dy = this.heightAt(tx, ty + 1) - this.heightAt(tx, ty - 1);
    const slope = (-dx - dy) * 0.5;
    return clamp(0.74 + h * 0.42 + slope * 1.5, 0.6, 1.4);
  }
}

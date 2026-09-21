/**
 * Regenerate all level maps and write them to data/maps/.
 *
 * Each map is described as a road (segments) plus a blocking rule, so the
 * layouts are code rather than hand-typed ASCII. Validated here: every row is
 * the same width, the lane is connected, and the lane length / buildable count
 * are printed for a balance sanity check.
 *
 *   node tools/makemaps.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Grid } from '../src/sim/grid.js';
import { buildPaths } from '../src/sim/pathfinding.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const W = 40;
const H = 24;

const blank = () => Array.from({ length: H }, () => Array(W).fill('.'));

function build(spec) {
  const g = blank();
  for (const seg of spec.segs) {
    if (seg.t === 'r') {
      for (let x = Math.min(seg.a, seg.b); x <= Math.max(seg.a, seg.b); x += 1) g[seg.y][x] = '#';
    } else {
      for (let y = Math.min(seg.a, seg.b); y <= Math.max(seg.a, seg.b); y += 1) g[y][seg.x] = '#';
    }
  }
  g[spec.spawn[1]][spec.spawn[0]] = 'S';
  g[spec.base[1]][spec.base[0]] = 'E';

  const isRoad = (x, y) => g[y] && (g[y][x] === '#' || g[y][x] === 'S' || g[y][x] === 'E');

  if (spec.mode === 'corridor') {
    const m = spec.margin;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (isRoad(x, y)) continue;
        let near = false;
        for (let dy = -m; dy <= m && !near; dy += 1) {
          for (let dx = -m; dx <= m && !near; dx += 1) {
            if (isRoad(x + dx, y + dy)) near = true;
          }
        }
        if (!near) g[y][x] = 'X';
      }
    }
  } else if (spec.mode === 'terrace') {
    for (const wall of spec.walls) {
      for (let y = wall.y0; y <= wall.y1; y += 1) {
        if (!g[y]) continue;
        for (let x = 0; x < W; x += 1) {
          if (isRoad(x, y)) continue;
          if (wall.open && wall.open.includes(x)) continue;
          g[y][x] = 'X';
        }
      }
    }
  }

  if (spec.frame) {
    for (let x = 0; x < W; x += 1) {
      if (g[0][x] === '.') g[0][x] = 'X';
      if (g[H - 1][x] === '.') g[H - 1][x] = 'X';
    }
  }

  // Bonus tiles: buildable spots far from the lane, spread apart.
  const dist = (x, y) => {
    let best = 99;
    for (let yy = 0; yy < H; yy += 1) {
      for (let xx = 0; xx < W; xx += 1) {
        if (isRoad(xx, yy)) best = Math.min(best, Math.abs(xx - x) + Math.abs(yy - y));
      }
    }
    return best;
  };
  const cands = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (g[y][x] === '.') cands.push({ x, y, d: dist(x, y) });
    }
  }
  cands.sort((a, b) => b.d - a.d);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= (spec.bonus ?? 4)) break;
    if (chosen.some((k) => Math.abs(k.x - c.x) + Math.abs(k.y - c.y) < 9)) continue;
    chosen.push(c);
    g[c.y][c.x] = '*';
  }
  return g.map((r) => r.join('')).join('\n') + '\n';
}

const SPECS = {
  // Open switchbacks: tutorial map, almost nothing blocked.
  level_01: {
    mode: 'open', frame: false, bonus: 4, spawn: [0, 2], base: [38, 22],
    segs: [
      { t: 'r', y: 2, a: 0, b: 32 }, { t: 'c', x: 32, a: 2, b: 7 },
      { t: 'r', y: 7, a: 6, b: 32 }, { t: 'c', x: 6, a: 7, b: 12 },
      { t: 'r', y: 12, a: 6, b: 32 }, { t: 'c', x: 32, a: 12, b: 17 },
      { t: 'r', y: 17, a: 6, b: 32 }, { t: 'c', x: 6, a: 17, b: 22 },
      { t: 'r', y: 22, a: 6, b: 37 },
    ],
  },
  // Comb: a serpentine whose teeth are separated by fins.
  level_02: {
    mode: 'terrace', frame: true, bonus: 4, spawn: [0, 2], base: [36, 20],
    segs: [
      { t: 'r', y: 2, a: 0, b: 30 }, { t: 'c', x: 30, a: 2, b: 5 },
      { t: 'r', y: 5, a: 10, b: 30 }, { t: 'c', x: 10, a: 5, b: 8 },
      { t: 'r', y: 8, a: 10, b: 30 }, { t: 'c', x: 30, a: 8, b: 11 },
      { t: 'r', y: 11, a: 10, b: 30 }, { t: 'c', x: 10, a: 11, b: 14 },
      { t: 'r', y: 14, a: 10, b: 30 }, { t: 'c', x: 30, a: 14, b: 17 },
      { t: 'r', y: 17, a: 10, b: 30 }, { t: 'c', x: 10, a: 17, b: 20 },
      { t: 'r', y: 20, a: 10, b: 35 },
    ],
    walls: [
      { y0: 3, y1: 4, open: [30] }, { y0: 6, y1: 7, open: [10] },
      { y0: 9, y1: 10, open: [30] }, { y0: 12, y1: 13, open: [10] },
      { y0: 15, y1: 16, open: [30] }, { y0: 18, y1: 19, open: [10] },
    ],
  },
  // A double Z across the whole height: long enough to play.
  level_03: {
    mode: 'corridor', margin: 2, frame: true, bonus: 4, spawn: [2, 1], base: [2, 22],
    segs: [
      { t: 'r', y: 1, a: 2, b: 36 }, { t: 'c', x: 36, a: 1, b: 8 },
      { t: 'r', y: 8, a: 4, b: 36 }, { t: 'c', x: 4, a: 8, b: 15 },
      { t: 'r', y: 15, a: 4, b: 36 }, { t: 'c', x: 36, a: 15, b: 22 },
      { t: 'r', y: 22, a: 2, b: 36 },
    ],
  },
  // Inward spiral to a central base.
  level_04: {
    mode: 'corridor', margin: 2, frame: true, bonus: 4, spawn: [2, 2], base: [13, 16],
    segs: [
      { t: 'r', y: 2, a: 2, b: 36 }, { t: 'c', x: 36, a: 2, b: 20 },
      { t: 'r', y: 20, a: 2, b: 36 }, { t: 'c', x: 2, a: 8, b: 20 },
      { t: 'r', y: 8, a: 2, b: 32 }, { t: 'c', x: 32, a: 8, b: 16 },
      { t: 'r', y: 16, a: 14, b: 32 },
    ],
  },
  // Staggered canyon arms.
  level_05: {
    mode: 'corridor', margin: 1, frame: true, bonus: 4, spawn: [2, 2], base: [37, 20],
    segs: [
      { t: 'r', y: 2, a: 2, b: 36 }, { t: 'c', x: 36, a: 2, b: 6 },
      { t: 'r', y: 6, a: 8, b: 36 }, { t: 'c', x: 8, a: 6, b: 11 },
      { t: 'r', y: 11, a: 8, b: 33 }, { t: 'c', x: 33, a: 11, b: 15 },
      { t: 'r', y: 15, a: 6, b: 33 }, { t: 'c', x: 6, a: 15, b: 20 },
      { t: 'r', y: 20, a: 6, b: 36 },
    ],
  },
  // Accordion folds, lengthened so the map is playable.
  level_06: {
    mode: 'corridor', margin: 2, frame: true, bonus: 4, spawn: [3, 2], base: [38, 4],
    segs: [
      { t: 'c', x: 3, a: 2, b: 22 }, { t: 'r', y: 22, a: 3, b: 9 },
      { t: 'c', x: 9, a: 4, b: 22 }, { t: 'r', y: 4, a: 9, b: 15 },
      { t: 'c', x: 15, a: 4, b: 22 }, { t: 'r', y: 22, a: 15, b: 21 },
      { t: 'c', x: 21, a: 4, b: 22 }, { t: 'r', y: 4, a: 21, b: 27 },
      { t: 'c', x: 27, a: 4, b: 22 }, { t: 'r', y: 22, a: 27, b: 33 },
      { t: 'c', x: 33, a: 4, b: 22 }, { t: 'r', y: 4, a: 33, b: 37 },
    ],
  },
  // Two inset rails crossed by regular rungs: a ladder with an open belly.
  level_07: {
    mode: 'corridor', margin: 1, frame: true, bonus: 4, spawn: [3, 2], base: [34, 22],
    segs: [
      { t: 'c', x: 3, a: 2, b: 4 }, { t: 'r', y: 4, a: 3, b: 34 },
      { t: 'c', x: 34, a: 4, b: 8 }, { t: 'r', y: 8, a: 3, b: 34 },
      { t: 'c', x: 3, a: 8, b: 12 }, { t: 'r', y: 12, a: 3, b: 34 },
      { t: 'c', x: 34, a: 12, b: 16 }, { t: 'r', y: 16, a: 3, b: 34 },
      { t: 'c', x: 3, a: 16, b: 20 }, { t: 'r', y: 20, a: 3, b: 34 },
      { t: 'c', x: 34, a: 20, b: 22 },
    ],
  },
  // A horseshoe hugging the edges, leaving a wide open field in the middle.
  level_08: {
    mode: 'corridor', margin: 2, frame: true, bonus: 4, spawn: [2, 1], base: [20, 4],
    segs: [
      { t: 'r', y: 1, a: 2, b: 38 }, { t: 'c', x: 38, a: 1, b: 21 },
      { t: 'r', y: 21, a: 2, b: 38 }, { t: 'c', x: 2, a: 21, b: 4 },
      { t: 'r', y: 4, a: 2, b: 20 },
    ],
  },
  // A labyrinth of terrace walls, each with two gaps.
  level_09: {
    mode: 'terrace', frame: true, bonus: 4, spawn: [2, 2], base: [36, 20],
    segs: [
      { t: 'r', y: 2, a: 2, b: 36 }, { t: 'c', x: 36, a: 2, b: 5 },
      { t: 'r', y: 5, a: 4, b: 36 }, { t: 'c', x: 4, a: 5, b: 8 },
      { t: 'r', y: 8, a: 4, b: 36 }, { t: 'c', x: 36, a: 8, b: 11 },
      { t: 'r', y: 11, a: 4, b: 36 }, { t: 'c', x: 4, a: 11, b: 14 },
      { t: 'r', y: 14, a: 4, b: 36 }, { t: 'c', x: 36, a: 14, b: 17 },
      { t: 'r', y: 17, a: 4, b: 36 }, { t: 'c', x: 4, a: 17, b: 20 },
      { t: 'r', y: 20, a: 4, b: 36 },
    ],
    walls: [
      { y0: 3, y1: 4, open: [8, 28] }, { y0: 6, y1: 7, open: [12, 32] },
      { y0: 9, y1: 10, open: [8, 28] }, { y0: 12, y1: 13, open: [12, 32] },
      { y0: 15, y1: 16, open: [8, 28] }, { y0: 18, y1: 19, open: [12, 32] },
    ],
  },
  // An outward spiral: spawn in the middle, unwinding to the top-right corner.
  level_10: {
    mode: 'corridor', margin: 1, frame: true, bonus: 4, spawn: [18, 12], base: [38, 2],
    segs: [
      { t: 'r', y: 12, a: 18, b: 23 }, { t: 'c', x: 23, a: 12, b: 15 },
      { t: 'r', y: 15, a: 16, b: 23 }, { t: 'c', x: 16, a: 15, b: 10 },
      { t: 'r', y: 10, a: 16, b: 24 }, { t: 'c', x: 24, a: 10, b: 16 },
      { t: 'r', y: 16, a: 14, b: 24 }, { t: 'c', x: 14, a: 16, b: 8 },
      { t: 'r', y: 8, a: 14, b: 26 }, { t: 'c', x: 26, a: 8, b: 18 },
      { t: 'r', y: 18, a: 12, b: 26 }, { t: 'c', x: 12, a: 18, b: 6 },
      { t: 'r', y: 6, a: 12, b: 28 }, { t: 'c', x: 28, a: 6, b: 20 },
      { t: 'r', y: 20, a: 10, b: 28 }, { t: 'c', x: 10, a: 20, b: 2 },
      { t: 'r', y: 2, a: 10, b: 38 },
    ],
  },
  // An hourglass serpentine: lanes pinch toward the middle, then flare again.
  level_11: {
    mode: 'corridor', margin: 1, frame: true, bonus: 4, spawn: [2, 2], base: [38, 22],
    segs: [
      { t: 'r', y: 2, a: 2, b: 38 }, { t: 'c', x: 38, a: 2, b: 6 },
      { t: 'r', y: 6, a: 6, b: 38 }, { t: 'c', x: 6, a: 6, b: 10 },
      { t: 'r', y: 10, a: 6, b: 34 }, { t: 'c', x: 34, a: 10, b: 14 },
      { t: 'r', y: 14, a: 6, b: 34 }, { t: 'c', x: 6, a: 14, b: 18 },
      { t: 'r', y: 18, a: 6, b: 30 }, { t: 'c', x: 30, a: 18, b: 20 },
      { t: 'r', y: 20, a: 6, b: 30 }, { t: 'c', x: 6, a: 20, b: 22 },
      { t: 'r', y: 22, a: 6, b: 38 },
    ],
  },
};

const report = [];
for (const [id, spec] of Object.entries(SPECS)) {
  const text = build(spec);
  const grid = Grid.fromText(text); // throws on width mismatch / bad glyph
  const paths = buildPaths(grid); // throws when the lane is disconnected
  let blocked = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) if (grid.at(x, y) === 'X') blocked += 1;
  }
  writeFileSync(join(ROOT, 'data', 'maps', `${id}.txt`), text);
  report.push({ id, lane: +paths.ground.length.toFixed(0), buildable: grid.buildable.size, bonus: grid.bonus.size, blocked });
}

// eslint-disable-next-line no-console
console.log(JSON.stringify(report, null, 1));

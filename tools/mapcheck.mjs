import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid } from '../src/sim/grid.js';
import { buildPaths } from '../src/sim/pathfinding.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ids = JSON.parse(readFileSync(join(ROOT, 'data', 'maps.json'), 'utf8')).levels.map((l) => l.id);
const out = [];
for (const id of ids) {
  try {
    const text = readFileSync(join(ROOT, 'data', 'maps', `${id}.txt`), 'utf8');
    const grid = Grid.fromText(text);
    const p = buildPaths(grid);
    out.push({ id, lane: +p.ground.length.toFixed(0), buildable: grid.buildable.size, ok: true });
  } catch (e) {
    out.push({ id, ok: false, error: String(e.message || e) });
  }
}
writeFileSync(join(ROOT, 'tools', 'mapcheck.json'), JSON.stringify(out, null, 1));

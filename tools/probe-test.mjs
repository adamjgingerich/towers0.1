import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/sim/config.js';
import { runProbe } from './balance_probe.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (n) => JSON.parse(readFileSync(join(ROOT, 'data', n), 'utf8'));

try {
  const config = buildConfig({
    enemies: read('enemies.json'),
    towers: read('towers.json'),
    damage: read('damage_matrix.json'),
    waves: read('waves.json'),
    atlas: read('atlas.json'),
    specialisations: read('specialisations.json'),
    terrain: read('terrain.json'),
    barracks: read('barracks.json'),
    weather: read('weather.json'),
    skills: read('skills.json'),
    map: readFileSync(join(ROOT, 'data', 'maps', 'level_01.txt'), 'utf8'),
    mapId: 'level_01',
  });
  const r = runProbe(config, { budget: 10, seed: 12345, maxWave: 70 });
  writeFileSync(join(ROOT, 'tools', 'probe-test.json'), JSON.stringify(r, null, 2));
  process.stdout.write('ok wave=' + r.wave + '\n');
} catch (e) {
  writeFileSync(join(ROOT, 'tools', 'probe-test.json'), 'ERROR ' + (e && e.stack ? e.stack : String(e)));
  process.stdout.write('error\n');
}

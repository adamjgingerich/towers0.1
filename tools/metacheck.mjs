/**
 * How much does the skill tree actually change the difficulty wall?
 *
 * Every other tool in here measures the curve with an EMPTY tree. That is a floor
 * no real player ever stands on: anyone with Cores banked plays a strictly easier
 * game than any number `sweep.mjs` produces, which makes those numbers a floor
 * rather than a forecast. This runs the same probe twice -- once bare, once with a
 * preset tree -- and reports the gap, so a tree buff or nerf can be read as "how
 * many waves did that buy" instead of being felt.
 *
 *   node tools/metacheck.mjs
 *   node tools/metacheck.mjs --budgets 10,16,26 --maps level_01,level_03
 *   node tools/metacheck.mjs --presets none,rank1,maxed
 *
 * Writes tools/metacheck.json.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig } from '../src/sim/config.js';
import { buildSkills, resolveMeta } from '../src/sim/skills.js';
import { runProbe } from './balance_probe.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tools', 'metacheck.json');
const SKILLS_RAW = JSON.parse(readFileSync(join(ROOT, 'data', 'skills.json'), 'utf8'));

function read(name) {
  return JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
}

function loadConfig(mapName) {
  const levels = read('maps.json');
  const entry = (levels.levels ?? []).find((l) => l.id === mapName) ?? null;
  return buildConfig({
    enemies: read('enemies.json'),
    towers: read('towers.json'),
    damage: read('damage_matrix.json'),
    waves: read('waves.json'),
    atlas: read('atlas.json'),
    specialisations: read('specialisations.json'),
    terrain: read('terrain.json'),
    barracks: read('barracks.json'),
    weather: read('weather.json'),
    skills: SKILLS_RAW,
    map: readFileSync(join(ROOT, 'data', 'maps', `${mapName}.txt`), 'utf8'),
    mapId: mapName,
    mapTint: entry?.tint ?? null,
    mapZoom: entry?.zoom ?? 1.0,
  });
}

/**
 * Build the bag a preset stands for.
 *
 * `resolveMeta` wants the RAW skills.json rather than the built tree, because it
 * has to agree with whatever the simulation was configured with.
 */
function metaPreset(name) {
  if (!name || name === 'none') return null;
  const tree = buildSkills(SKILLS_RAW);
  const ranks = {};
  for (const node of tree.nodes) {
    if (name === 'maxed') ranks[node.id] = node.maxRank;
    else if (name === 'rank1') ranks[node.id] = 1;
  }
  return resolveMeta(SKILLS_RAW, ranks);
}

function parseArgs(argv) {
  const args = {
    maps: read('maps.json').levels.map((l) => l.id),
    budgets: [10, 16, 26],
    presets: ['none', 'maxed'],
    seed: 12345,
    maxWave: 70,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--maps') args.maps = argv[++i].split(',');
    else if (a === '--budgets') args.budgets = argv[++i].split(',').map(Number);
    else if (a === '--presets') args.presets = argv[++i].split(',');
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--max-wave') args.maxWave = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const presets = args.presets.map((name) => ({ name, meta: metaPreset(name) }));

const configs = new Map();
for (const mapId of args.maps) {
  try {
    configs.set(mapId, loadConfig(mapId));
  } catch (e) {
    configs.set(mapId, { error: String(e.message || e) });
  }
}

const runs = [];
for (const mapId of args.maps) {
  const config = configs.get(mapId);
  if (config.error) {
    runs.push({ map: mapId, error: config.error });
    continue;
  }
  for (const budget of args.budgets) {
    const byPreset = {};
    for (const preset of presets) {
      try {
        const r = runProbe(config, { budget, seed: args.seed, maxWave: args.maxWave, meta: preset.meta });
        byPreset[preset.name] = {
          wave: r.wave, leaks: r.leaks, specs: r.specs,
          baseHpMax: r.baseHpMax, end: r.endReason,
        };
      } catch (e) {
        byPreset[preset.name] = { error: String(e.message || e) };
      }
    }
    const bare = byPreset[args.presets[0]];
    const forPreset = (p) => {
      const v = byPreset[p];
      return v && v.wave != null && bare && bare.wave != null
        ? {
            wave: v.wave,
            deltaWaves: v.wave - bare.wave,
            baseHpMax: v.baseHpMax,
          }
        : { error: v?.error ?? 'no result' };
    };
    runs.push({
      map: mapId,
      budget,
      bases: Math.max(1, Math.min(5, Math.ceil((budget - 10) / 8) + 1)),
      byPreset: Object.fromEntries(args.presets.map((p) => [p, forPreset(p)])),
    });
  }
}

/**
 * Summary across maps, per preset and budget.
 *
 * Reported as a median because a single map can disagree with the others for
 * builder reasons rather than curve reasons (see the cross-map caveat in
 * docs/DESIGN.md) -- an average would let one bad layout set the headline.
 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const summary = [];
for (const budget of args.budgets) {
  const rows = runs.filter((r) => r.budget === budget && !r.error);
  for (const preset of args.presets) {
    const waves = rows.map((r) => r.byPreset[preset]?.wave).filter((n) => n != null);
    const deltas = rows.map((r) => r.byPreset[preset]?.deltaWaves).filter((n) => n != null);
    summary.push({
      budget,
      bases: Math.max(1, Math.min(5, Math.ceil((budget - 10) / 8) + 1)),
      preset,
      maps: rows.length,
      medianWave: median(waves),
      medianDeltaWaves: median(deltas),
    });
  }
}

const out = {
  seed: args.seed,
  maxWave: args.maxWave,
  presets: args.presets,
  summary,
  runs,
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
process.stdout.write(`wrote ${runs.length} rows to ${OUT}\n`);

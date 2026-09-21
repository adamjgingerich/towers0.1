/**
 * Headless balance sweep over budgets (base counts) and maps.
 *
 * Same builder policy as tools/balance_probe.js (barracks, specialisations and
 * upgrades included), but run under Node with no browser, no DOM, no rendering.
 * The probe AI is the scripted "competent player"; budget N is a stand-in for
 * "how many towers the player can field", so sweeping budget answers "how many
 * bases does this curve actually demand".
 *
 *   node tools/sweep.mjs --map level_01 --budgets 10,18,26,34,50
 *   node tools/sweep.mjs --all --budgets 10,26 --seed 7
 *   node tools/sweep.mjs --all --budgets 16 --meta maxed
 *
 * `--meta` selects the skill tree the simulated player owns:
 *   none   (default) the bare curve -- what someone who bought nothing plays
 *   maxed  every node at maxRank -- the ceiling a finished tree reaches
 *   rank1  one rank of every node -- roughly an early-tree player
 *
 * Sweeps run with `none` by default, which makes them a *floor*, not a forecast.
 * A real player owns part of the tree and therefore does better than any number
 * produced without this flag. Compare `--meta none` against `--meta maxed` to
 * see how wide the tree makes that margin.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig } from '../src/sim/config.js';
import { buildSkills, resolveMeta } from '../src/sim/skills.js';
import { runProbe } from './balance_probe.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tools', 'sweep-out.json');

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
    skills: read('skills.json'),
    map: readFileSync(join(ROOT, 'data', 'maps', `${mapName}.txt`), 'utf8'),
    mapId: mapName,
    mapTint: entry?.tint ?? null,
    mapZoom: entry?.zoom ?? 1.0,
  });
}

function parseArgs(argv) {
  const args = { map: null, all: false, budgets: [10, 18, 26, 34, 50], seed: 12345, maxWave: 70, out: OUT, meta: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--map') args.map = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--budgets') args.budgets = argv[++i].split(',').map(Number);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--max-wave') args.maxWave = Number(argv[++i]);
    else if (a === '--meta') args.meta = argv[++i];
    else if (a === '--out') args.out = join(ROOT, 'tools', argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/**
 * Build the skill-tree bag a preset stands for.
 *
 * `resolveMeta` takes the RAW skills.json, not the built tree, because it needs
 * the same json the simulation was configured with.
 */
function metaPreset(name) {
  if (!name || name === 'none') return null;
  const raw = read('skills.json');
  const tree = buildSkills(raw);
  const ranks = {};
  for (const node of tree.nodes) {
    if (name === 'maxed') ranks[node.id] = node.maxRank;
    else if (name === 'rank1') ranks[node.id] = 1;
  }
  return resolveMeta(raw, ranks);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write('usage: node tools/sweep.mjs [--map id] [--all] [--budgets N,N] [--seed N] [--max-wave N] [--meta none|maxed|rank1] [--out file]\n');
  process.exit(0);
}

const maps = args.all
  ? read('maps.json').levels.map((l) => l.id)
  : [args.map ?? 'level_01'];

const meta = metaPreset(args.meta);
const metaLabel = meta ? (args.meta ?? 'none') : 'none';

const rows = [];
for (const mapId of maps) {
  let config;
  try {
    config = loadConfig(mapId);
  } catch (e) {
    rows.push({ map: mapId, error: String(e.message || e) });
    continue;
  }
  for (const budget of args.budgets) {
    const bases = Math.max(1, Math.min(5, Math.ceil((budget - 10) / 8) + 1));
    try {
      const r = runProbe(config, { budget, seed: args.seed, maxWave: args.maxWave, meta });
      rows.push({
        map: mapId, budget, bases, meta: metaLabel,
        wave: r.wave, end: r.endReason, kills: r.kills, specs: r.specs,
        maxLevel: r.maxLevel, leaks: r.leaks,
      });
    } catch (e) {
      rows.push({ map: mapId, budget, bases, meta: metaLabel, error: String(e.message || e) });
    }
  }
}

writeFileSync(args.out, JSON.stringify(rows, null, 2) + '\n');
process.stdout.write(`wrote ${rows.length} rows to ${args.out}\n`);

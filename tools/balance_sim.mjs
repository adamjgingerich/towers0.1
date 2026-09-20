/**
 * Headless balance sweep.
 *
 * Runs the simulation with a scripted "competent player" and prints a per-wave
 * table, so the difficulty curve can be tuned without playing the game. This is
 * the whole reason src/sim/ has no three.js and no DOM imports: the same
 * modules that run in the browser run here, under Node, with no browser and no
 * rendering.
 *
 *   node tools/balance_sim.mjs --waves 60
 *   node tools/balance_sim.mjs --waves 40 --seed 7 --trace
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig } from '../src/sim/config.js';
import { ROAD } from '../src/sim/grid.js';
import { World } from '../src/sim/world.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXED_DT = 1 / 60;

/**
 * A reasonable human build order. Cheap backbone early, utility once the
 * economy supports it, premium towers once waves start carrying armour.
 */
const BUILD_PRIORITY = [
  'basic', 'basic', 'basic', 'frost', 'basic', 'tesla', 'basic', 'cannon',
  'venom', 'tesla', 'basic', 'sniper', 'cannon', 'tesla', 'sniper', 'venom',
];

/** Coins above which the AI prefers upgrading an existing tower. */
const UPGRADE_RESERVE = 260;

/** Half-width of the window scanned when ranking a build spot, in tiles. */
const COVERAGE_RADIUS = 3;

function loadConfig() {
  const read = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
  return buildConfig({
    enemies: read('enemies.json'),
    towers: read('towers.json'),
    damage: read('damage_matrix.json'),
    waves: read('waves.json'),
    atlas: read('atlas.json'),
    map: readFileSync(join(ROOT, 'data', 'maps', 'level_01.txt'), 'utf8'),
  });
}

/**
 * Count road tiles within COVERAGE_RADIUS of a build spot.
 *
 * Scans a small window rather than the whole road network. Ranking every
 * candidate by scanning every road tile, every frame of prep, is enough to make
 * a short run take minutes instead of seconds.
 */
function coverage(grid, tx, ty) {
  let score = 0;
  for (let dy = -COVERAGE_RADIUS; dy <= COVERAGE_RADIUS; dy += 1) {
    for (let dx = -COVERAGE_RADIUS; dx <= COVERAGE_RADIUS; dx += 1) {
      if (grid.at(tx + dx, ty + dy) === ROAD) score += 1;
    }
  }
  return score;
}

function buildSpotRanking(world) {
  const spots = [];
  for (const key of world.grid.buildable) {
    const [tx, ty] = key.split(',').map(Number);
    if (!world.towers.has(key)) spots.push([tx, ty, coverage(world.grid, tx, ty)]);
  }
  spots.sort((a, b) => b[2] - a[2] || a[1] - b[1] || a[0] - b[0]);
  return spots;
}

/** Scripted stand-in for a competent player. */
class GreedyAI {
  constructor(world) {
    this.world = world;
    this.buildIndex = 0;
    this._ranking = [];
    this._rankedFor = -1;
  }

  /** Cached; recomputed only when the tower count changes. */
  ranking() {
    const occupied = this.world.towers.size;
    if (occupied !== this._rankedFor) {
      this._ranking = buildSpotRanking(this.world);
      this._rankedFor = occupied;
    }
    return this._ranking;
  }

  _upgradeBest() {
    const world = this.world;
    const candidates = [...world.towers.values()].filter((t) => t.alive);
    candidates.sort((a, b) => b.damageDealt - a.damageDealt || b.level - a.level);

    for (const tower of candidates) {
      const cost = tower.upgradeCost(world.leveling);
      if (cost === null || !world.economy.canAfford(cost)) continue;
      // Never spend down to nothing: keep a reserve for the next build.
      if (world.economy.coins - cost < UPGRADE_RESERVE * 0.25) continue;
      if (world.upgradeTower(tower)[0]) return true;
    }
    return false;
  }

  spend() {
    const world = this.world;

    while (this.buildIndex < BUILD_PRIORITY.length) {
      const key = BUILD_PRIORITY[this.buildIndex];
      if (!world.economy.canAfford(world.config.towers[key].cost)) break;

      let placed = false;
      for (const [tx, ty] of this.ranking()) {
        if (world.placeTower(key, tx, ty)[0]) {
          placed = true;
          this.buildIndex += 1;
          break;
        }
      }
      if (!placed) break;
    }

    while (world.economy.coins >= UPGRADE_RESERVE && this._upgradeBest()) {
      // keep upgrading while it is sensible
    }
  }
}

function parseArgs(argv) {
  const args = { waves: 60, seed: 12345, trace: false, dt: FIXED_DT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--waves') args.waves = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--trace') args.trace = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function pad(value, width, decimals = 0) {
  const text = Number(value).toFixed(decimals);
  return text.padStart(width);
}

function run({ waves, seed, trace }) {
  const config = loadConfig();
  const world = new World(config, config.waves.map, { seed });
  const ai = new GreedyAI(world);

  const header =
    `${'wave'.padStart(4)} ${'spawn'.padStart(6)} ${'alive'.padStart(6)} ` +
    `${'hp_mult'.padStart(10)} ${'coins'.padStart(9)} ${'towers'.padStart(7)} ` +
    `${'base'.padStart(5)} ${'dps'.padStart(8)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  let reportedWave = 0;
  let peakEnemies = 0;
  let steps = 0;
  let lastTime = 0;
  const started = performance.now();

  while (world.wave <= waves && !world.gameOver) {
    if (world.prepared) {
      ai.spend();

      const upcoming = world.waves.wave + 1;
      if (upcoming !== reportedWave) {
        reportedWave = upcoming;
        console.log(
          `${pad(upcoming, 4)} ${pad(0, 6)} ${pad(world.enemies.length, 6)} ` +
            `${pad(world.waves.hpMult(upcoming), 10, 1)} ${pad(world.economy.coins, 9)} ` +
            `${pad(world.towers.size, 7)} ${pad(Math.max(0, world.economy.baseHp), 5)} ` +
            `${pad(world.totalDps(), 8)}`,
        );
        if (trace) {
          const preview = world.nextWavePreview();
          const summary = Object.entries(preview.counts)
            .sort()
            .map(([key, count]) => `${key}x${count}`)
            .join(', ');
          const flag = preview.is_boss ? ' BOSS' : preview.is_mini_boss ? ' mini' : '';
          console.log(`       compose: ${summary}${flag}`);
        }
      }
    }

    world.update(FIXED_DT);
    steps += 1;
    if (world.enemies.length > peakEnemies) peakEnemies = world.enemies.length;

    lastTime = world.time;
  }

  const elapsed = (performance.now() - started) / 1000;
  const stats = world.summary();

  console.log();
  console.log(`simulated ${lastTime.toFixed(0)}s of game time in ${elapsed.toFixed(1)}s wall clock`);
  console.log(`steps: ${steps}   peak concurrent enemies: ${peakEnemies}`);
  console.log(`reached wave: ${world.wave}   base hp: ${stats.base_hp.toFixed(0)}`);
  console.log(`kills: ${stats.kills}   leaked: ${stats.leaked}`);
  console.log(
    `towers built: ${stats.towers_built}   sold: ${stats.towers_sold}   ` +
      `earned: ${world.economy.earned.toFixed(0)}   spent: ${world.economy.spent.toFixed(0)}`,
  );
  if (world.gameOver) {
    console.log('RESULT: base destroyed (curve too steep for this build policy)');
  } else {
    console.log(`RESULT: survived ${waves} waves`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: node tools/balance_sim.mjs [--waves N] [--seed N] [--trace]');
  process.exit(0);
}
run(args);

/**
 * Headless balance probe.
 *
 * Runs the simulation with a scripted "competent player" so the difficulty curve
 * can be measured without playing. This is the payoff for keeping `src/sim/`
 * free of three.js and DOM imports: the same modules that run in the browser run
 * here with no renderer at all.
 *
 * This is the browser-runnable counterpart to `balance_sim.mjs`. That one needs
 * Node and prints a per-wave trace; this one returns plain objects so a sweep can
 * be tabulated. It exists because this project's machine has no Node, and a
 * balance tool that cannot run is a balance tool that does not exist.
 *
 * ## What the numbers mean, and what they do not
 *
 * The probe measures **whether a given amount of investment survives the curve**.
 * A budget of N towers is a stand-in for "how well the player is doing", not a
 * prediction of any particular run: real players sell, reposition and mis-time.
 * What it reliably answers is "at what point does the curve stop being survivable
 * for a fixed amount of investment", which is the question a difficulty change
 * actually asks.
 *
 * Results are only comparable against results from the *same* builder policy. Any
 * change to `BUILD_ROTATION`, the upgrade rule or the specialisation policy makes
 * earlier numbers incomparable — the policy is part of the measurement.
 */

import { World } from '../src/sim/world.js';

export const FIXED_DT = 1 / 60;

/**
 * Build order for a generalist player.
 *
 * Weighted toward the cheap backbone early, because that is what actually
 * survives the first ten waves, then branching into armour answers and air
 * coverage. It deliberately includes most of the air-capable towers: flyers walk
 * the road and three of the ten towers cannot touch them, so a build that ignores
 * air would be measuring a strawman.
 */
export const BUILD_ROTATION = [
  'basic', 'basic', 'gatling', 'cannon', 'basic', 'frost', 'tesla', 'basic',
  'sniper', 'mortar', 'venom', 'gatling', 'cannon', 'missile', 'tesla', 'sniper',
  'basic', 'flamethrower', 'mortar', 'gatling', 'venom', 'tesla', 'missile', 'sniper',
  'basic', 'cannon', 'gatling', 'flamethrower', 'mortar', 'venom', 'tesla', 'missile',
];

/** Coins held back so an upgrade never eats the budget for the next tower. */
const BUILD_RESERVE = 40;

/** Upgrades are considered once the bank is worth more than this. */
const UPGRADE_THRESHOLD = 180;

/** Samples per tile along the lane when scoring how much road a spot covers. */
const PATH_SAMPLE_STEP = 0.5;

/** Longest a single run may take, in simulated seconds. */
export const DEFAULT_MAX_SECONDS = 6000;

/** Wave the sweep runs to before declaring the curve survived. */
export const DEFAULT_MAX_WAVE = 70;

/**
 * Points sampled along the ground path.
 *
 * Coverage is measured against the lane rather than against road *tiles*
 * because what makes a tower good is how many enemies it can see over time, and
 * a stretch of lane that loops back on itself is worth more than a single long
 * straight. Counting tiles would treat those as equal.
 */
function pathSamples(world) {
  if (world._probeSamples) return world._probeSamples;
  const path = world.groundPath;
  const samples = [];
  const count = Math.max(2, Math.ceil(path.length / PATH_SAMPLE_STEP));
  for (let i = 0; i <= count; i += 1) {
    samples.push(path.posAt((path.length * i) / count));
  }
  world._probeSamples = samples;
  return samples;
}

/** How many lane samples a tower of this range could hit from (tx, ty). */
function coverageAt(world, samples, tx, ty, range) {
  const cx = tx + 0.5;
  const cy = ty + 0.5;
  const r2 = range * range;
  let score = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const dx = samples[i][0] - cx;
    const dy = samples[i][1] - cy;
    if (dx * dx + dy * dy <= r2) score += 1;
  }
  return score;
}

/**
 * Rank every free buildable tile for a given tower type.
 *
 * Ranked per *type* because range varies three-fold across the roster: the best
 * spot for a mortar is not the best spot for a gatling, and ranking once globally
 * would systematically misplace the long-range towers.
 */
function rankSpots(world, towerKey, limit = 64) {
  const samples = pathSamples(world);
  const range = world.config.towers[towerKey].range;
  const spots = [];

  for (const key of world.grid.buildable) {
    // Barracks occupy tiles too, so both maps have to be checked or the builder
    // will keep trying to build on top of one.
    if (world.towers.has(key) || world.barracks.has(key)) continue;
    const comma = key.indexOf(',');
    const tx = Number(key.slice(0, comma));
    const ty = Number(key.slice(comma + 1));
    spots.push([tx, ty, coverageAt(world, samples, tx, ty, range)]);
  }

  spots.sort((a, b) => b[2] - a[2] || a[1] - b[1] || a[0] - b[0]);
  return spots.slice(0, limit);
}

/**
 * The scripted player.
 *
 * Deterministic by construction: no randomness anywhere, so a difference between
 * two runs is always a difference in the curve and never in the policy.
 */
export class ProbePlayer {
  /**
   * @param {World} world
   * @param {{budget: number, specPolicy: 'first'|'second', upgrade: boolean}} opts
   */
  constructor(world, { budget = 12, specPolicy = 'first', upgrade = true, barracksPolicy = 0 } = {}) {
    this.world = world;
    this.budget = budget;
    this.specPolicy = specPolicy;
    this.upgrade = upgrade;
    /**
     * Which option to take at each barracks level.
     *
     * The scripted player has no judgement about which power is worth having,
     * so leaving levels unspent would make every measurement a measurement of an
     * unfinished build. Policy 0 takes the first option each time, which mixes
     * aura powers with the air wing -- see `_spendBarracksLevels`.
     */
    this.barracksPolicy = barracksPolicy;
    this.buildIndex = 0;
    this.placed = 0;
    this.specs = 0;
    this.barracksPlaced = 0;
  }

  /** Buy one tower of the next type in the rotation, at its best free spot. */
  _build() {
    const world = this.world;
    const key = BUILD_ROTATION[this.buildIndex % BUILD_ROTATION.length];
    const cost = world.config.towers[key].cost;
    if (!world.economy.canAfford(cost + BUILD_RESERVE)) return false;

    for (const [tx, ty] of rankSpots(world, key)) {
      if (world.placeTower(key, tx, ty)[0]) {
        this.buildIndex += 1;
        this.placed += 1;
        return true;
      }
    }
    // Nowhere left to put this type: retire it rather than looping forever.
    this.buildIndex += 1;
    return false;
  }

  /**
   * Raise a barracks where it covers the most existing towers.
   *
   * Placed to serve the towers already standing rather than for lane coverage:
   * the aura is the whole point, so a barracks in a quiet corner is a purchase
   * that does nothing but raise the tower cap.
   */
  _buildBarracks() {
    const world = this.world;
    const cfg = world.config.barracks;
    if (!cfg) return false;

    const cost = world.nextBarracksCost();
    if (cost === null || !world.economy.canAfford(cost + BUILD_RESERVE)) return false;

    const radius = cfg.aura.radius;
    let best = null;
    let bestScore = -1;

    for (const cell of world.grid.buildable) {
      if (world.towers.has(cell) || world.barracks.has(cell)) continue;
      const comma = cell.indexOf(',');
      const cx = Number(cell.slice(0, comma)) + 0.5;
      const cy = Number(cell.slice(comma + 1)) + 0.5;

      let score = 0;
      for (const tower of world.towers.values()) {
        if (Math.hypot(tower.x - cx, tower.y - cy) <= radius) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }

    if (best === null) return false;
    const comma = best.indexOf(',');
    if (world.placeBarracks(Number(best.slice(0, comma)), Number(best.slice(comma + 1)))[0]) {
      this.barracksPlaced += 1;
      return true;
    }
    return false;
  }

  /** Put surplus coins into the tower that has been doing the most work. */
  _upgrade() {
    const world = this.world;
    const candidates = [...world.towers.values()].filter((t) => t.alive);
    candidates.sort((a, b) => b.damageDealt - a.damageDealt || b.level - a.level);

    for (const tower of candidates) {
      const cost = tower.upgradeCost(world.leveling);
      if (cost === null) continue;
      if (!world.economy.canAfford(cost)) continue;
      // Keep enough in hand that upgrades never stall the next tower.
      const reserve = world.towers.size < this.budget ? BUILD_RESERVE : 0;
      if (world.economy.coins - cost < reserve) continue;
      if (world.upgradeTower(tower)[0]) return true;
    }
    return false;
  }

  /**
   * Take any specialisation a tower has earned.
   *
   * Skipping these was a real hole in the earlier probe: a level-20 tower with
   * three unspent tiers is a very different unit from one that has taken them, so
   * a policy that ignores specialisations measures a build nobody would play.
   */
  _specialise() {
    const world = this.world;
    for (const tower of world.towers.values()) {
      if (!tower.alive) continue;
      const tier = world.pendingSpecTier(tower);
      if (tier === null) continue;
      const cost = world.specialisationCost(tower);
      // Specs outrank upgrades: they are multipliers, not increments.
      if (tower.damageDealt <= 0 && tier.tier > 5) continue;
      if (world.economy.coins < cost) continue;
      const option = this.specPolicy === 'second'
        ? tier.options[tier.options.length - 1]
        : tier.options[0];
      if (world.chooseSpecialisation(tower, option.key)[0]) {
        this.specs += 1;
        return true;
      }
    }
    return false;
  }

  /**
   * Spend every level the barracks have earned.
   *
   * Called from `spend` rather than from a wave hook so it happens on the same
   * cadence as tower building, and so a level earned mid-wave is taken at the
   * next prep like everything else the player does.
   *
   * `autoChoose` writes the power table directly rather than going through
   * `World.chooseBarracksPower`, so the derived state a power owns -- the aura
   * and the air wing -- has to be rebuilt here. Without this the wing would only
   * ever be built once, at the moment a barracks was placed, and every later
   * power would be invisible to the probe. That is a measurement bug that reads
   * as "the air road is weak".
   */
  _spendBarracksLevels() {
    let changed = false;
    for (const barracks of this.world.barracks.values()) {
      const before = barracks.pendingLevel();
      if (!barracks.alive || before === null) continue;
      barracks.autoChoose(this.barracksPolicy);
      changed = true;
    }
    if (changed) {
      this.world.refreshSupport();
      this.world.refreshAircraft();
    }
  }

  /** One decision pass. Called while the wave is in prep. */
  spend() {
    const world = this.world;

    this._spendBarracksLevels();

    // 1. Fill out the build order up to the budget. Barracks come first when the
    //    tower cap is what is holding the build back -- which it is by design.
    let guard = 0;
    while (world.towers.size < this.budget && guard < 64) {
      guard += 1;
      if (world.towers.size >= world.towerCapacity()) {
        if (!this._buildBarracks()) break;
        continue;
      }
      if (!this._build()) break;
    }

    // 2. Then spend down: specs first, then upgrades.
    guard = 0;
    while (guard < 64) {
      guard += 1;
      if (this._specialise()) continue;
      if (this.upgrade && world.economy.coins > UPGRADE_THRESHOLD && this._upgrade()) continue;
      break;
    }
  }
}

/**
 * Run one probe.
 *
 * `meta` is a resolved skill-tree bag (see `resolveMeta`). It is null by default,
 * which measures the *bare* curve -- a player who has bought nothing. Pass a
 * resolved bag to measure what the curve actually plays like for someone who owns
 * part of the tree; the two are very different games late on.
 *
 * @returns {{budget:number, seed:number, mapId:string, survived:boolean,
 *            wave:number, baseHp:number, baseHpMax:number, leaks:number,
 *            kills:number, towers:number, specs:number, maxLevel:number,
 *            earned:number, simSeconds:number, wallMs:number}}
 */
export function runProbe(config, {
  budget = 12,
  seed = 12345,
  maxWave = DEFAULT_MAX_WAVE,
  maxSeconds = DEFAULT_MAX_SECONDS,
  specPolicy = 'first',
  upgrade = true,
  barracksPolicy = 0,
  terrain = null,
  meta = null,
} = {}) {
  const started = performance.now();
  const world = new World(config, config.waves.map, { seed, terrain, meta });
  const player = new ProbePlayer(world, { budget, specPolicy, upgrade, barracksPolicy });

  let peakEnemies = 0;

  while (!world.gameOver && world.wave < maxWave && world.time < maxSeconds) {
    if (world.prepared) player.spend();
    world.update(FIXED_DT);
    if (world.enemies.length > peakEnemies) peakEnemies = world.enemies.length;
  }

  let maxLevel = 0;
  for (const tower of world.towers.values()) {
    if (tower.level > maxLevel) maxLevel = tower.level;
  }

  /**
   * Why the run stopped.
   *
   * Reported explicitly because the caps are not the same result: a run that hit
   * the time limit was still alive and would have kept going, so counting it as
   * "survived" would quietly flatter whatever curve was under test.
   */
  const endReason = world.gameOver
    ? 'died'
    : world.wave >= maxWave
      ? 'waveCap'
      : 'timeCap';

  return {
    budget,
    seed,
    mapId: config.mapId,
    survived: endReason !== 'died',
    endReason,
    wave: world.wave,
    baseHp: Math.max(0, world.economy.baseHp),
    baseHpMax: world.economy.baseHpMax,
    leaks: world.economy.leaked,
    kills: world.stats.kills,
    towers: world.towers.size,
    specs: player.specs,
    maxLevel,
    earned: Math.round(world.economy.earned),
    peakEnemies,
    simSeconds: Math.round(world.time),
    wallMs: Math.round(performance.now() - started),
  };
}

/**
 * Sweep a grid of budgets x configs x seeds.
 *
 * @param {Array<{id:string, config:object, terrain?:object}>} maps
 * @param {{budgets?:number[], seeds?:number[], onResult?:Function}} opts
 */
export function runSweep(maps, {
  budgets = [4, 6, 8, 12, 16, 24],
  seeds = [12345],
  maxWave = DEFAULT_MAX_WAVE,
  maxSeconds = DEFAULT_MAX_SECONDS,
  specPolicy = 'first',
  upgrade = true,
  onResult = null,
} = {}) {
  const results = [];
  for (const { id, config, terrain } of maps) {
    for (const budget of budgets) {
      for (const seed of seeds) {
        const result = runProbe(config, {
          budget, seed, maxWave, maxSeconds, specPolicy, upgrade, terrain,
        });
        results.push(result);
        if (onResult) onResult(result);
      }
    }
  }
  return results;
}

/** One line per result, for pasting into a report. */
export function formatTable(results) {
  const head = [
    'map'.padEnd(9),
    'towers'.padStart(6),
    'seed'.padStart(7),
    'wave'.padStart(5),
    'base'.padStart(7),
    'leaks'.padStart(6),
    'kills'.padStart(7),
    'specs'.padStart(6),
    'lvl'.padStart(4),
    'outcome'.padStart(10),
  ].join(' ');

  const rows = results.map((r) => [
    String(r.mapId).padEnd(9),
    String(r.budget).padStart(6),
    String(r.seed).padStart(7),
    String(r.wave).padStart(5),
    `${r.baseHp}/${r.baseHpMax}`.padStart(7),
    String(r.leaks).padStart(6),
    String(r.kills).padStart(7),
    String(r.specs).padStart(6),
    String(r.maxLevel).padStart(4),
    (r.endReason === 'died' ? 'DIED' : r.endReason).padStart(10),
  ].join(' '));

  return [head, '-'.repeat(head.length), ...rows].join('\n');
}

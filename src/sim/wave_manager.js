/**
 * Endless wave generation, spawn scheduling and phase transitions.
 *
 * Phases: prep -> spawning -> clearing -> prep ...
 *
 * The spawn clock only advances while spawns are actually being issued, so when
 * the concurrency cap is hit the whole schedule slips rather than the frame
 * rate suffering.
 */

import { Rng } from './rng.js';

export const PREP = 'prep';
export const SPAWNING = 'spawning';
export const CLEARING = 'clearing';
export const OVER = 'over';

export class SpawnOrder {
  constructor(time, key, hpMult = 1.0, bountyMult = 1.0, speedMult = 1.0) {
    this.time = time;
    this.key = key;
    this.hpMult = hpMult;
    this.bountyMult = bountyMult;
    this.speedMult = speedMult;
  }
}

/** Adaptive-difficulty bounds: how far the threat multiplier may drift. */
const THREAT_MAX = 1.5;
const THREAT_MIN = 0.85;
/** Threat gained for a wave cleared with zero leaks. */
const THREAT_PER_CLEAN = 0.025;
/** Threat lost per enemy that leaked through. */
const THREAT_PER_LEAK = 0.06;

export class WaveManager {
  constructor(config, seed = 12345) {
    this.config = config;
    this.rng = new Rng(seed);
    this.wave = 0;
    this.state = PREP;
    this.prepRemaining = config.waves.prep_time;
    this.queue = [];
    this.queueHead = 0;
    this.clock = 0.0;
    this.waveElapsed = 0.0;
    this.lastBonus = 0.0;
    /** Rate actually applied by the most recent payout, for the HUD. */
    this.lastInterestRate = 0.0;
    /**
     * Adaptive difficulty: rises on clean clears and falls on leaks, so the
     * horde keeps pace with a strong build but eases off a struggling one.
     */
    this.threat = 1.0;
    /** Leaks counted at the start of the current wave, to score how clean it was. */
    this.leaksAtWaveStart = 0;
    /** Neutral until the host supplies a difficulty selection. */
    this.diff = { size: 1.0, power: 1.0, growth: 1.0 };
  }

  /**
   * Apply the player's difficulty selection.
   *
   * Three multipliers that do different jobs:
   *   `size`   -- how many enemies a wave contains
   *   `power`  -- a flat multiplier on enemy health
   *   `growth` -- how far the endless curves have travelled from their wave-1
   *               baseline, so 0.8 ramps slower and 1.45 much faster
   *
   * Bounty is deliberately left alone. Compensating the economy for a harder
   * curve would make the higher settings not actually harder, they would just
   * have a longer ramp.
   */
  setDifficulty(mult) {
    const pick = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : 1.0;
    };
    const ramp = Number(mult?.powerRampWaves);
    this.diff = {
      size: pick(mult?.size),
      power: pick(mult?.power),
      growth: pick(mult?.growth),
      powerRampWaves: Number.isFinite(ramp) && ramp >= 1 ? Math.floor(ramp) : 1,
    };
  }

  /**
   * How much of the difficulty power multiplier is in force at a wave.
   *
   * Ramps from 0 at wave 1 to 1 at `powerRampWaves`, then holds. Applied this way
   * rather than flat because the opening is on a knife edge: the starting economy
   * buys about seven Basic towers and wave 1 is only just winnable with them, so a
   * flat multiplier does not scale the challenge, it deletes the first ten waves.
   */
  _powerRamp(wave) {
    const span = this.diff.powerRampWaves;
    if (!(span > 1)) return 1.0;
    return Math.min(1.0, Math.max(0.0, (wave - 1) / (span - 1)));
  }

  /** Effective enemy-health multiplier including the ramped-in difficulty. */
  effectivePower(wave) {
    return 1.0 + (this.diff.power - 1.0) * this._powerRamp(wave);
  }

  get scaling() {
    return this.config.waves.scaling;
  }

  /**
   * Health growth at a wave.
   *
   * `growth` scales the *distance from 1.0* rather than the multiplier itself,
   * so growth 0 would hold every wave at the wave-1 baseline and growth 1
   * reproduces the authored curve exactly. Scaling the multiplier directly would
   * make growth 0 mean "zero health".
   */
  hpMult(wave) {
    const s = this.scaling;
    const d = this.diff;
    const lin = 1.0 + s.hp_lin * d.growth * (wave - 1);
    const exp = 1.0 + (s.hp_exp - 1.0) * d.growth;
    return lin * exp ** (wave - 1) * this.effectivePower(wave) * this.threat;
  }

  countMult(wave) {
    const size = 1.0 + (this.diff.size - 1.0) * this._powerRamp(wave);
    return (1.0 + this.scaling.count_lin * this.diff.growth * (wave - 1)) * size;
  }

  speedMult(wave) {
    const s = this.scaling;
    return Math.min(s.speed_cap, 1.0 + s.speed_lin * (wave - 1));
  }

  /**
   * Flat armour every enemy gains by this wave.
   *
   * The counterweight to the damage ceiling. Health scaling only delays the
   * point at which a maxed build stops growing; armour *reduces* what that build
   * actually achieves, because it is subtracted from every hit. A tower firing
   * many small shots loses far more of its output than one firing few large
   * ones, so this is what stops a single build order from solving every wave.
   *
   * Scaled by `growth` (the authored-curve knob) but deliberately not by
   * `power`: armour is subtraction, and multiplying it by Nightmare's 5.4x would
   * leave low-damage towers dealing the 10% damage floor on every shot rather
   * than merely being weakened.
   */
  armorBonus(wave) {
    const s = this.scaling;
    const perWave = s.armor_lin ?? 0;
    if (perWave <= 0) return 0;
    const ramped = Math.max(0, wave - 1) * perWave * this.diff.growth;
    return Math.min(s.armor_cap ?? Infinity, ramped);
  }

  /**
   * Crowd-control resistance every enemy gains by this wave.
   *
   * Armour answers builds that fire many small shots; this answers builds that
   * lean on slowing everything to a crawl and letting the lane do the work.
   * Without it, `applySlow` reads `d.cc_resist`, which is a constant per type --
   * 0.0 on seven of the eleven -- so a frost build applied its full slow to a
   * wave-60 Colossus exactly as it did to a wave-1 Basic. The tower's four
   * specialisation tiers kept multiplying the slow while the enemy side of that
   * contest never moved at all.
   *
   * It is resist, not immunity: the cap leaves a meaningful slow still landing,
   * so frost remains a real purchase rather than becoming dead weight. Scaled by
   * `growth` for consistency with armour, and deliberately not by `power` -- this
   * is a flat fraction, and Nightmare's 6.5x would push it past 1.0.
   */
  ccResistBonus(wave) {
    const s = this.scaling;
    const perWave = s.cc_resist_lin ?? 0;
    if (perWave <= 0) return 0;
    const ramped = Math.max(0, wave - 1) * perWave * this.diff.growth;
    return Math.min(s.cc_resist_cap ?? Infinity, ramped);
  }

  bountyMult(wave) {
    const s = this.scaling;
    return (1.0 + s.bounty_lin * (wave - 1)) * s.bounty_exp ** (wave - 1);
  }

  isBossWave(wave) {
    const every = this.config.waves.boss_every;
    return every > 0 && wave > 0 && wave % every === 0;
  }

  isMiniBossWave(wave) {
    const every = this.config.waves.mini_boss_every;
    return every > 0 && wave > 0 && wave % every === 0 && !this.isBossWave(wave);
  }

  _pool(wave) {
    const keys = [];
    const weights = [];
    for (const key of Object.keys(this.config.enemies)) {
      const weight = this.config.enemyWeight(key, wave);
      if (weight > 0.0) {
        keys.push(key);
        weights.push(weight);
      }
    }
    return { keys, weights };
  }

  /**
   * Choose `wanted` distinct types, favouring the heavier weights.
   *
   * Weighted sampling *without* replacement: each pick removes the chosen key, so
   * a type cannot be selected twice. Picking with replacement and then
   * de-duplicating would silently return fewer types than asked for on skewed
   * weights, which is the exact failure this is meant to fix.
   *
   * The draws are in a fixed order, so wave composition stays reproducible from
   * a seed.
   */
  _pickTypes(keys, weights, wanted) {
    const poolKeys = keys.slice();
    const poolWeights = weights.slice();
    const cast = [];

    while (cast.length < wanted && poolKeys.length > 0) {
      const key = this.rng.weighted(poolKeys, poolWeights);
      const index = poolKeys.indexOf(key);
      if (index < 0) break;
      poolKeys.splice(index, 1);
      poolWeights.splice(index, 1);
      cast.push(key);
    }

    return cast.length > 0 ? cast : [keys[0]];
  }

  /** Toughest unlocked non-flying, non-boss type. */
  _miniBossKey(wave) {
    const exclude = 'boss' in this.config.enemies ? 'boss' : null;
    let bestKey = null;
    let bestHp = -1.0;

    for (const [key, d] of Object.entries(this.config.enemies)) {
      if (key === exclude || d.flying || d.weight <= 0.0) continue;
      if (d.unlock_wave > wave) continue;
      if (d.hp > bestHp) {
        bestHp = d.hp;
        bestKey = key;
      }
    }
    return bestKey;
  }

  buildWave(wave) {
    const cfg = this.config.waves;
    const hpM = this.hpMult(wave);
    const spdM = this.speedMult(wave);
    const btyM = this.bountyMult(wave);

    let count = Math.round(cfg.base_count * this.countMult(wave));
    // The per-wave cap is a safety valve against runaway wave sizes, so it has
    // to scale with `size` or Nightmare would silently flatten out at the cap.
    const sizeMult = 1.0 + (this.diff.size - 1.0) * this._powerRamp(wave);
    count = Math.max(1, Math.min(count, Math.round(cfg.max_per_wave * sizeMult)));

    const interval = Math.max(
      cfg.spawn_interval_floor,
      cfg.spawn_interval_base - cfg.spawn_interval_per_wave * wave,
    );
    const gap = Math.max(cfg.group_gap_floor, cfg.group_gap - cfg.group_gap_per_wave * wave);

    const orders = [];
    let clock = 0.0;
    const { keys, weights } = this._pool(wave);

    if (keys.length > 0) {
      /**
       * How many distinct enemy types this wave should actually contain.
       *
       * Waves were previously built by drawing each group independently from the
       * weighted pool, which sounds varied but is not: the weights are skewed,
       * so a late wave could easily come out as almost entirely one type. The
       * count of *possible* types was never the same as the count of types that
       * showed up.
       *
       * Now the wave commits to a set of types up front and rotates through them,
       * so every chosen type is genuinely present. The set grows with the wave,
       * which is what makes late waves read as a mixed assault rather than a
       * single-type grind.
       */
      const mixBase = Number(cfg.mix_types_base ?? 1);
      const mixEvery = Math.max(1, Number(cfg.mix_types_per_waves ?? 5));
      const wanted = Math.max(
        1,
        Math.min(keys.length, mixBase + Math.floor(wave / mixEvery)),
      );
      const cast = this._pickTypes(keys, weights, wanted);

      let remaining = count;
      let turn = 0;
      while (remaining > 0) {
        const size = Math.min(remaining, this.rng.randint(3, 8));
        const key = cast[turn % cast.length];
        turn += 1;
        for (let i = 0; i < size; i += 1) {
          orders.push(new SpawnOrder(clock, key, hpM, btyM, spdM));
          clock += interval;
        }
        clock += gap;
        remaining -= size;
      }
    }

    if (this.isMiniBossWave(wave)) {
      const key = this._miniBossKey(wave);
      if (key !== null) {
        const bosses = 2 + Math.floor(wave / 20);
        for (let i = 0; i < bosses; i += 1) {
          orders.push(
            new SpawnOrder(
              clock,
              key,
              hpM * cfg.mini_boss_hp_mult,
              btyM * cfg.mini_boss_bounty_mult,
              spdM,
            ),
          );
          clock += Math.max(1.2, interval * 2.0);
        }
        clock += gap;
      }
    }

    if (this.isBossWave(wave) && 'boss' in this.config.enemies) {
      const countBoss =
        cfg.boss_count_base + Math.floor(wave / 50) * cfg.boss_count_per_50_waves;
      for (let i = 0; i < Math.max(1, countBoss); i += 1) {
        orders.push(new SpawnOrder(clock, 'boss', hpM, btyM, spdM));
        clock += 3.0;
      }
    }

    return orders;
  }

  waveDurationEstimate(wave) {
    const orders = this.buildWave(wave);
    return orders.length > 0 ? orders[orders.length - 1].time : 0.0;
  }

  startWave(world) {
    this.wave += 1;
    this.leaksAtWaveStart = world.stats.leaked;
    this.queue = this.buildWave(this.wave);
    this.queueHead = 0;
    this.clock = 0.0;
    this.waveElapsed = 0.0;
    this.state = SPAWNING;
    world.onWaveStart(this.wave);
  }

  /** Skip the rest of prep, banking a coin bonus for the saved time. */
  callEarly(world) {
    if (this.state !== PREP) return 0.0;
    const bonus = Math.round(
      Math.max(0.0, this.prepRemaining) * this.config.waves.early_call_coins_per_sec,
    );
    this.prepRemaining = 0.0;
    world.economy.earn(bonus);
    world.note(`Early call: +${bonus.toFixed(0)} coins`);
    this.startWave(world);
    return bonus;
  }

  _completeWave(world) {
    const cfg = this.config.waves;
    const bonus = cfg.wave_bonus_base + cfg.wave_bonus_per_wave * this.wave
      + (world.meta?.waveBonus ?? 0);

    let bonusTiles = 0;
    for (const tower of world.towers.values()) {
      if (world.grid.isBonus(tower.tx, tower.ty)) bonusTiles += 1;
    }
    const tileBonus = bonusTiles * cfg.bonus_tile_coins;

    const interest = this.calculateInterest(world);

    this.lastBonus = bonus + tileBonus + interest;
    world.economy.earn(this.lastBonus);
    world.onWaveComplete(this.wave, this.lastBonus, bonusTiles, interest);

    this.state = PREP;
    this.prepRemaining = cfg.prep_time;

    // Adaptive difficulty: score the wave that just ended against the previous.
    const leaks = world.stats.leaked - this.leaksAtWaveStart;
    const before = this.threat;
    if (leaks <= 0) {
      this.threat = Math.min(THREAT_MAX, this.threat + THREAT_PER_CLEAN);
    } else {
      this.threat = Math.max(THREAT_MIN, this.threat - THREAT_PER_LEAK * leaks);
    }
    if (this.threat !== before) {
      world.note(
        this.threat > before
          ? `Horde adapting — enemy health ×${this.threat.toFixed(2)}`
          : `Horde easing — enemy health ×${this.threat.toFixed(2)}`,
      );
    }
  }

  /**
   * Interest on coins still in the bank when the wave is cleared.
   *
   * The rate rises with the size of the hoard and again with the wave number,
   * then clamps. Paying a *flat* rate would reward saving in exact proportion
   * to the balance, which makes "build nothing" the dominant line at every
   * bank size; ramping the rate instead means the reward is for saving
   * deliberately, and the clamp stops a huge hoard from compounding away the
   * whole difficulty curve.
   */
  calculateInterest(world) {
    const cfg = this.config.waves;
    const interest = cfg.interest;
    if (!interest || interest.max_rate <= 0.0) return 0.0;

    const bank = world.economy.coins;
    if (bank <= 0.0) return 0.0;

    const step = Math.max(1, interest.step_coins);
    const steps = Math.floor(bank / step);
    const rate = Math.min(
      interest.max_rate,
      interest.base_rate
        + (world.meta?.interestBase ?? 0)
        + interest.rate_per_step * steps
        + interest.wave_rate_bonus * (this.wave - 1),
    );

    this.lastInterestRate = rate;
    return Math.floor(bank * rate);
  }

  update(dt, world) {
    if (this.state === OVER) return;

    if (this.state === PREP) {
      this.prepRemaining -= dt;
      if (this.prepRemaining <= 0.0) this.startWave(world);
      return;
    }

    if (this.state === SPAWNING) {
      this.waveElapsed += dt;
      const cap = this.config.waves.max_concurrent;
      let alive = world.enemies.length;
      let blockedByCap = false;

      while (this.queueHead < this.queue.length && this.queue[this.queueHead].time <= this.clock) {
        if (alive >= cap) {
          blockedByCap = true;
          break;
        }
        const order = this.queue[this.queueHead];
        this.queueHead += 1;
        world.spawnEnemy(order.key, order.hpMult, order.bountyMult, order.speedMult);
        alive += 1;
      }

      // Advance the clock unless the cap is holding orders back, so hitting the
      // cap slips the schedule rather than the frame rate.
      //
      // This must NOT be keyed on "did we spawn this frame": orders are spaced
      // an interval apart, so most frames legitimately spawn nothing, and
      // freezing the clock then means it can never reach the next order's time.
      if (!blockedByCap) this.clock += dt;

      if (this.queueHead >= this.queue.length) this.state = CLEARING;
      return;
    }

    if (this.state === CLEARING) {
      if (world.enemies.length === 0) this._completeWave(world);
    }
  }

  forceOver() {
    this.state = OVER;
  }

  prepFraction() {
    const total = this.config.waves.prep_time;
    if (total <= 0.0) return 1.0;
    return Math.max(0.0, Math.min(1.0, 1.0 - this.prepRemaining / total));
  }

  /** Enemies still to be released this wave. */
  get queuedCount() {
    return this.queue.length - this.queueHead;
  }
}

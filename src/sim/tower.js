/**
 * Tower entities: targeting, rotation, firing and in-run levelling.
 *
 * Turrets may only fire once roughly aimed. That ties firing rate to traversal
 * speed, which is what makes the slow-traversing sniper a real trade-off
 * rather than just a big number.
 */

export const TARGETING_MODES = ['first', 'last', 'strongest', 'weakest', 'closest', 'sequential'];

export const TARGETING_LABELS = {
  first: 'First',
  last: 'Last',
  strongest: 'Strongest',
  weakest: 'Weakest',
  closest: 'Closest',
  sequential: 'Sequential',
};

export const AIM_TOLERANCE_RADIANS = (10.0 * Math.PI) / 180.0;

/**
 * Flags whose neutral value is 1 rather than 0.
 *
 * `flags` is the table specialisations write mechanics into. Most entries are
 * rates that stack additively (two burns burn twice as hard), but a multiplier
 * has to combine multiplicatively or two +2.5x crit picks would silently mean
 * +5x. See Tower._applySpecs.
 */
const FLAG_NEUTRAL_ONE = new Set(['crit_mult', 'bounty_mult']);

/** How fast a muzzle flash decays, in units of the timer per second. */
const MUZZLE_DECAY = 6.5;

/**
 * How often a beam applies its accumulated damage.
 *
 * A beam melts continuously, but flat armour is subtracted per *hit* — applied
 * every frame, the ticks are so small that armour eats each one and the beam
 * hits the damage floor against anything armoured. Batching into five hits a
 * second makes each tick a real hit, so armour bites the beam the same way it
 * bites every other tower rather than disproportionately.
 */
const BEAM_TICK = 0.2;

const TWO_PI = Math.PI * 2.0;

/** Python's `%` is always non-negative for a positive modulus; JS's is not. */
function mod(x, m) {
  return ((x % m) + m) % m;
}

/** Smallest signed difference between two angles, in (-pi, pi]. */
export function angleDifference(a, b) {
  return mod(b - a + Math.PI, TWO_PI) - Math.PI;
}

export function rotateToward(current, target, maxStep) {
  const delta = angleDifference(current, target);
  if (Math.abs(delta) <= maxStep) return target;
  return mod(current + Math.sign(delta) * maxStep, TWO_PI);
}

export class Tower {
  constructor(d, tx, ty, leveling, meta = null) {
    this.key = d.key;
    this.d = d;
    /** Resolved skill-tree buffs, shared by reference; null for a bare tower. */
    this.meta = meta ?? null;
    this.tx = tx;
    this.ty = ty;
    this.x = tx + 0.5;
    this.y = ty + 0.5;

    this.level = 1;
    this.xp = 0.0;
    this.cooldown = 0.0;
    this.angle = -Math.PI / 2.0;
    this.invested = d.cost;
    this.damageDealt = 0.0;
    this.kills = 0;
    this.mode = 'first';
    /**
     * How far along the lane the last enemy this tower *hit* had travelled.
     *
     * Only meaningful in `sequential` mode, where it is the sweep position.
     * Starts before the lane, so the first shot takes the leading enemy.
     */
    this.lastTargetProgress = -1.0;
    this.alive = true;
    this.levelsGained = 0;

    /**
     * Beam-weapon state. Only the laser uses it; every other tower leaves it
     * untouched and the beam branch in update() is skipped on the first check.
     */
    this.beamTarget = null;
    this.beamTime = 0.0;
    this.beamGap = 0.0;
    this.beamCharge = 0.0;
    this._beamChargeEid = -1;
    /** Unapplied beam damage, flushed in BEAM_TICK-sized hits. */
    this.beamAccumulator = 0.0;

    /**
     * Purely presentational, but owned by the simulation so it advances with
     * sim time and therefore freezes on pause and scales with game speed.
     *
     * `shots` is a monotonic counter rather than a flag: the renderer watches it
     * for a change to detect a firing edge, which stays correct at 3x speed
     * where a fast tower can fire again before a decaying flash reaches zero.
     * `muzzle` drives barrel recoil.
     */
    this.shots = 0;
    this.muzzle = 0.0;

    /** Chosen specialisations, tier number -> option object. */
    this.specs = new Map();

    /** Ground the tower stands on. Assigned by the world at placement. */
    this.terrainBand = null;

    /**
     * Barracks bonuses from every aura this tower stands in, as multipliers.
     *
     * Assigned by the world when the aura picture changes -- which is only on a
     * build, a sale or a barracks evolving -- rather than recomputed per frame.
     */
    this.support = null;
    /**
     * Board-wide weather multipliers, or null when the weather is neutral.
     *
     * Held by reference: the bag is owned by the weather manager and shared by
     * every tower, so copying it per tower would allocate on every spell.
     */
    this.weather = null;
    /** The barracks contributing to `support`, so damage can credit them XP. */
    this.supportSources = [];

    this._applySpecs(leveling);
  }

  /**
   * Damage, range and rate for a definition at an arbitrary level.
   *
   * Static because the renderer previews the range of a tower that does not
   * exist yet, and because levelling maths should live in exactly one place.
   */
  static statsAtLevel(d, level, leveling) {
    const steps = Math.max(0, level - 1);
    return {
      damage: d.damage * (1.0 + leveling.damage_per_level) ** steps,
      range: d.range * (1.0 + leveling.range_per_level) ** steps,
      rate: d.rate * (1.0 + leveling.rate_per_level) ** steps,
    };
  }

  /**
   * Fold every chosen specialisation into flat modifier tables, then recalc.
   *
   * Rebuilt from scratch each time rather than merged in place: the tables are
   * the *product* of the picks, so folding them into the existing tables would
   * compound every time the tower gained a level.
   */
  _applySpecs(leveling) {
    const mult = {};
    const add = {};
    const override = {};
    const flags = {};

    for (const option of this.specs.values()) {
      for (const [key, value] of Object.entries(option.mult ?? {})) {
        mult[key] = (mult[key] ?? 1) * value;
      }
      for (const [key, value] of Object.entries(option.add ?? {})) {
        add[key] = (add[key] ?? 0) + value;
      }
      Object.assign(override, option.override ?? {});
      for (const [key, value] of Object.entries(option.flags ?? {})) {
        if (flags[key] === undefined) {
          flags[key] = value;
        } else if (key === 'true_damage' || key === 'allow_air') {
          // On/off switches: taking a second one changes nothing.
          flags[key] = Math.max(flags[key], value);
        } else if (FLAG_NEUTRAL_ONE.has(key)) {
          // Multiplier-shaped flags. Adding these would turn two +2.5x crit
          // picks into +5x, which is not what "another 2.5x bonus" means.
          flags[key] *= value;
        } else {
          // Rates and durations accumulate -- two burns really do burn twice.
          flags[key] += value;
        }
      }
    }

    this.mult = mult;
    this.add = add;
    this.override = override;
    this.flags = flags;
    this._recalc(leveling);
  }

  /**
   * Resolve base stats x level scaling x specialisations into plain fields.
   *
   * Everything downstream -- the projectile, the damage flow, the renderer --
   * reads these instead of reaching into `d` or knowing about specialisations.
   */
  _recalc(leveling) {
    const d = this.d;
    const stats = Tower.statsAtLevel(d, this.level, leveling);
    const mult = this.mult ?? {};
    const add = this.add ?? {};
    const over = this.override ?? {};
    const flags = this.flags ?? {};

    this.damage = stats.damage * (mult.damage ?? 1);
    this.range = stats.range * (mult.range ?? 1);
    this.rate = stats.rate * (mult.rate ?? 1);

    // Ground applies last, on top of level scaling and specialisations, so the
    // inspector reports the number the tower actually fights with.
    if (this.terrainBand) {
      this.range *= this.terrainBand.tower.range;
      this.damage *= this.terrainBand.tower.damage;
    }

    this.projectileSpeed = d.projectile_speed * (mult.projectile_speed ?? 1);
    this.splash = d.splash_radius * (mult.splash_radius ?? 1);

    this.chainCount = Math.max(1, Math.round(d.chain_count + (add.chain_count ?? 0)));
    this.chainFalloff = Math.min(1.0, over.chain_falloff ?? d.chain_falloff);
    this.chainRange = d.chain_range * (mult.chain_range ?? 1);

    this.slowFactor = over.slow_factor ?? d.slow_factor;
    this.slowDuration = d.slow_duration * (mult.slow_duration ?? 1);

    this.poisonDps = d.poison_dps * (mult.poison_dps ?? 1);
    this.poisonDuration = d.poison_duration * (mult.poison_duration ?? 1);
    this.poisonStacks = d.poison_max_stacks + (add.poison_max_stacks ?? 0);

    this.burnDps = flags.burn_dps ?? 0;
    this.burnDuration = flags.burn_duration ?? 0;
    this.burnStacks = flags.burn_stacks ?? 0;
    this.armorShred = flags.armor_shred ?? 0;
    this.armorShredDuration = flags.armor_shred_duration ?? 0;

    this.critChance = flags.crit_chance ?? 0;
    this.critMult = (flags.crit_mult ?? 1) * (mult.crit_mult ?? 1);
    this.executeBelow = flags.execute_below ?? 0;
    this.bountyMult = (flags.bounty_mult ?? 1) * (mult.bounty_mult ?? 1);
    this.pierce = Math.round(flags.pierce ?? 0);
    this.trueDamage = (flags.true_damage ?? 0) > 0;

    this.groundOnly = over.ground_only ?? d.ground_only ?? false;
    this.airOnly = over.air_only ?? d.air_only ?? false;
    /**
     * Airburst lifts a ground-only restriction; the anti-air seeker override goes
     * the other way. Neither is allowed to clear the *other* restriction -- a
     * mortar that could suddenly shoot ground as well would not be a trade-off.
     */
    if ((flags.allow_air ?? 0) > 0) this.groundOnly = false;
    if ((flags.allow_ground ?? 0) > 0) this.airOnly = false;

    // Beam weapons melt continuously. `damage` is per second while firing; the
    // pulse/gap cycle and the charge ramp are read from the data, with pulse
    // length and ramp extensible through specialisations.
    this.beam = d.beam ?? null;
    if (this.beam !== null) {
      this.pulseDuration = (this.beam.pulse + (add.pulse_duration ?? 0)) * (mult.pulse_duration ?? 1);
      this.gapDuration = this.beam.gap;
      this.rampPerSec = this.beam.ramp_per_sec + (add.ramp_per_sec ?? 0);
      this.rampMax = this.beam.ramp_max * (mult.ramp_max ?? 1);
    }

    // Barracks support goes on last, like terrain, so the inspector and the shop
    // report the numbers the tower actually fights with.
    const support = this.support;
    if (support !== null) {
      this.damage *= support.damage;
      this.range *= support.range;
      this.rate *= support.rate;
      this.bountyMult *= support.bounty;
      this.critChance += support.crit_chance;
    }

    // Weather is applied after even the aura, because it is a condition of the
    // whole board rather than something the tower has earned: it should scale
    // whatever the tower already is, aura included.
    const weather = this.weather;
    if (weather !== null) {
      this.damage *= weather.damage;
      this.range *= weather.range;
      this.rate *= weather.rate;
    }

    // Persistent skill-tree buffs go on last, after every in-run modifier, so
    // the inspector reports the number the tower actually fights with.
    const meta = this.meta;
    if (meta !== null) {
      this.damage *= meta.towerDamage;
      this.range *= meta.towerRange;
      this.rate *= meta.towerRate;
      this.critChance += meta.critChance;
    }
  }

  /** Set the board-wide weather multipliers and recalculate. */
  setWeather(weather, leveling) {
    this.weather = weather ?? null;
    this._recalc(leveling);
  }

  /**
   * Set the barracks aura bonuses for this tower.
   *
   * Called with `null` when nothing covers the tower, which is the common case
   * and keeps the recalculation above to a single null check.
   */
  setSupport(support, sources, leveling) {
    this.support = support;
    this.supportSources = sources ?? [];
    this._recalc(leveling);
  }

  /**
   * What this tower is allowed to shoot at, as a short label.
   *
   * The UI shows this next to the price, because a restriction the player cannot
   * see is a restriction they will discover by losing.
   */
  get targetLabel() {
    if (this.groundOnly) return 'ground only';
    if (this.airOnly) return 'air only';
    return null;
  }

  /**
   * Set the ground band this tower stands on.
   *
   * Called at placement and again when a save is restored, so a reloaded tower
   * gets the same terrain bonuses it had when it was built.
   */
  setTerrain(band, leveling) {
    this.terrainBand = band ?? null;
    this._recalc(leveling);
  }

  /**
   * Commit to one option from a specialisation tier.
   *
   * @returns {boolean} false if this tier was already chosen
   */
  chooseSpec(tier, option, leveling) {
    if (this.specs.has(tier)) return false;
    this.specs.set(tier, option);
    this._applySpecs(leveling);
    return true;
  }

  get specCount() {
    return this.specs.size;
  }

  /**
   * Cost of taking a specialisation, scaled off the tower's build price.
   *
   * Scales with how many the tower has already taken: a tier-20 capstone that
   * cost the same as a tier-5 pick would make the later tiers strictly free
   * power rather than a decision. Defaults to the next tier this tower owes,
   * which is the one the UI is asking about.
   */
  specCost(leveling, taken = this.specs.size) {
    const base = this.d.cost * leveling.specialisation_cost_factor;
    const growth = leveling.spec_cost_growth ?? 1.0;
    return Math.round(base * growth ** Math.max(0, taken) * (this.meta?.specCost ?? 1));
  }

  static xpNeeded(level, leveling) {
    return leveling.xp_to_next_base * level ** leveling.xp_to_next_power;
  }

  /** Award combat XP. Returns how many levels were gained. */
  addXp(amount, leveling) {
    if (amount <= 0.0 || this.level >= leveling.max_level) return 0;

    this.xp += amount;
    let gained = 0;

    while (this.level < leveling.max_level) {
      const needed = Tower.xpNeeded(this.level, leveling);
      if (this.xp < needed) break;
      this.xp -= needed;
      this.level += 1;
      gained += 1;
    }

    if (gained > 0) {
      this.levelsGained += gained;
      this._recalc(leveling);
    }
    if (this.level >= leveling.max_level) this.xp = 0.0;
    return gained;
  }

  /** Purchase one level with coins. */
  buyLevel(leveling) {
    if (this.level >= leveling.max_level) return false;
    this.level += 1;
    this._recalc(leveling);
    return true;
  }

  /**
   * Jump straight to a level, bypassing XP and cost.
   *
   * Only the test sandbox calls this. In a normal run levels are earned from
   * combat XP or bought with coins, which is the whole progression curve.
   */
  setLevel(level, leveling) {
    const clamped = Math.max(1, Math.min(leveling.max_level, Math.floor(level)));
    this.level = clamped;
    this.xp = 0.0;
    this._recalc(leveling);
    return this.level;
  }

  upgradeCost(leveling) {
    if (this.level >= leveling.max_level) return null;
    return Math.round(
      leveling.upgrade_cost_factor
        * this.d.cost
        * leveling.upgrade_cost_growth ** (this.level - 1)
        * (this.meta?.upgradeCost ?? 1),
    );
  }

  sellValue(sellRefund) {
    return this.invested * sellRefund;
  }

  /** Sustained single-target damage per second, ignoring armour. */
  dps() {
    // A beam's `damage` is already a per-second rate; there is no shot cadence
    // to multiply it by. The shop and inspector show the melt rate directly.
    if (this.d.attack === 'beam') return this.damage;
    // Crits are folded in as an expectation so the inspector and the shop
    // report a number comparable to a tower without them.
    const expected = 1.0 + this.critChance * (this.critMult - 1.0);
    return this.damage * this.rate * expected;
  }

  /** One-shot damage against a specific enemy, including crit roll and bonus. */
  rawDamageAgainst(enemy, rng = null) {
    const bonus = this.d.bonus_vs[enemy.d.armor_class] ?? 1.0;
    let raw = this.damage * bonus;
    if (this.critChance > 0.0 && rng !== null && rng.next() < this.critChance) {
      raw *= this.critMult;
    }
    return raw;
  }

  canTarget(enemy) {
    if (enemy.d.flying) return !this.groundOnly;
    return !this.airOnly;
  }

  /** Pick a target using the current targeting mode. */
  acquire(world) {
    const mode = this.mode;
    const rangeSq = this.range * this.range;
    const ox = this.x;
    const oy = this.y;
    const groundOnly = this.groundOnly;
    const airOnly = this.airOnly;

    // Sequential needs the whole candidate set rather than a running best, so
    // it is handled on its own instead of being squeezed into a score.
    if (mode === 'sequential') {
      return this._acquireSequential(world, rangeSq, groundOnly, airOnly);
    }

    let best = null;
    let bestScore = 0.0;

    const enemies = world.enemies;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;

      const dx = enemy.x - ox;
      const dy = enemy.y - oy;
      const distSq = dx * dx + dy * dy;
      if (distSq > rangeSq) continue;

      if (enemy.d.flying) {
        if (groundOnly) continue;
      } else if (airOnly) {
        continue;
      }

      let score;
      if (mode === 'closest') score = -distSq;
      else if (mode === 'first') score = enemy.progress;
      else if (mode === 'last') score = -enemy.progress;
      else if (mode === 'strongest') score = enemy.hp;
      else score = -enemy.hp;

      if (best === null || score > bestScore) {
        best = enemy;
        bestScore = score;
      }
    }

    return best;
  }

  /**
   * Sequential: sweep along the lane instead of focusing.
   *
   * Takes the first enemy past the one this tower last *hit*, wrapping back to
   * the front of the lane once there is nothing new. On a pack that spreads
   * damage rather than overkilling whoever is in front, which is what makes it
   * the right mode for a cheap high-rate gun and the wrong one for a sniper.
   *
   * The sweep position advances in `fire`, not here: `acquire` can return a
   * target the turret then fails to aim at in time, and advancing on a shot that
   * was never taken would silently skip enemies.
   */
  _acquireSequential(world, rangeSq, groundOnly, airOnly) {
    const enemies = world.enemies;
    const ox = this.x;
    const oy = this.y;
    const past = this.lastTargetProgress;

    let next = null;
    let nextProgress = Infinity;
    let first = null;
    let firstProgress = Infinity;

    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;

      const dx = enemy.x - ox;
      const dy = enemy.y - oy;
      if (dx * dx + dy * dy > rangeSq) continue;

      if (enemy.d.flying) {
        if (groundOnly) continue;
      } else if (airOnly) {
        continue;
      }

      const progress = enemy.progress;
      if (progress < firstProgress) {
        firstProgress = progress;
        first = enemy;
      }
      if (progress > past && progress < nextProgress) {
        nextProgress = progress;
        next = enemy;
      }
    }

    // Wrapping is what keeps it sweeping rather than fixing forever on the one
    // enemy it cannot finish.
    return next ?? first;
  }

  update(dt, world) {
    // Decay before the cooldown gate: the recoil has to settle even on frames
    // where the tower is not ready to fire again.
    if (this.muzzle > 0.0) this.muzzle = Math.max(0.0, this.muzzle - dt * MUZZLE_DECAY);

    // A beam does not fire shots: it locks a target for a pulse, melts it the
    // whole time, then rests for a gap. Its own cycle replaces the cooldown.
    if (this.d.attack === 'beam') {
      this._updateBeam(dt, world);
      return;
    }

    this.cooldown -= dt;
    if (this.cooldown > 0.0) return;

    const target = this.acquire(world);
    if (target === null) return;

    const desired = Math.atan2(target.y - this.y, target.x - this.x);
    this.angle = rotateToward(
      this.angle,
      desired,
      ((this.d.rotation_speed * Math.PI) / 180.0) * dt,
    );

    if (Math.abs(angleDifference(this.angle, desired)) > AIM_TOLERANCE_RADIANS) return;

    this.fire(target, world);
    this.cooldown = 1.0 / this.rate;
  }

  /** Whether the current beam target is still in range and a legal target. */
  inBeamRange(enemy) {
    const dx = enemy.x - this.x;
    const dy = enemy.y - this.y;
    return dx * dx + dy * dy <= this.range * this.range && this.canTarget(enemy);
  }

  /**
   * The laser's pulse cycle.
   *
   * A pulse locks one target and melts it continuously; `beamCharge` ramps the
   * longer the tower stays on the SAME target, which is the "eats away" feel --
   * the first second is a tickle and the fifth is a column of light. Losing the
   * target or switching to a new one resets the ramp. After a pulse the tower
   * rests for a gap before picking up again, which is what stops a single laser
   * from simply being a better gatling.
   */
  _updateBeam(dt, world) {
    const beam = this.beam;
    if (beam === null) return;

    // Mid-pulse: hold the lock and melt.
    if (this.beamTime > 0.0) {
      this.beamTime -= dt;
      const target = this.beamTarget;
      if (target !== null && target.alive && this.inBeamRange(target)) {
        const desired = Math.atan2(target.y - this.y, target.x - this.x);
        this.angle = rotateToward(
          this.angle,
          desired,
          ((this.d.rotation_speed * Math.PI) / 180.0) * dt,
        );
        this.beamCharge = Math.min(this.rampMax, this.beamCharge + this.rampPerSec * dt);
        this.beamAccumulator += this.damage * (1.0 + this.beamCharge) * dt;
        while (this.beamAccumulator >= BEAM_TICK) {
          this.beamAccumulator -= BEAM_TICK;
          world.applyDamage(
            this,
            target,
            this.damage * (1.0 + this.beamCharge) * BEAM_TICK,
            this.d.damage_type,
            { showFx: false },
          );
        }
        if (this.beamTime <= 0.0) {
          // Flush the remainder as one last hit so nothing is lost.
          if (this.beamAccumulator > 0.0) {
            world.applyDamage(
              this,
              target,
              this.beamAccumulator,
              this.d.damage_type,
              { showFx: false },
            );
            this.beamAccumulator = 0.0;
          }
          this.beamTarget = null;
          this.beamGap = this.gapDuration;
        }
      } else {
        this.beamTarget = null;
        this.beamTime = 0.0;
        this.beamGap = this.gapDuration;
        this.beamCharge = 0.0;
        this.beamAccumulator = 0.0;
      }
      return;
    }

    // Resting between pulses.
    if (this.beamGap > 0.0) {
      this.beamGap -= dt;
      return;
    }

    // Pick up a new target and open the beam.
    const target = this.acquire(world);
    if (target === null) return;

    // The ramp belongs to a single target: switching resets it, while coming
    // back to the same enemy continues where it left off.
    if (this._beamChargeEid !== target.eid) {
      this.beamCharge = 0.0;
      this._beamChargeEid = target.eid;
    }
    this.beamTarget = target;
    this.beamTime = this.pulseDuration;
    this.shots += 1;
    this.muzzle = 1.0;
    this.lastTargetProgress = target.progress;
    // Burn and shred land once per pulse, not on every damage tick.
    world._applyRiders(this, target, this);
  }

  fire(target, world) {
    this.shots += 1;
    this.muzzle = 1.0;
    /**
     * Recorded on every shot, whatever the mode.
     *
     * It is the sweep position for `sequential`, and free to maintain for the
     * rest -- branching on the mode here would save nothing and would put the
     * one line that keeps sequential correct behind a condition.
     */
    this.lastTargetProgress = target.progress;

    const attack = this.d.attack;
    if (attack === 'projectile') world.spawnProjectile(this, target);
    else if (attack === 'hitscan') world.fireHitscan(this, target);
    else world.fireChain(this, target);
  }
}

/**
 * Enemy entities.
 *
 * Hot-path class: plain fields, no getters, and locals over repeated property
 * lookups, because there can be several hundred alive at once and every one of
 * them is stepped 60 times a second.
 */

/**
 * Hard ceiling on total crowd-control resistance, from any source.
 *
 * Below 1.0 so that no enemy can ever become fully immune to a slow: the
 * late-game curve *reduces* what a frost build achieves, it does not switch
 * that build off. Kept here rather than in data because it is a correctness
 * bound on `applySlow`, not a tunable -- a value of 1.0 would make slows
 * silently do nothing, which reads as a bug rather than as difficulty.
 */
const CC_RESIST_CEILING = 0.85;

export class Enemy {
  constructor(eid, d, path, {
    hpMult = 1.0,
    speedMult = 1.0,
    bountyMult = 1.0,
    armorBonus = 0.0,
    ccResistBonus = 0.0,
  } = {}) {
    this.eid = eid;
    this.key = d.key;
    this.d = d;
    this.path = path;

    // Visual mutant index, resolved once at spawn from the eid. The renderer
    // uses it to pick between the base atlas row and its `_v1`/`_v2` variants,
    // so a crowd of one type reads as a population. Purely cosmetic.
    this.variant = eid % 3;

    this.maxHp = d.hp * hpMult;
    this.hp = this.maxHp;

    /**
     * Flat armour granted by the wave, on top of the type's own.
     *
     * Stored on the instance rather than read from the wave manager, because it
     * is fixed at spawn and `effectiveArmor` is consulted on every hit.
     */
    this.armorBonus = armorBonus;

    /**
     * Crowd-control resistance granted by the wave, on top of the type's own.
     *
     * Same reasoning as `armorBonus`: fixed at spawn, so it is stored rather
     * than recomputed on every slow applied. Without it a frost build's slow
     * never diminished, because `d.cc_resist` is a constant per type and seven
     * of the eleven types sit at 0.0.
     */
    this.ccResistBonus = ccResistBonus;

    this.dist = 0.0;
    this.progress = 0.0;
    this.speedMult = speedMult;
    this.bounty = d.bounty * bountyMult;
    // Base damage on leak. Easy to forget: without it `baseHp -= undefined`
    // turns the base health into NaN, and `NaN <= 0` is false, so the run can
    // never actually be lost.
    this.leak = d.leak;

    this.alive = true;
    this.leaked = false;
    this.killed = false;

    this.slowTime = 0.0;
    this.slowFactor = 1.0;

    /** Ground modifiers, refreshed each step from the terrain. */
    this.terrainSpeed = 1.0;
    this.terrainDamageTaken = 1.0;

    /**
     * Active damage-over-time stacks: [dps, secondsLeft, ownerTower, dtype].
     *
     * Poison and burn share this list -- the damage type on each stack is what
     * tells them apart, so a tower can apply both without either overwriting
     * the other's stack budget.
     */
    this.dots = [];

    /** Flat armour removed by corrosive hits, and the seconds that lasts. */
    this.armorShred = 0.0;
    this.armorShredTime = 0.0;

    /**
     * Shield pool.
     *
     * A second health bar that refills, not a flat resistance. Damage is eaten
     * by the pool before it reaches health, and the pool only starts refilling
     * after `shield_delay` seconds without being hit -- so sustained fire keeps
     * one down while intermittent chip damage never gets past it at all.
     *
     * Scaled by `hpMult` alongside health, because a flat pool against an
     * exponentially growing health bar is not a weak barrier, it is no barrier.
     * Authored flat, the Bulwark's 200-point pool fell from 62% of its health at
     * wave 1 to 0.5% at wave 30 and 0.009% at wave 70 -- so past the early game
     * the shield was stripped by the first shot of any tower and `shield_mult`
     * stopped mattering at all. That silently deleted the counterplay the pool
     * exists to create: energy damage is meant to be the answer to a shielded
     * type (1.5x against physical's 0.5x), and it was an answer to nothing.
     *
     * Scaling pool and regeneration by the *same* factor keeps the seconds-to-
     * refill the authored constant: `shield_delay` is the design decision, and
     * the rate only has to be proportional to the pool for that to hold.
     *
     * `shielded` mirrors "the pool is up" and is what the damage matrix reads
     * to pick `shield_mult`, so it has to track the pool rather than be a static
     * property of the type.
     */
    this.shieldMax = (d.shield ?? 0.0) * hpMult;
    this.shield = this.shieldMax;
    this.shieldRegen = (d.shield_regen ?? 0.0) * hpMult;
    this.shieldHold = 0.0;
    this.shielded = this.shieldMax > 0.0;

    const [x, y, angle] = path.posAt(0.0);
    this.x = x;
    this.y = y;
    this.angle = angle;
  }

  /**
   * Apply damage, returning the amount actually dealt.
   *
   * A shield eats damage before health does. Damage that goes into the shield
   * still counts as dealt, so a tower is not starved of credit -- or of the
   * experience that drives levelling -- merely for shooting something armoured.
   */
  takeDamage(amount) {
    if (amount <= 0.0 || !this.alive) return 0.0;

    let remaining = amount;
    let dealt = 0.0;

    if (this.shield > 0.0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      dealt += absorbed;
      if (this.shield <= 0.0) {
        this.shield = 0.0;
        this.shielded = false;
      }
    }

    // Any hit restarts the delay, shielded or not, so a barrier does not refill
    // while it is still being worked on.
    this.shieldHold = this.d.shield_delay ?? 0.0;

    if (remaining <= 0.0) return dealt;

    if (remaining >= this.hp) {
      dealt += this.hp;
      this.hp = 0.0;
      this.alive = false;
      this.killed = true;
      return dealt;
    }

    this.hp -= remaining;
    return dealt + remaining;
  }

  heal(amount) {
    if (amount <= 0.0 || !this.alive) return 0.0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
  }

  /** `factor` is a speed multiplier (0.65 = 35% slow). */
  applySlow(factor, duration) {
    /*
      Capped below 1.0 so that a late wave is slow-*resistant*, never
      slow-immune: a hardened enemy still eats a real fraction of the slow, so
      frost towers remain worth their slots instead of being switched off by a
      curve. The type's own `cc_resist` and the wave's bonus stack here, which
      is why the sum is clamped rather than either value alone.
    */
    const resist = Math.min(CC_RESIST_CEILING, this.d.cc_resist + this.ccResistBonus);
    const strength = (1.0 - factor) * (1.0 - resist);
    if (strength <= 0.0 || duration <= 0.0) return;

    const effective = 1.0 - strength;
    if (effective < this.slowFactor) this.slowFactor = effective;
    this.slowTime = Math.max(this.slowTime, duration * (1.0 - resist));
  }

  /**
   * Armour actually applied to incoming hits.
   *
   * Derived rather than stored on `d`: the definition object is shared by every
   * enemy of that type, so corrosion must not write into it.
   */
  get effectiveArmor() {
    return Math.max(0.0, this.d.armor + this.armorBonus - this.armorShred);
  }

  /**
   * Add a damage-over-time stack.
   *
   * @param {string} dtype damage type each tick resolves as (poison, fire, ...)
   */
  applyDot(dps, duration, maxStacks, owner = null, dtype = 'poison') {
    if (dps <= 0.0 || duration <= 0.0 || maxStacks <= 0 || !this.alive) return;

    const dots = this.dots;
    if (dots.length < maxStacks) {
      dots.push([dps, duration, owner, dtype]);
      return;
    }

    // Replace the weakest active stack so a stronger one is never lost.
    let weakest = 0;
    for (let i = 1; i < dots.length; i += 1) {
      if (dots[i][0] < dots[weakest][0]) weakest = i;
    }
    if (dots[weakest][0] < dps) {
      dots[weakest] = [dps, duration, owner, dtype];
    } else {
      dots[weakest][1] = Math.max(dots[weakest][1], duration);
    }
  }

  /** Melt armour off, lasting `duration` seconds. Strongest active shred wins. */
  applyShred(amount, duration) {
    if (amount <= 0.0 || duration <= 0.0 || !this.alive) return;
    this.armorShred = Math.max(this.armorShred, amount);
    this.armorShredTime = Math.max(this.armorShredTime, duration);
  }

  update(dt, world) {
    if (!this.alive) return;

    if (this.dots.length > 0) {
      this._tickDots(dt, world);
      if (!this.alive) return;
    }

    if (this.armorShredTime > 0.0) {
      this.armorShredTime -= dt;
      if (this.armorShredTime <= 0.0) {
        this.armorShredTime = 0.0;
        this.armorShred = 0.0;
      }
    }

    // Shields refill only after a quiet period, which is what makes sustained
    // fire the answer and a single big hit followed by nothing not enough.
    if (this.shieldMax > 0.0) {
      if (this.shieldHold > 0.0) {
        this.shieldHold -= dt;
      } else if (this.shield < this.shieldMax) {
        this.shield = Math.min(this.shieldMax, this.shield + this.shieldRegen * dt);
        this.shielded = true;
      }
    }

    if (this.slowTime > 0.0) {
      this.slowTime -= dt;
      if (this.slowTime <= 0.0) {
        this.slowTime = 0.0;
        this.slowFactor = 1.0;
      }
    }

    const d = this.d;
    if (d.heal_per_sec > 0.0) this._healAllies(dt, world);

    // Ground under the enemy. Speed is eased toward the new value rather than
    // switched, or crossing a tile boundary would pop visibly.
    if (world.terrain) {
      const band = world.terrain.bandAtPoint(this.x, this.y);
      this.terrainDamageTaken = band.enemy.damage_taken;
      this.terrainSpeed += (band.enemy.speed - this.terrainSpeed) * Math.min(1.0, dt * 3.0);
    }

    const weather = world.weather === undefined ? 1.0 : world.weather.enemySpeed;
    const speed = d.speed * this.speedMult * this.slowFactor * this.terrainSpeed * weather;
    this.dist += speed * dt;

    if (this.dist >= this.path.length) {
      this.alive = false;
      this.leaked = true;
      world.onLeak(this);
      return;
    }

    const [x, y, angle] = this.path.posAt(this.dist);
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.progress = this.dist / this.path.length;
  }

  _tickDots(dt, world) {
    const dots = this.dots;
    for (let i = 0; i < dots.length; i += 1) {
      const entry = dots[i];
      if (entry[1] <= 0.0) continue;

      world.applyDamage(entry[2], this, entry[0] * dt, entry[3], { showFx: false });
      if (!this.alive) break;
      entry[1] -= dt;
    }

    // Most frames nothing expires; only rebuild the array when something does.
    let expired = false;
    for (let i = 0; i < dots.length; i += 1) {
      if (dots[i][1] <= 0.0) {
        expired = true;
        break;
      }
    }
    if (expired) this.dots = dots.filter((entry) => entry[1] > 0.0);
  }

  _healAllies(dt, world) {
    const d = this.d;
    const radius = d.heal_radius;
    const radiusSq = radius * radius;
    const amount = d.heal_per_sec * dt;

    const enemies = world.enemies;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other === this || !other.alive || other.hp >= other.maxHp) continue;
      const dx = other.x - this.x;
      const dy = other.y - this.y;
      if (dx * dx + dy * dy <= radiusSq) other.heal(amount);
    }
  }
}

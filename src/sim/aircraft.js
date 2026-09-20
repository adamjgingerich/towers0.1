/**
 * Aircraft.
 *
 * A barracks that has taken an air wing fields real units: they launch from the
 * structure, fly to whatever is inside its strike range, attack at the rate the
 * power-up defined, and go home when the sky is clear.
 *
 * ## Why this is not a Tower
 *
 * A tower is bolted to a tile, draws range from where it stands, levels up, aims
 * with a rotation speed, and can be sold on its own. An aircraft moves, belongs
 * to a barracks, never levels, and dies with its parent. Sharing the Tower class
 * would mean half a dozen flags that exactly one caller reads.
 *
 * ## Why it still implements part of Tower's surface
 *
 * `World.applyDamage` expects an owner to carry `damageDealt`, `kills`,
 * `bountyMult`, `trueDamage`, `executeBelow`, `addXp` and `supportSources`. That
 * is a small enough contract to satisfy honestly, and satisfying it is what lets
 * aircraft go through the same armour, crit, splash and bounty path as every
 * other source of damage -- rather than through a parallel one that would
 * eventually disagree with it.
 *
 * `supportSources` holds the parent barracks, so aircraft damage credits the
 * structure that launched them and levels it. An air wing pays for its own
 * upgrades.
 *
 * Pure simulation: no three.js, no DOM.
 */

import { Fx } from './fx.js';

const IDLE = 'idle';
const OUTBOUND = 'outbound';
const ATTACKING = 'attacking';
const RETURNING = 'returning';

/** How close to the pad counts as home, in tiles. */
const DOCK_RADIUS = 0.42;
/** Radius of the idle orbit around the barracks, in tiles. */
const ORBIT_RADIUS = 0.85;
/** Radians per second the idle orbit advances. */
const ORBIT_SPEED = 0.9;

export class Aircraft {
  /**
   * @param {number} id stable identity, used only for the orbit slot
   * @param {string} kind aircraft key, e.g. 'fighter'
   * @param {object} d parsed per-kind stats from `barracks.aircraft`
   * @param {import('./barracks.js').Barracks} barracks the parent structure
   * @param {number} rate attacks per second, set by the power-up that bought it
   */
  constructor(id, kind, d, barracks, rate) {
    this.id = id;
    this.kind = kind;
    this.d = d;
    this.barracks = barracks;
    this.rate = rate > 0 ? rate : d.rate;

    this.x = barracks.x;
    this.y = barracks.y;
    this.angle = 0;
    this.state = IDLE;
    this.target = null;
    this.cool = 0;

    /**
     * Condition.
     *
     * Wears down while the aircraft is away from its pad and recovers on it.
     * `maxHp` of 0 means the type has no condition model and is never destroyed,
     * which is what a data file without these numbers should get.
     */
    this.maxHp = d.hp;
    this.hp = d.hp;
    /** Seconds left before a destroyed aircraft is rebuilt. */
    this.rebuildLeft = 0;
    /** Whether the last sortie ended in it being lost, for the inspector. */
    this.lost = false;

    /**
     * Idle orbit phase.
     *
     * Seeded from the id so a wing spreads around the pad instead of stacking on
     * one point, which is the difference between "a squadron" and "one sprite".
     */
    this.orbit = (id % 8) * (Math.PI / 4);

    this.alive = true;

    // --- the owner surface World.applyDamage reads ---
    this.trueDamage = false;
    this.executeBelow = 0;
    this.damageDealt = 0;
    this.kills = 0;
    this.bountyMult = 1;
    this.supportSources = [barracks];
  }

  /**
   * Aircraft do not level.
   *
   * `applyDamage` calls this on every hit, so it has to exist. Returning 0 is
   * cheaper than a null check on the damage hot path for the sake of one caller.
   */
  addXp() {
    return 0;
  }

  /**
   * Whether this unit will engage a given enemy.
   *
   * Mirrors `Tower.canTarget` deliberately, including its argument order, so the
   * aircraft can be handed straight to `world.nearestEnemy` as its filter. A
   * tank is `ground_only`, which is the entire cost that buys its higher damage.
   */
  canTarget(enemy) {
    if (enemy.d.flying) return !this.d.ground_only;
    return !this.d.air_only;
  }

  /** Whether a target is still inside the parent structure's strike range. */
  inStrikeRange(enemy) {
    const b = this.barracks;
    const dx = enemy.x - b.x;
    const dy = enemy.y - b.y;
    return dx * dx + dy * dy <= this.d.range * this.d.range;
  }

  update(dt, world) {
    // A destroyed aircraft is off the board: it neither flies nor shoots, and
    // its only job is to count down to being rebuilt.
    if (!this.alive) {
      this.rebuildLeft -= dt;
      if (this.rebuildLeft <= 0) this._rebuild();
      return;
    }

    this._fly(dt, world);
    this._condition(dt, world);
  }

  /**
   * Wear and recovery.
   *
   * This is what makes a wing a rotating asset rather than a flat damage bonus.
   * An aircraft that keeps coming home never dies; one that is sent far out and
   * left there does. So the wing's uptime is really a question about how close
   * the fighting is to the barracks, which is the same question the aura asks --
   * and the two answers pull in the same direction.
   */
  _condition(dt, world) {
    const d = this.d;
    if (this.maxHp <= 0) return;

    if (this.state === IDLE) {
      // Faster to repair than to wear, so a wing that does come home is back in
      // the fight quickly rather than sitting out the rest of the wave.
      this.hp = Math.min(this.maxHp, this.hp + d.repair * dt);
      return;
    }

    this.hp -= d.attrition * dt;
    if (this.hp <= 0.0) {
      this.hp = 0.0;
      this._destroy(world);
    }
  }

  /**
   * Shoot down.
   *
   * Deliberately not instantaneous to replace. `rebuild` is longer than either
   * `repair` or the wear rate, so losing a wing costs the player real time and
   * defending by rotation beats defending by throwing aircraft at the problem.
   */
  _destroy(world) {
    this.alive = false;
    this.lost = true;
    this.rebuildLeft = this.d.rebuild;
    this.target = null;
    this.state = IDLE;
    world.addFx(Fx.sprite('boom', this.x, this.y, 0.34, 0.34));
    world.addFx(Fx.sprite('smoke', this.x, this.y, 0.6, 0.5));
  }

  /** Back on the pad, at full condition, ready to launch again. */
  _rebuild() {
    const b = this.barracks;
    this.alive = true;
    this.lost = false;
    this.hp = this.maxHp;
    this.cool = 0;
    this.target = null;
    this.state = IDLE;
    this.x = b.x;
    this.y = b.y;
  }

  _fly(dt, world) {
    const d = this.d;
    const b = this.barracks;

    if (this.cool > 0) this.cool -= dt;

    // Drop a target that died, has left the structure's reach, or is no longer
    // something this unit may engage. An aircraft is a sortie from a base, not
    // an independent hunter: letting it chase across the map would make
    // placement stop mattering for the wing, and placement is the whole point of
    // the barracks. The `canTarget` check matters for a tank, so one that had
    // locked a ground target drops the lock rather than holding something it
    // cannot shoot.
    if (
      this.target
      && (!this.target.alive
        || !this.canTarget(this.target)
        || !this.inStrikeRange(this.target))
    ) {
      this.target = null;
      this.state = RETURNING;
    }

    if (!this.target) {
      // The `null` is the exclude-set, and `this` is the target filter: an
      // aircraft with no restriction shoots at anything, which is the one thing
      // the wing does that no single tower can. A tank filters flyers out here.
      this.target = world.nearestEnemy(b.x, b.y, d.range, null, this);
      if (this.target) this.state = OUTBOUND;
    }

    if (!this.target) {
      this._goHome(dt, b);
      return;
    }

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const dist = Math.hypot(dx, dy);
    this.angle = Math.atan2(dy, dx);

    if (dist > d.attack_range) {
      // Fly to a standoff distance rather than to the target's centre, so a wing
      // does not pile onto one pixel and a fast fighter does not overshoot it.
      const step = Math.min(dist - d.attack_range, d.speed * dt);
      if (dist > 1e-4) {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }
      this.state = OUTBOUND;
      return;
    }

    this.state = ATTACKING;
    if (this.cool > 0) return;
    this.cool = 1 / this.rate;
    this._strike(world);
  }

  /** Circle the pad when there is nothing to shoot. */
  _goHome(dt, barracks) {
    const dx = barracks.x - this.x;
    const dy = barracks.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (this.state !== IDLE && dist > DOCK_RADIUS) {
      this.state = RETURNING;
      const step = Math.min(dist, this.d.speed * dt);
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
      this.angle = Math.atan2(dy, dx);
      return;
    }

    this.state = IDLE;
    this.orbit += ORBIT_SPEED * dt;
    const targetX = barracks.x + Math.cos(this.orbit) * ORBIT_RADIUS;
    const targetY = barracks.y + Math.sin(this.orbit) * ORBIT_RADIUS;
    // Ease onto the orbit instead of snapping to it, so returning aircraft curve
    // in rather than jumping when they arrive.
    this.x += (targetX - this.x) * Math.min(1, dt * 4.0);
    this.y += (targetY - this.y) * Math.min(1, dt * 4.0);
    this.angle = this.orbit + Math.PI / 2;
  }

  _strike(world) {
    const d = this.d;
    const target = this.target;
    if (!target) return;

    if (d.splash > 0) {
      // Aimed at where the target is, not at the target object: a bomber is
      // dropping ordnance, and ordnance does not home.
      world.applyBlast(this, target.x, target.y, d.splash, d.damage, d.damage_type);
    } else {
      world.applyDamage(this, target, d.damage, d.damage_type);
    }
  }
}

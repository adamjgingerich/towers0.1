/**
 * Projectiles.
 *
 * Pooled and preallocated. At 400 concurrent projectiles, allocating a fresh
 * object per shot is the difference between holding 60 FPS and not. The pool
 * slot index doubles as the instanced-mesh slot index in the renderer, so the
 * allocation strategy and the draw strategy are the same shape.
 */

/** Slack added to an enemy's radius when testing for a hit. */
export const HIT_PADDING = 0.08;

/** Squared distance from point p to segment ab (swept-collision test). */
function segmentDistanceSq(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-12) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

export class Projectile {
  constructor(slot = 0) {
    this.slot = slot;
    this.alive = false;
    this.x = 0.0;
    this.y = 0.0;
    this.vx = 0.0;
    this.vy = 0.0;
    this.speed = 0.0;
    this.damage = 0.0;
    this.damageType = 'physical';
    this.target = null;
    this.owner = null;
    this.splash = 0.0;
    this.sprite = 'bullet';
    this.angle = 0.0;
    this.life = 0.0;
    this.slowFactor = 1.0;
    this.slowDuration = 0.0;
    this.poisonDps = 0.0;
    this.poisonDuration = 0.0;
    this.poisonStacks = 0;
    this.burnDps = 0.0;
    this.burnDuration = 0.0;
    this.burnStacks = 0;
    this.armorShred = 0.0;
    this.armorShredDuration = 0.0;
    this.trueDamage = false;
    /** Extra enemies this shot may pass through before it dies. */
    this.pierce = 0;
    /** Already-hit enemies, so a piercing shot cannot hit the same one twice. */
    this.hitIds = new Set();
  }

  launch(owner, target, rng = null) {
    const d = owner.d;

    this.owner = owner;
    this.target = target;
    // Read the tower's resolved stats, never the definition: specialisations
    // change damage, range, blast, speed and every rider effect.
    this.damage = owner.rawDamageAgainst(target, rng);
    this.damageType = d.damage_type;
    this.speed = owner.projectileSpeed;
    this.splash = owner.splash;
    this.sprite = d.projectile_sprite || 'bullet';
    this.slowFactor = owner.slowFactor;
    this.slowDuration = owner.slowDuration;
    this.poisonDps = owner.poisonDps;
    this.poisonDuration = owner.poisonDuration;
    this.poisonStacks = owner.poisonStacks;
    this.burnDps = owner.burnDps;
    this.burnDuration = owner.burnDuration;
    this.burnStacks = owner.burnStacks;
    this.armorShred = owner.armorShred;
    this.armorShredDuration = owner.armorShredDuration;
    this.trueDamage = owner.trueDamage;
    this.pierce = owner.pierce;
    this.hitIds.clear();

    const muzzle = 0.30;
    const angle = Math.atan2(target.y - owner.y, target.x - owner.x);
    this.angle = angle;
    this.x = owner.x + Math.cos(angle) * muzzle;
    this.y = owner.y + Math.sin(angle) * muzzle;
    this.vx = Math.cos(angle) * this.speed;
    this.vy = Math.sin(angle) * this.speed;

    // Generous lifetime: extra range acts as a safety net for lost targets.
    this.life = (owner.range + 1.5) / Math.max(this.speed, 0.001) + 0.4;
    this.alive = true;
  }

  update(dt, world) {
    const target = this.target;
    const prevX = this.x;
    const prevY = this.y;

    if (target !== null && target.alive) {
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 1e-6) {
        // Perfect homing: direction is re-aimed every step.
        this.vx = (dx / distance) * this.speed;
        this.vy = (dy / distance) * this.speed;
        this.angle = Math.atan2(dy, dx);
      }
    } else {
      this.target = null;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;

    if (target !== null && target.alive) {
      const hitRadius = target.d.radius + HIT_PADDING;
      const distSq = segmentDistanceSq(prevX, prevY, this.x, this.y, target.x, target.y);
      if (distSq <= hitRadius * hitRadius) {
        world.onProjectileHit(this, target);
        return;
      }
    }

    if (this.life <= 0.0) {
      if (this.splash > 0.0) world.detonate(this, this.x, this.y);
      else world.releaseProjectile(this);
    }
  }
}

/**
 * Damage resolution.
 *
 * Armor is flat subtraction (scaled per damage type), resistance is a
 * multiplicative reduction applied afterwards, and a damage floor guarantees
 * no tower/enemy matchup is ever fully immune.
 */

export class DamageMatrix {
  constructor(floor, types) {
    /** Fraction of raw damage that always gets through. */
    this.floor = floor;
    this.types = types;
  }

  profile(dtype) {
    return this.types[dtype] ?? null;
  }

  /**
   * Final damage actually dealt for a single hit.
   */
  resolve(raw, dtype, { armor = 0, resist = null, armorClass = 'light', shielded = false } = {}) {
    const profile = this.types[dtype];
    if (!profile) return 0;

    let amount = raw * (profile.class_mult[armorClass] ?? 1.0);
    if (shielded) amount *= profile.shield_mult;

    const effectiveArmor = armor * profile.armor_mult;
    const afterArmor = Math.max(this.floor * amount, amount - effectiveArmor);

    const reduction = resist ? (resist[dtype] ?? 0.0) : 0.0;
    return afterArmor * (1.0 - reduction);
  }
}

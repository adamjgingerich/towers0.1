/**
 * The shop key for a barracks.
 *
 * Shared rather than spelled out at each call site: it is the one "tower key" that
 * is not a tower, so every place that walks the shop or handles a placement has to
 * single it out, and a typo in one of them would silently treat a barracks as a
 * tower.
 */
export const BARRACKS_KEY = 'barracks';

/**
 * Barracks: the structure that gates tower count and buffs the towers near it.
 *
 * Two jobs, and they pull in the same direction. A barracks raises how many
 * towers the run may field, so it is the price of getting bigger; and it makes
 * the towers inside its aura hit harder, so it also decides *where* the ones you
 * already have should stand. A barracks dumped in an empty corner is a wasted
 * purchase, which is the whole point -- it is a placement decision, not a tax.
 *
 * Experience comes mostly from damage dealt by towers inside the aura. That
 * makes evolution a consequence of the fighting rather than of elapsed time, so
 * a barracks evolves quickly when it is where it should be and crawls when it is
 * not.
 *
 * Pure simulation: no three.js, no DOM, so it runs under the balance probe.
 */

export class Barracks {  /**
   * @param {object} d parsed `data/barracks.json`
   * @param {number} tx tile column
   * @param {number} ty tile row
   * @param {number} cost what this particular barracks actually cost (cost rises)
   */
  constructor(d, tx, ty, cost) {
    this.d = d;
    this.kind = 'barracks';
    this.tx = tx;
    this.ty = ty;
    this.x = tx + 0.5;
    this.y = ty + 0.5;

    this.alive = true;
    this.level = 1;
    this.xp = 0.0;
    this.invested = cost;
    this.levelsGained = 0;

    /**
     * Level -> chosen power key.
     *
     * Level 1 arrives with the structure and takes no power, so the first
     * choice is at level 2. Kept as a plain object rather than a Map so it
     * serialises straight through the save format.
     */
    this.powers = {};

    /** Towers currently inside the aura, refreshed by the world. */
    this.supported = [];

    /**
     * Supply links to other bases, as tile keys ("tx,ty"). Connecting two bases
     * draws a pathway between them and lets their wings be re-homed across it.
     */
    this.links = [];

    /**
     * Wing re-homing. `transfersOut` is kind -> {tileKey -> count} of aircraft
     * sent to other bases; `transfersIn` is kind -> {count, rate} of aircraft
     * received from them. Plain objects so they serialise like `powers`.
     */
    this.transfersOut = {};
    this.transfersIn = {};
  }

  /** Distance at which this barracks reaches, in tiles. */
  get radius() {
    const aura = this.d.aura;
    return aura.radius + this.radiusBonus() + (this.level - 1) * aura.radius_per_level;
  }

  /** The power options the barracks is waiting to take, or an empty list. */
  pendingOptions() {
    const entry = this.pendingEntry();
    return entry ? entry.options : [];
  }

  /** The level waiting for a choice, or 0 when there is nothing pending. */
  pendingLevel() {
    const entry = this.pendingEntry();
    return entry ? entry.level : 0;
  }

  /**
   * The lowest level that has been reached but not yet spent.
   *
   * Levels are earned by experience and spent by choosing, and the two are not
   * the same event: a barracks can cross two thresholds during one wave and owes
   * two choices. Returning the lowest keeps the queue in order.
   *
   * Level 1 is included. The structure arrives owing one choice -- that is what
   * "a power-up at every level" means, and excluding it silently dropped the
   * first option in the table, which looked like a working choice the player
   * could never take.
   */
  pendingEntry() {
    const powers = this.d.powers;
    if (!powers) return null;
    for (const entry of powers) {
      if (entry.level > this.level) break;
      if (this.powers[entry.level] === undefined) return entry;
    }
    return null;
  }

  /** The option definition behind a chosen key, or null. */
  chosenOption(level) {
    const key = this.powers[level];
    if (key === undefined) return null;
    const entry = this.d.powers?.find((p) => p.level === level);
    return entry?.options.find((o) => o.key === key) ?? null;
  }

  /** Every chosen option, in level order. */
  chosenOptions() {
    const out = [];
    for (const entry of this.d.powers ?? []) {
      const option = this.chosenOption(entry.level);
      if (option) out.push(option);
    }
    return out;
  }

  /**
   * Take a power.
   *
   * @returns {object|null} the option taken, or null if it was not on offer
   */
  choosePower(key) {
    const entry = this.pendingEntry();
    if (!entry) return null;
    const option = entry.options.find((o) => o.key === key);
    if (!option) return null;
    this.powers[entry.level] = key;
    return option;
  }

  /**
   * Extra tower capacity granted by chosen powers.
   *
   * Summed rather than multiplied, and read by the world's capacity formula,
   * because capacity is the one number a player plans a whole run around. */
  capacityBonus() {
    let total = 0;
    for (const option of this.chosenOptions()) total += option.capacity ?? 0;
    return total;
  }

  /** Extra aura radius granted by chosen powers, in tiles. */
  radiusBonus() {
    let total = 0;
    for (const option of this.chosenOptions()) total += option.radius ?? 0;
    return total;
  }

  /**
   * The aircraft this barracks fields, one entry per kind.
   *
   * Options may carry a single `air` object or a list of them, and two options
   * of the same kind add their counts -- a player who takes both Fighter Wing
   * and Second Wing has five fighters, not two wings of different sizes.
   */
  airRoster() {
    const out = new Map();
    for (const option of this.chosenOptions()) {
      if (!option.air) continue;
      const list = Array.isArray(option.air) ? option.air : [option.air];
      for (const spec of list) {
        const existing = out.get(spec.kind);
        if (existing) {
          existing.count += spec.count;
          // The later, better rate wins rather than averaging: a power that
          // says "attacking 1.6 times a second" should deliver that, not a
          // blend of that and an older wing's 1.2.
          existing.rate = Math.max(existing.rate, spec.rate);
        } else {
          out.set(spec.kind, { kind: spec.kind, count: spec.count, rate: spec.rate });
        }
      }
    }
    return [...out.values()];
  }

  /**
   * What is actually stationed here: the powers roster, minus what has been
   * sent to linked bases, plus what they have sent over.
   *
   * `airRoster()` is what the base *owns*; this is what it *fields*. The world
   * builds the wing from this, so a transfer survives the next rebuild instead
   * of being silently undone the moment a power is taken or a base is placed.
   */
  fieldedRoster() {
    const out = [];
    for (const spec of this.airRoster()) {
      const sent = Object.values(this.transfersOut[spec.kind] ?? {})
        .reduce((sum, n) => sum + (n ?? 0), 0);
      const count = spec.count - sent;
      if (count > 0) out.push({ kind: spec.kind, count, rate: spec.rate });
    }
    for (const [kind, t] of Object.entries(this.transfersIn)) {
      if (!t || !(t.count > 0)) continue;
      const existing = out.find((s) => s.kind === kind);
      if (existing) {
        existing.count += t.count;
        existing.rate = Math.max(existing.rate, t.rate ?? 0);
      } else {
        out.push({ kind, count: t.count, rate: t.rate ?? 0 });
      }
    }
    return out;
  }

  /** Whether a supply pathway exists to the given base. */
  isLinkedTo(other) {
    return this.links.includes(`${other.tx},${other.ty}`);
  }

  /** Add a supply pathway to another base. Returns false if it already exists. */
  linkTo(other) {
    if (this.isLinkedTo(other)) return false;
    this.links.push(`${other.tx},${other.ty}`);
    return true;
  }

  /**
   * The promotion this barracks currently holds.
   *
   * Derived from the level rather than stored, so a save that predates ranks --
   * or one written by a build with a different rank table -- resolves to
   * whatever the current data says that level is, and cannot drift out of sync
   * with its own level.
   */
  get rankIndex() {
    const ranks = this.d.ranks;
    if (!ranks || ranks.length === 0) return 0;
    let index = 0;
    for (let i = 0; i < ranks.length; i += 1) {
      if (this.level >= ranks[i].at) index = i;
    }
    return index;
  }

  get rank() {
    const ranks = this.d.ranks;
    if (!ranks || ranks.length === 0) return null;
    return ranks[this.rankIndex];
  }

  /** What to call the structure right now, e.g. "Citadel". */
  get rankName() {
    return this.rank?.name ?? this.d.name;
  }

  /**
   * The sprite row to draw this promotion from, 1-based.
   *
   * 1-based because the atlas rows are named `barracks_1` upward, and an
   * off-by-one here would silently show every barracks as an Outpost.
   */
  get rankArt() {
    return this.rankIndex + 1;
  }

  /** The next promotion, or null when this is the last one. */
  nextRank() {
    const ranks = this.d.ranks;
    if (!ranks) return null;
    const index = this.rankIndex;
    return index + 1 < ranks.length ? ranks[index + 1] : null;
  }

  /**
   * The bonus this barracks currently grants, as a plain bag of numbers.
   *
   * Every stat is expressed the same way -- a multiplier of 1 means "no effect,
   * except `crit_chance`, which is an additive probability. The world sums these
   * across overlapping barracks and clamps each to its cap.
   */
  bonuses() {
    const out = { damage: 1.0, range: 1.0, rate: 1.0, crit_chance: 0.0, bounty: 1.0 };
    const items = [];

    // A promotion sharpens everything the structure already does, on top of the
    // per-level scaling and whatever powers were chosen. Without it a rank would
    // be a new silhouette and a new word in the inspector but no reason to want
    // one.
    const promotion = this.rank?.aura_bonus ?? 0.0;

    /**
     * Powers ADD together, and the promotion is added once on top.
     *
     * Every value here is a plain bonus rather than a value-at-level: unlike the
     * old fixed schedule, a power is a discrete thing the player bought, so
     * there is nothing to interpolate.
     */
    const totals = { damage: 0, range: 0, rate: 0, crit_chance: 0, bounty: 0 };
    for (const option of this.chosenOptions()) {
      const aura = option.aura ?? {};
      for (const stat of Object.keys(totals)) totals[stat] += aura[stat] ?? 0;
    }
    for (const stat of Object.keys(totals)) {
      if (totals[stat] !== 0) totals[stat] += promotion;
    }

    const labels = {
      damage: 'Damage',
      range: 'Range',
      rate: 'Fire rate',
      crit_chance: 'Crit chance',
      bounty: 'Bounty',
    };

    for (const [stat, value] of Object.entries(totals)) {
      if (value === 0) continue;
      items.push({ stat, label: labels[stat], value });
      if (stat === 'crit_chance') out.crit_chance += value;
      else out[stat] *= 1.0 + value;
    }

    out.unlocked = items;
    return out;
  }

  /** A short line for the inspector: what it is giving right now. */
  describeBonuses() {
    const { unlocked } = this.bonuses();
    if (unlocked.length === 0) return 'nothing yet';
    return unlocked
      .map((u) => `${u.label} +${Math.round(u.value * 100)}%`)
      .join(', ');
  }

  /** The names of the powers taken so far, for the inspector. */
  describePowers() {
    const taken = this.chosenOptions();
    return taken.length === 0 ? 'none yet' : taken.map((o) => o.name).join(' · ');
  }

  static xpNeeded(level, levels) {
    return levels.xp_to_next_base * level ** levels.xp_to_next_power;
  }

  /**
   * Award experience, evolving as thresholds are crossed.
   *
   * @returns {number} how many levels were gained, so the caller can celebrate
   */
  addXp(amount, levels) {
    if (amount <= 0.0 || this.level >= levels.max_level) return 0;

    this.xp += amount;
    let gained = 0;

    while (this.level < levels.max_level) {
      const needed = Barracks.xpNeeded(this.level, levels);
      if (this.xp < needed) break;
      this.xp -= needed;
      this.level += 1;
      gained += 1;
    }

    if (gained > 0) this.levelsGained += gained;
    if (this.level >= levels.max_level) this.xp = 0.0;
    return gained;
  }

  /** Buying a level outright, for the test sandbox. */
  setLevel(level, levels) {
    this.level = Math.max(1, Math.min(levels.max_level, Math.floor(level)));
    this.xp = 0.0;
    return this.level;
  }

  /**
   * Take every power automatically, for the balance probe.
   *
   * The scripted player has no judgement about which option is worth taking, so
   * leaving levels unspent would make every measurement a measurement of an
   * unfinished build. `policy` picks the index within each level's options.
   */
  autoChoose(policy = 0) {
    let entry = this.pendingEntry();
    let guard = 0;
    while (entry && guard < 32) {
      guard += 1;
      const index = Math.min(policy, entry.options.length - 1);
      this.powers[entry.level] = entry.options[index].key;
      entry = this.pendingEntry();
    }
    return this;
  }

  /** Replace the whole power set, for save loading. Unknown keys are dropped. */
  setPowers(map) {
    this.powers = {};
    for (const entry of this.d.powers ?? []) {
      const key = map?.[entry.level];
      if (typeof key !== 'string') continue;
      if (!entry.options.some((o) => o.key === key)) continue;
      this.powers[entry.level] = key;
    }
    return this;
  }

  /** Fraction of the way to the next level, for the progress bar. */
  progress(levels) {
    if (this.level >= levels.max_level) return 1.0;
    const needed = Barracks.xpNeeded(this.level, levels);
    return needed > 0 ? Math.min(1.0, this.xp / needed) : 0.0;
  }

  sellValue(refund) {
    return this.invested * refund;
  }
}

/**
 * What a single barracks costs, given how many are already standing.
 *
 * Rises per barracks so the fifth is a real commitment rather than a formality,
 * which is what stops "build six barracks immediately" from being a free way to
 * remove the tower limit.
 */
export function barracksCost(d, existing) {
  return Math.round(d.cost * d.cost_growth ** existing);
}

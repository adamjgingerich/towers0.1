/**
 * Persistent meta-progression: the skill tree and what it resolves to.
 *
 * Pure simulation -- no DOM, no localStorage -- so it runs under the headless
 * balance sweep like the rest of src/sim. The host (src/storage.js) owns the
 * player's Cores and bought ranks; this module only turns a tree plus a set of
 * owned ranks into a plain bag of numbers the simulation can multiply by.
 */

/** Stats an effect may target. Anything else is dropped by the parser. */
const META_STATS = new Set([
  // Flats.
  'startCoins',
  'baseHp',
  'towerCap',
  'critChance',
  'interestBase',
  'waveBonus',
  'startLevel',
  'sellRefund',
  // Multipliers.
  'towerDamage',
  'towerRange',
  'towerRate',
  'upgradeCost',
  'specCost',
]);

/** The neutral meta: every multiplier at 1, every flat at 0. */
export function emptyMeta() {
  return {
    startCoins: 0,
    baseHp: 0,
    towerCap: 0,
    critChance: 0,
    interestBase: 0,
    waveBonus: 0,
    startLevel: 0,
    sellRefund: 0,
    towerDamage: 1,
    towerRange: 1,
    towerRate: 1,
    upgradeCost: 1,
    specCost: 1,
  };
}

/**
 * Parse and validate the raw skills block.
 *
 * Falls back to an empty tree rather than throwing: meta-progression is a
 * bonus layer, and a malformed file should cost the player the tree, not the
 * game. Unknown effect stats are dropped so a typo cannot silently buff a
 * field nothing reads.
 */
export function buildSkills(raw) {
  const branches = (Array.isArray(raw?.branches) ? raw.branches : [])
    .filter((b) => b && typeof b === 'object' && typeof b.key === 'string')
    .map((b) => ({
      key: String(b.key),
      name: String(b.name ?? b.key),
      color: String(b.color ?? '#ffffff'),
    }));

  const nodes = (Array.isArray(raw?.nodes) ? raw.nodes : [])
    .filter((n) => n && typeof n === 'object' && typeof n.id === 'string')
    .map((n) => ({
      id: String(n.id),
      name: String(n.name ?? n.id),
      desc: String(n.desc ?? ''),
      branch: String(n.branch ?? ''),
      cost: Math.max(1, Math.floor(Number(n.cost) || 1)),
      maxRank: Math.max(1, Math.floor(Number(n.maxRank) || 1)),
      costGrowth: Number.isFinite(Number(n.costGrowth)) && Number(n.costGrowth) >= 1
        ? Number(n.costGrowth)
        : 1,
      requires: (Array.isArray(n.requires) ? n.requires : []).map(String),
      effects: (Array.isArray(n.effects) ? n.effects : [])
        .filter((e) => e && typeof e === 'object' && META_STATS.has(e.stat))
        .map((e) => {
          const value = Number(e.value);
          return {
            stat: String(e.stat),
            kind: e.kind === 'mult' ? 'mult' : 'flat',
            value: Number.isFinite(value) ? value : 0,
          };
        })
        .filter((e) => e.value !== 0),
    }));

  return {
    currency: String(raw?.currency ?? 'Cores'),
    branches,
    nodes,
  };
}

/** Find a node by id. */
export function skillNode(skills, id) {
  return skills.nodes.find((node) => node.id === id) ?? null;
}

/**
 * The cost of the next rank of a node, given its current owned rank.
 *
 * `costGrowth ** rank` means each rank is pricier than the last, so a tree is
 * something you *climb*, not something you fill in.
 */
export function skillCost(node, ownedRank) {
  const rank = Math.max(0, Math.floor(Number(ownedRank) || 0));
  return Math.round(node.cost * node.costGrowth ** rank);
}

/**
 * Whether a node can be bought right now.
 *
 * Requires every listed prerequisite to hold at least one rank, and the node
 * to have a rank left to buy. Cores affordability is checked by the host,
 * which owns the wallet.
 */
export function skillUnlocked(node, skills, owned) {
  for (const id of node.requires) {
    if ((owned[id] ?? 0) < 1) return false;
  }
  return (owned[node.id] ?? 0) < node.maxRank;
}

/**
 * Fold every owned node rank into one neutral bag.
 *
 * Flats add (`value * rank`), multipliers compound (`value ** rank`), so ten
 * ranks of a +5% damage node mean x1.05^10, not x1.5 -- which is what stops a
 * wide tree from exploding into an automatic win.
 */
export function resolveMeta(skills, owned) {
  const meta = emptyMeta();
  for (const node of skills.nodes) {
    const rank = Math.max(0, Math.floor(Number(owned?.[node.id]) || 0));
    if (rank <= 0) continue;
    for (const effect of node.effects) {
      if (effect.kind === 'mult') {
        meta[effect.stat] *= effect.value ** rank;
      } else {
        meta[effect.stat] += effect.value * rank;
      }
    }
  }
  // Sell refund must never reach 100%: a tower that sells for what it cost
  // removes the placement decision the whole game is built on.
  meta.sellRefund = Math.min(0.25, meta.sellRefund);
  return meta;
}

/** Total Cores a node still costs to finish from its current rank. */
export function nodeRemainingCost(node, ownedRank) {
  const rank = Math.max(0, Math.floor(Number(ownedRank) || 0));
  let total = 0;
  for (let r = rank; r < node.maxRank; r += 1) {
    total += Math.round(node.cost * node.costGrowth ** r);
  }
  return total;
}

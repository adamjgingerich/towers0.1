/**
 * Skill-tree economy check.
 *
 * Prints what the tree costs to complete, what a run banks under the current
 * Cores rule, and how many runs that implies. Also prints the combined effect
 * of a fully-bought branch, so a nerf can be read as a number rather than felt.
 *
 *   node tools/skillmath.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSkills, resolveMeta } from '../src/sim/skills.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'skills.json'), 'utf8'));
const tree = buildSkills(raw);

/** Total Cores to take every node to maxRank. */
let total = 0;
const perBranch = {};
for (const node of tree.nodes) {
  let cost = 0;
  for (let r = 0; r < node.maxRank; r += 1) cost += Math.round(node.cost * node.costGrowth ** r);
  total += cost;
  perBranch[node.branch] = (perBranch[node.branch] ?? 0) + cost;
}

/**
 * Cores banked by a run that reaches `wave`, mirroring Main._trackProgression:
 * a drop every third wave, worth 1 + floor(difficulty/2) + floor(wave/20).
 */
function runIncome(wave, difficultyIndex) {
  let sum = 0;
  for (let w = 3; w <= wave; w += 3) {
    sum += 1 + Math.floor(difficultyIndex / 2) + Math.floor(w / 20);
  }
  return sum;
}

const DIFF = ['relaxed', 'easy', 'normal', 'hard', 'brutal', 'nightmare'];

/** Every rank of one branch, resolved, to read the branch's real weight. */
function fullBranch(key) {
  const ranks = {};
  for (const node of tree.nodes) if (node.branch === key) ranks[node.id] = node.maxRank;
  return resolveMeta(raw, ranks);
}

const active = fullBranch('warfare');
const fort = fullBranch('fortification');
const eco = fullBranch('economy');

const out = {
  totalCostToMax: total,
  perBranch,
  income: DIFF.map((name, i) => {
    for (const wave of [30, 40, 50, 60]) {
      // eslint-disable-next-line no-param-reassign
    }
    return {
      difficulty: name,
      toWave30: runIncome(30, i),
      toWave40: runIncome(40, i),
      toWave50: runIncome(50, i),
      toWave60: runIncome(60, i),
    };
  }),
  runsToMax: {
    'wave40/normal': +(total / runIncome(40, 2)).toFixed(1),
    'wave50/hard': +(total / runIncome(50, 3)).toFixed(1),
    'wave60/nightmare': +(total / runIncome(60, 5)).toFixed(1),
  },
  maxedWarfare: {
    towerDamage: +active.towerDamage.toFixed(3),
    towerRate: +active.towerRate.toFixed(3),
    towerRange: +active.towerRange.toFixed(3),
    critChance: active.critChance,
    dpsMult: +(active.towerDamage * active.towerRate).toFixed(3),
  },
  maxedFortification: { baseHp: fort.baseHp, towerCap: fort.towerCap },
  maxedEconomy: {
    startCoins: eco.startCoins,
    baseHp: eco.baseHp,
    interestBase: eco.interestBase,
    waveBonus: eco.waveBonus,
    sellRefund: eco.sellRefund,
  },
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
writeFileSync(join(ROOT, 'tools', 'skillmath.json'), JSON.stringify(out, null, 2) + '\n');

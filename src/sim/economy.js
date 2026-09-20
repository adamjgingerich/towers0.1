/** Coin and base-health bookkeeping. */

export class Economy {
  constructor(coins, baseHp) {
    this.coins = coins;
    this.baseHp = baseHp;
    this.baseHpMax = baseHp;
    this.earned = 0.0;
    this.spent = 0.0;
    this.leaked = 0;
  }

  canAfford(cost) {
    return this.coins >= cost;
  }

  spend(cost) {
    if (cost > this.coins) return false;
    this.coins -= cost;
    this.spent += cost;
    return true;
  }

  earn(amount) {
    if (amount <= 0.0) return;
    this.coins += amount;
    this.earned += amount;
  }

  refund(amount) {
    if (amount <= 0.0) return;
    this.coins += amount;
  }

  takeLeak(amount) {
    this.leaked += 1;
    this.baseHp -= amount;
  }

  get defeated() {
    return this.baseHp <= 0.0;
  }
}

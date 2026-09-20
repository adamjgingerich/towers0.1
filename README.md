# Towers

Endless tower defense in the browser — three.js renderer, framework-free simulation.
Infinitode-style: fixed road, grid placement, endless waves, towers that level up during a run.

## Running it

The browser blocks `fetch` on `file://` URLs, so **double-clicking `index.html` will not work** —
you will get the "Could not load game data" panel. The page has to come from an HTTP server.

### Windows, no install required

Windows PowerShell ships with everything needed:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

That serves the folder on <http://localhost:8000/> and opens your browser. `Ctrl+C` stops it.
Use `-NoBrowser` to skip the auto-open, or `-Port 9000` for a different port.

If it is already running, just open <http://localhost:8000/>.

### If you have Python or Node

```bash
python serve.py           # same thing, stdlib only
npx serve .               # or any static server
```

Note that this machine currently has **no Python and no Node** — `python` on the PATH is only the
Microsoft Store alias stub, which opens the Store instead of running. Use `serve.ps1`.

## Controls

### Camera

| Input | Action |
|---|---|
| Ctrl + scroll, or a trackpad pinch | Zoom about the pointer (100%–800%) |
| Two-finger scroll | Pan |
| Shift + scroll | Pan horizontally |
| `−` / `+` / `Fit` buttons (bottom-right of the board) | Zoom out, zoom in, reset to the whole board |

At 100% the whole board fits and the view is locked to centre, so panning has
nothing to do until you zoom in. Panning is clamped to the board, so you can
never scroll it off-screen. Zoom is anchored to the pointer, and the current
zoom doubles as the button label.

### Game

| Input | Action |
|---|---|
| `1`–`9`, `0` or click a shop button | Select a tower to build (click again to cancel) |
| `B` | Select a barracks to build (raises the tower limit) |
| Left click a tile | Build, or select an existing tower or barracks |
| Right click / `Esc` | Cancel placement / deselect |
| `U` | Upgrade the selected tower |
| `X` | Sell the selected tower (70% refund) |
| `T` | Cycle targeting mode (first / last / strongest / weakest / closest / sequential) |
| `Space` or `P` | Pause / resume |
| `+` / `-` | Game speed, 1× to 5× |
| `R` | Restart |
| **Save** / **Load** buttons | Store or restore the current run (see Saving) |

Pausing shows a badge on the board. A frozen frame and a very slow one look
identical otherwise, and at 5× the difference matters.

Every speed runs the *same simulation*: speed adds fixed 1/60 s steps rather than
enlarging a step. See the note under Game speed below for why that had to change.

### Game speed

1× to 5×. Speed multiplies the **number** of fixed 1/60 s steps taken, never the
size of a step — see `src/loop.js`.

That distinction is not cosmetic, and it fixed a real bug. Speed used to scale the
step itself, which meant 3× was a *different game*: a tower's cooldown is
decremented once per step, so a step of 0.05 s silently caps every weapon at 20
shots per second, and a fully-upgraded Gatling fires around 24/s. At 3× it was
quietly firing at half rate. Verified after the change: the same seed stepped for
the same simulated time at 1×, 3× and 5× produces byte-identical state.

The cost is CPU, since 5× needs five times the steps. If the machine cannot keep
up, catch-up drops steps and the effective speed falls short of the selected one —
a slowdown rather than a corrupted simulation.

## Shop

The first button is the **Barracks** — not a tower. It raises the tower limit and
buffs everything inside its aura; see Barracks below.

The ten tower buttons are deliberately compact — two lines each, hotkey and name
above, price and targeting badge below. Laid out as a single row per button they
ran about 110px wide, so the roster needed 1100px and the bar scrolled on any
normal window. Stacked, each is about **52px** and the whole roster fits without
scrolling from 900px upward.

## Difficulty

A slider in the top bar, six stops, kept dim until hovered. It sets three
independent multipliers, because they do different jobs:

| | What it changes |
|---|---|
| **wave size** | How many enemies a wave contains |
| **enemy power** | A flat multiplier on enemy health |
| **growth** | How fast the endless curves ramp. `1` is the authored curve, `0.8` ramps slower, `1.4` much faster |

| Setting | Size | Power | Growth | Enemy HP at wave 20 |
|---|---|---|---|---|
| Relaxed | 0.78 | ×1.0 | 0.85 | what Normal used to be |
| Easy | 0.90 | ×1.4 | 0.93 | ×1.3 |
| **Normal** (default) | 1.0 | **×2.0** | 1.0 | **×2.0** |
| Hard | 1.12 | ×2.8 | 1.12 | ×3.4 |
| Brutal | 1.25 | ×3.9 | 1.25 | ×5.9 |
| Nightmare | 1.45 | ×5.4 | 1.4 | ×10.3 |

Each step is roughly 1.4× the last, so the ladder is geometric rather than
arbitrary. **Relaxed is pinned at ×1.0** so there is always a setting that plays
the way the game did before the doubling.

### The power multiplier ramps in

`power` does not apply from wave 1. It ramps linearly to full strength over the
first 25 waves:

```
effective power = 1 + (power - 1) * min(1, (wave - 1) / 24)
```

| Wave | 1 | 5 | 10 | 15 | 25+ |
|---|---|---|---|---|---|
| Effective power at Normal | ×1.00 | ×1.17 | ×1.38 | ×1.58 | ×2.00 |

The reason is that the opening is on a knife edge. The starting economy buys about
seven Basic towers, and wave 1 is only *just* winnable with them — so a flat ×2
from the start does not make the game twice as hard, it deletes the first ten
waves. Measured: with a flat ×2, every build died at **wave 6**. With the ramp,
the opening is untouched and the multiplier lands in full once the player has an
economy.

Bounty is deliberately **not** scaled, so harder means harder rather than
harder-but-richer. The setting is remembered between sessions, applies from the
next wave, and every change is announced in the notes feed with its numbers.

It is kept out of the save file on purpose: loading a save must not silently
change how hard the game is.

## Characters and map progression

The first thing the game asks for is a **character name**. Progress is kept per
name: a name owns one number per map — the furthest wave survived there — and
everything else is derived from that, so the two can never disagree.

**A map opens when you survive 40 waves on the one before it.** That is a floor,
not a limit: the run does not stop at 40, you simply stop having only one thing
to do. Six maps means a ladder of 40 waves apiece, as far as you can take it.

* The **Maps** button (top bar) opens the level list: state, name and your best
  on each. Locked rows keep their name visible and say what is missing
  (*"Reach wave 40 on Switchbacks"*), because knowing what is next is the whole
  reason to keep playing the current map.
* The **next-level button** appears on the right of the board the moment wave 40
  is behind you — mid-run, not at defeat — naming the map it leads to. Crossing
  the threshold is a choice about what to do next, not an ending.
* The **name button** (top bar) switches character. Since unlocks belong to a
  name, switching drops you onto the furthest map *that* character has earned,
  rather than leaving you stranded on one they have not.
* **Test mode bypasses all of it**, deliberately: it is a sandbox, and a sandbox
  with a lock on it is not a sandbox.

Progress is written as the run advances rather than only at the end, because the
next map has to open the moment the 50th wave is behind you — that is what makes
the next-level button appear mid-run. It is guarded by the last recorded wave, so
it is one write per wave rather than one per frame.

A pre-progression `towers.bestWave` is migrated onto the first map on first run,
and only when no characters exist at all — so it can never overwrite real
progress.

## Saving

The **Save** and **Load** buttons in the header store a run in `localStorage` and
restore it later. There is one slot; **Load** stays disabled until something has
been saved, and its tooltip shows the wave and tower count stored.

A save carries the wave, phase and prep timer, the coin and base-health ledger,
every tower (level, XP, targeting mode, kills and **specialisation choices**),
the enemies currently on the path, the notes, and both RNG streams.

Two details worth knowing:

* **Saving and loading is exactly reversible, as long as nothing is mid-flight.**
  Save with no shots in the air and playing forward gives byte-identical
  results to playing the original forward — the same waves, the same crits, the
  same coin total. That works because the wave generator is seeded and its whole
  state is a single 32-bit counter, so a save only needs one number per stream;
  crits run on their own stream from the wave generator, so crit luck can never
  shift wave composition.

  In-flight projectiles are deliberately *not* saved. Saving mid-combat and
  reloading therefore loses the handful of shots that were airborne, which
  shifts the run by a fraction of a percent (measured: 0.1 damage out of 23,250
  over the next 15 seconds). Nothing a player would notice, but it does mean
  "save and reload" is not a perfectly exact undo mid-fight.
* **Test mode travels with the save.** A run built with free level-20 towers
  reloads with the sandbox switched back on, so it cannot be laundered into a
  legitimate best-wave record by saving it and loading it later.

What a save deliberately does *not* contain:

* **The tile grid.** It records the map id instead, so an edited map file takes
  effect on the next load rather than being overridden by the save.
* **In-flight projectiles and active damage-over-time.** They last a fraction of
  a second; rebuilding them faithfully would mean serialising homing targets and
  pooled buffer slots for no real gain.

Saves are validated before anything is touched, so a save referring to a tower,
map or specialisation that no longer exists fails with a message like
`save contains an unknown tower: 'trebuchet'` and the current run keeps running.
Corrupt JSON is treated as "no save" rather than an error. If the save names a
different map, loading rebuilds the board onto that map first.

## Test mode

The **Test** button in the header opens a sandbox. It exists so a tower can be
tried at any level without grinding to it first.

* Builds and upgrades cost nothing — no coins, and no XP to earn a level.
* **Build level** picks the level every tower built from then on starts at
  (1–20).
* Select a tower and a second **Selected** strip appears, which sets that
  tower's level directly.
* **Map** switches level, rebuilding the board and camera in place.
* Specialisations are free, so you can try both branches of any tower.
* Levelling maths is unchanged: a level-20 Basic has exactly the damage, rate
  and range it would have earned in a real run, and the placement range ring
  shows the level you are about to build rather than the definition's base.
* Upgrade costs are still *displayed* in the inspector but nothing is deducted.

Two deliberate consequences:

* **The best wave record is not written while test mode is on.** A wave reached
  with free level-10 towers is not comparable to one earned normally, so it must
  not overwrite the real record in `localStorage`.
* Turning test mode off restores normal rules immediately — the shop greys out
  anything unaffordable and placements are rejected with `Not enough coins`.

Nothing about the mode touches `src/sim/`'s determinism: `world.test` is a plain
flag that `canPlace`, `placeTower` and `upgradeTower` consult, so the same code
path runs headlessly under the balance sweep with the flag simply off.

## Towers

| Key | Tower | Cost | Dmg | Rate | Range | Type | Role |
|---|---|---|---|---|---|---|---|
| `1` | Basic | 50 | 12 | 2.0 | 3.0 | physical | Cheap backbone. Best damage per coin in the game. |
| `2` | Cannon | 120 | 45 | 0.8 | 3.5 | physical | Splash 1.0. **Ground only.** |
| `3` | Frost | 90 | 7 | 1.2 | 2.8 | ice | Almost no damage; pays for a 35% slow over 2s. **Ground only.** |
| `4` | Tesla | 150 | 20 | 1.5 | 2.5 | energy | Chains to 3. Energy halves armour. |
| `5` | Venom | 140 | 6 | 1.0 | 3.0 | poison | +18/s for 4s, stacks 3, ignores armour entirely. **Ground only.** |
| `6` | Sniper | 200 | 130 | 0.5 | 8.0 | physical | Hitscan at extreme range, ×1.5 vs armoured. Slow to traverse. |
| `7` | Gatling | 125 | 4 | 8.0 | 2.4 | physical | Very fast, very small hits. Excellent vs swarms, useless vs armour. |
| `8` | Flame | 145 | 5 | 6.0 | 1.8 | fire | Splash 0.7, ×1.5 vs light, ×0.5 vs armoured. **Ground only.** |
| `9` | Missile | 165 | 30 | 1.1 | 4.2 | physical | Guided splash 0.9. **Air only.** |
| `0` | Mortar | 180 | 70 | 0.45 | 6.5 | physical | Splash 1.6 at long range. **Ground only.** |

### What can hit a flyer

Flyers are not a separate route. They float along the same road as everything
else, and what sets them apart is that most towers cannot shoot at them — so a
lane packed with cannons, mortars and flames is a lane they cross for free. They
are drawn with a lift and a shadow so they stay distinguishable from the ground
units they are passing over.

Only **5 of the 10 towers** can touch air, and only **9 of 10** can touch ground:

| Verdict | Towers | Why |
|---|---|---|
| **Air only** | Missile | A guided anti-air seeker is tuned for aircraft; it cannot engage ground at all, the same reason real SAM batteries are not used against infantry. |
| **Ground only** | Cannon, Flame, Frost, Mortar, Venom | A low-velocity lob on a fixed mount, a jet of burning fuel, a ground-level coolant spray, indirect high-arc artillery, and a thrown glob of toxin. None can reach or track a target overhead. |
| **Both** | Basic, Tesla, Sniper, Gatling | Elevated guns that traverse upward, an electric arc that does not care what it hits, and a high-velocity rifle. |

Bounty is the pressure this creates: the towers that cannot hit air include the
best anti-swarm weapon in the game (Flame), the only slow (Frost) and the only
armour-ignoring damage over time (Venom). A build that spends everything on
splash and ground answers will watch a flyer wave walk through it.

`Fire` (Flame) and `Frost` are both short-range spray weapons and share the same
physical limit, which is what makes the restriction read as a rule rather than as
arbitrary balancing.

Two specialisation options exist to buy the restriction back: the Mortar's
**Airburst Fuse** (`allow_air`) and the Missile's **Ground Attack Mode**
(`allow_ground`).

### How they are priced

Cost tracks single-target DPS at roughly **2 coins per DPS** for a plain tower
(`basic`: 24 DPS for 50), plus a premium for whatever utility the tower brings:

| Tower | Cost/DPS | What the premium buys |
|---|---|---|
| Basic | 2.1 | nothing — the baseline |
| Sniper | 3.1 | range 8, hitscan, ×1.5 vs armour |
| Cannon | 3.3 | splash 1.0 (discounted: ground only) |
| Gatling | 3.9 | damage concentrated into a tiny footprint |
| Flame | 4.8 | splash + ×1.5 vs light |
| Tesla | 5.0 | chain to 3, energy pierces armour |
| Missile | 5.0 | splash that reaches air |
| Mortar | 5.7 | range 6.5 + splash 1.6 |
| Frost | 10.7 | crowd control |
| Venom | 23.3 | armour-ignoring damage over time |

Damage types matter more than raw numbers, because armour is **flat** subtraction:

* **Gatling** and **Flame** are wrecked by armour — many small hits never get
  through flat reduction. Both shine against the unarmoured swarm.
* **Venom** ignores armour completely and **Tesla** halves it, so they are the
  answers to `armored` and `boss`.
* **Flame** is the only fire tower: ×1.5 against light, ×0.5 against armoured.

New towers are pure data — add an entry to `data/towers.json` plus a row in
`data/atlas.json` and nothing else needs to change.

## Targeting

Every tower cycles its target priority with `T` or the inspector button:

| Mode | Picks |
|---|---|
| **First** | Furthest along the lane |
| **Last** | Least far along |
| **Strongest** | Most current health |
| **Weakest** | Least current health |
| **Closest** | Nearest to the tower |
| **Sequential** | The one past the last enemy it *hit*, wrapping round |

**Sequential** sweeps along the lane instead of focusing. It remembers how far
the last enemy it hit had travelled and takes the next one past that point,
wrapping to the front of the lane when there is nothing new — so on a pack it
spreads damage rather than overkilling whoever is in front. That makes it the
right mode for a cheap high-rate gun and the wrong one for a sniper. Verified
against three enemies at progress 0.496 / 0.500 / 0.504: sequential picks
`0, 1, 2, 0, 1, 2` where **First** picks `2, 2, 2, 2, 2, 2`.

The sweep position advances in `fire`, not in `acquire`. A turret can pick a
target and then fail to aim at it in time, and advancing on a shot that was never
taken would silently skip enemies.

`world.cycleTargeting` reads the mode list from `TARGETING_MODES` rather than
repeating it: the previous local copy had already drifted out of order against
the parser's, and a mode added to the data but not to a hand-maintained duplicate
is unreachable from the UI.

## Specialisations

Every tower offers a choice of two upgrades at **levels 5, 10, 15 and 20** — four
tiers, so sixteen possible builds per tower. Picks are locked in for that tower,
so two Gatlings can be built to do completely different jobs.

### Tier 5: the branch

Tier 5 sets a direction, and most options **cancel the tower's own weakness**
rather than just adding numbers.

| Tower | Option A | Option B |
|---|---|---|
| Basic | **Rifled Barrel** +45% range, +60% shell speed | **Hollowpoint** +45% damage, -18% rate, 20% chance of a 2.5× crit |
| Cannon | **Cluster Shells** +60% blast, -20% damage | **HEAT Shells** ignore armour, -15% damage |
| Frost | **Deep Freeze** slows to 45% and lasts 50% longer | **Shatter** +150% damage, executes below 12% hp |
| Tesla | **Superconductor** +3 chains, almost no falloff | **Overload** +80% damage, 20% chance of a 3× crit |
| Venom | **Necrosis** +80% poison, two more stacks | **Corrosive Venom** melts 6 armour off for every tower |
| Sniper | **Headhunter** 35% chance of triple damage | **Railgun** +100% damage, ignores armour, -25% rate |
| Gatling | **Incendiary** sets targets alight, 8/s for 3s | **Sabot Rounds** ignore armour, -20% damage |
| Flame | **Napalm** wider cone, burns 20/s for 4s | **Pressure Bellows** +60% range, +40% damage |
| Missile | **MIRV** +80% blast, -20% damage | **Shaped Charge** +90% damage, ignores armour |
| Mortar | **Airburst Fuse** *can finally hit flyers* | **Thermobaric** +70% blast, +40% damage |

### Tiers 10, 15 and 20: escalation

The later tiers are the *same menu for everyone* — they cannot branch on which
tier-5 pick you made — so they are designed to build on either direction rather
than assume one. The shape is:

* **Tier 10** refines the core: a focused multiplier, or a utility that patches a
  remaining weakness.
* **Tier 15** escalates: a new mechanic, or a large multiplier with a cost.
* **Tier 20** is a capstone — the tower's defining ability.

A few of the eight new options per tower, to show the flavour:

| Tower | Tier 15 | Tier 20 |
|---|---|---|
| Cannon | **Airburst Refit** — buys back air coverage | **Carpet Bombardment** +60% blast, +30% damage |
| Flame | **Thermite Mix** — burns through armour at last | **White Phosphorus** +24/s burn, wider cone |
| Missile | **Ground Attack Mode** — buys back ground coverage | **Tandem Warhead** +55% damage, ignores armour |
| Gatling | **Shredder Tips** — melts 5 armour *for every other tower too* | **Scavenger Rounds** +45% damage, +45% bounty |
| Tesla | **Ball Lightning** +3 chains, wider arcs | **Storm Front** +4 chains, no falloff to speak of |
| Venom | **Plague Bloom** three more poison stacks | **Pandemic** four more stacks, 50% longer |

The two `allow_air` / `allow_ground` options matter more than their numbers: they
are the only way to buy back the targeting restriction, and they sit in different
tiers so you cannot have both.

### What the tiers actually do

Measured by simulating one maxed tower against a fixed group walking past it, and
comparing every one of the sixteen paths against the same tower with no
specialisations:

| Tower | Weakest path | Median | Strongest path |
|---|---|---|---|
| Basic | ×3.4 | ×4.8 | ×6.5 |
| Cannon | ×2.2 | ×4.0 | ×5.5 |
| Frost | ×1.5 | ×3.9 | ×6.2 |
| Tesla | ×4.5 | ×5.3 | ×6.6 |
| Venom | ×2.9 | ×4.3 | ×6.3 |
| Sniper | ×2.6 | ×4.9 | ×8.3 |
| Gatling | ×2.5 | ×3.7 | ×4.7 |
| Flame | ×2.6 | ×5.2 | ×6.4 |
| Missile | ×2.8 | ×4.7 | ×5.9 |
| Mortar | ×2.7 | ×4.2 | ×5.0 |

Two things this establishes. **No path is worse than an unspecialised tower** —
every one of the 160 paths measured came out above ×1. And the spread between
strongest and weakest averages about ×2.4, so the choices are real choices rather
than a right answer and a trap.

Frost's ×1.5 floor is the pure crowd-control path (Deep Freeze → Cryo Core →
Absolute Zero → Glacier). It scores lowest on damage *by design* — it is buying
slow, not damage, and the metric deliberately does not price that.

### Effect on the difficulty curve

This was the point of the exercise. A maxed tower used to produce a fixed amount
of damage, so a run always ended around wave 60 no matter how well it was played.
With four tiers, the same fixed builder now reaches:

| Towers built | Before | After |
|---|---|---|
| 7 | died wave 10 | died wave 10 |
| 12 | died wave 50 | died wave **59** |
| 16 | died wave 60 | died wave **66** |
| 22 | died wave 54 | died wave **66** |

A 6–12 wave extension, and the probe now buys 48–85 specialisations instead of
~16. Small builds are unchanged, which is correct: seven towers have not finished
levelling by wave 10 and gain nothing from later tiers.

### Costs

Choices cost `1.2 × base cost`, multiplied by `1.55` once per tier already taken.
On a Sniper that is 240 → 372 → 577 → 894, so all four tiers cost about 2 080 —
roughly ten times the tower itself, which is what makes a fully-specialised tower
a genuine investment rather than a formality.

They are free in test mode. The moment a tower reaches a tier it has not committed
to, a note appears — a pending choice is a straight power loss until it is taken.

Adding a tier is pure data: append another entry to the tower's list in
`data/specialisations.json` with a higher `tier`. The UI generates the buttons from
the data and prices them by their depth.

## Barracks

A barracks is the only way to raise the tower limit. You start able to build
**4 towers**; the limit is

```
capacity = base + per_barracks × barracks standing          (4 + 5 each)
```

so every five towers past the fourth costs a barracks. A barracks is capped at
**6**, giving a maximum of 34 towers. Buildings are bought with `B`, and each one
costs more than the last (`110 × 1.45ⁿ` → 110, 160, 231, 335, 486, 705).

Trying to build past the limit does not silently fail: the note reads
*"Tower limit 4 — build a barracks"*.

### They evolve

A barracks gains experience from the fighting it supports, not from time passing:

| Source | Amount |
|---|---|
| Damage dealt by a tower in its aura | 0.05 per point |
| Each wave you survive | 26 |

The bar is steeper each level (×1.32, from 200), so level 10 is a late-run
achievement rather than a formality. Crucially, XP is credited to the *barracks
that supported the tower that did the damage* — a barracks parked in a quiet corner
with nothing to buff earns nothing, so placement is the whole decision.

### What the aura does

A buff unlocks at a level, then grows every level after it, and is capped:

| Level | Buff | Base | Per level | Cap |
|---|---|---|---|---|
| 1 | Damage | +4% | +2% | +50% |
| 3 | Range | +3% | +1% | +20% |
| 5 | Fire rate | +3% | +1.5% | +25% |
| 7 | Critical chance | +3% | +1% | +12% |
| 9 | Bounty | +5% | +2% | +30% |

The aura starts at **3.2 tiles** and grows by a flat **+0.07 tiles per level**
(3.2 + 0.07 × (level − 1), so 3.83 at level 10). Growth is deliberately slow and
additive rather than proportional: a radius that scaled with level would let one
barracks reach across the map and make placement stop mattering, which is the whole
decision the mechanic is built around. As it grows it covers more of the board and
supports more towers — the inspector shows the count live.

**Buffs from overlapping auras add up, but each stat is clamped at its cap.**
Stacking six barracks around one gun therefore has diminishing returns, which is
what stops "wall the map in barracks" from being the answer. The aura also reaches
towers only: it never buffs enemies, and it does not touch the base.

### Placement, and why it is not a tax

The interesting property is that the limit is on *towers*, not on *squares*, so a
barracks is a purchase that pays back in three separate currencies:

* more tower slots,
* a damage aura over whatever it covers,
* and a second way to spend a wave's income.

Because the aura rewards clustering and the limit rewards spreading, the two
pressures pull against each other — a tight knot of towers around one barracks is
strong but covers one stretch of road, while a spread-out board needs several
barracks to buff anything. That tension is the mechanic; the numbers just price it.

Selling a barracks refunds 70% like any building and immediately re-checks the
tower limit. If the board is already over the limit, no existing tower is removed —
the limit only blocks *new* construction, so selling can never destroy your defence.

### In the inspector

Selecting a barracks shows its level and XP, how many towers it currently
supports, its aura radius, the full buff list, which buff unlocks next and at what
level, and a Sell button. Its aura is drawn as a ring on the board, and towers
inside it are tinted slightly so the effect is visible rather than inferred.

The upgrade and targeting buttons are disabled for a barracks rather than hidden,
so the panel does not jump around as you move the selection between structures.

## Savings interest

Coins still in the bank when a wave is cleared earn interest:

```
rate = min(max_rate, base + rate_per_step * floor(bank / step_coins)
                     + wave_rate_bonus * (wave - 1))
```

With the shipped numbers (`data/waves.json`) that is a 1.5% floor, rising 0.4pp per
250 coins banked and 0.12pp per wave, capped at 8%. The rate is printed in the
notes feed each time it pays, because a reward the player cannot see is not a
strategy.

The rate **ramps** rather than being flat on purpose. A flat percentage pays out
strictly in proportion to the balance, which makes "build nothing" the best line
at every bank size; a ramp rewards saving deliberately, and the cap stops a large
hoard from compounding the difficulty curve away.

## Death effects

Enemies die differently depending on **what killed them**, so a kill doubles as
feedback about which tower is working:

| Damage type | Effect |
|---|---|
| physical | impact ring, puff, small bang, or a spray of coins |
| fire | burning tongues, or a bang |
| ice | shattering shards, or a puff |
| energy | arcs of sparks, or a bang |
| poison | green goo spatter, or a puff |

Four enemies have a signature death regardless of damage type, set per enemy in
`data/enemies.json` as `death_fx` (empty means "pick from the damage type"):
**Armored** shatters, **Flyer** pops, **Healer** bursts into coins, and the
**Boss** detonates.

The variant is chosen from the enemy's `eid`, *not* the RNG. Rolling for it would
consume the combat stream and shift every later crit, which would break save
reproducibility for the sake of a puff of smoke.

Three things keep them from being distracting: every effect is about half a tile
(0.47–0.66, always under a full tile), none lasts longer than 0.32s, and they are
all drawn on the *ground* layer — underneath enemies, towers and projectiles, so
they can never hide what is happening.

### Wave composition

Higher waves deliberately contain **more distinct enemy types**. A wave commits
to a set of types up front and rotates through them:

```
distinct types = mix_types_base + floor(wave / mix_types_per_waves)
```

With the shipped numbers (`2` and `5`) that is one type on waves 1–2, three by
wave 6, four by wave 10 and all eight by wave 25 — so late waves read as a mixed
assault rather than a single-type grind.

The set is chosen **without replacement**. The earlier code drew each group
independently from the weighted pool, which sounds varied but is not: the weights
are skewed, so a late wave could easily come out almost entirely one type. The
count of *possible* types was never the same as the count that showed up.

### The Bulwark, and shields

The **Bulwark** (unlocks wave 22) is the one enemy with a **shield**: a pool that
absorbs damage before health and **refills** after 3.5s without being hit.

That last part is what makes it a real threat rather than a thick enemy. A pool
that regenerates cannot be worn down by chip damage at all once regeneration
outpaces it, so the answer is burst or the right damage type:

| Damage type | Into a shield |
|---|---|
| Physical | **×0.5** |
| Energy (Tesla) | **×1.5** |
| Poison | ×0.6 |
| Ice / Fire | ×1.0 |

Measured: 100 raw damage removes **44** from a Bulwark's shield as physical but
**147** as energy — a 3.3× swing, which is what makes "build a Tesla" a real
answer rather than a marginal one. Damage absorbed by the shield still counts as
dealt, so a tower is not starved of the experience that drives its levelling.

The barrier is drawn as a cyan hexagon under the unit that **shrinks and dims as
the pool drains**. Without that the health bar would sit still while the enemy
shrugged off everything, which reads as a bug rather than as a shield.

Worth knowing: because the player's damage saturates late (see the balance
sweep), a pool that refills scales with whatever is shooting it, where flat
armour does not. It is the counter to a maxed build rather than to a weak one.

## Weather

From wave 3 onward the board has weather. A spell lasts 2–4 waves and then the
next one is rolled, with **Clear** in the pool so calms happen on their own.

Weather is the one mechanic that changes what a build is *worth* without changing
the build, which is the thing a difficulty multiplier cannot do. Every type is a
**trade**, never a pure penalty:

| Weather | Towers | Enemies |
|---|---|---|
| **Rain** | −6% dmg, −6% rate, −12% range | −5% speed |
| **Snow** | −8% rate, −8% range | **−15% speed** |
| **Sleet** | −4% dmg, −12% rate, −10% range | **−18% speed** |
| **Hot sun** | **+14% dmg**, −8% rate | +10% speed |
| **Thunderstorm** | **+10% dmg**, −14% range | −4% speed |
| **Fog** | +6% dmg, **−20% range** | −6% speed |

A player who has leaned entirely on range has a bad time in fog and a good time
in the sun, and neither cost them a coin.

### How it reads on the board

Two layers, both deliberately restrained:

* A **translucent wash** over the whole board, tinted per type at **0.09–0.12
  alpha**. Low enough that the lane is never hidden, which was the constraint —
  weather you cannot see through is weather you cannot play under. The parser
  clamps alpha hard, so a data typo cannot black the map out.
* **Particles** for the falling and drifting: rain streaks, snowflakes, sleet as
  a deliberate mix of both, heat motes lifting in the sun, and slow wide bands
  for fog. Emission is a **rate per second**, not a per-frame count, so the same
  spell does not look like a drizzle on one machine and a downpour on another.
* **Thunderstorms flash** — a brief spike in the wash rather than drawn bolts,
  which at gameplay zoom would hide the lane they strike.

Weather has its **own particle pool and its own render layer**. Sharing the
atmosphere pool would let a storm's hundreds of drops per second evict every
muzzle flash and damage plume on the board, which are gameplay feedback rather
than decoration. Verified: with weather running, the atmosphere pools stay at
zero live particles while the weather pool holds 200–320.

### The badge

A small translucent badge sits at the top centre, naming the weather and listing
its effects:

```
Fog
Towers +6% damage · Towers −20% range · Enemies −6% speed
```

Those numbers are read off the **same bag the simulation multiplies by**, not
from a hand-written label, so the badge cannot drift away from what is actually
happening. It is not dismissable, on purpose: the weather is currently changing
every number on the board, and a status you can hide is a status you will forget.

### What it does to the curve

Measured with weather on and off at the same seed: **49/55/53 versus 47/53/55**
at tower budgets 12/16/22. Roughly ±2 waves in either direction, so weather adds
**variance** rather than difficulty — which is the intent. It should make each
run play differently, not make every run harder.

Weather runs on its **own RNG stream**, seeded apart from the crit and
wave-composition streams for the same reason those two are apart from each
other: a weather roll must not be able to shift wave composition, or a balance
sweep would quietly be measuring the weather generator.

## Terrain

Every map generates its own **mountain ranges**, and the ground a tower or an
enemy stands on changes how they perform.

The height field is value noise — three octaves on a 7-cell lattice — seeded from
the map text. Ridges are therefore identical on every reload and for every
player, but differ between levels. It is normalised to 0..1, which guarantees
every map spans the whole range of bands rather than coming out all-valley.

The tile layer bakes the relief in: tiles are tinted by height *and* by slope,
lit from the upper left. The slope term is what makes it read as hills instead
of as noise.

| Ground | Tower range | Tower damage | Enemy speed | Enemy damage taken |
|---|---|---|---|---|
| Valley | −14% | **+14%** | +12% | +10% |
| Lowland | −5% | +5% | +4% | +4% |
| Highland | +6% | −3% | −4% | −3% |
| Peak | **+18%** | −12% | −12% | −8% |

Every row is two-sided on purpose. High ground buys range but costs damage; low
ground does the reverse. Enemies on peaks are slower but harder to hurt, and
enemies in valleys are faster and easier. Nothing is a free win, so the shape of
a map becomes part of the build decision rather than just scenery.

Three details worth knowing:

* **The placement ring already includes the ground.** Hover across a ridge while
  placing a tower and the circle grows and shrinks, so the rule teaches itself.
* **The inspector names the ground** — `Highland` with `+6% range, −3% dmg`.
* **Enemy speed is eased toward the target**, not switched, or crossing a tile
  boundary would visibly pop the enemy forward.

Terrain is derived from the map rather than stored, so saves do not carry it:
loading rebuilds the same field and re-applies each tower's ground bonus from
the tile it sits on.

## Levels

| Map | Shape | Framing |
|---|---|---|
| **Switchbacks** (`level_01`) | Four switchbacks. Open and forgiving. | whole board |
| **Serpentine** (`level_02`) | One lane doubling back five times — splash country. | close (1.25×) |
| **The Z** (`level_03`) | Two very long straight runs — sniper and mortar country. | whole board |
| **Inward Spiral** (`level_04`) | A slow clockwise spiral; one tower near the middle reaches every lap. | close (1.45×) |
| **Staircase** (`level_05`) | Six right-angle corners marching down the map. | close (1.2×) |
| **Nested** (`level_06`) | Four nested U-turns, and the longest path in the game. | close (1.3×) |

Maps are plain text in `data/maps/`, one character per tile, and the list lives
in `data/maps.json`. Glyphs: `#` road · `.` buildable · `X` blocked · `S` spawn ·
`E` base · `*` bonus tile. Every map must have a spawn and a base; the loader
rejects one that does not.

Each level also carries a `tint` in `data/maps.json` — its base colour, which
multiplies the tile art. The sprites are shared, so the six maps read as six
different biomes (grey, green, sand, red, cyan, violet) without six sets of art.

A level's third field is `zoom` — the framing it was authored for. `1.0` shows the
whole board, anything above opens closer so the scenery and the tower models can
actually be read. Fit returns the player to this framing, and `minZoom` stays at 1,
so a level's framing can never permanently hide part of itself: the player can
always zoom out past it to the whole map.

A normal run always starts on `level_01`; the picker lives in test mode.
Switching a map rebuilds the world, the tile batch and the camera, and the old
renderer is disposed so its GPU buffers do not leak.

`Call wave` starts the next wave early and pays a bonus for the time you gave up.

## Project layout

```
index.html            page shell, HUD markup, CSS, import map
serve.ps1 / serve.py  static servers (serve.ps1 needs nothing installed)
src/
  sim/                framework-free simulation -- no three.js, no DOM
  render/             three.js: stage, atlas, instanced batches, renderer
  ui/                 DOM HUD, input handling, floating combat text
  loop.js             fixed-timestep accumulator loop
data/                 every tunable number, plus ASCII maps
docs/DESIGN.md        the parameter design and the reasoning behind it
tools/balance_probe.js  headless balance probe (browser, no Node needed)
tools/balance_sim.mjs   per-wave trace (needs Node)
```

`src/sim/` imports nothing but its own modules. That is deliberate: it means the same code runs in
the browser and headlessly under Node for balance testing, and the renderer can be replaced without
touching gameplay.

The barracks mechanic adds `data/barracks.json` (every one of its numbers) and `src/sim/barracks.js`
(the model). The probe knows how to build them, so it measures the same game a player faces.

## Tuning

Every gameplay number lives in `data/` — towers, enemies, damage types, wave curves, leveling,
specialisations, terrain and per-map colours. Editing those files needs no code change and no
rebuild; just reload the page.

Maps are plain ASCII in `data/maps/`. `#` road, `.` buildable, `X` blocked, `S` spawner, `E` base,
`*` bonus tile. Rows must all be the same width, and the map needs one `S` and one `E`.

`docs/DESIGN.md` documents what each parameter does and why the endless curves are shaped the way
they are.

### Making it easier or harder

A few knobs in `data/waves.json`, roughly in order of how much difference they make:

| Knob | Effect |
|---|---|
| `scaling.hp_lin`, `scaling.hp_exp` | Enemy health growth. **The main difficulty dial** for the early and mid game. |
| `scaling.count_lin` | How fast wave sizes grow |
| `start_coins` | How much you can build before wave 1 |
| `base_hp` | How many leaks you can absorb |
| `wave_bonus_base`, `wave_bonus_per_wave` | Steady income between waves |
| `leveling.max_level` | **The late-game dial.** Raises the ceiling a tower can reach, which the health curves cannot compensate for. |

Two traps worth knowing before reaching for any of them:

**`base_hp` does not make the game easier when the problem is too little damage.** A build
with too few towers dies on the same wave whatever its base health — it just leaks more times
on the way there. Measured, going from 20 to 24 HP moved a six-tower build from dying on wave
16 to dying on wave 17. Only the health curve moved the wall.

**`hp_lin` and `hp_exp` barely touch the late game.** Past roughly wave 50 every build is dying
to a *power ceiling*, not to the curve: a tower at `max_level` with its specialisation produces a
fixed amount of damage, while enemy health keeps growing exponentially. Easing the curve buys a
few waves, not a way through — see the sweep table above. The levers that move that wall are
`leveling.max_level` and the specialisation tiers in `data/specialisations.json`.

## Balance sweep

Two tools, and only one of them runs on this machine:

* `tools/balance_probe.js` — **runs in the browser, no Node needed.** Returns plain
  objects so a sweep can be tabulated. This is the one to use.
* `tools/balance_sim.mjs` — the older Node-only tool. Prints a per-wave trace, but
  needs `node`, which is not installed here. Kept because the trace is useful when
  Node is available.

The probe imports `src/sim/` directly in a page, which is the payoff for keeping the
simulation free of three.js and DOM imports — no renderer, no game loop, just the
model. From the devtools console on `http://localhost:8000/`:

```js
const probe = await import('/tools/balance_probe.js');
const { loadConfig } = await import('/src/data-loader.js');
const config = await loadConfig('level_01');

// One run: how far does a 16-tower build get?
probe.runProbe(config, { budget: 16, seed: 12345 });

// A sweep across budgets, all six maps.
const maps = [];
for (const id of ['level_01', 'level_02', 'level_03', 'level_04', 'level_05', 'level_06']) {
  maps.push({ id, config: await loadConfig(id) });
}
console.log(probe.formatTable(probe.runSweep(maps, { budgets: [7, 12, 16, 22] })));
```

**How to read a result.** `budget` is the maximum number of towers the scripted
player may build — a stand-in for how well the player is doing, not a prediction of
any real run. What it reliably answers is *"at what point does the curve stop being
survivable for a fixed amount of investment"*, which is the question a difficulty
change actually asks.

Results are only comparable against runs from the same builder policy: `BUILD_ROTATION`,
the upgrade rule and the specialisation policy are all part of the measurement.
`endReason` distinguishes a real death from hitting the time or wave cap — counting a
capped run as a survival would quietly flatter whatever curve was under test.

### Measured: the power ceiling is the wall, not the curve

Level 1, seed 12345, one tower budget per row:

| Towers | Final DPS | DPS/tower | Growth stops at | Died wave | Coins left |
|---|---|---|---|---|---|
| 9 | 8 008 | 890 | wave 42 | 50 | 218 289 |
| 16 | 15 073 | 942 | wave 55 | 61 | 360 956 |
| 30 | 21 102 | 703 | never | 58 | 32 986 |

**A fully upgraded tower always produces about 900 DPS, whatever else is going on.**
That is the whole story. `max_level` 20 multiplies a tower's damage by ~8.6× and its
rate by ~3.0×, and specialisations contribute exactly one tier, so a tower's power
becomes a constant at level 20. Enemy health does not — it is exponential, and it
grows 108× → 164× between wave 55 and 61.

So past the point where towers max out, the player can no longer grow at all while
the enemy still can, and death is arithmetic rather than difficulty. The visible
symptoms are all of it:

* Every budget from 9 to 30 dies between wave 50 and 64.
* Budget 30 reaches *higher* total DPS than budget 16 and still dies at the same
  place — it has more towers, each less upgraded (703 vs 942 DPS each).
* 200 000–360 000 coins sit unspent, because the upgrade path they exist to feed has
  run out. Interest then compounds a pile that cannot be spent.

The consequence for tuning: **`hp_lin`/`hp_exp` are a weak lever for the late game.**
They change *when* the ceiling is reached, not whether it can be escaped. That is why
the three curve variants below are so close together:

| Towers | original (0.09 / 1.058 / 0.15) | before (0.075 / 1.052 / 0.135) | at that time (0.087 / 1.056 / 0.145) |
|---|---|---|---|
| 7 | died wave 9 | died wave 10 | died wave 9 |
| 12 | died wave 50 | died wave 61 | died wave 58 |
| 16 | died wave 59 | died wave 64 | died wave 61 |
| 22 | died wave 55 | died wave 61 | died wave 58 |

Same builder, same seed, same map — so unlike earlier numbers in this file, these
*are* directly comparable. They show that curve sitting within ~3 waves of the
previous one and well short of the original, which is the "a little harder" that
was asked for.

The curve has since been raised again to `0.098 / 1.058 / 0.155`. Re-measured the
same way, that moves the wall by **0–2 waves** (budget 16: died w62 → w60; budget
22: w56 → w54; budget 12 unchanged at w50). Barely anything, which is the ceiling
below asserting itself: once the player's damage is capped, the health curve only
changes *when* the cap is reached, not whether it can be beaten.

**The lever that actually matters is the missing specialisation tiers.** Tiers 10, 15
and 20 are the only thing that raises the ceiling, because they multiply a tower
instead of incrementing it. Until they exist, no amount of curve tuning moves the
late-game wall.

### Measured: what the barracks did to the curve

Same builder, same seed, level 1 — with the barracks mechanic, the probe now buys
one whenever the tower limit is what is holding the build back, placing it where it
covers the most existing towers:

| Towers | Before barracks | After |
|---|---|---|
| 7 | died wave 10 | died wave **25** |
| 12 | died wave 55 | died wave 55 |
| 16 | died wave 59 | died wave **62** |
| 22 | died wave 57 | died wave **62** |

Two things to read here, and the first is the more important one.

**Small builds are no longer capped out.** Budget 7 used to mean "four towers,
forever" — the limit, not the curve, is what killed it at wave 10. Now that build
can buy one 110-coin barracks and field seven towers, and it reaches wave 25. That
is a fix, not a loosening: "you may own four towers and then you lose" was never a
difficulty curve.

**Large builds moved 57–59 → 62**, which is a small net easing. It is not
compensated for, and it is worth being explicit about why: the top-end wall is set
by the damage ceiling (every tower maxes at level 20 with four tiers taken), not by
tower count, so two extra barracks' worth of capacity buys about three waves. If
the wall needs to come back down, `hp_exp` is the wrong dial — see above.

Both large budgets now die at exactly wave 62. That is not a spike: waves 56–65
are all ordinary mixed waves of 76–87 enemies with 6 types, so the wall is the
smooth one, and the difference between a 16- and a 22-tower build is worth less
than a single wave of health growth by then.

### Measured: the harder-enemies pass

After the barracks landed, the enemy side was raised in one pass: wave-scaled
flat armour (a new mechanic), the exponential health curve from `1.058` to
`1.076`, a faster speed cap, denser late-wave delivery, healers from 15 to 22
heal/s, and the Bulwark above. Same builder, same seed, level 1:

| Towers | Before barracks | After barracks | After harder enemies |
|---|---|---|---|
| 7 | died wave 10 | died wave 25 | died wave **10** |
| 12 | died wave 55 | died wave 55 | died wave **48** |
| 16 | died wave 59 | died wave 62 | died wave **54** |
| 22 | died wave 57 | died wave 62 | died wave **56** |

**6–8 waves off the top end, and the small build is back where it started.** The
two changes do different jobs and it shows: the barracks raise the *floor* (a
seven-tower build used to be hard-capped at four), and the enemy pass lowers the
*ceiling*.

Three findings worth keeping:

* **Raising the enemy count made the game EASIER.** An early attempt also raised
  `count_lin`; budget 22 then reached wave **67** against a 62 baseline, because
  extra enemies are extra bounty and the income outpaced the threat. Reverted.
* **Flat armour is a low-end punisher.** At wave 60 it is +6.5, which is nothing
  against a maxed tower hitting for hundreds — it moved the small build 15 waves
  and the top end not at all. The top end only moved because of `hp_exp`.
* **The Bulwark alone is worth about one wave.** The probe's build rotation
  already carries Teslas, so the measured build has the counter. That is the
  point of a counter-unit — it punishes a *gap* in a build, not a strong build —
  and it is why it shows up as a small number here but will bite a player who
  spent everything on cannons and mortars.

### Early game

Small builds die at **wave 9** on five of the six maps, with 9–10 leaks. Wave 9 is
when `armored` unlocks (14 flat armour), and a build of mostly Basics and Gatlings has
no answer to flat armour — many small physical hits never get through. That is a
legitimate "you needed an armour answer" signal rather than a spike, and it is the
cheapest place in the game to teach it.

### Caveat

Cross-map numbers partly measure the builder, not the map. At 16 towers the probe
reaches wave 61 on Switchbacks but only 29 on The Z and 38 on Staircase — the fixed
placement heuristic is simply worse on those layouts. Treat map-to-map differences as
"the scripted player struggles here", not as a verdict on map difficulty.

## Sprite art

`data/atlas.json` describes sheets that do **not** exist as PNGs. `src/render/textures.js`
generates them at runtime whose layout matches the atlas exactly — same frame size,
same rows, same frame counts.

The art is drawn from curves and gradients rather than pixel blocks, and is
generated large (`art_scale: 3` puts a logical 64-unit sprite on a 192px frame) so
it survives the deeper zoom levels without turning to mush. Sheets are sampled
with linear filtering plus mipmaps for the same reason: this art is minified far
more often than it is magnified, and nearest sampling would shimmer along every
edge as the camera moves.

To use real art, drop the PNGs in `assets/` and load them instead of generating: the
UV maths in `src/render/atlas.js` only cares about the declared layout, so nothing
else changes.

### Models

Every tower has its own silhouette on two sheets. The **base** is what the tower is
installed on — an octagonal emplacement, a squat bunker, a crystal housing, a coil
pad, an organic sac, a sandbag nest, an ammo turntable, fuel drums on a grate, a
launcher pad with a blast deflector, a mortar pit. The **turret** is its weapon, and
anything that is not really a gun is drawn as its emitter instead: a coil stack for
the Tesla, a crystal cluster for the Frost, a drooping nozzle for the Venom.

Turret art is scaled by `TURRET_SCALE` because a weapon occupying its literal share
of a cell looks undersized next to a platform that fills it.

Towers whose weapon has a moving part get several frames — a rotating barrel cluster,
a pulsing coil, a flickering pilot light — and each tower's animation phase is offset
by its grid position, so a row of identical guns does not pulse in unison.

Enemies face +x and carry one idle tell each on top of the walk cycle: a wobbling
antenna, flapping wings and a rotor blur, a breathing halo, a pulsing core, four eyes
on the boss. That second, unrelated motion is what stops a crowd reading as a texture.

## Effects

Effects come in two kinds, and keeping them apart matters:

* **`world.fx`** is the *gameplay* budget — explosions, death flourishes, beams.
  It is small and deliberately capped, and when it fills the oldest entry is dropped.
  It is stepped with simulation time, so it respects pause and game speed.
* **Particles** (`src/render/particles.js`) are the *atmosphere*: muzzle flashes,
  gun smoke, rocket exhaust, dust, the plume off a burning enemy. They live in their
  own pools, owned by the renderer.

The split is not tidiness. When floating damage numbers shared the effect buffer, a
few splash towers could fill it with text and evict the explosion that caused them,
so death effects silently stopped appearing. Atmosphere must never be able to evict
gameplay, so filling the particle pool costs nothing but atmosphere — a
self-correcting failure rather than a misleading one.

Emissions are all rate-limited rather than fired per frame, and use a renderer-local
PRNG, so a puff of smoke can never advance the world's RNG and shift a crit roll.

Things that emit: muzzle flash and sparks on firing, a smoke curl from anything
throwing 40+ damage, exhaust trails behind rockets and flame jets, smoke and grit
from every blast, continuous smoke from anything on fire, dust from heavy and boss
footsteps, and a plume from the base once it drops below 60% health that thickens as
it gets closer to falling.

### Making them look alive

* Turrets **recoil** along their own barrel and ease home, derived from the tower's
  damage so a sniper kicks visibly harder than a gatling.
* A firing edge is detected on a monotonic shot counter, not a timer, so shots are
  never missed at 3x speed.
* The base smoulders as it takes damage — the one place on the board where the
  scenery reports the score.
* Turret and base sheets animate; ambient smoke drifts with simulation time, so
  pausing freezes the smoke along with everything else.

Smoke and the five other ambient sprites are covered by `SMOKY_FX` and the shapes in
`FX_STYLES`. Adding one is a `FX_STYLES` entry, plus a row in `data/atlas.json`.

## Notes for the next change

**Fixed:** an orthographic-camera bug that made the board render as one magnified
quadrant in a corner, which also threw off pointer picking. `OrthographicCamera`'s
`left/right/top/bottom` are in camera space, so they must be centred on zero to
match a camera centred on the board. `Stage.fitToGrid` now does that.

**Fixed:** `Enemy` never copied `leak` from its definition, so `baseHp -= undefined`
left base health as `NaN` — and since `NaN <= 0` is false, a run could never be lost.

**Fixed:** the spawn clock only advanced on frames where a spawn happened, so a wave
deadlocked after its first enemy. It now advances unless the concurrency cap is
holding orders back.

**Fixed — this was the biggest structural problem in the game:** a tower's damage was a *constant*
once it hit level 20 with its single specialisation tier, while enemy health kept growing
exponentially. Every build died in the same narrow band around wave 55–61 whatever it did, and
200 000+ coins accumulated unspent because the upgrade path had run out. Four specialisation tiers
raised the ceiling; the same probe builder now reaches wave 66. See the sweep section for the
numbers.

**Open:** the economy still has no sink that survives a full run. Once every tower is maxed and every
tier is taken, coins pile up with nothing to buy, and savings interest compounds that dead pile
rather than rewarding a decision.

**Open:** tiers 10, 15 and 20 are the *same menu for every path* — they cannot branch on which tier-5
option was chosen, because the data model has no notion of conditional tiers. They are designed to
build on either direction instead. Genuine branching would need a `requires` key on each option.

**Measured, with a caveat:** the current curve sits within ~3 waves of the previous one and well short
of the original, using a fixed builder — see the sweep table above. Cross-map probe results partly
measure the builder's placement heuristic rather than map difficulty.

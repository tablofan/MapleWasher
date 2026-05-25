# MapleWasher

Browser-based calculator for HP/MP washing in MapleLegends — the practice of using AP Resets to trade MP for HP, exploiting INT-based MP gains to overshoot natural HP caps.

## Language

### Goals & constraints

**HP Goal**:
The user's required final HP at the **Target Level**. A hard constraint — the calculated plan must meet or exceed it.
_Avoid_: HP target, max HP

**MP Goal**:
The user's required final MP at the **Target Level**. A hard constraint — the calculated plan must meet or exceed it. Must itself be ≥ **Minimum MP** at the target level.
_Avoid_: MP target, max MP

**Target Level**:
The character level at which both **HP Goal** and **MP Goal** must be satisfied.
_Avoid_: goal level, washing target level

**Minimum MP**:
The class-and-level-dependent MP floor that **AP Resets** cannot drop MP below. A game-enforced lower bound. Computed per Nise's MapleLegends formulas (e.g. `14·L + 135` for 2nd-job+ Thieves).
_Avoid_: MP floor, min MP

### Game primitives

**AP Reset**:
A Cash Shop consumable (3,100 NX each) that converts one point of any stat into one point of any other stat. The atomic operation underlying every washing method. Notation: `-X +Y` (e.g. `-MP +INT`).
_Avoid_: reset, scroll

**AP Allocation**:
The free placement of newly-earned AP points (from level-up) into any stat. Distinct from **AP Reset** — no item is consumed, the AP is "fresh".
_Avoid_: AP spend, stat point

**Base INT**:
INT from **AP Allocation** and AP-Reset gains. Excludes equipment. Used in `INT/10` MP gain bonuses.
_Avoid_: pure INT, character INT

**Gear INT**:
INT from equipment. Added to **Base INT** to get **Total INT** (the value used in MP-gain formulas). User enters this as a flat number; assumed worn from level 10 until **Level to Remove INT Gear**.
_Avoid_: INT gear, equip INT

**Total INT**:
**Base INT** + **Gear INT**. The value plugged into per-level MP-gain formulas.

**Main Stat**:
The combat stat each class scales damage from — STR (Warrior), DEX (Bowman/Pirate-Gunslinger), LUK (Thief), STR (Pirate-Brawler/Buccaneer), and **INT itself** (Magician). For Magicians, INT serves as both the washing currency *and* the **Main Stat**, which is why their wash is much simpler.
_Avoid_: primary stat, attacking stat

### Wash phases & strategy

**MP Wash**:
The cycle: allocate 1 fresh AP → MP at level-up, later AP Reset `-MP +X` (where X is INT, Main Stat, or HP). Net effect per cycle: (`MP_gain_fresh` − `MP_loss_reset`) MP + 1 of stat X. Each cycle costs 1 **AP Reset**.

**Fresh HP Wash**:
Allocate 1 fresh AP → HP at level-up; the HP gain is the higher "Fresh AP HP" value for that class. Doesn't itself consume an AP Reset, but consumes a fresh AP slot. Typically paired with an `-MP +STAT` reset later to absorb the MP penalty from natural level-up MP gain.

**Stale HP Wash**:
AP Reset `-MP +HP` — directly converts existing MP into HP at the (slightly lower) Stale AP HP rate for the class. One **AP Reset** per HP point gained.

**MP Wash Start Level**:
The character level at which the user begins **MP Wash** cycles. Before this, fresh AP goes into building **Base INT**; from this level on, fresh AP goes into MP for the wash cycle. Decided by the calculator.

**Target Base INT**:
The peak **Base INT** the calculator decides the user should build up to. Sustained from the end of the INT-build phase through to **Target Level**. Reset back to **Main Stat** at **Target Level**.

**Phase Plan**:
The level-banded sequence of allocation strategies the calculator outputs. Always shaped: build **Base INT** → **MP Wash** → reset **Base INT** to **Main Stat** at **Target Level**. **Fresh HP Wash** and **Stale HP Wash** are interleaved as needed.

## Calculator behavior

The calculator's job is to find the **Phase Plan** that minimises total **AP Resets** subject to: `final HP ≥ HP Goal`, `final MP ≥ MP Goal`, `MP ≥ Minimum MP` at every level along the way.

**Locked to Target Level (not optimization variables):**
- Level to remove **Gear INT** = **Target Level** (wearing it longer only helps; removing it earlier costs MP gain).
- Level to reset **Base INT** → **Main Stat** = **Target Level** (resetting earlier loses INT/10 MP gain for remaining levels at no benefit).

**Search space (calculator decides):**
- **Target Base INT**
- **MP Wash Start Level**
- **MP Wash Stop Level** (the level at which the user switches from **MP Wash** to **Stale HP Wash** / **Fresh HP Wash**; can be ≤ **Target Level** — Krythan's NL sheet defaults to lvl 145 with **Target Level** = 180)
- The mix of **Fresh HP Wash** / **Stale HP Wash** per level (where applicable)
- For mid-progress users: amount of **Main Stat → INT** AP Resets to do up-front, if it lowers total cost

## Output

When the calculator runs successfully:

1. **Summary card** — `Target Base INT`, `MP Wash Start Level`, `MP Wash Stop Level`, total **AP Resets**, **NX Cost** (= AP Resets × 3,100), **Days-to-Wash** (= NX Cost ÷ 6,500 NX-per-day-per-account), plus a one-line per-reset-type breakdown.
2. **Phase Plan** — level-banded allocation guide (e.g. "Lvl 4-67 · All fresh AP → INT") matching the **Search space** decisions.
3. **Level-by-level table** — 7 columns: Level, HP, MP, Base INT, Phase, AP Resets this level, Cumulative AP Resets. Collapsed by default. The Phase column shows one of: *Build Base INT* / *MP Wash* / *Stale HP Wash* / *Fresh HP Wash* / *Reset Base INT* / *Done*.

When the user's inputs make the goal **infeasible** (e.g. Mage requesting 30k HP at lvl 50), the calculator shows an **infeasibility warning** in place of the Summary, naming the violated constraint (`HP Goal exceeds maximum possible at Target Level` / `MP Goal below Minimum MP at Target Level`).

**Days-to-Wash** anchors the user on whether the plan is realistic: 6,500 NX/day/account from daily voting, so a 7.5M NX plan = ~1,150 days on one account or ~580 days on two. Shown alongside the raw NX number, not in place of it.

## Reference calculators (MapleLegends)

Krythan's per-class washing sheets — one per class, same author, same Nise-formula basis. Useful templates for our analytical math (they compute HP/MP by summing contributions rather than simulating level-by-level):

- Night Lord / Archer: `1Ja3Fq26SCGZz-WCPkcxwbw-3tJGmzgR871hNvZzGcm0`
- Corsair: `1TrtTH36lrAUvCS5-ZMxrO5Gy_ChLAbm653hWKlYa2w0`
- Mage: `17LC5PGv8p0-DB-uEKFV8RxCZXEEvqtQLknNr-XK2j04`
- Warrior: `1xY8q4bTbICN6CfC6mcp74jWc96gru4otte9kAIYgJ_Q`
- Buccaneer: `1UffgnbjUbmkSZTnuZBe2dnzCyoBCbRYyiVMBIvJSCoY`

Their inputs include both "Level to Stop MP Washing" (the strategic switch) AND "Level to Project To" (the level at which targets are evaluated). MapleWasher collapses both into the single **Target Level** and treats the switch point as an internal optimization variable (**MP Wash Stop Level**) hidden from the user.

Differences from MapleWasher's scope: Krythan's sheets include HP Challenges columns (skipped here), Spring of Youth quest HP and equip HP constants (skipped here), and individual INT-gear-piece tracking (replaced here with a single Gear INT input).

## Relationships

- An **HP Goal** and an **MP Goal** are both evaluated at the same **Target Level**.
- An **MP Goal** must be ≥ **Minimum MP** at the **Target Level** — the game makes lower MP physically unreachable via AP Resets.

## Example dialogue

> **User:** "I want 30k HP and 4k MP by level 135 on my Night Lord."
> **Calculator:** "Your HP Goal is 30,000 and MP Goal is 4,000, both at Target Level 135. Minimum MP for a Night Lord at level 135 is 2,025, so 4,000 is feasible."

## Flagged ambiguities

*(none yet)*

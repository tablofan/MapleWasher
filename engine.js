// MapleWasher calculator engine.
// Analytical (no level-by-level simulation in the hot loop) — mirrors Krythan's approach.

const GEAR_WORN_FROM_LEVEL = 10;  // Per spec: INT gear is treated as worn from lvl 10 onward.
const MAX_HP = 30000;
const MAX_MP = 30000;

function firstJALevel(classData) {
  return classData.jaBonuses.length > 0 ? classData.jaBonuses[0].level : 10;
}

function naturalHPGainAtLevel(classData, L) {
  if (L <= firstJALevel(classData)) return BEGINNER_HP_PER_LEVEL;
  let gain = classData.naturalHPPerLevel;
  if (classData.maxHPActivatesAt !== null && L >= classData.maxHPActivatesAt) {
    gain += classData.maxHPBonusPerLevel;
  }
  return gain;
}

function naturalMPGainAtLevel(classData, L) {
  if (L <= firstJALevel(classData)) return BEGINNER_MP_PER_LEVEL;
  let gain = classData.naturalMPPerLevel;
  // NOTE: Mages don't have MaxMP active until ~lvl 16 (when the skill is typically maxed).
  // Pre-16 Magicians legitimately use the lower base. Matches Krythan's reference sheets.
  if (classData.maxMPActivatesAt !== null && L >= classData.maxMPActivatesAt) {
    gain += classData.maxMPBonusPerLevel;
  }
  return gain;
}

function cumulativeNaturalHP(classData, fromLevel, toLevel) {
  let total = 0;
  for (let L = fromLevel + 1; L <= toLevel; L++) {
    total += naturalHPGainAtLevel(classData, L);
  }
  return total;
}

function cumulativeNaturalMPBase(classData, fromLevel, toLevel) {
  let total = 0;
  for (let L = fromLevel + 1; L <= toLevel; L++) {
    total += naturalMPGainAtLevel(classData, L);
  }
  return total;
}

function jaHPBonusInRange(classData, fromLevel, toLevel) {
  let total = 0;
  for (const ja of classData.jaBonuses) {
    if (ja.level > fromLevel && ja.level <= toLevel) total += ja.hp;
  }
  return total;
}

function jaMPBonusInRange(classData, fromLevel, toLevel) {
  let total = 0;
  for (const ja of classData.jaBonuses) {
    if (ja.level > fromLevel && ja.level <= toLevel) total += ja.mp;
  }
  return total;
}

function minMPAtLevel(classData, level) {
  return Math.max(0, classData.minMPFormula(level));
}

function minHPAtLevel(classData, level) {
  // Per Nise's compilation, every class has an exact (coeff * level + intercept) Min HP formula.
  return Math.max(0, classData.minHPFormula(level));
}

// Clamp HP Goal and MP Goal up to their respective class+level Min HP/MP floors at the
// Target Level. At Target Level the character is in its post-2nd-JA state, where max HP/MP
// is game-enforced to be ≥ Min HP/MP — so a Goal below the floor is unreachable-NOT-to-meet,
// and we treat the user's typed Goal as the floor. The user's typed value stays visible in
// the input; the engine receives the floored value; the UI surfaces the returned `notes`.
//
// IMPORTANT: Current HP and Current MP are NOT clamped. Pre-2nd-JA states (e.g. lvl 1 with
// HP 50 / MP 5) legitimately sit below the Min HP/MP formula — the formulas describe the
// post-advancement floor, not a hard constraint on the user's actual current state.
//
// Mutates the input objects in place and returns the list of clamps applied. Each note carries
// { fieldId, label, stat, clamped, atLevel, className }.
function prepareInputs(classData, currentState, goals, className) {
  const notes = [];

  const minHPAtTgt = minHPAtLevel(classData, goals.targetLevel);
  if (goals.hpGoal < minHPAtTgt) {
    notes.push({ fieldId: 'i-hp-goal', label: 'HP Goal', stat: 'HP', clamped: minHPAtTgt, atLevel: goals.targetLevel, className });
    goals.hpGoal = minHPAtTgt;
  }
  const minMPAtTgt = minMPAtLevel(classData, goals.targetLevel);
  if (goals.mpGoal < minMPAtTgt) {
    notes.push({ fieldId: 'i-mp-goal', label: 'MP Goal', stat: 'MP', clamped: minMPAtTgt, atLevel: goals.targetLevel, className });
    goals.mpGoal = minMPAtTgt;
  }
  return notes;
}

// ─────────────────── Wash-math primitives ───────────────────
// Named domain operations from CONTEXT.md. Each is a single per-cycle / per-level formula —
// all consumers (evaluateStrategy, levelTable) should call these instead of inlining the math.

// MP gained per single MP-Wash cycle (Krythan/Nise): freshAPMPBase + floor(Base INT / 10) - mpLossPerReset.
// Uses Base INT only — Gear INT and Maple Warrior do NOT amplify this per-cycle yield (per Nise).
function washCycleMP(classData, baseInt) {
  const deficit = classData.mpLossPerReset - classData.freshAPMPBase;
  return Math.floor(baseInt / 10) - deficit;
}

// Per-level MP gained from INT after a level-up: floor((Base INT * MW + Gear INT) / 10).
// Gear INT contributes only if level ≥ GEAR_WORN_FROM_LEVEL. Class-independent (no classData).
function intMPPerLevel(baseInt, gearInt, mwMultiplier, level) {
  const gearActive = level >= GEAR_WORN_FROM_LEVEL ? gearInt : 0;
  return Math.floor((baseInt * mwMultiplier + gearActive) / 10);
}

// HP yield from Fresh HP Wash (N fresh APs allocated to HP at level-up).
function freshHPWashYield(classData, count) {
  return count * classData.freshAPHP;
}

// HP yield from Stale HP Wash (N -MP +HP AP Resets).
function staleHPWashYield(classData, count) {
  return count * classData.staleAPHP;
}

// MP cost (drain) of N -MP +X AP Resets — same per-reset cost regardless of destination.
function washCycleMPCost(classData, count) {
  return count * classData.mpLossPerReset;
}

// Sum of INT-driven MP contributions over levels (fromLevel, toLevel] (level-ups at L = fromLevel+1 … toLevel).
// Per Nise: MP Gained LvlUP includes Total INT/10. Per Krythan: MW multiplies the Base-INT portion only.
// Per spec: Gear INT is worn from level GEAR_WORN_FROM_LEVEL onward (lvl 10 by default).
// Per level L: gain = floor((Base_INT_at_L * MW + Gear_INT_at_L) / 10), via intMPPerLevel().
//
// For plateau ranges (startInt === endInt) the sum is computed as `levels * intMPPerLevel(...)`.
// For ramp ranges, this iterates per level using the same `+5 INT per level, capped at endInt`
// rule that levelTable() applies — so the analytical sum here and the per-level walk in
// levelTable always agree exactly. This is the contract that lets us drop the test tolerance.
function intMPContribution(fromLevel, toLevel, startInt, endInt, gearInt, mwMultiplier) {
  const levels = toLevel - fromLevel;
  if (levels <= 0) return 0;

  if (startInt === endInt) {
    // Plateau: INT constant across the range. Split at the gear threshold for one O(1) answer.
    if (toLevel < GEAR_WORN_FROM_LEVEL) {
      return levels * Math.floor((startInt * mwMultiplier) / 10);
    }
    if (fromLevel + 1 >= GEAR_WORN_FROM_LEVEL) {
      return levels * Math.floor((startInt * mwMultiplier + gearInt) / 10);
    }
    const preLevels = (GEAR_WORN_FROM_LEVEL - 1) - fromLevel;
    const postLevels = levels - preLevels;
    return preLevels * Math.floor((startInt * mwMultiplier) / 10)
         + postLevels * Math.floor((startInt * mwMultiplier + gearInt) / 10);
  }

  // Ramp: walk per level. At the START of level L (used for L's intMP gain), INT = the value
  // after level L-1's allocations. The per-level allocation is +5 INT (Phase 1: fresh AP all to
  // INT; Phase 2 build: 5 -MP +INT resets), capped so Base INT never exceeds endInt.
  let intAtL = startInt;
  let total = 0;
  for (let i = 1; i <= levels; i++) {
    const L = fromLevel + i;
    total += intMPPerLevel(intAtL, gearInt, mwMultiplier, L);
    intAtL = Math.min(endInt, intAtL + 5);
  }
  return total;
}

// ─────────────────── Phase steps ───────────────────
// Each phase is a pure computation taking the strategy params and producing the phase's outputs.
// `evaluateStrategy` chains them and runs cross-phase invariant checks between calls.

// Phase 1: INT build via fresh AP from currentLevel → mpWashStart.
// 5 AP per level allocated to INT; Base INT rises from `startBaseInt` to `phase1EndInt`.
function runPhase1(classData, currentState, params, gearInt, mwMultiplier) {
  const { mpWashStart, shift } = params;
  const startBaseInt = currentState.baseInt + shift;
  const phase1Levels = mpWashStart - currentState.level;
  const phase1EndInt = startBaseInt + 5 * phase1Levels;
  const mpFromInt = intMPContribution(currentState.level, mpWashStart, startBaseInt, phase1EndInt, gearInt, mwMultiplier);
  return { startBaseInt, phase1EndInt, mpFromInt };
}

// Phase 2: MP Wash from mpWashStart → mpWashStop. 5 AP Resets/level: -MP +INT until Base INT
// reaches `targetBaseInt`, then -MP +MainStat for remaining plateau levels.
function runPhase2(classData, params, phase1, gearInt, mwMultiplier) {
  const { mpWashStart, mpWashStop, targetBaseInt } = params;
  const { phase1EndInt } = phase1;

  const phase2Levels = mpWashStop - mpWashStart;
  const phase2APResets = phase2Levels * 5;
  const intResetsInPhase2 = Math.max(0, targetBaseInt - phase1EndInt);
  const phase2BuildLevels = Math.ceil(intResetsInPhase2 / 5);
  const phase2PlateauLevels = phase2Levels - phase2BuildLevels;
  const phase2BuildEndLevel = mpWashStart + phase2BuildLevels;

  const mpFromInt_build   = intMPContribution(mpWashStart, phase2BuildEndLevel, phase1EndInt, targetBaseInt, gearInt, mwMultiplier);
  const mpFromInt_plateau = intMPContribution(phase2BuildEndLevel, mpWashStop, targetBaseInt, targetBaseInt, gearInt, mwMultiplier);

  const phase2BuildAvgInt = (phase1EndInt + targetBaseInt) / 2;
  const mpFromMPWash_build   = phase2BuildLevels   * 5 * washCycleMP(classData, phase2BuildAvgInt);
  const mpFromMPWash_plateau = phase2PlateauLevels * 5 * washCycleMP(classData, targetBaseInt);

  return {
    phase2APResets, intResetsInPhase2,
    phase2BuildLevels, phase2BuildEndLevel, phase2PlateauLevels,
    mpFromInt_build, mpFromInt_plateau,
    mpFromMPWash_build, mpFromMPWash_plateau,
  };
}

// Phase 3: from mpWashStop → targetLevel. Each level can combine `freshHPPerLevelPhase3`
// fresh-AP-to-HP wash AND `staleHPPerLevelPhase3` -MP+HP resets. Both drain MP via reset cost.
function runPhase3(classData, params, goals, gearInt, mwMultiplier) {
  const { mpWashStop, targetBaseInt, freshHPPerLevelPhase3, staleHPPerLevelPhase3 = 0 } = params;
  const phase3Levels = goals.targetLevel - mpWashStop;
  const phase3FreshHPResets = phase3Levels * freshHPPerLevelPhase3;
  const phase3StaleHPResets = phase3Levels * staleHPPerLevelPhase3;

  const hpFromFresh = freshHPWashYield(classData, phase3FreshHPResets);
  const hpFromStale = staleHPWashYield(classData, phase3StaleHPResets);
  // Base INT stays at targetBaseInt across Phase 3 (the reset to MainStat happens AT target level).
  const mpFromInt = intMPContribution(mpWashStop, goals.targetLevel, targetBaseInt, targetBaseInt, gearInt, mwMultiplier);
  const mpFromResets = -washCycleMPCost(classData, phase3FreshHPResets + phase3StaleHPResets);

  return {
    phase3FreshHPResets, phase3StaleHPResets,
    hpFromFresh, hpFromStale,
    mpFromInt, mpFromResets,
  };
}

// Cleanup at target level: cleanup Stale HP Wash (-MP +HP) tops up to HP Goal, then Base INT
// is reset back to MainStat (skipped for Mages — see classData.requiresIntResetAtTarget).
function runCleanup(classData, hpEndPhase3, mpEndPhase3Raw, goals, targetBaseInt) {
  const intResetAPResets = classData.requiresIntResetAtTarget ? Math.max(0, targetBaseInt - STARTING_MAIN_STAT) : 0;
  const hpGap = Math.max(0, goals.hpGoal - hpEndPhase3);
  const cleanupStaleHPWash = hpGap > 0 ? Math.ceil(hpGap / classData.staleAPHP) : 0;
  const finalHP = Math.min(MAX_HP, hpEndPhase3 + staleHPWashYield(classData, cleanupStaleHPWash));
  const finalMP = mpEndPhase3Raw - washCycleMPCost(classData, cleanupStaleHPWash);
  return { intResetAPResets, cleanupStaleHPWash, finalHP, finalMP };
}

// The strategy:
//   (Pre-game) Optional `shift`: AP-Reset `-<non-INT> +INT` (shift > 0; source is any of the user's non-INT stats)
//              or `-INT +MainStat` (shift < 0; Mages can't shift down — their MainStat IS INT).
//   Phase 1 (currentLevel → mpWashStart): Fresh AP → INT. Base INT rises from (currentBaseInt + shift) to phase1EndInt.
//   Phase 2 (mpWashStart → mpWashStop):  MP Wash. Fresh AP → MP. 5 AP Resets/lvl: -MP +INT until targetBaseInt, then -MP +MainStat.
//   Phase 3 (mpWashStop → targetLevel): Combinable per level — `freshHPPerLevelPhase3` fresh-AP→HP (each paired
//              with a -MP +MainStat reset) AND `staleHPPerLevelPhase3` -MP +HP resets (drains MP into HP at the
//              stale rate; required when peak MP would otherwise blow past the 30k cap).
//   At targetLevel: Stale HP wash (-MP +HP) to fill remaining HP gap, then Reset Base INT (-INT +MainStat) to STARTING_MAIN_STAT (skipped for Mages).
//
// Returns { feasible, finalHP, finalMP, apResets, breakdown, params }.
function evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, params, ranges, phase1Cache) {
  const { targetBaseInt, mpWashStart, mpWashStop, shift } = params;
  ranges = ranges || precomputeRanges(classData, currentState.level, goals.targetLevel);

  // --- Cross-phase parameter validation ---
  const startBaseInt = currentState.baseInt + shift;
  if (startBaseInt < STARTING_MAIN_STAT) return { feasible: false, reason: 'shift would drop Base INT below starting value' };
  if (startBaseInt > targetBaseInt)      return { feasible: false, reason: 'starting INT after shift exceeds target INT' };
  if (mpWashStart < currentState.level || mpWashStop < mpWashStart || mpWashStop > goals.targetLevel) {
    return { feasible: false, reason: 'invalid phase ordering' };
  }

  // --- Phase 1 (hoistable: depends only on currentState, mpWashStart, shift — not on mpWashStop / freshHP / staleHP)
  const p1 = phase1Cache || runPhase1(classData, currentState, params, gearInt, mwMultiplier);
  if (p1.phase1EndInt > targetBaseInt) return { feasible: false, reason: 'phase 1 overshoots target INT' };

  // --- Phase 2 ---
  const p2 = runPhase2(classData, params, p1, gearInt, mwMultiplier);
  if (p2.intResetsInPhase2 > p2.phase2APResets) return { feasible: false, reason: 'not enough phase 2 resets to reach target INT' };

  // --- Phase 3 ---
  const p3 = runPhase3(classData, params, goals, gearInt, mwMultiplier);

  // --- Aggregate end-of-Phase-3 HP/MP ---
  const hpEndPhase3 = currentState.hp + ranges.hpNatural + ranges.hpJA + p3.hpFromFresh + p3.hpFromStale;
  const mpEndPhase3Raw = currentState.mp + ranges.mpNaturalBase + ranges.mpJA
    + p1.mpFromInt + p2.mpFromInt_build + p2.mpFromInt_plateau + p3.mpFromInt
    + p2.mpFromMPWash_build + p2.mpFromMPWash_plateau
    + p3.mpFromResets;

  // MP at the Phase 2 → Phase 3 boundary (the peak if Phase 3 drains MP).
  const naturalMPInPhase3 = ranges.naturalMPInRange(mpWashStop, goals.targetLevel);
  const jaMPInPhase3 = ranges.jaMPInRange(mpWashStop, goals.targetLevel);
  const mpEndPhase2 = mpEndPhase3Raw - (naturalMPInPhase3 + jaMPInPhase3 + p3.mpFromInt + p3.mpFromResets);

  // --- 30k caps + Min MP/HP invariant checks ---
  const peakMP = Math.max(mpEndPhase2, mpEndPhase3Raw);
  if (peakMP > MAX_MP) return { feasible: false, reason: `Plan overshoots the 30,000 MP cap (peak would reach ${Math.round(peakMP)})` };
  if (hpEndPhase3 > MAX_HP) return { feasible: false, reason: `Plan overshoots the 30,000 HP cap (would reach ${Math.round(hpEndPhase3)})` };

  const mpAtMPWashStart = currentState.mp
    + ranges.naturalMPInRange(currentState.level, mpWashStart)
    + ranges.jaMPInRange(currentState.level, mpWashStart)
    + p1.mpFromInt;
  const minMPAtStart = minMPAtLevel(classData, mpWashStart);
  if (mpAtMPWashStart < minMPAtStart) {
    return { feasible: false, reason: `MP at lvl ${mpWashStart} (${Math.round(mpAtMPWashStart)}) would be below Min MP (${minMPAtStart})` };
  }
  const minMPAtStop = minMPAtLevel(classData, mpWashStop);
  if (mpEndPhase2 < minMPAtStop) {
    return { feasible: false, reason: `MP at lvl ${mpWashStop} (${Math.round(mpEndPhase2)}) would be below Min MP (${minMPAtStop})` };
  }
  if (mpEndPhase3Raw < minMPAtLevel(classData, goals.targetLevel)) {
    return { feasible: false, reason: `MP at lvl ${goals.targetLevel} after Phase 3 washes (${Math.round(mpEndPhase3Raw)}) would be below Min MP (${minMPAtLevel(classData, goals.targetLevel)})` };
  }

  // --- Cleanup ---
  const cleanup = runCleanup(classData, hpEndPhase3, mpEndPhase3Raw, goals, targetBaseInt);

  // --- Final goal checks ---
  const minMPAtTarget = minMPAtLevel(classData, goals.targetLevel);
  if (cleanup.finalMP < minMPAtTarget) {
    return { feasible: false, reason: `Final MP (${Math.round(cleanup.finalMP)}) would be below Min MP (${minMPAtTarget}) at lvl ${goals.targetLevel}` };
  }
  if (cleanup.finalMP < goals.mpGoal) return { feasible: false, reason: 'MP Goal not reached' };
  const minHPAtTarget = minHPAtLevel(classData, goals.targetLevel);
  if (cleanup.finalHP < minHPAtTarget) {
    return { feasible: false, reason: `Final HP (${Math.round(cleanup.finalHP)}) would be below Min HP (${minHPAtTarget}) at lvl ${goals.targetLevel}` };
  }

  // --- Assemble result ---
  const totalStaleHPWash = p3.phase3StaleHPResets + cleanup.cleanupStaleHPWash;
  const apResets = p2.phase2APResets + p3.phase3FreshHPResets + p3.phase3StaleHPResets
                 + cleanup.intResetAPResets + cleanup.cleanupStaleHPWash + Math.abs(shift);

  return {
    feasible: true,
    finalHP: Math.round(cleanup.finalHP),
    finalMP: Math.round(cleanup.finalMP),
    apResets,
    breakdown: {
      shift: Math.abs(shift),
      shiftDir: shift >= 0 ? 'up' : 'down',
      mpWash: p2.phase2APResets,
      phase3Fresh: p3.phase3FreshHPResets,
      intReset: cleanup.intResetAPResets,
      staleHPWash: totalStaleHPWash,
    },
    params: {
      ...params,
      phase1EndInt: p1.phase1EndInt,
      phase2BuildEndLevel: p2.phase2BuildEndLevel,
      mpEndPhase2: Math.round(mpEndPhase2),
      mpEndPhase3: Math.round(mpEndPhase3Raw),
      hpEndPhase3: Math.round(hpEndPhase3),
      phase3StaleHPResets: p3.phase3StaleHPResets,
      cleanupStaleHPWash: cleanup.cleanupStaleHPWash,
    },
  };
}

// Precompute level-range quantities that don't depend on strategy choice.
// (Called once outside the brute-force loop; each saves O(targetLevel) work per evaluation.)
// Builds prefix sums for O(1) range queries — partial ranges are pulled by subtraction.
function precomputeRanges(classData, fromLevel, toLevel) {
  const naturalMPPrefix = new Float64Array(toLevel + 2);
  const jaMPPrefix = new Float64Array(toLevel + 2);
  for (let L = 1; L <= toLevel; L++) {
    naturalMPPrefix[L] = naturalMPPrefix[L - 1] + naturalMPGainAtLevel(classData, L);
    jaMPPrefix[L] = jaMPPrefix[L - 1];
    for (const ja of classData.jaBonuses) {
      if (ja.level === L) jaMPPrefix[L] += ja.mp;
    }
  }
  return {
    hpNatural: cumulativeNaturalHP(classData, fromLevel, toLevel),
    mpNaturalBase: naturalMPPrefix[toLevel] - naturalMPPrefix[fromLevel],
    hpJA: jaHPBonusInRange(classData, fromLevel, toLevel),
    mpJA: jaMPPrefix[toLevel] - jaMPPrefix[fromLevel],
    naturalMPInRange: (from, to) => naturalMPPrefix[to] - naturalMPPrefix[from],
    jaMPInRange: (from, to) => jaMPPrefix[to] - jaMPPrefix[from],
  };
}

// Brute-force search across the parameter space; returns the minimum-AP-Reset feasible plan.
function optimize(classData, currentState, goals, gearInt, mwMultiplier) {
  // Quick global feasibility prechecks.
  if (goals.hpGoal > MAX_HP) {
    return { feasible: false, reason: `HP Goal (${goals.hpGoal}) exceeds the 30,000 HP cap.` };
  }
  if (goals.mpGoal > MAX_MP) {
    return { feasible: false, reason: `MP Goal (${goals.mpGoal}) exceeds the 30,000 MP cap.` };
  }
  if (goals.hpGoal < 0 || goals.mpGoal < 0) {
    return { feasible: false, reason: 'HP and MP Goals must be ≥ 0.' };
  }
  if (currentState.level < 1 || currentState.level > 200) {
    return { feasible: false, reason: 'Current Level must be in [1, 200].' };
  }
  if (goals.targetLevel < 2 || goals.targetLevel > 200) {
    return { feasible: false, reason: 'Target Level must be in [2, 200].' };
  }
  if (currentState.level >= goals.targetLevel) {
    return { feasible: false, reason: `Target Level (${goals.targetLevel}) must be greater than Current Level (${currentState.level}).` };
  }
  const minMPAtTarget = minMPAtLevel(classData, goals.targetLevel);
  if (goals.mpGoal < minMPAtTarget) {
    return { feasible: false, reason: `MP Goal (${goals.mpGoal}) is below the minimum possible MP (${minMPAtTarget}) at level ${goals.targetLevel} for a ${classData.isMage ? 'Magician' : 'character of this class'}.` };
  }
  const minHPAtTarget = minHPAtLevel(classData, goals.targetLevel);
  if (goals.hpGoal < minHPAtTarget) {
    return { feasible: false, reason: `HP Goal (${goals.hpGoal}) is below the minimum possible HP (${minHPAtTarget}) at level ${goals.targetLevel}.` };
  }

  const remainingLevels = goals.targetLevel - currentState.level;
  // Positive-shift budget = sum of non-INT stats above starting. The optimizer doesn't care which specific
  // non-INT stat is the source — the player chooses (and accepts the consume-into-MainStat collapse at target).
  const str = currentState.str ?? STARTING_MAIN_STAT;
  const dex = currentState.dex ?? STARTING_MAIN_STAT;
  const luk = currentState.luk ?? STARTING_MAIN_STAT;
  const maxPositiveShift = Math.max(0,
    (str - STARTING_MAIN_STAT) + (dex - STARTING_MAIN_STAT) + (luk - STARTING_MAIN_STAT)
  );
  const maxNegativeShift = classData.canShiftIntDownToMainStat ? Math.max(0, currentState.baseInt - STARTING_MAIN_STAT) : 0;

  // Precompute range sums (these depend only on class + currentLevel + targetLevel, not strategy).
  const ranges = precomputeRanges(classData, currentState.level, goals.targetLevel);

  // Target Base INT range. Allow values BELOW current Base INT (via shift-down).
  const intMin = STARTING_MAIN_STAT;
  // Cap: largest INT we could reach via shift-up + all fresh AP. No reason to go higher.
  const intMax = Math.min(2000, currentState.baseInt + maxPositiveShift + 5 * remainingLevels);
  const intStep = 5;

  let best = null;
  let bestReason = 'No feasible strategy found.';

  for (let targetBaseInt = intMin; targetBaseInt <= intMax; targetBaseInt += intStep) {
    // idealShift makes phase 1 zero-length (start at target INT already).
    const idealShift = targetBaseInt - currentState.baseInt;
    // shift ∈ [minShift, maxShift]. minShift covers "fit phase 1 within remainingLevels"; maxShift covers "fit phase 1 ≥ 0".
    const minShift = Math.max(-maxNegativeShift, idealShift - 5 * remainingLevels);
    const maxShift = Math.min(maxPositiveShift, idealShift);
    if (minShift > maxShift) continue;

    // Shift candidates: a handful of strategic values rather than a fine sweep.
    const shiftCandidateSet = new Set();
    shiftCandidateSet.add(minShift);
    shiftCandidateSet.add(maxShift);
    if (idealShift >= minShift && idealShift <= maxShift) shiftCandidateSet.add(idealShift);
    if (0 >= minShift && 0 <= maxShift) shiftCandidateSet.add(0);
    // A few intermediate points
    if (maxShift - minShift > 5) {
      shiftCandidateSet.add(Math.floor((minShift + maxShift) / 2));
      shiftCandidateSet.add(Math.floor(minShift + (maxShift - minShift) / 4));
      shiftCandidateSet.add(Math.floor(minShift + 3 * (maxShift - minShift) / 4));
    }
    const shiftCandidates = [...shiftCandidateSet].filter(s => s >= minShift && s <= maxShift);

    for (const shift of shiftCandidates) {
      const adjustedStart = currentState.baseInt + shift;
      if (adjustedStart < STARTING_MAIN_STAT || adjustedStart > targetBaseInt) continue;

      // Phase 1 length needed via fresh AP (after shift).
      const phase1IntNeeded = targetBaseInt - adjustedStart;
      const phase1FreshLevels = Math.floor(phase1IntNeeded / 5);
      const naturalMPWashStart = currentState.level + phase1FreshLevels;

      // MP-wash-start candidates: the no-overlap natural value plus 2 "overlap" candidates
      // where MP wash starts earlier (Phase 2 builds the remaining INT via -MP +INT cycles).
      const mpWashStartCandidates = new Set();
      mpWashStartCandidates.add(naturalMPWashStart);
      // Earlier candidates — make Phase 1 shorter
      const earlier1 = currentState.level + Math.floor(phase1FreshLevels * 0.5);
      const earlier2 = Math.max(currentState.level, currentState.level + phase1FreshLevels - 10);
      mpWashStartCandidates.add(earlier1);
      mpWashStartCandidates.add(earlier2);
      mpWashStartCandidates.add(currentState.level);  // Full overlap (no Phase 1)

      for (const mpWashStart of mpWashStartCandidates) {
        if (mpWashStart < currentState.level || mpWashStart > goals.targetLevel) continue;

        // Hoist Phase 1 out of the inner 3 loops — Phase 1 depends only on (currentState,
        // mpWashStart, shift) and the per-level iteration would otherwise re-run for every
        // (mpWashStop × freshHP × staleHP) combo. This restores most of the perf cost from
        // unifying intMPContribution's math with levelTable.
        const phase1Cache = runPhase1(classData, currentState, { mpWashStart, shift, targetBaseInt }, gearInt, mwMultiplier);
        if (phase1Cache.phase1EndInt > targetBaseInt) continue;

        // mpWashStop step 1 for accuracy. Phase 3 freshHPPerLevel full sweep [0..5] — needed for
        // Warriors/Buccaneers where intermediate values (2, 4) are often optimal.
        // Phase 3 staleHPPerLevel [0..5]: lets the optimizer absorb MP overshoot mid-flight via -MP+HP.
        for (let mpWashStop = mpWashStart; mpWashStop <= goals.targetLevel; mpWashStop++) {
          for (let freshHPPerLevelPhase3 = 0; freshHPPerLevelPhase3 <= 5; freshHPPerLevelPhase3++) {
            for (let staleHPPerLevelPhase3 = 0; staleHPPerLevelPhase3 <= 5; staleHPPerLevelPhase3++) {
              const result = evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, {
                targetBaseInt, mpWashStart, mpWashStop, shift, freshHPPerLevelPhase3, staleHPPerLevelPhase3,
              }, ranges, phase1Cache);

              if (result.feasible && result.finalHP >= goals.hpGoal) {
                if (!best || result.apResets < best.apResets) best = result;
              } else if (!result.feasible && result.reason && !best) {
                bestReason = result.reason;
              }
            }
          }
        }
      }
    }
  }

  if (best) return best;
  return { feasible: false, reason: bestReason };
}

// Generate a Phase Plan description from a chosen strategy result.
function phasePlan(classData, currentState, goals, result) {
  const p = result.params;
  const b = result.breakdown;
  const phases = [];

  if (b.shift > 0 && b.shiftDir === 'up') {
    phases.push({
      range: `Before levelling`,
      action: `AP Reset ${b.shift} times: -<STR/DEX/LUK> +INT (mid-progress shift; you choose which non-INT stat(s) to draw from).`,
      phase: 'Shift to INT',
    });
  } else if (b.shift > 0 && b.shiftDir === 'down') {
    phases.push({
      range: `Before levelling`,
      action: `AP Reset ${b.shift} times: -INT +${classData.mainStat} (reduce over-built INT).`,
      phase: 'Shift from INT',
    });
  }
  if (p.mpWashStart > currentState.level) {
    const fromInt = currentState.baseInt + (b.shiftDir === 'down' ? -b.shift : b.shift);
    phases.push({
      range: `Lvl ${currentState.level} → ${p.mpWashStart}`,
      action: `Allocate fresh AP to INT. Build Base INT from ${fromInt} to ${p.phase1EndInt}.`,
      phase: 'Build Base INT',
    });
  }
  if (p.mpWashStop > p.mpWashStart) {
    phases.push({
      range: `Lvl ${p.mpWashStart} → ${p.mpWashStop}`,
      action: `Allocate fresh AP to MP. 5 AP Resets per level: -MP +INT until Base INT = ${p.targetBaseInt}, then -MP +${classData.mainStat}.`,
      phase: 'MP Wash',
    });
  }
  if (goals.targetLevel > p.mpWashStop) {
    const fresh = p.freshHPPerLevelPhase3;
    const stale = p.staleHPPerLevelPhase3 || 0;
    if (fresh > 0 || stale > 0) {
      const parts = [];
      if (fresh > 0) parts.push(`${fresh} fresh AP per level → HP (Fresh HP Wash) + ${fresh} AP Resets: -MP +${classData.mainStat}`);
      if (stale > 0) parts.push(`${stale} AP Resets per level: -MP +HP (Stale HP Wash, absorbs MP)`);
      const phaseName = (fresh > 0 && stale > 0) ? 'Fresh + Stale HP Wash'
                      : fresh > 0 ? 'Fresh HP Wash'
                      : 'Stale HP Wash';
      phases.push({
        range: `Lvl ${p.mpWashStop} → ${goals.targetLevel}`,
        action: parts.join(' · ') + '.',
        phase: phaseName,
      });
    } else {
      phases.push({
        range: `Lvl ${p.mpWashStop} → ${goals.targetLevel}`,
        action: `Allocate fresh AP to ${classData.mainStat}.`,
        phase: `Build ${classData.mainStat}`,
      });
    }
  }
  // Cleanup stale wash at target level (separate from any Phase 3 stale wash; both count toward breakdown.staleHPWash).
  if (p.cleanupStaleHPWash > 0) {
    phases.push({
      range: `At Lvl ${goals.targetLevel}`,
      action: `${p.cleanupStaleHPWash} AP Resets: -MP +HP (Stale HP Wash, fill remaining HP gap).`,
      phase: 'Stale HP Wash',
    });
  }
  if (b.intReset > 0) {
    phases.push({
      range: `At Lvl ${goals.targetLevel}`,
      action: `${b.intReset} AP Resets: -INT +${classData.mainStat} (Reset Base INT).`,
      phase: 'Reset Base INT',
    });
  }
  return phases;
}

// Generate a level-by-level table. Mirrors the analytical engine's math by sharing the same
// wash-math primitives (washCycleMP, intMPPerLevel, freshHPWashYield, staleHPWashYield,
// washCycleMPCost). Each per-level value is computed with the same formula evaluateStrategy
// used to compute its analytical sum, so the two paths agree.
function levelTable(classData, currentState, goals, gearInt, mwMultiplier, result) {
  const p = result.params;
  const rows = [];

  let hp = currentState.hp;
  let mp = currentState.mp;
  let baseInt = currentState.baseInt + (result.breakdown.shiftDir === 'down' ? -result.breakdown.shift : result.breakdown.shift);
  let cumulativeResets = result.breakdown.shift;  // pre-game shift counted at level 0

  for (let L = currentState.level; L <= goals.targetLevel; L++) {
    let resetsThisLevel = 0;
    let phase = '';

    if (L > currentState.level) {
      // Natural HP/MP gain on level-up to L. Gear is worn iff L >= GEAR_WORN_FROM_LEVEL.
      // INT reset happens AT target level AFTER this level-up's MP gain, so use baseInt and full gearInt here.
      hp += naturalHPGainAtLevel(classData, L);
      mp += naturalMPGainAtLevel(classData, L);
      mp += intMPPerLevel(baseInt, gearInt, mwMultiplier, L);
      // JA bonus this level
      for (const ja of classData.jaBonuses) {
        if (ja.level === L) {
          hp += ja.hp;
          mp += ja.mp;
        }
      }
    }

    // Phase classification + actions
    if (L < p.mpWashStart) {
      phase = 'Build Base INT';
      if (L > currentState.level) baseInt += 5;
    } else if (L < p.mpWashStop) {
      phase = 'MP Wash';
      if (L > currentState.level) {
        const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += resetsToInt;
        // 5 cycles/lvl, each cycle gain = washCycleMP(class, current baseInt).
        mp += 5 * washCycleMP(classData, baseInt);
        resetsThisLevel = 5;
      }
    } else if (L < goals.targetLevel) {
      const fresh = p.freshHPPerLevelPhase3;
      const stale = p.staleHPPerLevelPhase3 || 0;
      if (fresh > 0 || stale > 0) {
        phase = (fresh > 0 && stale > 0) ? 'Fresh + Stale HP Wash'
              : fresh > 0 ? 'Fresh HP Wash'
              : 'Stale HP Wash';
        if (L > currentState.level) {
          hp += freshHPWashYield(classData, fresh) + staleHPWashYield(classData, stale);
          mp -= washCycleMPCost(classData, fresh + stale);
          resetsThisLevel = fresh + stale;
        }
      } else {
        phase = `Build ${classData.mainStat}`;
      }
    } else {
      // L == targetLevel: cleanup stale HP wash (gap fill) + reset INT all happen here.
      const cleanupStale = p.cleanupStaleHPWash || 0;
      const intResets = result.breakdown.intReset;
      hp = Math.min(MAX_HP, hp + staleHPWashYield(classData, cleanupStale));
      mp -= washCycleMPCost(classData, cleanupStale);
      baseInt = classData.requiresIntResetAtTarget ? STARTING_MAIN_STAT : baseInt;
      resetsThisLevel = cleanupStale + intResets;
      phase = cleanupStale > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
        : cleanupStale > 0 ? 'Stale HP Wash'
        : intResets > 0 ? 'Reset Base INT'
        : 'Done';
    }

    cumulativeResets += resetsThisLevel;

    rows.push({
      level: L,
      hp: Math.round(hp),
      mp: Math.round(mp),
      baseInt: Math.round(baseInt),
      phase,
      resetsThisLevel,
      cumulativeResets,
    });
  }

  return rows;
}

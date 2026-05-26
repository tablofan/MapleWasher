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

// Sum of INT-driven MP contributions over levels (fromLevel, toLevel] (level-ups at L = fromLevel+1 … toLevel).
// Per Nise: MP Gained LvlUP includes Total INT/10. Per Krythan: MW multiplies the Base-INT portion only.
// Per spec: Gear INT is worn from level GEAR_WORN_FROM_LEVEL onward (lvl 10 by default).
// Per level: gain = floor((Base_INT_at_L * MW + Gear_INT_at_L) / 10).
function intMPContribution(fromLevel, toLevel, startInt, endInt, gearInt, mwMultiplier) {
  const levels = toLevel - fromLevel;
  if (levels <= 0) return 0;
  // Linear interpolation of Base INT across the phase.
  // intAt(L) = startInt + (endInt - startInt) * (L - fromLevel) / levels

  if (toLevel < GEAR_WORN_FROM_LEVEL) {
    // No gear contribution in the whole range.
    const avg = (startInt + endInt) / 2;
    return levels * Math.floor((avg * mwMultiplier) / 10);
  }
  if (fromLevel + 1 >= GEAR_WORN_FROM_LEVEL) {
    // Gear contributes to all level-ups in the range.
    const avg = (startInt + endInt) / 2;
    return levels * Math.floor((avg * mwMultiplier + gearInt) / 10);
  }
  // Split at the gear-worn threshold.
  // Pre-gear level-ups: L in [fromLevel+1, GEAR_WORN_FROM_LEVEL - 1].
  // Post-gear level-ups: L in [GEAR_WORN_FROM_LEVEL, toLevel].
  const preLevels = (GEAR_WORN_FROM_LEVEL - 1) - fromLevel;
  const postLevels = toLevel - (GEAR_WORN_FROM_LEVEL - 1);
  // Base INT at the boundary (just before gear is worn).
  const intAtBoundary = startInt + (endInt - startInt) * (preLevels / levels);
  const avgPre = (startInt + intAtBoundary) / 2;
  const avgPost = (intAtBoundary + endInt) / 2;
  return preLevels * Math.floor((avgPre * mwMultiplier) / 10)
       + postLevels * Math.floor((avgPost * mwMultiplier + gearInt) / 10);
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
function evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, params, ranges) {
  const { targetBaseInt, mpWashStart, mpWashStop, shift, freshHPPerLevelPhase3, staleHPPerLevelPhase3 = 0 } = params;
  const isMage = classData.mainStat === 'INT';
  // Cached range sums (if not provided, compute lazily).
  ranges = ranges || precomputeRanges(classData, currentState.level, goals.targetLevel);

  // --- Validate input ranges ---
  const startBaseInt = currentState.baseInt + shift;
  if (startBaseInt < STARTING_MAIN_STAT) {
    return { feasible: false, reason: 'shift would drop Base INT below starting value' };
  }
  if (startBaseInt > targetBaseInt) {
    // Phase 1 cannot reduce INT; require sufficient shift down or smaller target.
    return { feasible: false, reason: 'starting INT after shift exceeds target INT' };
  }
  if (mpWashStart < currentState.level || mpWashStop < mpWashStart || mpWashStop > goals.targetLevel) {
    return { feasible: false, reason: 'invalid phase ordering' };
  }

  // --- Phase 1: INT build via fresh AP from currentLevel to mpWashStart ---
  const phase1Levels = mpWashStart - currentState.level;
  const phase1IntGain = 5 * phase1Levels;
  const phase1EndInt = startBaseInt + phase1IntGain;

  if (phase1EndInt > targetBaseInt) {
    return { feasible: false, reason: 'phase 1 overshoots target INT' };
  }

  // --- Phase 2: MP Wash from mpWashStart to mpWashStop ---
  const phase2Levels = mpWashStop - mpWashStart;
  const phase2APResets = phase2Levels * 5;

  const intResetsInPhase2 = Math.max(0, targetBaseInt - phase1EndInt);
  if (intResetsInPhase2 > phase2APResets) {
    return { feasible: false, reason: 'not enough phase 2 resets to reach target INT' };
  }
  const phase2BuildLevels = Math.ceil(intResetsInPhase2 / 5);
  const phase2PlateauLevels = phase2Levels - phase2BuildLevels;
  const phase2BuildEndLevel = mpWashStart + phase2BuildLevels;

  // --- Phase 3 ---
  const phase3Levels = goals.targetLevel - mpWashStop;
  const phase3FreshHPResets = phase3Levels * freshHPPerLevelPhase3;
  const phase3StaleHPResets = phase3Levels * staleHPPerLevelPhase3;

  // --- HP accumulated through phases (natural, JA, Phase-3 fresh+stale wash) ---
  const hpFromNatural = ranges.hpNatural;
  const hpFromJA = ranges.hpJA;
  const hpFromPhase3Fresh = phase3FreshHPResets * classData.freshAPHP;
  const hpFromPhase3Stale = phase3StaleHPResets * classData.staleAPHP;

  // --- MP accumulated ---
  const mpFromNatural = ranges.mpNaturalBase;
  const mpFromJA = ranges.mpJA;
  const mpFromInt_phase1     = intMPContribution(currentState.level,  mpWashStart,         startBaseInt,    phase1EndInt,    gearInt, mwMultiplier);
  const mpFromInt_phase2build = intMPContribution(mpWashStart,         phase2BuildEndLevel, phase1EndInt,    targetBaseInt,   gearInt, mwMultiplier);
  const mpFromInt_phase2plateau = intMPContribution(phase2BuildEndLevel, mpWashStop,        targetBaseInt,   targetBaseInt,   gearInt, mwMultiplier);
  // Phase 3 still has Base INT = targetBaseInt for non-Mages (reset happens AT target level, not before).
  const mpFromInt_phase3     = intMPContribution(mpWashStop,          goals.targetLevel,   targetBaseInt,   targetBaseInt,   gearInt, mwMultiplier);

  // MP Wash net per cycle (Krythan / Nise): (freshAPMPBase + Base INT/10) - mpLossPerReset = Base INT/10 - deficit.
  // Uses Base INT only (no Gear INT, no MW). Phase 2 build uses avg INT during the ramp; plateau uses target.
  const deficit = classData.mpLossPerReset - classData.freshAPMPBase;
  const phase2BuildAvgInt = (phase1EndInt + targetBaseInt) / 2;
  const mpFromMPWashBuild   = phase2BuildLevels   * 5 * (Math.floor(phase2BuildAvgInt / 10) - deficit);
  const mpFromMPWashPlateau = phase2PlateauLevels * 5 * (Math.floor(targetBaseInt / 10)    - deficit);

  // Each Phase 3 fresh-HP-wash AP and each Phase 3 stale-HP-wash drains mpLossPerReset MP.
  const mpFromPhase3Resets = -(phase3FreshHPResets + phase3StaleHPResets) * classData.mpLossPerReset;

  // --- Assemble totals at end of phase 3 (before final cleanup stale HP wash at target level) ---
  const hpEndPhase3 = currentState.hp + hpFromNatural + hpFromJA + hpFromPhase3Fresh + hpFromPhase3Stale;
  const mpEndPhase3Raw = currentState.mp + mpFromNatural + mpFromJA
    + mpFromInt_phase1 + mpFromInt_phase2build + mpFromInt_phase2plateau + mpFromInt_phase3
    + mpFromMPWashBuild + mpFromMPWashPlateau
    + mpFromPhase3Resets;

  // MP at the boundary between Phase 2 and Phase 3 (peak if Phase 3 drains MP via wash; lower bound if Phase 3 builds).
  const naturalMPInPhase3 = cumulativeNaturalMPBase(classData, mpWashStop, goals.targetLevel);
  const jaMPInPhase3 = jaMPBonusInRange(classData, mpWashStop, goals.targetLevel);
  const phase3NetMPChange = naturalMPInPhase3 + jaMPInPhase3 + mpFromInt_phase3 + mpFromPhase3Resets;
  const mpEndPhase2 = mpEndPhase3Raw - phase3NetMPChange;

  // 30k caps — game enforces this at every level. Peak is max(end-of-Phase-2, end-of-Phase-3).
  const peakMP = Math.max(mpEndPhase2, mpEndPhase3Raw);
  if (peakMP > MAX_MP) {
    return { feasible: false, reason: `Plan overshoots the 30,000 MP cap (peak would reach ${Math.round(peakMP)})` };
  }
  if (hpEndPhase3 > MAX_HP) {
    return { feasible: false, reason: `Plan overshoots the 30,000 HP cap (would reach ${Math.round(hpEndPhase3)})` };
  }
  const mpEndPhase3 = mpEndPhase3Raw;

  // Min MP at MP-wash-start (MP must already be ≥ Min MP there).
  const mpAtMPWashStart = currentState.mp
    + cumulativeNaturalMPBase(classData, currentState.level, mpWashStart)
    + jaMPBonusInRange(classData, currentState.level, mpWashStart)
    + mpFromInt_phase1;
  const minMPAtStart = minMPAtLevel(classData, mpWashStart);
  if (mpAtMPWashStart < minMPAtStart) {
    return { feasible: false, reason: `MP at lvl ${mpWashStart} (${Math.round(mpAtMPWashStart)}) would be below Min MP (${minMPAtStart})` };
  }
  // If Phase 3 drains MP (fresh/stale wash), the lowest pre-cleanup MP is at the end of Phase 3.
  // If Phase 3 builds MP, the lowest pre-cleanup MP is at mpWashStop (mpEndPhase2). Check both.
  const minMPAtStop = minMPAtLevel(classData, mpWashStop);
  if (mpEndPhase2 < minMPAtStop) {
    return { feasible: false, reason: `MP at lvl ${mpWashStop} (${Math.round(mpEndPhase2)}) would be below Min MP (${minMPAtStop})` };
  }
  if (mpEndPhase3 < minMPAtLevel(classData, goals.targetLevel)) {
    return { feasible: false, reason: `MP at lvl ${goals.targetLevel} after Phase 3 washes (${Math.round(mpEndPhase3)}) would be below Min MP (${minMPAtLevel(classData, goals.targetLevel)})` };
  }

  // --- Final cleanup at target level: stale HP wash (to fill HP gap) + Base INT reset ---
  const intResetAPResets = isMage ? 0 : Math.max(0, targetBaseInt - STARTING_MAIN_STAT);
  const hpGap = Math.max(0, goals.hpGoal - hpEndPhase3);
  const cleanupStaleHPWash = hpGap > 0 ? Math.ceil(hpGap / classData.staleAPHP) : 0;
  const mpCostCleanup = cleanupStaleHPWash * classData.mpLossPerReset;

  let finalHP = Math.min(MAX_HP, hpEndPhase3 + cleanupStaleHPWash * classData.staleAPHP);
  const finalMP = mpEndPhase3 - mpCostCleanup;

  const minMPAtTarget = minMPAtLevel(classData, goals.targetLevel);
  if (finalMP < minMPAtTarget) {
    return { feasible: false, reason: `Final MP (${Math.round(finalMP)}) would be below Min MP (${minMPAtTarget}) at lvl ${goals.targetLevel}` };
  }
  if (finalMP < goals.mpGoal) {
    return { feasible: false, reason: 'MP Goal not reached' };
  }
  const minHPAtTarget = minHPAtLevel(classData, goals.targetLevel);
  if (finalHP < minHPAtTarget) {
    return { feasible: false, reason: `Final HP (${Math.round(finalHP)}) would be below Min HP (${minHPAtTarget}) at lvl ${goals.targetLevel}` };
  }

  // Total Stale HP Wash resets = mid-flight (Phase 3) + cleanup (target level). Lumped for the UI breakdown.
  const totalStaleHPWash = phase3StaleHPResets + cleanupStaleHPWash;
  // Total AP Resets — `shift` may be negative; its absolute value is the reset cost.
  const apResets = phase2APResets + phase3FreshHPResets + phase3StaleHPResets + intResetAPResets + cleanupStaleHPWash + Math.abs(shift);

  return {
    feasible: true,
    finalHP: Math.round(finalHP),
    finalMP: Math.round(finalMP),
    apResets,
    breakdown: {
      shift: Math.abs(shift),
      shiftDir: shift >= 0 ? 'up' : 'down',
      mpWash: phase2APResets,
      phase3Fresh: phase3FreshHPResets,
      intReset: intResetAPResets,
      staleHPWash: totalStaleHPWash,
    },
    params: {
      ...params,
      phase1EndInt,
      phase2BuildEndLevel,
      mpEndPhase2: Math.round(mpEndPhase2),
      mpEndPhase3: Math.round(mpEndPhase3),
      hpEndPhase3: Math.round(hpEndPhase3),
      phase3StaleHPResets,
      cleanupStaleHPWash,
    },
  };
}

// Precompute level-range quantities that don't depend on strategy choice.
// (Called once outside the brute-force loop; each saves O(targetLevel) work per evaluation.)
function precomputeRanges(classData, fromLevel, toLevel) {
  return {
    hpNatural: cumulativeNaturalHP(classData, fromLevel, toLevel),
    mpNaturalBase: cumulativeNaturalMPBase(classData, fromLevel, toLevel),
    hpJA: jaHPBonusInRange(classData, fromLevel, toLevel),
    mpJA: jaMPBonusInRange(classData, fromLevel, toLevel),
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
    return { feasible: false, reason: `MP Goal (${goals.mpGoal}) is below the minimum possible MP (${minMPAtTarget}) at level ${goals.targetLevel} for a ${classData.mainStat === 'INT' ? 'Magician' : 'character of this class'}.` };
  }
  const minHPAtTarget = minHPAtLevel(classData, goals.targetLevel);
  if (goals.hpGoal < minHPAtTarget) {
    return { feasible: false, reason: `HP Goal (${goals.hpGoal}) is below the minimum possible HP (${minHPAtTarget}) at level ${goals.targetLevel}.` };
  }

  const isMage = classData.mainStat === 'INT';
  const remainingLevels = goals.targetLevel - currentState.level;
  // Positive-shift budget = sum of non-INT stats above starting. The optimizer doesn't care which specific
  // non-INT stat is the source — the player chooses (and accepts the consume-into-MainStat collapse at target).
  const str = currentState.str ?? STARTING_MAIN_STAT;
  const dex = currentState.dex ?? STARTING_MAIN_STAT;
  const luk = currentState.luk ?? STARTING_MAIN_STAT;
  const maxPositiveShift = Math.max(0,
    (str - STARTING_MAIN_STAT) + (dex - STARTING_MAIN_STAT) + (luk - STARTING_MAIN_STAT)
  );
  // Mages can't shift INT down — their MainStat IS INT, so the destination is a no-op.
  const maxNegativeShift = isMage ? 0 : Math.max(0, currentState.baseInt - STARTING_MAIN_STAT);

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

        // mpWashStop step 1 for accuracy. Phase 3 freshHPPerLevel full sweep [0..5] — needed for
        // Warriors/Buccaneers where intermediate values (2, 4) are often optimal.
        // Phase 3 staleHPPerLevel [0..5]: lets the optimizer absorb MP overshoot mid-flight via -MP+HP.
        for (let mpWashStop = mpWashStart; mpWashStop <= goals.targetLevel; mpWashStop++) {
          for (let freshHPPerLevelPhase3 = 0; freshHPPerLevelPhase3 <= 5; freshHPPerLevelPhase3++) {
            for (let staleHPPerLevelPhase3 = 0; staleHPPerLevelPhase3 <= 5; staleHPPerLevelPhase3++) {
              const result = evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, {
                targetBaseInt, mpWashStart, mpWashStop, shift, freshHPPerLevelPhase3, staleHPPerLevelPhase3,
              }, ranges);

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
  const isMage = classData.mainStat === 'INT';
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

// Generate a level-by-level table. Mirrors the analytical engine's math (same formulas, no Gear INT or MW in MP-wash cycles).
function levelTable(classData, currentState, goals, gearInt, mwMultiplier, result) {
  const p = result.params;
  const isMage = classData.mainStat === 'INT';
  const rows = [];
  const deficit = classData.mpLossPerReset - classData.freshAPMPBase;

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
      const gearActive = (L >= GEAR_WORN_FROM_LEVEL) ? gearInt : 0;
      mp += Math.floor((baseInt * mwMultiplier + gearActive) / 10);
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
        // 5 resets/lvl, gain per cycle = floor(Base INT / 10) - deficit (Base INT only, no Gear, no MW)
        const mpFromCycle = 5 * (Math.floor(baseInt / 10) - deficit);
        mp += mpFromCycle;
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
          hp += fresh * classData.freshAPHP + stale * classData.staleAPHP;
          mp -= (fresh + stale) * classData.mpLossPerReset;
          resetsThisLevel = fresh + stale;
        }
      } else {
        phase = `Build ${classData.mainStat}`;
      }
    } else {
      // L == targetLevel: cleanup stale HP wash (gap fill) + reset INT all happen here.
      const cleanupStale = p.cleanupStaleHPWash || 0;
      const intResets = result.breakdown.intReset;
      hp = Math.min(MAX_HP, hp + cleanupStale * classData.staleAPHP);
      mp -= cleanupStale * classData.mpLossPerReset;
      baseInt = isMage ? baseInt : STARTING_MAIN_STAT;
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

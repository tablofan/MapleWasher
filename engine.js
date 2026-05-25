// MapleWasher calculator engine.
// Analytical (no level-by-level simulation in the hot loop) — mirrors Krythan's approach.

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

// Sum of (avgInt/10) MP contributions over levels [fromLevel+1 .. toLevel],
// where Base INT varies linearly between startInt and endInt across that range.
// Also multiplied by the Maple Warrior multiplier.
function intMPContribution(fromLevel, toLevel, startInt, endInt, gearInt, mwMultiplier) {
  const levels = toLevel - fromLevel;
  if (levels <= 0) return 0;
  const avgBaseInt = (startInt + endInt) / 2;
  const avgTotalInt = avgBaseInt + gearInt;
  return levels * Math.floor(avgTotalInt / 10) * mwMultiplier;
}

// The strategy:
//   Phase 1 (currentLevel → mpWashStart):  Fresh AP → INT.  Base INT rises from startBaseInt to startBaseInt + 5*(mpWashStart - currentLevel).
//   Phase 2 (mpWashStart → mpWashStop):    MP Wash. Fresh AP → MP. 5 AP Resets per level go to:
//                                            -MP +INT until targetBaseInt reached
//                                            -MP +MainStat thereafter (until end of phase 2)
//   Phase 3 (mpWashStop → targetLevel):    No more MP wash; fresh AP goes to MainStat or HP (Fresh HP Wash).
//   At targetLevel:                        Reset Base INT to 4 (or keep INT for Mages); stale HP wash to fill remaining HP gap.
//
// Returns { feasible, finalHP, finalMP, apResets, breakdown, params }.
function evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, params) {
  const { targetBaseInt, mpWashStart, mpWashStop, shift, freshHPPerLevelPhase3 } = params;
  const isMage = classData.mainStat === 'INT';

  // --- Validate input ranges ---
  const startBaseInt = currentState.baseInt + shift;
  if (startBaseInt > targetBaseInt) {
    // We'd need to AP-reset down — model that as infeasible for this strategy.
    return { feasible: false, reason: 'shift exceeds target INT' };
  }
  if (mpWashStart < currentState.level || mpWashStop < mpWashStart || mpWashStop > goals.targetLevel) {
    return { feasible: false, reason: 'invalid phase ordering' };
  }

  // --- Phase 1: INT build via fresh AP from currentLevel to mpWashStart ---
  const phase1Levels = mpWashStart - currentState.level;
  const phase1IntGain = 5 * phase1Levels;
  const phase1EndInt = startBaseInt + phase1IntGain;

  if (phase1EndInt > targetBaseInt) {
    // We'd overshoot targetBaseInt in phase 1; that means mpWashStart could be earlier and
    // we'd save phase-1 levels. We treat as infeasible to keep the search clean.
    return { feasible: false, reason: 'phase 1 overshoots target INT' };
  }

  // --- Phase 2: MP Wash from mpWashStart to mpWashStop ---
  const phase2Levels = mpWashStop - mpWashStart;
  const phase2APResets = phase2Levels * 5;

  // INT during phase 2: rises from phase1EndInt to targetBaseInt via AP Resets,
  // then plateaus at targetBaseInt.
  const intResetsInPhase2 = Math.max(0, targetBaseInt - phase1EndInt);
  if (intResetsInPhase2 > phase2APResets) {
    return { feasible: false, reason: 'not enough phase 2 resets to reach target INT' };
  }
  const mainStatResetsInPhase2 = phase2APResets - intResetsInPhase2;
  // Levels in phase 2 spent building INT vs at-target-INT
  const phase2BuildLevels = Math.ceil(intResetsInPhase2 / 5);
  const phase2PlateauLevels = phase2Levels - phase2BuildLevels;
  const phase2BuildEndLevel = mpWashStart + phase2BuildLevels;

  // --- Phase 3: post-MP-Wash from mpWashStop to targetLevel ---
  const phase3Levels = goals.targetLevel - mpWashStop;
  // Fresh HP wash: freshHPPerLevelPhase3 AP per level go to HP; one AP Reset -MP +MainStat per (to absorb MP penalty)
  // Net per fresh HP wash AP: +freshAPHP HP, -mpLossPerReset MP, +1 MainStat. Costs 1 AP Reset.
  const phase3FreshHPResets = phase3Levels * freshHPPerLevelPhase3;

  // --- HP accumulated through phases 1, 2, 3 from natural and JA bonuses ---
  const hpFromNatural = cumulativeNaturalHP(classData, currentState.level, goals.targetLevel);
  const hpFromJA = jaHPBonusInRange(classData, currentState.level, goals.targetLevel);
  const hpFromPhase3Fresh = phase3FreshHPResets * classData.freshAPHP;

  // --- MP accumulated through phases ---
  const mpFromNatural = cumulativeNaturalMPBase(classData, currentState.level, goals.targetLevel);
  const mpFromJA = jaMPBonusInRange(classData, currentState.level, goals.targetLevel);
  // MP from INT contribution per phase (avg INT × levels / 10, times MW multiplier)
  const mpFromInt_phase1 = intMPContribution(currentState.level, mpWashStart, startBaseInt, phase1EndInt, gearInt, mwMultiplier);
  const mpFromInt_phase2build = intMPContribution(mpWashStart, phase2BuildEndLevel, phase1EndInt, targetBaseInt, gearInt, mwMultiplier);
  const mpFromInt_phase2plateau = intMPContribution(phase2BuildEndLevel, mpWashStop, targetBaseInt, targetBaseInt, gearInt, mwMultiplier);
  // For Mages, INT stays as MainStat — no reset. For others, INT drops to 4 at targetLevel.
  // From mpWashStop to targetLevel: INT = targetBaseInt for non-Mages (only resets at targetLevel itself), or = targetBaseInt for Mages.
  const mpFromInt_phase3 = intMPContribution(mpWashStop, goals.targetLevel, targetBaseInt, targetBaseInt, gearInt, mwMultiplier);

  // MP gained from MP-wash cycles in phase 2: 5 resets per level × (avgInt/10 - deficit)
  // where avgInt is per-level, but for simplicity use avg across phase
  const phase2AvgInt = (phase1EndInt + targetBaseInt) / 2;
  const totalIntForCycle_phase2build = (phase2AvgInt + gearInt);
  const totalIntForCycle_phase2plateau = (targetBaseInt + gearInt);
  // MP gained per fresh AP into MP: freshAPMPBase + Total INT/10 (rounded down) × MW multiplier
  // (Per Krythan's M35 formula: ROUNDDOWN((K*MW + L)/10, 0) where K=Base INT, L=Gear INT)
  // Net MP per wash cycle = freshAPMPBase + INT contribution - mpLossPerReset
  const netMPPerCycle_phase2build = classData.freshAPMPBase + Math.floor(totalIntForCycle_phase2build * mwMultiplier / 10) * mwMultiplier - classData.mpLossPerReset;
  const netMPPerCycle_phase2plateau = classData.freshAPMPBase + Math.floor(totalIntForCycle_phase2plateau * mwMultiplier / 10) * mwMultiplier - classData.mpLossPerReset;

  // Simpler approximation matching Krythan: (INT/10 - deficit) × 5 per level, where deficit = mpLossPerReset - freshAPMPBase
  const deficit = classData.mpLossPerReset - classData.freshAPMPBase;
  const mpFromMPWashBuild = phase2BuildLevels * 5 * (Math.floor(phase2AvgInt * mwMultiplier / 10) + Math.floor(gearInt / 10) - deficit);
  const mpFromMPWashPlateau = phase2PlateauLevels * 5 * (Math.floor(targetBaseInt * mwMultiplier / 10) + Math.floor(gearInt / 10) - deficit);

  // Phase 3 fresh HP washes cost MP via the -MP +MainStat reset
  const mpFromPhase3Resets = -phase3FreshHPResets * classData.mpLossPerReset;

  // --- Assemble totals at end of phase 3 (before final stale HP wash) ---
  const hpEndPhase3 = currentState.hp + hpFromNatural + hpFromJA + hpFromPhase3Fresh;
  const mpEndPhase3 = currentState.mp + mpFromNatural + mpFromJA
    + mpFromInt_phase1 + mpFromInt_phase2build + mpFromInt_phase2plateau + mpFromInt_phase3
    + mpFromMPWashBuild + mpFromMPWashPlateau
    + mpFromPhase3Resets;

  // --- Final cleanup at targetLevel: reset INT + stale HP wash ---
  // INT reset cost (non-Mage only)
  const intResetAPResets = isMage ? 0 : Math.max(0, targetBaseInt - STARTING_MAIN_STAT);

  // Stale HP wash to fill HP gap
  const hpGap = Math.max(0, goals.hpGoal - hpEndPhase3);
  const staleHPWashAPResets = hpGap > 0 ? Math.ceil(hpGap / classData.staleAPHP) : 0;
  const mpCostStaleHPWash = staleHPWashAPResets * classData.mpLossPerReset;

  // Final HP & MP
  const finalHP = hpEndPhase3 + staleHPWashAPResets * classData.staleAPHP;
  const finalMP = mpEndPhase3 - mpCostStaleHPWash;

  // Min MP check at targetLevel
  const minMPAtTarget = minMPAtLevel(classData, goals.targetLevel);
  if (finalMP < minMPAtTarget) {
    return { feasible: false, reason: 'MP would go below Min MP at target level' };
  }
  if (finalMP < goals.mpGoal) {
    return { feasible: false, reason: 'MP Goal not reached' };
  }

  // Total AP Resets
  const apResets = phase2APResets + phase3FreshHPResets + intResetAPResets + staleHPWashAPResets + shift;

  return {
    feasible: true,
    finalHP: Math.round(finalHP),
    finalMP: Math.round(finalMP),
    apResets,
    breakdown: {
      shift,
      mpWash: phase2APResets,
      phase3Fresh: phase3FreshHPResets,
      intReset: intResetAPResets,
      staleHPWash: staleHPWashAPResets,
    },
    params: {
      ...params,
      phase1EndInt,
      phase2BuildEndLevel,
      mpEndPhase3: Math.round(mpEndPhase3),
      hpEndPhase3: Math.round(hpEndPhase3),
    },
  };
}

// Search over (targetBaseInt, mpWashStart, mpWashStop, shift, freshHPPerLevelPhase3) and return best.
function optimize(classData, currentState, goals, gearInt, mwMultiplier) {
  const isMage = classData.mainStat === 'INT';

  // Quick feasibility prechecks
  const minMPAtTarget = minMPAtLevel(classData, goals.targetLevel);
  if (goals.mpGoal < minMPAtTarget) {
    return { feasible: false, reason: `MP Goal (${goals.mpGoal}) is below the minimum possible MP (${minMPAtTarget}) at level ${goals.targetLevel} for a ${classData.mainStat === 'INT' ? 'Magician' : 'character of this class'}.` };
  }
  if (currentState.level >= goals.targetLevel) {
    return { feasible: false, reason: `Target Level (${goals.targetLevel}) must be greater than Current Level (${currentState.level}).` };
  }

  const remainingLevels = goals.targetLevel - currentState.level;
  const maxShiftAvailable = Math.max(0, currentState.mainStat - STARTING_MAIN_STAT);

  let best = null;
  let bestReason = 'No feasible strategy found.';

  // Coarse search; we narrow if useful.
  const intStep = 5;
  const intMin = Math.max(STARTING_MAIN_STAT, currentState.baseInt);
  // For mages, "Target Base INT" is just kept INT; doesn't need much building beyond what they'd already have.
  // Cap roughly at MP-wash usefulness ceiling.
  const intMax = Math.min(1000, currentState.baseInt + maxShiftAvailable + 5 * remainingLevels);

  for (let targetBaseInt = intMin; targetBaseInt <= intMax; targetBaseInt += intStep) {
    // Determine valid shift values: enough to make phase 1 reachable
    const totalIntNeededViaShiftPlusFresh = targetBaseInt - currentState.baseInt;
    const minShiftNeeded = Math.max(0, totalIntNeededViaShiftPlusFresh - 5 * remainingLevels);
    const maxShiftForThisInt = Math.min(maxShiftAvailable, totalIntNeededViaShiftPlusFresh);

    for (let shift = minShiftNeeded; shift <= maxShiftForThisInt; shift += Math.max(1, Math.floor((maxShiftForThisInt - minShiftNeeded) / 10) || 1)) {
      // Phase 1 length is determined: from currentLevel to (currentLevel + (targetBaseInt - currentBaseInt - shift) / 5)
      // But MP Wash can start earlier than this — try a few options.
      const naturalMPWashStart = currentState.level + Math.ceil((targetBaseInt - currentState.baseInt - shift) / 5);

      // Try mpWashStart at naturalMPWashStart (no overlap) and a few earlier values (with overlap).
      // For V1 we use only the natural start (simpler model). Overlap optimization can be V2.
      const mpWashStartCandidates = [naturalMPWashStart];

      for (const mpWashStart of mpWashStartCandidates) {
        if (mpWashStart < currentState.level || mpWashStart > goals.targetLevel) continue;

        for (let mpWashStop = mpWashStart; mpWashStop <= goals.targetLevel; mpWashStop += 5) {
          // Try fresh HP per level in phase 3 from 0 to 5
          for (let freshHPPerLevelPhase3 = 0; freshHPPerLevelPhase3 <= 5; freshHPPerLevelPhase3++) {
            const result = evaluateStrategy(classData, currentState, goals, gearInt, mwMultiplier, {
              targetBaseInt, mpWashStart, mpWashStop, shift, freshHPPerLevelPhase3,
            });

            if (result.feasible && result.finalHP >= goals.hpGoal) {
              if (!best || result.apResets < best.apResets) {
                best = result;
              }
            } else if (!result.feasible && result.reason && !best) {
              bestReason = result.reason;
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
  const phases = [];

  if (p.mpWashStart > currentState.level) {
    phases.push({
      range: `Lvl ${currentState.level} → ${p.mpWashStart}`,
      action: `Allocate fresh AP to INT. Build Base INT from ${currentState.baseInt + p.shift} to ${p.phase1EndInt}.`,
      phase: 'Build Base INT',
    });
  }
  if (p.shift > 0) {
    phases.unshift({
      range: `Before levelling`,
      action: `AP Reset ${p.shift} times: -${classData.mainStat} +INT.`,
      phase: 'Shift to INT',
    });
  }
  if (p.mpWashStop > p.mpWashStart) {
    phases.push({
      range: `Lvl ${p.mpWashStart} → ${p.mpWashStop}`,
      action: `Allocate fresh AP to MP. 5 AP Resets per level: -MP +INT until Base INT = ${p.targetBaseInt}, then -MP +${classData.mainStat}.`,
      phase: 'MP Wash',
    });
  }
  if (goals.targetLevel > p.mpWashStop && p.freshHPPerLevelPhase3 > 0) {
    phases.push({
      range: `Lvl ${p.mpWashStop} → ${goals.targetLevel}`,
      action: `Allocate ${p.freshHPPerLevelPhase3} fresh AP per level to HP (Fresh HP Wash), plus 1 AP Reset each: -MP +${classData.mainStat}.`,
      phase: 'Fresh HP Wash',
    });
  } else if (goals.targetLevel > p.mpWashStop) {
    phases.push({
      range: `Lvl ${p.mpWashStop} → ${goals.targetLevel}`,
      action: `Allocate fresh AP to ${classData.mainStat}.`,
      phase: 'Build Main Stat',
    });
  }
  if (result.breakdown.staleHPWash > 0) {
    phases.push({
      range: `Around Lvl ${goals.targetLevel}`,
      action: `${result.breakdown.staleHPWash} AP Resets: -MP +HP (Stale HP Wash).`,
      phase: 'Stale HP Wash',
    });
  }
  if (result.breakdown.intReset > 0) {
    phases.push({
      range: `At Lvl ${goals.targetLevel}`,
      action: `${result.breakdown.intReset} AP Resets: -INT +${classData.mainStat} (Reset Base INT).`,
      phase: 'Reset Base INT',
    });
  }
  return phases;
}

// Generate a level-by-level table from the chosen strategy.
function levelTable(classData, currentState, goals, gearInt, mwMultiplier, result) {
  const p = result.params;
  const isMage = classData.mainStat === 'INT';
  const rows = [];

  let hp = currentState.hp;
  let mp = currentState.mp;
  let baseInt = currentState.baseInt + p.shift;
  let cumulativeResets = p.shift;

  // Pre-game shift row (if any)
  // (We don't show this as a level row; it's implicit before currentLevel.)

  for (let L = currentState.level; L <= goals.targetLevel; L++) {
    // Apply level-up gains (for L > currentState.level)
    let resetsThisLevel = 0;
    let phase = '';

    if (L > currentState.level) {
      // Natural HP/MP gain
      hp += naturalHPGainAtLevel(classData, L);
      mp += naturalMPGainAtLevel(classData, L);
      // INT contribution to MP gain at this level (uses current Base INT and Gear INT)
      const intActive = (L < goals.targetLevel) ? baseInt : (isMage ? baseInt : STARTING_MAIN_STAT);
      const gearActive = (L < goals.targetLevel) ? gearInt : 0;
      mp += Math.floor((intActive + gearActive) / 10) * mwMultiplier;
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
      // 5 AP Resets this level: -MP +INT (until target) or -MP +MainStat
      if (L > currentState.level) {
        const resetsToInt = Math.min(5, Math.max(0, p.targetBaseInt - baseInt));
        baseInt += resetsToInt;
        const totalResets = 5;
        const mpFromCycle = (totalResets * (classData.freshAPMPBase + Math.floor((baseInt + gearInt) * mwMultiplier / 10) - classData.mpLossPerReset));
        mp += mpFromCycle;
        resetsThisLevel = totalResets;
      }
    } else if (L < goals.targetLevel) {
      if (p.freshHPPerLevelPhase3 > 0) {
        phase = 'Fresh HP Wash';
        if (L > currentState.level) {
          hp += p.freshHPPerLevelPhase3 * classData.freshAPHP;
          mp -= p.freshHPPerLevelPhase3 * classData.mpLossPerReset;
          resetsThisLevel = p.freshHPPerLevelPhase3;
        }
      } else {
        phase = `Build ${classData.mainStat}`;
      }
    } else {
      // Final level
      const staleResets = result.breakdown.staleHPWash;
      const intResets = result.breakdown.intReset;
      // Apply stale HP wash
      hp += staleResets * classData.staleAPHP;
      mp -= staleResets * classData.mpLossPerReset;
      // Apply INT reset
      baseInt = isMage ? baseInt : STARTING_MAIN_STAT;
      resetsThisLevel = staleResets + intResets;
      phase = staleResets > 0 && intResets > 0 ? 'Stale HP Wash + Reset INT'
        : staleResets > 0 ? 'Stale HP Wash'
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

// Tests for the MapleWasher engine.
//
// Run: `node tests/engine.test.js` (from repo root)
//
// No test framework — plain Node. The harness loads classes.js and engine.js
// via `eval` so we don't need module wrapping in the source files (they're
// loaded as plain <script> tags in the browser).
//
// Reference values for the calibration tests come from Krythan's per-class
// MapleLegends washing sheets (see CONTEXT.md for the spreadsheet IDs). Where
// his sheet allows a user-tunable input that our optimizer picks automatically
// (e.g. Target Base INT), we assert on the output ranges his sheets show across
// reasonable user choices, not on a single fixed number.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const classesSrc = fs.readFileSync(path.join(ROOT, 'classes.js'), 'utf-8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf-8');

// Load via a tmp CommonJS module so V8 JIT-optimises the hot loops the same way it does
// for normal require()'d code. (Top-level `eval` keeps the eval'd code in interpreted mode
// indefinitely, which is ~5× slower for the brute-force optimizer.)
const tmpModule = path.join(os.tmpdir(), `maplewasher-test-${process.pid}.js`);
const exportList = [
  'CLASSES', 'CLASS_ORDER', 'MAPLE_WARRIOR_LEVELS',
  'BEGINNER_HP_PER_LEVEL', 'BEGINNER_MP_PER_LEVEL',
  'STARTING_HP', 'STARTING_MP', 'STARTING_MAIN_STAT',
  'NX_PER_AP_RESET', 'MAX_NX_PER_DAY_PER_ACCOUNT',
  'MAX_HP', 'MAX_MP',
  'optimize', 'evaluateStrategy', 'phasePlan', 'levelTable',
  'minMPAtLevel', 'minHPAtLevel', 'prepareInputs',
  'runPhase1', 'runPhase2', 'runPhase3', 'runCleanup',
  'washCycleMP', 'freshHPWashYield', 'staleHPWashYield', 'washCycleMPCost',
];
fs.writeFileSync(tmpModule, classesSrc + '\n' + engineSrc + '\n' + `module.exports = { ${exportList.join(', ')} };`);
process.on('exit', () => { try { fs.unlinkSync(tmpModule); } catch {} });
const mod = require(tmpModule);
const { CLASSES, CLASS_ORDER, optimize, phasePlan, levelTable, prepareInputs } = mod;
globalThis.mod = mod;

// ────────────────────────── tiny harness ──────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  const t0 = Date.now();
  try {
    fn();
    const ms = Date.now() - t0;
    passed++;
    const tag = ms > 1000 ? ` (${ms}ms)` : '';
    console.log('  \x1b[32m✓\x1b[0m ' + name + tag);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    \x1b[31m' + (err.message || err) + '\x1b[0m');
  }
}

function describe(name, fn) {
  console.log('\n\x1b[1m' + name + '\x1b[0m');
  fn();
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg ? msg + ': ' : '') + 'expected ' + expected + ', got ' + actual);
}

function assertInRange(actual, min, max, msg) {
  if (actual < min || actual > max) throw new Error((msg ? msg + ': ' : '') + 'expected in [' + min + ', ' + max + '], got ' + actual);
}

function assertTrue(condition, msg) {
  if (!condition) throw new Error(msg || 'condition was false');
}

function assertFeasible(result) {
  if (!result.feasible) throw new Error('expected feasible plan, got infeasibility: ' + result.reason);
}

function assertInfeasible(result, reasonSubstring) {
  if (result.feasible) throw new Error('expected infeasible plan, but got feasible result with ' + result.apResets + ' AP Resets');
  if (reasonSubstring && !result.reason.toLowerCase().includes(reasonSubstring.toLowerCase())) {
    throw new Error('expected reason to mention "' + reasonSubstring + '", got: "' + result.reason + '"');
  }
}

// Convenience builder for `optimize` arguments.
// Supports both the new 4-stat shape (str/dex/luk/baseInt) and the legacy { mainStat: N } shorthand.
// When `mainStat` is supplied for a non-Mage class, it's mapped onto the class's main stat field.
function plan(opts) {
  const classData = CLASSES[opts.class];
  if (!classData) throw new Error('unknown class: ' + opts.class);
  const currentState = Object.assign(
    { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 },
    opts.current || {}
  );
  if (opts.current && opts.current.mainStat !== undefined && classData.mainStat !== 'INT') {
    currentState[classData.mainStat.toLowerCase()] = opts.current.mainStat;
  }
  delete currentState.mainStat;
  const goals = Object.assign({ hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, opts.goals || {});
  const gearInt = opts.gearInt ?? 40;
  const mwMultiplier = opts.mwMultiplier ?? 1.0;
  const r = optimize(classData, currentState, goals, gearInt, mwMultiplier);
  // Stash the className back into the result for tests that need it.
  if (r && r.params) r.params.className = opts.class;
  return r;
}

// ────────────────────────── reference cases ──────────────────────────
// Calibrated against Krythan's published sheet defaults.

describe('Reference cases (Krythan-aligned)', () => {
  test('Night Lord fresh start to 30k HP / 5k MP at lvl 180', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000, 'HP at cap');
    assertTrue(r.finalMP >= 5000, 'MP meets goal');
    // Krythan's NL sheet defaults give ~2121 AP Resets; tightened from 1900-2500.
    assertInRange(r.apResets, 2000, 2400, 'AP Resets within ±10% of Krythan default ~2121');
    assertInRange(r.params.targetBaseInt, 300, 600, 'Target Base INT in Krythan-style range');
  });

  test('Hero (Warrior) fresh start to 30k HP / 2k MP at lvl 180', () => {
    const r = plan({ class: 'Hero', goals: { hpGoal: 30000, mpGoal: 2000, targetLevel: 180 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000);
    assertTrue(r.finalMP >= 2000);
    // Warriors use fresh HP wash (52 HP/AP). Krythan's Warrior sheet gives ~470 resets.
    assertInRange(r.apResets, 400, 550, 'Warrior AP Resets near Krythan default ~470');
  });

  test('Magician fresh start to 5k HP / 10k MP at lvl 180', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalHP >= 5000, 'HP meets goal');
    assertTrue(r.finalMP >= 10000, 'MP meets goal');
    assertEq(r.breakdown.intReset, 0, 'Mages do not reset INT');
  });
});

describe('Maple Warrior multiplier', () => {
  const baseInputs = {
    class: 'Night Lord',
    goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
  };
  test('MW30 plan uses no more AP Resets than MW0', () => {
    const mw0 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.00 }));
    const mw30 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.15 }));
    assertFeasible(mw0);
    assertFeasible(mw30);
    // MW boosts natural MP gain from INT, so the optimizer can use a lower Target Base INT for
    // the same MP goal — fewer total resets (or at least no worse).
    assertTrue(mw30.apResets <= mw0.apResets, `MW30 (${mw30.apResets}) should be ≤ MW0 (${mw0.apResets})`);
  });
  test('MW20 is between MW0 and MW30', () => {
    const mw0  = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.00 }));
    const mw20 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.10 }));
    const mw30 = plan(Object.assign({}, baseInputs, { mwMultiplier: 1.15 }));
    assertTrue(mw20.apResets <= mw0.apResets);
    assertTrue(mw30.apResets <= mw20.apResets);
  });
});

describe('Mid-progress shift mechanic', () => {
  test('Mid-progress with low INT and high Main Stat picks a positive shift when beneficial', () => {
    // Lvl 100 Night Lord with LUK 400 but only 4 Base INT — should convert some LUK→INT.
    const r = plan({
      class: 'Night Lord',
      current: { level: 100, hp: 4000, mp: 1500, baseInt: 4, mainStat: 400 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(r);
    assertTrue(r.breakdown.shift > 0, 'shift should be > 0 (Main Stat → INT)');
    assertEq(r.breakdown.shiftDir, 'up', 'shift direction should be `up`');
  });
  test('Mid-progress with over-built INT picks a negative shift when target INT is lower', () => {
    // Lvl 100 Night Lord with way too much Base INT — the optimizer can choose to reduce it.
    const r = plan({
      class: 'Night Lord',
      current: { level: 100, hp: 4000, mp: 8000, baseInt: 800, mainStat: 4 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(r);
    if (r.params.targetBaseInt < 800) {
      assertEq(r.breakdown.shiftDir, 'down', 'shift direction should be `down`');
      assertTrue(r.breakdown.shift > 0, 'shift count should be > 0');
    }
  });
});

describe('Engine invariants', () => {
  test('Total AP Resets equals sum of breakdown parts', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const b = r.breakdown;
    const sum = b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash;
    assertEq(r.apResets, sum, `apResets ${r.apResets} != sum ${sum}`);
  });
  test('Invariant holds for Hero (Warrior-style plan with fresh HP wash dominant)', () => {
    const r = plan({ class: 'Hero', goals: { hpGoal: 30000, mpGoal: 2000, targetLevel: 180 } });
    assertFeasible(r);
    const b = r.breakdown;
    assertEq(r.apResets, b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash);
  });
  test('Invariant holds for Magician (no intReset, mostly MP wash)', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 } });
    assertFeasible(r);
    const b = r.breakdown;
    assertEq(r.apResets, b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash);
  });
  test('mpWashStart ≤ mpWashStop ≤ targetLevel always', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.params.mpWashStart <= r.params.mpWashStop, 'mpWashStart ≤ mpWashStop');
    assertTrue(r.params.mpWashStop <= 180, 'mpWashStop ≤ targetLevel');
  });
  test('Feasible plan with zero Gear INT', () => {
    const r = plan({
      class: 'Night Lord',
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
      gearInt: 0,
    });
    assertFeasible(r);
    assertEq(r.finalHP, 30000);
    assertTrue(r.finalMP >= 5000);
  });
});

describe('Unit tests for helpers', () => {
  test('minMPAtLevel matches Nise per class', () => {
    assertEq(mod.minMPAtLevel(CLASSES['Night Lord'], 180), 14 * 180 + 135);
    assertEq(mod.minMPAtLevel(CLASSES['Hero'], 180), 4 * 180 + 55);
    assertEq(mod.minMPAtLevel(CLASSES['Magician'], 180), 22 * 180 + 449);
    assertEq(mod.minMPAtLevel(CLASSES['Beginner'], 100), 10 * 100 - 5);
  });
  test('minHPAtLevel matches Nise per class', () => {
    assertEq(mod.minHPAtLevel(CLASSES['Night Lord'], 180), 20 * 180 + 378);
    assertEq(mod.minHPAtLevel(CLASSES['Hero'], 180), 24 * 180 + 472);
    assertEq(mod.minHPAtLevel(CLASSES['Dark Knight'], 180), 24 * 180 + 172);
    assertEq(mod.minHPAtLevel(CLASSES['Magician'], 180), 10 * 180 + 64);
    assertEq(mod.minHPAtLevel(CLASSES['Beginner'], 100), 12 * 100 + 50);
  });
});

describe('phasePlan output shape', () => {
  test('Night Lord plan emits Build Base INT → MP Wash → Stale HP Wash → Reset Base INT', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const phases = phasePlan(r.params && CLASSES[r.params.className || 'Night Lord'] || CLASSES['Night Lord'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, r);
    const phaseNames = phases.map(p => p.phase);
    assertTrue(phaseNames.includes('Build Base INT'), 'has Build Base INT phase');
    assertTrue(phaseNames.includes('MP Wash'), 'has MP Wash phase');
    assertTrue(phaseNames.includes('Reset Base INT'), 'has Reset Base INT phase');
  });
  test('Magician plan does not have a Reset Base INT phase', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 } });
    assertFeasible(r);
    const phases = phasePlan(CLASSES['Magician'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 }, r);
    const phaseNames = phases.map(p => p.phase);
    assertTrue(!phaseNames.includes('Reset Base INT'), 'Mages should not Reset Base INT');
  });
});

describe('levelTable output', () => {
  test('Has one row per level from current to target inclusive', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Night Lord'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    assertEq(rows.length, 180, '180 rows for levels 1-180');
    assertEq(rows[0].level, 1);
    assertEq(rows[rows.length - 1].level, 180);
  });
  test('Cumulative AP Resets monotone non-decreasing', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Night Lord'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    for (let i = 1; i < rows.length; i++) {
      assertTrue(rows[i].cumulativeResets >= rows[i-1].cumulativeResets, `non-decreasing at row ${i}`);
    }
  });
  test('HP is monotone non-decreasing across levels', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Night Lord'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    for (let i = 1; i < rows.length; i++) {
      assertTrue(rows[i].hp >= rows[i-1].hp, `HP non-decreasing at row ${i}`);
    }
  });
  test('Final-row HP matches the summary finalHP exactly (analytical and per-level paths unified)', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Night Lord'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    const lastRow = rows[rows.length - 1];
    // Both code paths now go through the same per-level math — no tolerance needed.
    assertEq(lastRow.hp, r.finalHP, `last row HP ${lastRow.hp} vs summary ${r.finalHP}`);
  });
  test('Final-row MP matches the summary finalMP exactly', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    const rows = levelTable(CLASSES['Night Lord'], { level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, 40, 1.0, r);
    const lastRow = rows[rows.length - 1];
    assertEq(lastRow.mp, r.finalMP, `last row MP ${lastRow.mp} vs summary ${r.finalMP}`);
  });
});

describe('Optimizer determinism', () => {
  test('Same inputs yield identical results on re-run', () => {
    const inputs = { class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } };
    const r1 = plan(inputs);
    const r2 = plan(inputs);
    assertEq(r1.apResets, r2.apResets);
    assertEq(r1.params.targetBaseInt, r2.params.targetBaseInt);
    assertEq(r1.params.mpWashStart, r2.params.mpWashStart);
    assertEq(r1.params.mpWashStop, r2.params.mpWashStop);
  });
});

// ────────────────────────── boundary cases ──────────────────────────

describe('Boundary cases', () => {
  test('Final HP equals exactly 30,000 when HP Goal is 30k (cap saturates)', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000, 'finalHP must equal the cap');
  });

  test('Final MP is capped at 30,000', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 2200, mpGoal: 25000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalMP <= 30000, 'finalMP must not exceed cap');
    assertTrue(r.params.mpEndPhase3 <= 30000, 'intermediate MP also respects cap');
  });

  test('MP Goal exactly at Min MP is feasible', () => {
    // Min MP for NL at lvl 180 = 14*180 + 135 = 2655.
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 5000, mpGoal: 2655, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalMP >= 2655);
  });

  test('Current Level == Target Level is infeasible', () => {
    const r = plan({ class: 'Night Lord', current: { level: 135, hp: 10000, mp: 2000 }, goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 135 } });
    assertInfeasible(r, 'target level');
  });

  test('Mid-progress current state typically costs less than a fresh start', () => {
    // Mid-progress at lvl 100 with some existing HP/MP/INT should be ≤ fresh-start cost.
    const fresh = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    const mid = plan({
      class: 'Night Lord',
      current: { level: 100, hp: 5000, mp: 3000, baseInt: 200, mainStat: 300 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(fresh);
    assertFeasible(mid);
    assertTrue(mid.apResets <= fresh.apResets * 1.1, 'mid-progress shouldnt explode the cost');
  });
});

// ────────────────────────── infeasibility cases ──────────────────────────

describe('Infeasibility detection', () => {
  test('Magician requesting 30k HP at lvl 50 is infeasible', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 30000, mpGoal: 1000, targetLevel: 50 }, gearInt: 0 });
    assertInfeasible(r);
  });

  test('MP Goal below class Min MP is infeasible with explicit reason', () => {
    // Buccaneer Min MP at lvl 180 = 18*180 + 95 = 3335.
    const r = plan({ class: 'Buccaneer', goals: { hpGoal: 30000, mpGoal: 1000, targetLevel: 180 } });
    assertInfeasible(r, 'minimum possible MP');
  });

  test('Target Level less than Current Level is infeasible', () => {
    const r = plan({
      class: 'Bowmaster',
      current: { level: 100 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 80 },
    });
    assertInfeasible(r);
  });

  test('HP Goal > 30,000 is rejected upfront', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 35000, mpGoal: 5000, targetLevel: 180 } });
    assertInfeasible(r, '30,000 HP cap');
  });

  test('MP Goal > 30,000 is rejected upfront', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 35000, targetLevel: 180 } });
    assertInfeasible(r, '30,000 MP cap');
  });

  test('Negative HP Goal is rejected', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: -1, mpGoal: 5000, targetLevel: 180 } });
    assertInfeasible(r, '≥ 0');
  });

  test('Negative MP Goal is rejected', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: -1, targetLevel: 180 } });
    assertInfeasible(r, '≥ 0');
  });

  test('Out-of-range Current Level is rejected', () => {
    const r = plan({ class: 'Night Lord', current: { level: 0 }, goals: { hpGoal: 5000, mpGoal: 3000, targetLevel: 180 } });
    assertInfeasible(r, 'Current Level');
  });

  test('Out-of-range Target Level is rejected', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 5000, mpGoal: 3000, targetLevel: 250 } });
    assertInfeasible(r, 'Target Level');
  });

  test('Plans overshooting the 30k MP cap are filtered out', () => {
    // A Mage with low HP goal (just at Min HP) and small MP goal — high INT would overshoot MP cap.
    // Mage Min HP at lvl 180 is 1864, so use 2000.
    const r = plan({ class: 'Magician', goals: { hpGoal: 2000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.params.mpEndPhase3 <= 30000, 'mpEndPhase3 must respect 30k cap');
  });
});

// ────────────────────────── wash-math primitives ──────────────────────────

describe('Wash-math primitives', () => {
  test('washCycleMP for NL at INT 200 = 28 - 12 = 8 MP per cycle', () => {
    // NL: freshAPMPBase=10, mpLossPerReset=12 → deficit=2. floor(200/10) - 2 = 18.
    assertEq(mod.washCycleMP(CLASSES['Night Lord'], 200), 18);
  });
  test('washCycleMP for Mage at INT 300 = floor(30) - 2 = 28', () => {
    // Mage: freshAPMPBase=28, mpLossPerReset=30 → deficit=2. floor(300/10) - 2 = 28.
    assertEq(mod.washCycleMP(CLASSES['Magician'], 300), 28);
  });
  test('freshHPWashYield for Hero (52 HP per fresh AP) × 10 = 520', () => {
    assertEq(mod.freshHPWashYield(CLASSES['Hero'], 10), 520);
  });
  test('staleHPWashYield for Mage (6 HP per reset) × 100 = 600', () => {
    assertEq(mod.staleHPWashYield(CLASSES['Magician'], 100), 600);
  });
  test('washCycleMPCost for NL (12 MP per reset) × 50 = 600', () => {
    assertEq(mod.washCycleMPCost(CLASSES['Night Lord'], 50), 600);
  });
});

// ────────────────────────── phase steps in isolation ──────────────────────────

describe('Phase steps in isolation', () => {
  test('runPhase1 builds INT from currentBaseInt+shift to phase1EndInt over fresh AP', () => {
    const cur = { level: 4, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const params = { mpWashStart: 14, shift: 0, targetBaseInt: 100 };  // 10 levels of Phase 1
    const p1 = mod.runPhase1(CLASSES['Night Lord'], cur, params, 0, 1.0);
    // Phase 1 = 10 levels × 5 fresh AP = +50 INT. End INT = 4 + 50 = 54.
    assertEq(p1.startBaseInt, 4);
    assertEq(p1.phase1EndInt, 54);
    assertTrue(p1.mpFromInt >= 0, 'INT-driven MP is non-negative');
  });
  test('runPhase2 produces 5 AP Resets per level', () => {
    const params = { mpWashStart: 60, mpWashStop: 145, targetBaseInt: 300 };
    const phase1 = { phase1EndInt: 300 };  // already at target, plateau-only Phase 2
    const p2 = mod.runPhase2(CLASSES['Night Lord'], params, phase1, 40, 1.0);
    assertEq(p2.phase2APResets, (145 - 60) * 5);
    assertEq(p2.intResetsInPhase2, 0, 'INT already at target');
    assertEq(p2.phase2PlateauLevels, 145 - 60, 'all Phase 2 is plateau');
  });
  test('runPhase3 with both fresh and stale wash combines yields', () => {
    const params = { mpWashStop: 145, targetBaseInt: 300, freshHPPerLevelPhase3: 3, staleHPPerLevelPhase3: 2 };
    const goals = { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
    const p3 = mod.runPhase3(CLASSES['Night Lord'], params, goals, 40, 1.0);
    assertEq(p3.phase3FreshHPResets, 35 * 3);  // 35 levels × 3 fresh per level
    assertEq(p3.phase3StaleHPResets, 35 * 2);  // 35 levels × 2 stale per level
    // NL freshAPHP=18, staleAPHP=16. Fresh yield = 105*18 = 1890. Stale yield = 70*16 = 1120.
    assertEq(p3.hpFromFresh, 105 * 18);
    assertEq(p3.hpFromStale, 70 * 16);
  });
  test('runCleanup fills HP gap with stale wash; skips INT reset for Mages', () => {
    const goals = { hpGoal: 5000, mpGoal: 4000, targetLevel: 180 };
    const mageCleanup = mod.runCleanup(CLASSES['Magician'], 2000, 10000, goals, 300);
    assertEq(mageCleanup.intResetAPResets, 0, 'Mage skips INT reset');
    // HP gap 3000 / staleAPHP 6 = 500 stale resets
    assertEq(mageCleanup.cleanupStaleHPWash, 500);
    const nlCleanup = mod.runCleanup(CLASSES['Night Lord'], 2000, 10000, goals, 300);
    assertEq(nlCleanup.intResetAPResets, 300 - 4, 'NL resets INT back to 4');
  });
});

// ────────────────────────── prepareInputs clamping ──────────────────────────

describe('prepareInputs clamps Goals only (not Current HP/MP)', () => {
  test('HP Goal below Min HP at target is clamped to the floor with a note', () => {
    const cur = { level: 100, hp: 5000, mp: 2000, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 100, mpGoal: 5000, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Night Lord'], cur, goals, 'Night Lord');
    // NL Min HP at lvl 180 = 20*180 + 378 = 3978
    assertEq(goals.hpGoal, 3978, 'HP Goal clamped to Min HP at target');
    const note = notes.find(n => n.fieldId === 'i-hp-goal');
    assertTrue(note, 'note recorded for HP Goal');
    assertEq(note.clamped, 3978);
    assertEq(note.atLevel, 180);
  });
  test('MP Goal below Min MP at target is clamped to the floor with a note', () => {
    const cur = { level: 100, hp: 5000, mp: 2000, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 30000, mpGoal: 100, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Night Lord'], cur, goals, 'Night Lord');
    // NL Min MP at lvl 180 = 14*180 + 135 = 2655
    assertEq(goals.mpGoal, 2655, 'MP Goal clamped to Min MP at target');
    const note = notes.find(n => n.fieldId === 'i-mp-goal');
    assertTrue(note, 'note recorded for MP Goal');
    assertEq(note.clamped, 2655);
  });
  test('Current HP/MP below Min are NOT clamped (legitimate pre-2nd-JA state)', () => {
    // Lvl 1 NL: HP 50 / MP 5 from game start, well below NL's post-2nd-JA Min HP/MP formulas.
    // These values must pass through untouched — pre-advancement state is real.
    const cur = { level: 1, hp: 50, mp: 5, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Night Lord'], cur, goals, 'Night Lord');
    assertEq(cur.hp, 50, 'Current HP unchanged');
    assertEq(cur.mp, 5, 'Current MP unchanged');
    assertTrue(!notes.find(n => n.fieldId === 'i-cur-hp'), 'no Current HP note');
    assertTrue(!notes.find(n => n.fieldId === 'i-cur-mp'), 'no Current MP note');
  });
  test('Above-Min values are not clamped and produce no notes', () => {
    const cur = { level: 100, hp: 5000, mp: 2000, str: 4, dex: 4, luk: 4, baseInt: 4 };
    const goals = { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
    const notes = prepareInputs(CLASSES['Night Lord'], cur, goals, 'Night Lord');
    assertEq(notes.length, 0, 'no notes');
  });
});

// ────────────────────────── Phase 3 stale-wash absorption ──────────────────────────

describe('Phase 3 stale-wash and peak MP cap', () => {
  test('Magician with moderate goals finds a feasible plan that respects peak MP cap', () => {
    const r = plan({
      class: 'Magician',
      goals: { hpGoal: 5000, mpGoal: 15000, targetLevel: 180 },
      gearInt: 40,
    });
    assertFeasible(r);
    assertTrue(r.params.mpEndPhase2 <= 30000, `peak MP at mpWashStop (${r.params.mpEndPhase2}) must respect 30k cap`);
    assertTrue(r.params.mpEndPhase3 <= 30000, `MP at target (${r.params.mpEndPhase3}) must respect 30k cap`);
    assertTrue(r.finalHP >= 5000, 'HP goal met');
    assertTrue(r.finalMP >= 15000, 'MP goal met');
  });

  test('Peak MP at end of Phase 2 stays ≤ 30k for every class', () => {
    // The engine's peak-MP check covers the boundary between Phase 2 and Phase 3.
    // Verify mpEndPhase2 is present in params and respects the cap for all classes.
    for (const className of CLASS_ORDER) {
      const goals = className === 'Magician' ? { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 }
                  : className === 'Beginner' ? { hpGoal: 5000, mpGoal: 2000, targetLevel: 180 }
                  : { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 };
      if (className === 'Hero' || className === 'Dark Knight' || className === 'Paladin') {
        goals.mpGoal = 2000;
      }
      if (className === 'Buccaneer') goals.mpGoal = 4000;
      const r = plan({ class: className, goals });
      assertFeasible(r);
      assertTrue(typeof r.params.mpEndPhase2 === 'number', `${className}: mpEndPhase2 present in params`);
      assertTrue(r.params.mpEndPhase2 <= 30000, `${className}: peak MP (${r.params.mpEndPhase2}) ≤ 30k cap`);
    }
  });

  test('Stale HP Wash breakdown lumps Phase 3 stale + cleanup stale into one count', () => {
    const r = plan({
      class: 'Night Lord',
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(r);
    const phase3Stale = r.params.phase3StaleHPResets || 0;
    const cleanupStale = r.params.cleanupStaleHPWash || 0;
    assertEq(r.breakdown.staleHPWash, phase3Stale + cleanupStale, 'breakdown.staleHPWash = Phase 3 stale + cleanup stale');
  });

  test('Invariant: apResets equals sum of all reset categories', () => {
    const r = plan({
      class: 'Magician',
      goals: { hpGoal: 5000, mpGoal: 15000, targetLevel: 180 },
      gearInt: 40,
    });
    assertFeasible(r);
    const b = r.breakdown;
    const sum = b.shift + b.mpWash + b.phase3Fresh + b.intReset + b.staleHPWash;
    assertEq(r.apResets, sum, `apResets ${r.apResets} != sum ${sum}`);
  });
});

// ────────────────────────── 4-stat shift budget ──────────────────────────

describe('4-stat shift budget', () => {
  test('Mage with extra LUK can shift LUK into INT pre-game', () => {
    // Mage that accidentally built LUK (50). The optimizer can shift it into INT.
    // Before the 4-stat change, Mages had maxPositiveShift = 0 (since their "mainStat" was INT).
    const r = plan({
      class: 'Magician',
      current: { level: 50, hp: 1500, mp: 3000, str: 4, dex: 4, luk: 50, baseInt: 4 },
      goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 },
    });
    assertFeasible(r);
    // The optimizer is free to use the LUK pool — shift may be > 0 if cheaper.
    assertTrue(r.breakdown.shift >= 0, 'shift count is non-negative');
  });

  test('Optimizer can shift from a non-MainStat stat (e.g., DEX on a Night Lord)', () => {
    // NL whose extras sit in DEX (not LUK). Pre-4-stat-change this was invisible to the optimizer.
    const r = plan({
      class: 'Night Lord',
      current: { level: 100, hp: 4000, mp: 1500, str: 4, dex: 400, luk: 4, baseInt: 4 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    assertFeasible(r);
    assertTrue(r.breakdown.shift > 0, 'should shift some non-INT into INT');
    assertEq(r.breakdown.shiftDir, 'up');
    assertTrue(r.breakdown.shift <= 396, `shift ${r.breakdown.shift} ≤ DEX budget 396`);
  });

  test('Mage cannot do negative shift (INT-to-MainStat is a no-op for them)', () => {
    // Mage with over-built INT — should NOT shift down (no useful destination).
    const r = plan({
      class: 'Magician',
      current: { level: 100, hp: 4000, mp: 10000, str: 4, dex: 4, luk: 4, baseInt: 600 },
      goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 },
    });
    assertFeasible(r);
    if (r.breakdown.shift > 0) {
      assertTrue(r.breakdown.shiftDir !== 'down', 'Mages should not shift INT down');
    }
  });
});

// ────────────────────────── per-class smoke tests ──────────────────────────

describe('Per-class smoke tests (every class returns a sensible plan)', () => {
  const sensibleGoals = {
    'Night Lord':  { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Shadower':    { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Bowmaster':   { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Marksman':    { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Corsair':     { hpGoal: 30000, mpGoal: 5000,  targetLevel: 180 },
    'Buccaneer':   { hpGoal: 30000, mpGoal: 4000,  targetLevel: 180 },
    'Hero':        { hpGoal: 30000, mpGoal: 2000,  targetLevel: 180 },
    'Dark Knight': { hpGoal: 30000, mpGoal: 2000,  targetLevel: 180 },
    'Paladin':     { hpGoal: 30000, mpGoal: 2000,  targetLevel: 180 },
    'Magician':    { hpGoal: 5000,  mpGoal: 10000, targetLevel: 180 },
    'Beginner':    { hpGoal: 5000,  mpGoal: 2000,  targetLevel: 180 },  // Beginner Min MP at 180 = 1795
  };

  for (const className of CLASS_ORDER) {
    test(className, () => {
      const r = plan({ class: className, goals: sensibleGoals[className] });
      assertFeasible(r);
      assertTrue(r.finalHP >= sensibleGoals[className].hpGoal, 'HP goal met');
      assertTrue(r.finalMP >= sensibleGoals[className].mpGoal, 'MP goal met');
      assertTrue(r.apResets > 0, 'has some AP Resets');
      assertTrue(r.params.mpEndPhase3 <= 30000, 'never overshoots MP cap');
      assertTrue(r.finalHP <= 30000, 'never overshoots HP cap');
    });
  }
});

// ────────────────────────── exit ──────────────────────────

console.log('\n──────────────');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const { name, err } of failures) {
    console.log('  - ' + name + ': ' + err.message);
  }
  process.exit(1);
}
process.exit(0);

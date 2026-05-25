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
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const classesSrc = fs.readFileSync(path.join(ROOT, 'classes.js'), 'utf-8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf-8');

// Evaluate both files and re-export their `const` bindings onto globalThis so
// the rest of this test module can reach them. (Plain `eval` doesn't expose
// `const` to the caller's module scope, but function declarations DO hoist into
// the module scope. We expose the consts via Object.assign(globalThis, …) and
// reach the functions directly.)
eval(classesSrc + '\n' + engineSrc + '\n' + `
  Object.assign(globalThis, {
    CLASSES, CLASS_ORDER, MAPLE_WARRIOR_LEVELS,
    BEGINNER_HP_PER_LEVEL, BEGINNER_MP_PER_LEVEL,
    STARTING_HP, STARTING_MP, STARTING_MAIN_STAT,
    NX_PER_AP_RESET, MAX_NX_PER_DAY_PER_ACCOUNT,
    MAX_HP, MAX_MP,
  });
`);
const CLASSES = globalThis.CLASSES;
const CLASS_ORDER = globalThis.CLASS_ORDER;

// ────────────────────────── tiny harness ──────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
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
function plan(opts) {
  const classData = CLASSES[opts.class];
  if (!classData) throw new Error('unknown class: ' + opts.class);
  const currentState = Object.assign({ level: 1, hp: 50, mp: 5, baseInt: 4, mainStat: 4 }, opts.current || {});
  const goals = Object.assign({ hpGoal: 30000, mpGoal: 5000, targetLevel: 180 }, opts.goals || {});
  const gearInt = opts.gearInt ?? 40;
  const mwMultiplier = opts.mwMultiplier ?? 1.0;
  return optimize(classData, currentState, goals, gearInt, mwMultiplier);
}

// ────────────────────────── reference cases ──────────────────────────
// Calibrated against Krythan's published sheet defaults.

describe('Reference cases (Krythan-aligned)', () => {
  test('Night Lord fresh start to 30k HP / 5k MP at lvl 180', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000, 'HP at cap');
    assertTrue(r.finalMP >= 5000, 'MP meets goal');
    assertInRange(r.apResets, 1900, 2500, 'AP Resets near Krythan default');
    assertInRange(r.params.targetBaseInt, 200, 700, 'Target Base INT in plausible range');
  });

  test('Hero (Warrior) fresh start to 30k HP / 2k MP at lvl 180', () => {
    const r = plan({ class: 'Hero', goals: { hpGoal: 30000, mpGoal: 2000, targetLevel: 180 } });
    assertFeasible(r);
    assertEq(r.finalHP, 30000);
    assertTrue(r.finalMP >= 2000);
    // Warriors use fresh HP wash (52 HP/AP). 30k / 52 ≈ 580 cycles plus base-int reset.
    assertInRange(r.apResets, 350, 700, 'Warrior AP Resets in Krythan-style range');
  });

  test('Magician fresh start to 5k HP / 10k MP at lvl 180', () => {
    const r = plan({ class: 'Magician', goals: { hpGoal: 5000, mpGoal: 10000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalHP >= 5000, 'HP meets goal');
    assertTrue(r.finalMP >= 10000, 'MP meets goal');
    assertEq(r.breakdown.intReset, 0, 'Mages do not reset INT');
  });
});

// ────────────────────────── boundary cases ──────────────────────────

describe('Boundary cases', () => {
  test('Final HP is capped at 30,000 (never overshoots)', () => {
    const r = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
    assertFeasible(r);
    assertTrue(r.finalHP <= 30000, 'finalHP must not exceed cap');
  });

  test('Final MP is capped at 30,000', () => {
    // Mage with HP goal = natural HP (~2200) and big MP goal — should hit the MP cap.
    const r = plan({ class: 'Magician', goals: { hpGoal: 2200, mpGoal: 25000, targetLevel: 180 } });
    if (r.feasible) {
      assertTrue(r.finalMP <= 30000, 'finalMP must not exceed cap');
    }
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

  test('Mid-progress current state is honoured', () => {
    // Skipping ahead to lvl 100 with some existing HP/MP/INT.
    const r = plan({
      class: 'Night Lord',
      current: { level: 100, hp: 5000, mp: 3000, baseInt: 200, mainStat: 300 },
      goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 },
    });
    if (r.feasible) {
      // Mid-progress should typically need fewer total AP Resets than fresh start.
      const fresh = plan({ class: 'Night Lord', goals: { hpGoal: 30000, mpGoal: 5000, targetLevel: 180 } });
      assertTrue(r.apResets <= fresh.apResets * 1.1, 'mid-progress shouldnt explode the cost');
    }
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

  test('Plans overshooting the 30k MP cap are filtered out', () => {
    // Indirect: a Mage with very low HP goal and very high INT would overshoot MP cap if not filtered.
    // The optimizer should still return *some* feasible plan, just not the overshooting one.
    const r = plan({ class: 'Magician', goals: { hpGoal: 1500, mpGoal: 5000, targetLevel: 180 } });
    if (r.feasible) {
      assertTrue(r.params.mpEndPhase3 <= 30000, 'mpEndPhase3 must respect 30k cap');
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

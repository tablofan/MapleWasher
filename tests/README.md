# Tests

## Run

From the repo root:

```
node tests/engine.test.js
```

No dependencies. The harness loads `classes.js` and `engine.js` via `eval` so
both source files stay in the form the browser expects (plain `<script>`s, no
module wrapping).

Exit code is `0` on success, non-zero on any failure.

## What's tested

- **Reference cases (Krythan-aligned)** — Night Lord, Hero, and Magician at
  Krythan's published defaults. We assert AP-Reset count ranges, not exact
  values, because Krythan's sheets take Target Base INT as a user input while
  our optimizer picks it automatically. Tolerance is ~±15%.
- **Boundary cases** — 30k HP/MP caps, MP exactly at Min MP, Current Level ==
  Target Level, mid-progress vs fresh-start cost relationship.
- **Infeasibility detection** — Mage requesting 30k HP at lvl 50, MP Goal below
  class Min MP, Target Level below Current Level, plans that would overshoot
  the 30k MP cap.
- **Per-class smoke tests** — every one of the 11 classes returns a feasible
  plan for a sensible HP/MP/Target Level combination.

## Where the reference numbers come from

Krythan's per-class washing sheets on MapleLegends (see `CONTEXT.md` for the
five spreadsheet IDs). His sheets cross-reference Nise's MapleLegends formula
compilation, which is what our `classes.js` constants are derived from.

When in doubt about a constant, the source of truth is:

1. Nise: <https://forum.legends.ml/index.php?threads/nises-hp-washing-formula-compilation.38558/>
2. Then Krythan's class-specific guides if Nise doesn't disambiguate.

# IRON ENGINE — Engineering Handoff

## What this is
Single-file PWA (`index.html`, ~780 lines, vanilla JS, zero dependencies) replicating the RP Hypertrophy app's autoregulated training algorithm, reverse-engineered from the owner's actual RP data. Runs as a Claude artifact (window.storage) or self-hosted on GitHub Pages (localStorage fallback, auto-detected). Deployed via "Add to Home Screen" on iPhone.

Live: https://schieltz.github.io/ironengine/

## Architecture (single file, three layers)
1. **Storage adapter** (`store`, top of script): window.storage → localStorage (`ironengine:` prefix) → in-memory. Swap here for any new backend.
2. **Pure-function engine**, delimited by `@engine:begin` / `@engine:end` comments: `RULES` (every tunable coefficient), `RIR_RAMP`, `DELOAD_RIR`, `rirFor()`, `prescribe()`, `startingSets()`, `roundLoad()`, `weeksSince()`. No DOM, storage, or app state (enforced by a test). Calibration = change a `RULES` value + add a test; the Engine tab renders from `RULES`, so its text can't drift.
3. **UI**: five views (Workout / Library / Builder / Engine / Data), string-template rendering, no framework.

## Data model
- Saved state `{v, meso, hist, draft}` under key `state2`. `v` = schema version; unversioned saves are v1. Changing the stored shape = bump `SCHEMA_VERSION`, append a step to `MIGRATIONS`, update `seedState()`, add a migration test. `migrate()` runs on load; upgraded state is saved immediately.
- `ST.meso`: {name, weeks, curWeek, curDay, days[3][exercises], log{wNdM: [exercise][sets]}}
- set: {w, reps, tgt, rir, st: 'logged'|'skipped'|null}
- `ST.hist`: exercise name → {w: last top-set weight, date} — cross-meso, permanent
- `ST.draft`: meso under construction in Builder
- `CATALOG`: 98 exercises (owner's performed list from RP), each {name, mg, equip, last, home}
- `TEMPLATES`: 6 RP meso blueprints; slots [MG, priority, optionalPinnedExercise]

## Engine rules (R1–R8)
| Rule | Behavior | Validation |
|------|----------|------------|
| R1 | Same weight, prior week reps +1 per set | VERIFIED vs RP exactly |
| R2 | +1 set/exercise/week; new sets get weight + RIR target only | Inferred, mechanism confirmed |
| R3 | Later sets ≤4 reps or ≥3 below set 1 → ~8% load cut, RIR reset | VERIFIED (60×4 → 55 exact match). The 8% is inferred: 60→55 fits any 4.2-12.5% cut. Set count after the cut (2 vs 3) unconfirmed |
| R4 | Joint pain ≥ moderate → hold reps, no set add | Inferred |
| R5 | Workload 'too much' → hold sets; 'not enough' → +2 | Inferred |
| R6 | All sets skipped → re-prescribe same weights, RIR only | VERIFIED |
| R7 | Deload wk 6: half sets, 8 RIR | Per RP docs |
| R8 | Soreness: still sore → hold volume; never sore + low pump → +2 sets | Inferred |
| Seeding | Wk 1 from hist; >8 wks stale → −10%; maintenance-priority slots start 1 set, full 2 | Design decision |

RIR ramp: 3/2/2/1/0 + deload 8. Days: Mon/Wed/Fri.

## Known gaps / roadmap candidates
- R2/R5/R8 coefficients unvalidated — owner is parallel-logging in RP for one meso to calibrate; expect tuning PRs
- No rep-range targets per exercise type (RP likely varies floor by compound/isolation)
- History stores top set only; consider full set-level history + e1RM trend
- No multi-meso archive browsing UI (data preserved in hist only)
- Casey Kelly template: 4 pinned exercises substituted with home equivalents (owner-approved to revisit)
- Export = clipboard JSON; consider file download + import
- No service worker yet (offline works via browser cache once loaded; make explicit)

## Testing protocol (established, keep it)
Run `npm test` (Node 20+, zero dependencies). Every engine change must pass it before commit.

- `tests/harness.js`: extracts the engine block (between the `@engine:begin` and `@engine:end` markers) and runs it in a node `vm` sandbox with a frozen clock. Can also boot the whole inline script against a DOM stub. `IRONENGINE_HTML=path` points it at another copy (used for mutation checks).
- `tests/engine.test.js`: parse check of the full script; single-file and engine-purity guards; the three VERIFIED fixtures (bench 120×10/9 → 120×11/10/+120@2RIR; DB incline 60×5/4 → 60×6, 55@2RIR; skipped → same weights @ RIR); R3 thresholds and the 8% coefficient; R4, R5, R7, R8; cross-meso seeding (recent, 8-week boundary, stale −10%, no history, maintenance); a "why" on every prescription.
- `tests/app.test.js`: VERIFIED fixtures again through the real `ensureDay()` path on the seed (w1d3 → w2d3); storage adapter guard (window.storage present → localStorage never touched; absent → `ironengine:` prefix, reload restores).
- Open `todo` test: DB incline set count. HANDOFF lists 2 sets; engine emits 3 (R2 adds a set after the R3 cut). Resolve with the RP screenshot, then make it a hard assertion.
- New RP-verified behavior from calibration becomes a permanent fixture in the VERIFIED block.

## Deployment
GitHub Pages from `main`, repo root (`.nojekyll`, no build). Repo: https://github.com/schieltz/ironengine. Flow: `npm test` green → commit (conventional, one logical change) → `git push`. Pages rebuilds in about a minute. Note: `tests/`, `package.json` and this file are also publicly served; harmless.

## Hard constraints
- Single self-contained HTML file. No build step, no CDN dependencies, no framework.
- Never break the three VERIFIED rules without new ground-truth screenshots proving RP behaves differently.
- localStorage path must remain guarded (only executes when window.storage is absent).
- Mobile-first: 44px+ touch targets, numeric inputmode, thumb-reachable actions.
- Every prescribed number keeps its "why" explanation — transparency is the product's differentiator vs RP.

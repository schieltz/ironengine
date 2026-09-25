# IRON ENGINE — Engineering Handoff

## What this is
Single-file PWA (`index.html`, ~780 lines, vanilla JS, zero dependencies) replicating the RP Hypertrophy app's autoregulated training algorithm, reverse-engineered from the owner's actual RP data. Runs as a Claude artifact (window.storage) or self-hosted on GitHub Pages (localStorage fallback, auto-detected). Deployed via "Add to Home Screen" on iPhone.

Live: https://schieltz.github.io/ironengine/

## Architecture (single file, three layers)
1. **Storage adapter** (`store`, top of script): mode picked once at startup: `claude` (window.storage) → `local` (localStorage, `ironengine:` prefix, only when window.storage is absent) → `memory`. `get()` distinguishes "nothing saved" from "read failed"; a failed read or unparseable/newer-version data blocks all saves and shows a recovery sheet (Retry / Copy raw / Start fresh, which backs the raw data up to `state2.unreadable-<ts>` first). Failed writes and memory mode show a persistent banner. Swap here for any new backend.
2. **Pure-function engine**, delimited by `@engine:begin` / `@engine:end` comments: `RULES` (every tunable coefficient), `RIR_RAMP`, `DELOAD_RIR`, `rirFor()`, `prescribe()`, `startingSets()`, `roundLoad()`, `weeksSince()`. No DOM, storage, or app state (enforced by a test). Calibration = change a `RULES` value + add a test; the Engine tab renders from `RULES`, so its text can't drift.
3. **UI**: five views (Workout / Library / Builder / Engine / Data), string-template rendering, no framework.

## Data model
- Saved state `{v, meso, hist, draft, archive}` under key `state2`. `v` = schema version; unversioned saves are v1. Changing the stored shape = bump `SCHEMA_VERSION`, append a step to `MIGRATIONS`, update `seedState()`, add a migration test. `migrate()` runs on load; upgraded state is saved immediately.
- `ST.meso`: {name, weeks, curWeek, curDay, days[3][exercises], log{wNdM: [exercise][sets]}, fb{wNdM: [exercise] → {soreness, pain, pump, workload}}}
- Feedback belongs to the session it was given in (`fb[wNdM][i]`) and shapes only the next week's prescription for that exercise on that day (v2; v1 stored one answer per exercise that applied to every later week).
- set: {w, reps, tgt, rir, st: 'logged'|'skipped'|null, u?: 1}. `u` = user-touched (edited, tapped, or manually added).
- Prescriptions are provisional: `planDay()` recomputes every exercise in a session from the prior week on each visit until any of its sets is touched (`st` or `u`); touched exercises are never recomputed. It fills missing prior weeks recursively, so looking ahead never freezes stale numbers or produces 0 lb sets. When the prior week is unlogged, the "why" says it's a preview.
- `ST.hist`: exercise name → {w: last top-set weight, date} — cross-meso, permanent
- `ST.draft`: meso under construction in Builder
- `ST.archive`: finished mesos, kept whole (every set) with `archivedAt` when a draft is activated (v3). No browsing UI yet; included in backups.
- `CATALOG`: 98 exercises (owner's performed list from RP), each {name, mg, equip, last, home}
- `TEMPLATES`: 6 RP meso blueprints; slots [MG, priority, optionalPinnedExercise]

## Engine rules (R1–R8)
| Rule | Behavior | Validation |
|------|----------|------------|
| R1 | Same weight, prior week reps +1 per set | VERIFIED vs RP exactly |
| R2 | +1 set/exercise/week; new sets get weight + RIR target only | Inferred, mechanism confirmed. RP history shows no weekly adds over 3-4 weeks on EZ curl (see Calibration evidence) |
| R3 | Later sets ≤4 reps or ≥3 below set 1 → ~8% load cut, RIR reset | VERIFIED (60×4 → 55 exact match). The 8% is inferred: 60→55 fits any 4.2-12.5% cut. Set count after the cut (2 vs 3) unconfirmed. Only the ≤4-rep floor trigger is verified; the ≥3-below-set-1 trigger is contradicted by RP history (5 cases) |
| R4 | Joint pain ≥ moderate → hold reps, no set add | Inferred |
| R5 | Workload 'too much' → hold sets; 'not enough' → +2 | Inferred |
| R6 | All sets skipped → re-prescribe same weights, RIR only | VERIFIED |
| R7 | Deload wk 6: half sets, 8 RIR | Per RP docs. Contradicted on load: RP's deload day 3 used half weight (60 → 30×5,5) |
| R8 | Soreness: still sore → hold volume; never sore + low pump → +2 sets | Inferred |
| Seeding | Wk 1 from hist; >8 wks stale → −10%; maintenance-priority slots start 1 set, full 2 | Design decision |

RIR ramp: 3/2/2/1/0 + deload 8. Days: Mon/Wed/Fri.

## Calibration evidence
**2026-09-25, RP "Exercise history" screenshots** (DB Press (High Incline), EZ Bar Curl (Normal Grip)). History lists logged sets only: skipped sets and RP's targets are invisible. Readings below assume what was logged = what RP prescribed; owner to confirm.
- **R1 supported.** EZ curl Wed: 11,9,7 → 12,10,9 → 13,11,10 → 14,12,11. Fri: 10,8,7,7 → 11,9,8,8.
- **R3 ≥3-below trigger contradicted.** 5 cases where a later set was 3+ reps below set 1 (above the 4-rep floor): RP kept 60 and the next week's reps went up by 1. Example: W2D3 60×10,8,7,7 → engine cuts sets 3-4 to 55; RP history W3D3 = 60×11,9,8,8. The verified 60×4 → 55 case went through the ≤4 floor trigger. The R3 "why" also mislabels this trigger as "below range floor".
- **R2 not visible.** EZ curl held 3 sets (Wed, W2-W5) and 4 sets (Fri, W2-W4). Could be feedback-gated or skipped add-on sets.
- **R7 load contradicted.** Incline deload (8-week meso, W8D3) logged 30×5,5 after 60×8-9 working sets: RP halved the load.
- **Q1 (incline set count after an R3 cut) unresolved.** That session (COPY meso W2D3) was skipped, so no history. Needs RP's day view of it.
- **Q2 (R6 set count) unresolved.** EZ curl W1D3 3 sets skipped → W2D3 4 sets logged: RP added one, or the owner did.

## Known gaps / roadmap candidates
- R2/R5/R8 coefficients unvalidated — owner is parallel-logging in RP for one meso to calibrate; expect tuning PRs
- No rep-range targets per exercise type (RP likely varies floor by compound/isolation)
- History stores top set only; consider full set-level history + e1RM trend
- No multi-meso archive browsing UI (full mesos are kept in `ST.archive` and in backups)
- Casey Kelly template: 4 pinned exercises substituted with home equivalents (owner-approved to revisit)
- Backup = file (iOS share sheet → Files/iCloud; download elsewhere) or clipboard JSON; restore from file on the Data tab or the load-error sheet. Reset, Activate, Discard, Restore and Start fresh all confirm first
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

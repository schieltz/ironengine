# IRON ENGINE — Engineering Handoff

## What this is
Single-file PWA (`index.html`, ~780 lines, vanilla JS, zero dependencies) replicating the RP Hypertrophy app's autoregulated training algorithm, reverse-engineered from the owner's actual RP data. Runs as a Claude artifact (window.storage) or self-hosted on GitHub Pages (localStorage fallback, auto-detected). Deployed via "Add to Home Screen" on iPhone.

Live: https://schieltz.github.io/ironengine/

## Architecture (single file, three layers)
1. **Storage adapter** (`store`, top of script): mode picked once at startup: `claude` (window.storage) → `local` (localStorage, `ironengine:` prefix, only when window.storage is absent) → `memory`. `get()` distinguishes "nothing saved" from "read failed"; a failed read or unparseable/newer-version data blocks all saves and shows a recovery sheet (Retry / Copy raw / Start fresh, which backs the raw data up to `state2.unreadable-<ts>` first). Failed writes and memory mode show a persistent banner. Swap here for any new backend.
2. **Pure-function engine**, delimited by `@engine:begin` / `@engine:end` comments: `RULES` (every tunable coefficient), `RIR_RAMP`, `DELOAD_RIR`, `rirFor()`, `prescribe()`, `startingSets()`, `roundLoad()`, `weeksSince()`. No DOM, storage, or app state (enforced by a test). Calibration = change a `RULES` value + add a test; the Engine tab renders from `RULES`, so its text can't drift.
3. **UI**: five views (Workout / Library / Builder / Engine / Data), string-template rendering, no framework.
   - Day editing, active meso: the exercise menu has Move up/down (today's session and the plan), Remove from plan (confirmed; gone from today unless sets are logged, and from later weeks; past sessions keep it), and "+ Add exercise" at the bottom of each session: **Just today** (extra entry, frozen with `u`) or **Today + rest of meso** (new plan slot). New slots get ids from `meso.seq`, are seeded like swaps, and are inserted after the last exercise of the same muscle group (end of day if none); the Builder does the same.
   - Day editing, Builder: tap a slot for Swap, note, priority (maintenance = 1 starting set), Move up/down, Remove; "+ Add exercise" per day.
   - Exercise history (`sessionsOf()`, `openHistory()`): every logged session of an exercise across `ST.archive` and the current meso, grouped by meso, newest first, with deload tags (RP: last week; app: week 6). Summary tiles: last done, best set, estimated 1RM (Epley via `e1rm()`, the same constant as the weight-change rule; weighted bodyweight work includes `ST.bodyweight`), plus a trend line of each non-deload session's best set that reads out any session on tap/drag. Opened from the exercise name, the "Last:" line under each workout card (latest earlier session), the ⋯ menu, and every Library item.
   - PRs (`prIndex()`): a logged set is a PR when its estimated 1RM (weighted bodyweight incl. bodyweight; bodyweight-only: reps) beats every earlier session of the exercise; only the session's best set is tagged, a toast announces it, and history tags each session that set a new best. `sessionsOf()` results are cached per render and cleared on every save.
   - Weekly sets per muscle (`weekVolume()`, `openVolume()`, button at the top of each workout): per muscle group, sets done (logged) out of planned (not skipped) across the week's sessions, a same-ramp meter, and last week's done count; plans the whole week first so days not yet opened count.
   - Backup reminder (`backupDue()`, `renderNudge()`, v9): on the Workout view, once any set is logged or history is imported, a bar asks for a backup when the last one (`lastBackupAt`, set by Save backup file or Copy JSON) is 7+ days old or missing; "Later" snoozes it until tomorrow. Hidden in memory-only mode (the red banner covers that).
   - Offline (`sw.js`, registered at the end of the script only on https/localhost and never when `window.storage` exists): network first so updates arrive with signal; after a failure or 3 s it serves the saved copy of `index.html`. Caches the app page only, never training data. Bump `CACHE` in sw.js only if the caching scheme changes.
   - Workout card actions: − (remove last set; logged ones after a confirm; one set minimum; marks the entry touched), + Set, Feedback, ⋯ (swap, skip remaining sets, note, move, remove).
   - Notes belong to the plan slot (shown every week the slot does that exercise); set from the exercise menu, rendered escaped.
   - "+ New exercise" (Library and picker) creates a custom exercise; from the picker it continues straight into the swap/add.
   - Each workout card has an exercise menu (⋯). Swap opens the shared exercise picker (same muscle group and home filter preselected; search re-renders only the list so the phone keyboard stays open; `matchesQuery()` needs every typed word in the name in any order, matches plurals, and knows a few synonyms: narrow/close, db, bb, rdl), then asks: **Just today** (only this session's entry changes, frozen with `u`; next week the slot returns to the original, as a missed week, R6) or **Rest of meso** (the plan slot changes; sets already logged today are kept). A swapped-in exercise is seeded from history, including this meso's earlier sessions, with the slot's last set count.

## Data model
- Saved state `{v, meso, hist, draft, archive, custom, bodyweight, lastBackupAt, backupSnooze}` under key `state2`. `v` = schema version; unversioned saves are v1. Changing the stored shape = bump `SCHEMA_VERSION`, append a step to `MIGRATIONS`, update `seedState()`, add a migration test. `migrate()` runs on load; upgraded state is saved immediately.
- `ST.meso`: {name, weeks, curWeek, curDay, days[3][slots], seq, log{wNdM: [entries]}, dates{wNdM: date}, schedule[3], dayOf{wNdM: weekday}}
- Weekday labels (v7): `dayLabel(w,d)` = the session's own label (`dayOf`, set from the day picker) → else the weekday of its logged date → else `schedule[d-1]` (the plan; default Mon/Wed/Fri, inherited by the next meso). Tap the selected day tab to pick a weekday, for this session only or every week. Training days stay ordinal (Day 1-3); labels are display only.
- slot (the plan for sessions not yet started): {id, name, mg, equip, note, pri}. `id` is permanent within the meso (`s1`, `s2`, … from `seq`).
- entry (one exercise in one session, display order): {slot, name, sets, why, fb, u?, date?}. `date` = local date its first set was logged (RP imports: that exercise's first completed set; sessions often span days). History, the "Last" line and `harvestHistory()` prefer it over the session date. `name` can differ from the slot's (a one-off swap). `fb` = feedback given in that session {soreness, pain, pump, workload}; it shapes only the next week's prescription for that slot. `u` = entry-level touch (swapped or added by hand). v5; before that, sessions were arrays lined up with the plan by position.
- set: {w, reps, tgt, rir, st: 'logged'|'skipped'|null, u?: 1}. `u` = user-touched (edited, tapped, or manually added).
- Prescriptions are provisional: `planDay()` recomputes untouched entries on each visit; touched entries (any set `st`/`u`, or entry `u`) are never recomputed. A session follows the plan (which exercises, in what order) until it's started (any entry touched); after that its exercise list is fixed. Missing prior weeks are filled recursively, so looking ahead never freezes stale numbers or produces 0 lb sets. When the prior week is unlogged, the "why" says it's a preview.
- `prescribeEntry()` progresses an entry from the most recent earlier session of the same slot that did the same exercise: last week → R1-R8 with that session's feedback; older (slot did something else in between) → missed week, R6; none → seeded via `startingSets()` from `effectiveHist()` (history plus this meso's earlier sessions), keeping the slot's last set count.
- `ST.hist`: exercise name → {w: last top-set weight, date} — cross-meso, permanent. Harvested on Activate by `harvestHistory()`: heaviest logged set in the exercise's most recent session (schedule order), dated with that session's date. It can go down. `date: null` = unknown (never treated as stale).
- `ST.meso.dates`: session → local date its first set was logged (v4). Undated legacy sessions borrow the meso's latest known date at harvest.
- `ST.bodyweight`: lb or null (v8); added to the load of weighted dips/pull-ups for R9. Log added weight only on those.
- `ST.draft`: meso under construction in Builder
- `ST.archive`: finished mesos, kept whole (every set) with `archivedAt` when a draft is activated (v3), plus mesos imported from RP (`source:'rp'`, `rpId` for de-duplication). No browsing UI yet; included in backups.
- RP import (Data tab → Import RP export; `rpToMesos()` + `importRPText()`): the export is read on the device only. Each RP meso becomes an archived meso in the app's own shape: slots per day+exercise, entries with sets `{w, reps, tgt, st}`, per-muscle feedback on that muscle's first exercise (RP soreness -1 = not asked → null), session dates from the first completed set (local), weekday labels. RP stores total load for bodyweight exercises; the app keeps added weight only (bodyweight-only → no weight). History takes each exercise's latest top set when it's newer than what the app has; unknown exercise names become custom exercises (equipment guessed from bodyweight tracking); bodyweight is filled in only if empty. Current meso untouched; re-import adds nothing. Real export: 13 mesos, 2,475 logged sets, 84 exercises of history, ~360 KB.
- Library dates show the later of history's date and the catalog's `last`.
- `CATALOG`: 213 built-in exercises, each {name, mg, equip, last, home}: 98 from the owner's RP history (with last-performed dates) plus 115 he approved in the 2026-09-26 library review (`last: null`; decisions pinned in `tests/fixtures/library-review-2026-09-26.json`). 12 muscle groups (`MGS`), including TRAPS and ABS from that review.
- `ST.custom`: exercises the owner creates, {name, mg, equip, home, last: null, custom: true} (v6). `libAll()` / `libByName()` = catalog + custom; everything the UI offers goes through them. Names are permanent (history is keyed by name) and can't contain `" < > \\`. A custom exercise can be deleted only while unused in the current meso and draft.
- `TEMPLATES`: 6 RP meso blueprints; slots [MG, priority, optionalPinnedExercise]

## Engine rules (R1–R8)
| Rule | Behavior | Validation |
|------|----------|------------|
| R1 | Same weight, prior week reps +1 per set | VERIFIED vs RP exactly; RP export: 92% of 858 same-weight targets |
| R9 | Load or reps: +1 jump (5 lb; 2.5 lb cable/machine, `RULES.increments`), same reps, when the jump is ≤3.8% of the load (`RULES.loadModeMax`); otherwise R1 (+1 rep). Bodyweight-only → always reps; weighted bodyweight → load includes `ST.bodyweight` (v8, Data tab) | VERIFIED by RP export: fits 99% of 1,195 targets; examples pinned as fixtures |
| R2 | Volume steps once: prescribing week 2 (`RULES.addWeek`) adds +1 set unless a later set hit the rep floor; after that the set count holds unless R5 ('not enough') or R8 (never sore + low pump) → +1 (was +2). At most one added set per muscle per session, on its first exercise (`opts.allowAdd`, from `prescribeEntry`) | Calibrated on RP export: set count agreement 19% → 68%. Keeps the VERIFIED bench (+1, week 2) and incline (2 sets) fixtures |
| R3 | A later set at ≤4 reps → ~8% load cut, RIR reset. Load is held (never raised) when rounding cancels the cut or the set is bodyweight | VERIFIED (60×4 → 55; the only floor case in 18 months of RP data). The 8% is inferred (60→55 fits 4.2-12.5%). The former ≥3-below-set-1 trigger was removed: RP export 82/82 held or raised the load |
| R4 | Joint pain ≥ moderate → hold reps, no set add | Inferred |
| R5 | Workload 'too much' → hold sets; 'not enough' → +1 | Inferred; RP rarely adds 2 |
| R6 | All sets skipped → re-prescribe same weights, RIR only | VERIFIED; RP export: same weights 85%, extra set only 7% (Q2 settled: no add) |
| R7 | Deload week: `RULES.deloadSets` (2) sets per exercise; load ~90% of last week in the first half of the week, ~50% in the second half (`deloadLoad`, uses `opts.day/days`); rep targets ~60% of last week's (`deloadReps`). Unlogged week 5 → planned weights lightened, 8 RIR | Calibrated on RP export: deload weight agreement 1% → 69%, sets 40% → 65%. Consistent with the logged 60 → 30×5,5 day-3 deload |
| R8 | Soreness: still sore → hold volume; never sore + low pump → +1 set | Inferred; RP adds mostly after 'never sore' |
| Weight change | Set's weight edited before logging (no reps typed) → rep target re-derived for equal effort at the week's RIR: Epley on reps-to-failure, `RULES.epley`=30, measured from the originally prescribed weight/target (`pw`/`ptgt` on the set); hint line under the set. The change carries to later sets still at the old weight (not logged, no reps typed) | Inferred (owner request 2026-09-26); calibrate vs RP |
| Seeding | Wk 1 from hist; >8 wks stale → −10%; maintenance-priority slots start 1 set, full 2 | Design decision |

RIR ramp: 3/2/2/1/0 + deload 8. Three training days per week; weekday labels are editable (see Data model).

## Calibration evidence
**2026-09-27, RP data export** (13 mesos, Mar 2025 to Aug 2026, ~3,000 sets). Unlike history screenshots it stores RP's prescribed target (weight, reps, weight range) next to what was done, plus per-session, per-muscle soreness/pump/workload and RP's `recommendedSets`. Kept outside the repo (personal data; the repo is public). Replay of week N actuals → RP's week N+1 targets, 803 exercise pairs, 1,057 targeted sets, deload transitions excluded:
- Current engine: weight right 74.7%, weight + reps right 64.0%, set count right 18%.
- **Progression mode (not implemented yet):** RP adds load (usually +5 lb, same reps) when the smallest increment is ≤3.8% of the load and the exercise isn't bodyweight-only; otherwise +1 rep. Fits 99.0% of 1,195 targets. With it and without R3's drop trigger: weight right 97.5%, weight + reps 85.7%. Holding set count would match 74.1%.
- Q1 settled: week 2 Friday incline targets were exactly 2 sets (60×6, 55); no set added after the cut.
- Week 1 seeding: RP's week-1 targets were not the last top set (higher 56%, same 30%, lower 14%); RP appears to use its own strength estimate.
- Not calibratable from the export: the weight-change rep rule (RP stores the original target, not the recalculated one).

**Owner's logging habit (confirmed 2026-09-26):** adjusts weights, reps and sets by feel, especially adding early in a meso. So logged history is NOT evidence of what RP prescribed; only skipped sets (which keep RP's prescribed values in RP's day view) and screenshots of RP's targets taken before training count as ground truth.

**2026-09-25, RP "Exercise history" screenshots** (DB Press (High Incline), EZ Bar Curl (Normal Grip)). Leads to test in the calibration meso, NOT proof (see above):
- **R1 supported.** EZ curl Wed: 11,9,7 → 12,10,9 → 13,11,10 → 14,12,11. Fri: 10,8,7,7 → 11,9,8,8.
- **R3 ≥3-below trigger contradicted.** 5 cases where a later set was 3+ reps below set 1 (above the 4-rep floor): RP kept 60 and the next week's reps went up by 1. Example: W2D3 60×10,8,7,7 → engine cuts sets 3-4 to 55; RP history W3D3 = 60×11,9,8,8. The verified 60×4 → 55 case went through the ≤4 floor trigger. The R3 "why" also mislabels this trigger as "below range floor".
- **R2 not visible.** EZ curl held 3 sets (Wed, W2-W5) and 4 sets (Fri, W2-W4). Could be feedback-gated or skipped add-on sets.
- **R7 load contradicted.** Incline deload (8-week meso, W8D3) logged 30×5,5 after 60×8-9 working sets: RP halved the load.
- **Q1 (incline set count after an R3 cut) unresolved.** That session (COPY meso W2D3) was skipped entirely, so RP's day view of it should still show RP's prescribed sets: owner to send.
- **Q2 (R6 set count) unresolved.** EZ curl W1D3 3 sets skipped → W2D3 4 sets logged: RP added one, or the owner did.

### Calibration protocol (side-by-side meso)
1. Start the meso fresh in both apps with identical exercises per day (easiest: the same RP template in both, then swap to match).
2. Before each session, screenshot RP's workout screen showing its targets, before changing anything.
3. Train however you like; log the same actual weights/reps/sets in both apps, and give identical feedback answers in both.
4. Send the screenshot. Each RP target is compared with IRON ENGINE's prescription for the same session; every confirmed behavior becomes a permanent VERIFIED fixture, every mismatch a rule change + fixture.
5. Situations worth catching (they settle open questions): an exercise skipped entirely (R6 set count); a later set at ≤4 reps (R3 floor); a later set 3+ reps below set 1 but above 4 (R3 drop trigger); a manually added set (R2 interaction); each feedback extreme (moderate pain, still sore, too much, not enough, never sore + low pump); every deload day.

## Known gaps / roadmap candidates
- Exercise detail view (tap an exercise → every past session from the current meso and `ST.archive`) not built yet
- R2/R5/R8 coefficients unvalidated — owner is parallel-logging in RP for one meso to calibrate; expect tuning PRs
- No rep-range targets per exercise type (RP likely varies floor by compound/isolation)
- History stores top set only; consider full set-level history + e1RM trend
- No multi-meso archive browsing UI (full mesos are kept in `ST.archive` and in backups)
- Casey Kelly template: 4 pinned exercises substituted with home equivalents (owner-approved to revisit)
- Backup = file (iOS share sheet → Files/iCloud; download elsewhere) or clipboard JSON; restore from file on the Data tab or the load-error sheet. Reset, Activate, Discard, Restore and Start fresh all confirm first

## Testing protocol (established, keep it)
Run `npm test` (Node 20+, zero dependencies). Every engine change must pass it before commit.

- `tests/harness.js`: extracts the engine block (between the `@engine:begin` and `@engine:end` markers) and runs it in a node `vm` sandbox with a frozen clock. Can also boot the whole inline script against a DOM stub. `IRONENGINE_HTML=path` points it at another copy (used for mutation checks).
- `tests/engine.test.js`: parse check of the full script; single-file and engine-purity guards; the three VERIFIED fixtures (bench 120×10/9 → 120×11/10/+120@2RIR; DB incline 60×5/4 → 60×6, 55@2RIR; skipped → same weights @ RIR); R3 thresholds and the 8% coefficient; R4, R5, R7, R8; cross-meso seeding (recent, 8-week boundary, stale −10%, no history, maintenance); a "why" on every prescription.
- `tests/app.test.js`: VERIFIED fixtures again through the real `ensureDay()` path on the seed (w1d3 → w2d3); storage adapter guard (window.storage present → localStorage never touched; absent → `ironengine:` prefix, reload restores).
- New RP-verified behavior from calibration becomes a permanent fixture in the VERIFIED block.
- `tests/calibration.test.js`: replays 721 anonymized cases from the owner's RP export (`tests/fixtures/rp-calibration.json`, built by `node tools/rp-calibration.js <export.json>`; weights, reps and feedback only, bodyweight-only weights blanked) through the engine and reports agreement with RP's actual next-week prescriptions. `FLOORS` hold the agreement the current rules reach; a rule change must not drop below them, and raises them when it improves agreement.

## Deployment
GitHub Pages from `main`, repo root (`.nojekyll`, no build). Repo: https://github.com/schieltz/ironengine. Flow: `npm test` green → commit (conventional, one logical change) → `git push`. Pages rebuilds in about a minute. Note: `tests/`, `package.json` and this file are also publicly served; harmless.

## Hard constraints
- Single self-contained HTML file. No build step, no CDN dependencies, no framework. One approved exception (2026-09-28): `sw.js`, a ~40-line service worker beside it for offline launch; the app itself stays one file and runs without it.
- Never break the three VERIFIED rules without new ground-truth screenshots proving RP behaves differently.
- localStorage path must remain guarded (only executes when window.storage is absent).
- Mobile-first: 44px+ touch targets, numeric inputmode, thumb-reachable actions.
- Every prescribed number keeps its "why" explanation — transparency is the product's differentiator vs RP.

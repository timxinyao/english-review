# Learning engine review — 2026-10-29

## Preserve the learning model

Word and Chunk remain separate content types; Understanding (U) and Production (P) keep independent FSRS state. Phase 13 remains Chinese-prompt chip assembly, including multi-item tasks. No historical answers are regraded, no progress is reset, and no schema migration is required. Existing `too_easy` scheduling semantics are unchanged; feedback changes only add stale-state safety checks.

The scheduler remains the installed `ts-fsrs` implementation with official default weights, desired retention 0.90, long-term mode, deterministic scheduling and the existing 1–365-day interval bounds. This review does not claim that new weights or different retention targets would improve this learner's results.

## Evidence and its limits

- [TS-FSRS official implementation and documentation](https://github.com/open-spaced-repetition/ts-fsrs) define the scheduler's ratings, parameters and persistence interface. The application should preserve valid independent state and feed it trustworthy evidence, not replace its equations with uncalibrated heuristics.
- [Anki's official answer-button guidance](https://docs.ankiweb.net/manual/studying) distinguishes incorrect recall (Again) from correct but difficult recall (Hard), ordinary correct recall (Good), and effortless recall (Easy). A failed sentence is not automatically evidence that every target failed, but merely selecting the target somewhere is not evidence of correct usage either.
- [Smith & Karpicke (2014), original research](https://learninglab.psych.purdue.edu/downloads/2014/2014_Smith_Karpicke_Memory.pdf) found learning benefits from several retrieval formats and showed that retrieval success matters. It does not justify claiming that free typing universally beats recognition, or that chip assembly measures spontaneous speech or unrestricted writing.

The per-target scoring below is a **conservative product rule**, not a validated psychometric measure or a general English grammar checker. It improves the integrity of the evidence sent to FSRS; it does not establish a quantified learning-outcome gain.

## Identified failure modes and intended corrections

| Failure mode | Correction |
| --- | --- |
| U tasks consumed the daily cap before older P tasks | Form P groups first, rank U tasks and P groups by oldest due time, then apply the cap. New Learn remains separate. |
| Idle counted P items while sessions counted groups | Use grouped review-task counts consistently for planned reviews and backlog. |
| Arbitrary text or repeated use of a chip could be submitted | Check the selected chip multiset against the actual reference-plus-distractor inventory before creating an attempt. Invalid requests do not change progress. |
| All entries in a flat morphology list were treated as interchangeable | Judge the actual surface tokens in the reference. The old metadata remains readable but cannot establish unrelated-word equivalence. |
| Bare target subsequences earned full Good even in incomplete nonsense | A correct complete assembly earns pass/Good. A complete-length imperfect assembly can earn basic_pass/Hard only for a target at its reference positions; absent, displaced, reordered or incomplete target evidence earns fail/Again. |
| Secondary participants were missing from invalidation and cancellation | Include all linked participants; stale or incompatible question/task membership is rejected before settlement. |
| Single-item stock could serve a multi-item question | Restrict single-item acquisition and practice to a matching one-target payload. |
| Automatic mastery made an already-scheduled P group unanswerable | Keep scheduled tasks valid when a participant becomes mastered naturally; pause, archive, reset and goal changes remain protected. |
| Pause, archive or reset left unanswerable tasks in the session | Cancel only pending primary/secondary tasks in the lifecycle transaction and reconcile session progress; retain completed history and other participants' FSRS state. |
| Old feedback could overwrite a reset or a later answer | Require current eligibility and a matching affected-dimension post-state before feedback, and a usable pre-state before recalculating guessed feedback. Independent P progress does not block U feedback. |
| Rollback restored both dimensions and could erase subsequent progress | Restore only dimensions affected by that attempt, check all participants against post-state, preserve independent progress and user lifecycle choices. |
| Library history showed aggregate failure for partial credit and omitted secondary participants | Read per-item evidence for every participant, retain legacy primary-only fallback and let whole-attempt or item void status take precedence. No historical rows are rewritten. |
| Undo left task-participant audit rows marked pass | Void both task-participant and attempt-participant results together. |
| Trimming old attempts cascaded away their per-item audit rows, which undo did not restore | Preserve pruned participant results in the existing attempt snapshot and restore them atomically with their parent attempts. |
| Generation and grading disagreed on sentence-end punctuation | Share normalized target coverage between AI invariants, persisted-payload validation and grading. |

### Grading details

A chip's submitted identity must be present in the displayed inventory and cannot be consumed more often than it appears. Once identity is validated, scoring ignores capitalization and simple boundary punctuation. The reference's inflected surface is authoritative; a flat list such as `wear, wears, meetings, meeting` cannot prove which substitutions are grammatical in this sentence.

Target evidence is anchored to the reference's ordered positions, so separable phrasal verbs such as `wear … down` still work. Partial evidence never upgrades the entire task: task-level pass/fail, daily task totals and production pass rate remain sentence-level. Each item's P state receives its own result. An unfinished sentence or a list of target words receives no positive item credit.

This intentionally accepts fewer alternatives than an open-ended language judge. Legitimate alternative word orders can still be rejected. The reference, target feedback and existing bad-question control make that limitation visible and recoverable; adding semantic grading or alternative references requires a separately evaluated contract.

### State and rollback details

Invalid payloads, mismatched participants and invalid chip inventories must fail before any attempt/FSRS/statistics write. Multi-item settlement remains one atomic transaction and one formal task. Repeated submissions replay the recorded result rather than applying the scheduler again.

Rollback is dimension-scoped. A later U answer must survive reversal of a P task, including when that item was a secondary participant. A later change to any affected P state makes reversal unsafe and must be refused atomically. Recompute active/mastered using the current U/P states and current Production goal; never revive paused or archived items simply because a snapshot used to say active.

Ordinary undo also creates a replacement task, so it must recheck all participants before fetching a replacement and again inside the settlement transaction. If a participant was paused, archived, reset or had Production disabled while generation was pending, refuse undo without changing progress or history. Bad-question rollback creates no replacement and therefore can preserve the explicit lifecycle choice while safely reversing the original evidence.

Explicit pause, archive and reset cancel only unfinished tasks linked to that item, including a grouped task where it is secondary. Session totals and completion are reconciled atomically; completed tasks, attempts and other participants' progress are unchanged. Canceling a group does not count its remaining participants as reviewed; their existing due dates remain. Resuming does not resurrect canceled task identities. Mastery, whether inferred automatically or explicitly marked, retains the existing behavior: already-scheduled eligible work can finish, while future session planning excludes mastered items.

## Verification

Deterministic regression coverage is recorded with the change:

- `scramble-evidence.test.ts`: incomplete evidence, partial target correctness, unrelated morphology, wrong placement and punctuation.
- Shared `scramble.test.ts`: unique target identities, nonblank payload fields and per-target basic-pass response contract.
- `learning-engine-safety.test.ts`: grouped due ordering/counts, secondary invalidation/cancellation, single-item stock, zero-write request rejection, independent U/P rollback, lifecycle preservation, automatic mastery during a session, stale U/Learn rejection, pending-task cancellation, undo-generation races, stale-feedback rejection, per-participant Library history and pruned-history audit restoration.
- `scramble-safety.test.ts`: HTTP rejection with zero writes, partial-credit settlement, replay, practice isolation and Library history legacy/void precedence.
- `questions-production.test.ts`: generated target coverage, including sentence-end punctuation.
- `fsrs-engine.test.ts`: unchanged scheduler round trips for all four ratings at same-day, fractional-day and overdue times; finite state and 1–365-day bounds; deterministic retries.

All tests use isolated local data and deterministic AI fixtures. No real-provider quality claim follows from these tests. Production history and pre-existing cutover markers are not rewritten.

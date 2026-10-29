# Foxi native learning upgrade

## Intent and constraints
A comprehensive upgrade of the existing personal B1 learning app covers algorithm correctness, UI interaction, iPhone 18 Pro adaptation, motion and supported haptics. Preserve the latest Phase 13 Chinese-prompt scramble workflow, Word/Chunk, historical data, production progress, current stack and server source of truth. No destructive migration, auth change, production API, deploy, new audio or unrelated feature.

## Approaches
1. Cosmetic restyle only: low risk but leaves real scheduling, multi-item rollback and scramble evidence bugs. Rejected.
2. Replace FSRS/free-text or make a native app: major migration/platform scope and contradicts yesterday's scramble decision. Rejected.
3. Evolve current PWA with evidence-driven algorithm corrections and a coherent native-feeling shell. Selected: protects data, improves the daily learning loop, stays reversible.

## Learning contract
- Keep ts-fsrs default parameters, desired retention .90, existing independent U/P state and 1..365-day bounds.
- Rank U tasks and grouped P tasks together by oldest due time, then apply the existing daily task cap. Idle counts reflect grouped task count, not underlying P item count. New Learn remains separate.
- Reject fabricated or over-consumed chips before any attempt or FSRS write. Do not use a global unrelated-morphology equivalence set.
- A complete correct assembly receives pass/Good. In a complete-length but imperfect assembly, supported target evidence may receive basic_pass/Hard, never full pass simply for including a substring. Missing/reordered/incomplete evidence fails/Again. Rule-based judgement is explicitly not a general natural-language correctness checker; expose the reference and targeted feedback.
- All participants govern question invalidation, P goal cancellation and rollback eligibility. Undo/bad-question rollback must never overwrite later independent progress or another participant's progress.
- No schema migration or historical regrading/reset. No prompt-body change; real-model eval is not invoked.

## Visual specification
Reference concept: `native-learning-concept.png` (QA artifact outside repo; generated 2026-10-29). Three full primary mobile states: idle Today, revealed Recall and composing Scramble. Extend the same system to Library, Read, Settings, completion, error and dialogs.

Tokens (globals.css only): cool off-white #f5f5f7; white #ffffff surfaces; foreground #242528; muted slate #686b73; accent terracotta #a64e38; quiet pale warm selection. Preserve serif English vocabulary display; use system sans-serif UI, not a CJK serif font. 18px card radius; 48px primary controls and 44px minimum interactive targets. No gradient, decorative dashboard cards, fake metrics or stock art. Native icon family remains lucide at consistent 1.75-2 stroke weight.

Composition: clean mobile Foxi/centered route/settings top bar, only three main bottom tabs, transparent/blurred chrome with solid-color fallback, safe-area aware. One primary action per screen. Today idle uses a spacious open hero, real counts, CTA and linked recent list. Active session keeps single full-height scrolling-content card and fixed action dock; progress remains read-only history entry. No fragile device-name sizing: verify 402×874 primary target plus narrow and desktop; native iOS behavior remains a real-device acceptance item.

Allowed Today idle copy: 每天一点，慢慢记住。; 今日计划; 复习; 新学; 开始今日复习; 做一点也行，不必一次清完; 最近学过; 积压; 之后每天自动安排; actual server totals. Empty Today is truthful and offers Library instead of a meaningless start. Recall retains 显示答案 / 重来 / 良好 / 简单 and exact learning content. Scramble controls retain 提交 / 不会 / 继续 for existing contract/test compatibility (intentional concept copy deviation from 检查答案 / 暂时不会); add 撤回 / 清空, stable chip positions, explicit accessible labels, feedback with reference and per-item basic-pass state. Actual fixture learning data can differ from concept sample data; never fabricate user metrics.

## Interaction and accessibility
- Scramble chip identity is index-based (duplicates safe), bank positions stable after selection, 44px targets; remove selected token, undo last selection, clear selection, disable when submitting; preserve draft on error. Question identity resets draft. Submission/give-up guarded against repeat requests.
- Shared portal dialog handles focus trapping/restoration, Escape, accessible title, body scroll lock and safe-area; pending destructive operations cannot dismiss. Apply to Today history, undo and start, then inspect other modal flows.
- All controls visible keyboard focus. Network/retry states use live status/alert; refresh invalidates queries rather than hard reloading/discarding drafts. Unknown connectivity must not falsely claim offline operation.
- Meaningful short fade/translate/press feedback only; `prefers-reduced-motion` removes movement and scrolling animation.
- Device-local haptics opt-in, feature detection of `navigator.vibrate`, user-gesture only, no hidden switch hack or speculative bridge. Unsupported Safari shows honest explanatory status and keeps visual feedback. Do not claim successful physical vibration based on function existence/return or emulation.

Sources checked 2026-10-29: [WebKit standards position](https://github.com/WebKit/standards-positions/issues/267), [open Safari/iOS request](https://bugs.webkit.org/show_bug.cgi?id=288846), [Apple product page](https://www.apple.com/shop/buy-iphone/iphone-18-pro). iPhone-specific hardware feedback and Safari native keyboard behavior need actual device signoff, not Chromium emulation.

## Verification and stopping condition
TDD for algorithm and interactive helpers, full lint/typecheck/unit/integration/build, existing E2E and new mobile regressions. Iterative actual UI operations with local seeded/mock data only; inspect screenshots against concept for typography, palette, hierarchy, spacing, controls and mobile overflow. Record evidence and continuous screen recording when the browser surface supports it; explicitly report tooling limits otherwise. Continue until no known important reproducible defects remain; do not label software perfect or imply untested hardware behavior.

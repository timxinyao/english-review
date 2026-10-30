# Phase 14 — Native learning reliability

Status: implemented and locally verified, 2026-10-29. See `../NATIVE_LEARNING_QA.md` for exact verification and remaining platform acceptance limits.

## Decisions
- Source translations are supplied once with learning content, not generated at runtime. A nullable example translation column is added non-destructively; re-import backfills only missing translations and never resets progress. Earlier no-migration scope applied to the original upgrade; this explicitly requested follow-up adds migration 0011.
- Preserve Phase 13 scramble and existing data, no migration/reset or deployment.
- Keep proven FSRS parameters; fix due fairness, evidence validation and multi-item data integrity.
- 2026-10-30: Restore the earlier warm-paper palette and retain the enlarged type and controls. Use 12px base and 16px large-card radii; leave 20px between the mobile active review card and visible tab bar while preserving keyboard docking. This replaces the cold-white palette choice; learning behavior remains unchanged.
- System text, readable serif targets and terracotta action; no fake haptics.

## Completion
- [x] Backend and interaction regressions verified
- [x] Native visual system implemented and compared against concept
- [x] Repeated simulated operations and image QA
- [x] Full quality gates and documented platform limitations

## Changelog

- 2026-10-30 16:21（Asia/Shanghai）：用户追加部署授权后，将 `e0cf6c2` 前端产物发布到生产，仅更新静态资源并备份旧版本。HTTPS/HTTP 两入口资源与新构建一致，API 健康检查正常，API 未重启；未在生产账号作答或验证 iPhone/PWA 客户端。详见 `../WARM_REVIEW_UI_QA.md` 与本机 `output/warm-review-spacing/deployment/`。
- 2026-10-30: 恢复暖纸色卡与 PWA 主题，保留放大后的字体/控件，基础圆角 12px、大卡片 16px；同步 chrome 几何，手机活动复习卡与 Tab 留 20px。旧 E2E 的 7 处失配在原主干复现后，仅同步测试到现行拼词契约。lint、串行 typecheck、1,025 项单元/集成测试、完整 E2E（26 通过/10 既有跳过）及 build 通过；独立模拟视口验收通过，真机与跳过路径不计为已验证。详见 `../WARM_REVIEW_UI_QA.md`。
- 2026-10-30: Restored the warm-paper palette and mobile active-card spacing. Chromium layout checks covered narrow and standard phones, simulated safe areas, long revealed content, desktop and keyboard-height branches; keyboard unit tests passed. Existing compact-learning E2E had a pre-existing chip-loading race, reproduced three times on the baseline and fixed by waiting for the chip before counting. No iPhone or physical keyboard acceptance was performed.
- 2026-10-29: Added optional `source_example_translation` import/export and `sourceExampleTranslation` Today/Library projection, answer-only reveal, Library edit preservation, old-data compatibility and progress-safe translation backfill. Independent review resolved stale-field and lifecycle edge cases; 1,025 tests, lint, all typechecks and production build passed. Browser-runner limitation and exact evidence: `../SOURCE_TRANSLATION_QA.md`.
- Preserved Phase 13 data contracts; added regression-tested learning integrity, native-feeling interaction system, and iterative responsive visual verification.

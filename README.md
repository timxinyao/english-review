# English Review

[English](README.md) | [简体中文](README.zh-CN.md)

Personal English review system — an Anki-light closed loop. Single-user, single-machine, SQLite.

Not a chat tutor. Not multi-user SaaS. A small, disciplined review loop with optional AI assist under backend rules.

## What it does

- **Import** learning material (batch-friendly)
- **New Queue** holds new items; daily limits feed Today
- **Today** is the only formal review entry: **Understanding** and **Production** (independent scheduling)
- **AI feedback** for generation / judgment only — business state is always decided by the backend
- **Personal Example** captures useful corrections
- **Read** resurfaces items in context (does not change formal review progress)

## Who it's for

Self-hosters who want a focused personal review loop, not a classroom product or chatbot. Coding agents should start at [AGENTS.md](AGENTS.md), not this README alone.

## Stack

| Layer | Choice |
| --- | --- |
| Web | React + Vite + TypeScript, Tailwind + shadcn/ui |
| API | Fastify, Zod, Drizzle ORM, SQLite |
| Workspace | pnpm monorepo (`apps/web`, `apps/api`, `packages/shared`) |

Requirements: **Node.js >= 20.19**, **pnpm 10**.

## Quick start

```bash
pnpm install
cp .env.example apps/api/.env   # dotenv loads from apps/api when the API runs
# Edit apps/api/.env: set AUTH_PASSWORD and SESSION_SECRET
# Optional: GLM_API_KEY / GLM_* for live AI (eval can use --provider mock)
pnpm dev                        # API 127.0.0.1:5174 + web http://127.0.0.1:5173
```

See [`.env.example`](.env.example) for all fields (`AUTH_PASSWORD` / `AUTH_PASSWORD_HASH`, `SESSION_SECRET`, `DATABASE_PATH`, `APP_ORIGINS`, `APP_TIMEZONE`, optional `S3_BUCKET` and `GLM_*`). Do not commit real secrets.

## HTTP API

This is the **single-user app API** the web UI uses — not a public multi-tenant SDK. There is **no OpenAPI/Swagger** published; contracts live in code (`apps/api/src/modules/*/routes.ts`) and [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) §6.

| Topic | Detail |
| --- | --- |
| Prefix | All routes under `/api` |
| Dev base | API `http://127.0.0.1:5174`; web `http://127.0.0.1:5173` (set `APP_ORIGINS` for the web origin) |
| Auth | `POST /api/auth/login` with `{ "password" }` → signed **session cookie**; most routes require it |
| Public | `POST /api/auth/login`, `GET /api/health` only |
| Shape | JSON + Zod validation; stable error codes; no provider keys or prompt bodies exposed to the client |

Module map (Today, Library, Import, Read, Stats, Settings, …): [TECHNICAL_DESIGN §6.2](docs/TECHNICAL_DESIGN.md). Shared request/response types: `packages/shared`.

### `el-cli` (same API as the UI)

Scripted / agent access without the browser — talks to the running API with the same login cookie flow:

```bash
cd apps/api
pnpm exec tsx scripts/el-cli.ts find [query]
pnpm exec tsx scripts/el-cli.ts show <id>
pnpm exec tsx scripts/el-cli.ts preview <file.json|->   # import preview
pnpm exec tsx scripts/el-cli.ts commit --token <tok>
pnpm exec tsx scripts/el-cli.ts stats
pnpm exec tsx scripts/el-cli.ts backup ./backup.json
```

Defaults: `IMPORT_API_BASE=http://127.0.0.1:5174`, password from `IMPORT_PASSWORD` or `AUTH_PASSWORD` in `apps/api/.env`. See the header comment in [`apps/api/scripts/el-cli.ts`](apps/api/scripts/el-cli.ts).

## Agent Skills (for coding agents, not an in-app feature)

English Review does **not** ship end-user “Skills” inside the product UI. It does ship **agent skill playbooks** so Cursor / Claude-style agents can drive import and library ops via `el-cli`:

| Skill | Path | Does |
| --- | --- | --- |
| `import-english` | [`.agents/skills/import-english/`](.agents/skills/import-english/) (mirror under `.claude/skills/`) | Turn chat notes into import JSON → `preview` → confirm → `commit` |
| `library-english` | [`.agents/skills/library-english/`](.agents/skills/library-english/) | Find / show / edit / archive / pause / reset / master / stats / backup |

- Destructive or progress-changing ops: show current state, state consequences, get confirmation, then run.
- For **changing the codebase** (prompts, features, evals), ignore Skills and follow **[AGENTS.md](AGENTS.md)** → `docs/*` → edit `apps/api/prompts/*.md` and run `pnpm ai:eval` as needed.
- Phase / planning notes under `docs/superpowers/` are for staged implementation, not end users.

## Configure AI models

AI talks to a GLM / Anthropic-Messages-compatible endpoint. Copy [`.env.example`](.env.example) → `apps/api/.env`, then set:

| Variable | Role |
| --- | --- |
| `GLM_API_KEY` | Required for live generation / judgment |
| `GLM_API_BASE` | Default `https://open.bigmodel.cn/api/anthropic` |
| `GLM_MODEL_FLASH` / `GLM_MODEL_AIR` / `GLM_MODEL_MAX` | Optional pin; empty = auto-pick from `/v1/models` |
| `GLM_MAX_TOKENS` | Default `8192` |
| `GLM_THINKING` | Optional global override: `off` / `low` / `high` / `max`; empty = per-task policy |

- **Without a key**: API/web still boot; AI-backed actions degrade. Prompt eval works offline with `pnpm ai:eval -- --provider mock`.
- **After edits**: restart `pnpm dev` (or the API process) so env reloads.
- **Settings UI**: read-only resolved models / thinking via `GET /api/ai/models` (no keys or endpoints shown).
- Deeper policy: [docs/AI_RULES.md](docs/AI_RULES.md), [docs/MODEL_BENCHMARK.md](docs/MODEL_BENCHMARK.md), TECHNICAL_DESIGN §10.5.

## Common commands

```bash
pnpm test                              # unit/integration (vitest)
pnpm e2e                               # Playwright (starts api+web)
pnpm ai:eval -- --all                  # Prompt eval (use --provider mock without a GLM key)
pnpm ai:eval -- --task check_production
pnpm lint
pnpm format
pnpm typecheck
pnpm build                             # typecheck + web build
```

## Core product principles

- Simple first; **Today** is the only formal review entry.
- **Learning Item** is the core asset; exercise items are regenerable cache.
- Understanding / Production are scheduled independently (L1–L7 ladder / FSRS as documented).
- New Queue absorbs large imports; daily limits introduce work into Today.
- Library “try once” and Read do **not** advance formal review progress.
- AI only generates or judges text; business state is always decided by the backend. Prompt bodies live in Git, not in the DB.
- Single machine, SQLite, backup-friendly and recoverable.

## Documentation map

### Humans

Start here → dig into `docs/` as needed:

| Doc | Role |
| --- | --- |
| [docs/PRODUCT_DESIGN.md](docs/PRODUCT_DESIGN.md) | Product behavior (highest priority): flows, pages, learning rules |
| [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) | Stack, modules/API, deploy baseline |
| [docs/DATABASE.md](docs/DATABASE.md) | Tables and lifecycles |
| [docs/AI_RULES.md](docs/AI_RULES.md) | AI contracts, Prompt management, Eval |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Frontend/backend layering, style/component constraints |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | TDD flow, tests, lint gates |
| [docs/PHASES.md](docs/PHASES.md) | Phase plan and progress (sole progress source of truth) |
| [docs/MODEL_BENCHMARK.md](docs/MODEL_BENCHMARK.md) | Model × thinking benchmarks (living doc) |

Chinese product/tech docs are the authoritative written design; this English README is the public entry, not a second product spec.

### Coding agents

1. Read **[AGENTS.md](AGENTS.md)** before changing code (forbidden scope, stack lock, fact sources, process).
2. Then the same `docs/*` as source of truth; [docs/PHASES.md](docs/PHASES.md) for progress.
3. Prompts that are actually sent to models: [apps/api/prompts/](apps/api/prompts/).
4. Prompt eval fixtures: [apps/api/tests/ai/eval/](apps/api/tests/ai/eval/).
5. Runtime library/import via chat: Agent Skills above + `el-cli` (do not invent a second handbook).

Do not invent a second agent handbook. One fact lives in one place; link instead of copying.

## License

[MIT](./LICENSE) — Copyright (c) 2026 timxinyao.

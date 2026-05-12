# AGENTS.md

Operating manual for AI coding agents working on the Stock Analysis App. Read this **before** making any changes.

## Project at a glance

A full-stack stock-analysis application that visualizes price history and financial ratios for an investor-facing demo.

| Layer        | Tech                                            | Path             |
|--------------|-------------------------------------------------|------------------|
| Frontend     | React 19 + Vite + TypeScript + Recharts         | `frontend/`      |
| Backend      | Express 5 + TypeScript + Prisma ORM             | `backend/`       |
| Database     | PostgreSQL 16                                   | `docker-compose.yml` |
| Cache        | Redis 7 (24-hour TTL on fundamentals)           | `docker-compose.yml` |
| External API | Financial Modeling Prep — `https://financialmodelingprep.com/stable` | — |

Run everything: `./start-dev.sh`

## Architectural invariants — do not violate

1. **Fundamental data is quarterly**, not daily. The frontend forward-fills the most recent quarterly value across each trading day.
2. **ROE is stored as a decimal fraction** (0.28 means 28%). The frontend should multiply by 100 **exactly once** when displaying. Double-multiplication is a known historical bug — see "Known gotchas" below.
3. **Money fields use `BigInt`** in Prisma (`revenue`, `freeCashFlow`, `volume`). Serialize as string on the wire; convert to Number for chart math (with caution above 2^53).
4. **Ratios use `Decimal(12, 4)`** in Prisma. Convert to Number only at the API boundary.
5. **FMP `/stable/key-metrics` requires a paid plan**. On HTTP 402/403 the fetcher silently returns `[]`. Never assume key-metrics is populated unless the configured API key has the right tier.
6. **API response shape**: `{ success: boolean, data?: T, error?: string }`. Always wrapped.
7. **Time-series tables** use composite uniqueness `@@unique([symbol, date])` and index `@@index([symbol, date(sort: Desc)])`.

## Known gotchas (check these before debugging)

| Symptom | Likely cause | Where |
|---------|--------------|-------|
| P/E ratio (or any fundamental) shows nothing on `1M` / `1W` view | `calculateDateRange` uses the same window for fundamentals as for price data, but a 7- or 30-day window won't contain a quarterly report | `backend/src/services/fundamentalService.ts` |
| All ratios are silently null | FMP API key on free tier — `/stable/key-metrics` returns 402 and the fetcher swallows it | `backend/src/services/fundamentalFetcher.ts` (~line 157) |
| ROE displays as `2800%` | Double `× 100` — once in `mergeData`, once in `formatValue` | `frontend/src/components/AnalysisChart.tsx` and `frontend/src/types/stock.ts` |
| Quarterly metrics show as a step-function line | Expected — `connectNulls` + forward-filled quarterly data. Don't "fix" it. | `frontend/src/components/AnalysisChart.tsx` |

## Agent roster

When the user requests work, route to the right specialist agent:

| Agent          | Trigger phrases                                     | Owns                                              |
|----------------|-----------------------------------------------------|---------------------------------------------------|
| **code-writer**  | "implement", "add", "fix the bug in", "refactor"    | Feature implementation, bug fixes, refactors     |
| **qa-reviewer**  | "review", "look for issues", "is this safe?"        | Code review, security, type safety, conventions  |
| **researcher**   | "how does X work", "what does Y return", "should we use" | External docs, financial concepts, library choices |
| **db-architect** | "add a column", "design the schema for", "this query is slow" | Prisma schema, migrations, indexing, query tuning |
| **test-author**  | "add tests for", "write a regression test", "cover this" | Unit, integration, regression tests              |

## Suggested workflow

1. **researcher** clarifies any external/domain question first (cheap; prevents wasted code).
2. **db-architect** designs schema changes if the work touches the data layer.
3. **code-writer** implements the change end-to-end.
4. **test-author** adds coverage and regression tests.
5. **qa-reviewer** signs off before merge.

The orchestrating (parent) agent decides which sub-agent to invoke. Sub-agents do not call each other directly — they hand control back to the parent with their findings.

## Run / build / test commands

```bash
# Full stack
./start-dev.sh

# Backend only
cd backend && npm run dev
cd backend && npm run build           # TS compile check
cd backend && npm run prisma:migrate  # apply migrations
cd backend && npm run prisma:generate # regenerate client
cd backend && npm run prisma:studio   # visual DB inspector

# Frontend only
cd frontend && npm run dev
cd frontend && npm run build          # TS compile check
cd frontend && npm run lint
```

## Where things live

- Backend services: `backend/src/services/`
- Backend controllers/routes: `backend/src/controllers/`
- Prisma schema: `backend/prisma/schema.prisma`
- Frontend components: `frontend/src/components/`
- Frontend hooks: `frontend/src/hooks/`
- Frontend API client: `frontend/src/api/stockApi.ts`
- Shared frontend types: `frontend/src/types/stock.ts`

## Agent Teams (parallel teammates in tmux panes)

This project uses Anthropic's official **Agent Teams** feature (experimental) for parallel multi-agent work in tmux split panes.

### Configuration (already set)

`.claude/settings.json` enables it:

```json
{
  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" },
  "teammateMode": "tmux"
}
```

Valid `teammateMode` values: `"auto"` (use tmux if available, else in-process), `"tmux"`, `"in-process"`.

### How it works

The five files in `.claude/agents/` serve dual purposes:
- **As sub-agents**: invoked in-session via the Task tool (cheap, fast, no tmux needed).
- **As teammates**: spawned as parallel Claude Code processes in tmux panes with a shared task list and peer-to-peer messaging.

There is **no separate teammate file format** — Claude Code reuses the existing sub-agent definitions. (Caveat: `skills` and `mcpServers` fields are not applied to teammates; those come from project/user settings.)

### Launching the team

```bash
# Start tmux first — teammateMode: "tmux" requires you to already be in a tmux session
wsl -d Ubuntu
tmux new -s stockapp
cd /mnt/c/Users/wally/Documents/Github/Stock_Analysis_App
claude
```

Then ask the team lead in natural language:

> "Spawn a team using the code-writer, qa-reviewer, researcher, db-architect, and test-author teammate types."

Claude assembles the team automatically; each teammate gets its own pane.

### When to use which

| Situation | Use |
|-----------|-----|
| Single ad-hoc task | Sub-agent delegation (Task tool) — one session |
| Multiple parallel work streams that need to coordinate | Agent Teams — five panes |
| Background or scheduled work | Claude Agent SDK or `/schedule` skill |

### Reference

- Agent Teams: https://code.claude.com/docs/en/agent-teams.md
- Sub-agents: https://code.claude.com/docs/en/sub-agents.md
- Settings: https://code.claude.com/docs/en/settings.md

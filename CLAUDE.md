# CLAUDE.md

**Read `AGENTS.md` first** for the full project operating manual: stack overview, architectural invariants, known gotchas, run commands, and the agent roster.

## Required: delegate to specialist agents

This project has five specialist sub-agents defined in `.claude/agents/`. When a user request matches one of the patterns below, **delegate via the Task tool** rather than doing the work yourself.

| Request matches…                                                       | Use this agent     |
|------------------------------------------------------------------------|--------------------|
| "implement", "add", "fix the bug", "refactor", "update the code"       | `code-writer`      |
| "review", "look for issues", "is this safe?", "audit"                  | `qa-reviewer`      |
| "how does X work", "what does Y return", "should we use", "research"   | `researcher`       |
| "add a column", "design the schema", "migration", "this query is slow" | `db-architect`     |
| "add tests", "write a regression test", "cover this", "test for"       | `test-author`      |

## Default workflow for non-trivial work

1. **researcher** — clarify any external API or financial-domain question
2. **db-architect** — design schema/migration changes if the data layer is touched
3. **code-writer** — implement end-to-end
4. **test-author** — add coverage and regression tests
5. **qa-reviewer** — sign off before considering the work done

The orchestrating session decides which sub-agents to invoke. Sub-agents do not call each other directly.

## When NOT to delegate

Skip the agent system for:
- One-line factual questions ("what does this function do?")
- Reading a single file
- Trivial edits — typos, comment fixes
- Conversational/exploratory replies that don't change code

For everything else that fits a specialist's expertise, delegate. This keeps each agent focused and produces better output for an investor-facing product.

## Quick reference

- `./start-dev.sh` — start full stack (Postgres, Redis, backend, frontend)
- `cd backend && npm run build` — backend TypeScript check
- `cd frontend && npm run build` — frontend TypeScript check
- `backend/prisma/schema.prisma` — database schema
- `frontend/src/types/stock.ts` — shared frontend types

## Agent Teams (tmux split panes)

Agent Teams is enabled via `.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" },
  "teammateMode": "tmux"
}
```

The five specialist files in `.claude/agents/` work as both sub-agents (in-session, via the Task tool) and teammates (parallel tmux panes, with shared task list + peer messaging).

To run them as a team:

1. From WSL Ubuntu, start a tmux session and launch Claude Code:
   ```bash
   wsl -d Ubuntu
   tmux new -s stockapp
   cd /mnt/c/Users/wally/Documents/Github/Stock_Analysis_App
   claude
   ```
2. Ask the team lead to assemble the team, e.g.:
   > "Spawn a team using the code-writer, qa-reviewer, researcher, db-architect, and test-author teammate types so we can work on the project together."

The lead spawns each teammate into its own pane automatically.

For day-to-day single-session work, prefer Task-tool delegation from one Claude session — faster and cheaper than spinning up the full team.

> **Note**: Agent Teams is experimental. The `skills` and `mcpServers` fields on a sub-agent are NOT applied when running as a teammate (teammates inherit those from project/user settings instead).

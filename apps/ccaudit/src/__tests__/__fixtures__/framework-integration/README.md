# Phase 5 framework-integration fixture

Canonical 14-item `.claude/` tree used by `framework-integration.test.ts`.
Locked by Phase 5 decision D-03. Do NOT modify without regenerating all inline
snapshots in `framework-integration.test.ts`.

## Items

- 5 GSD agents (curated framework `gsd`): planner, executor, roadmapper,
  verifier, code-reviewer. `gsd-planner` + `gsd-executor` appear in the session
  JSONL as used → GSD framework status is `partially-used`.
- 3 `foo-*` agents (heuristic cluster `foo`): alpha, beta, gamma. None used.
- 4 `engineering/*` agents (domain-folder stop-list): backend-dev, frontend-dev,
  ml-engineer, devops. MUST render as ungrouped per DOMAIN_STOP_FOLDERS.
- 2 ungrouped singletons: `solo-agent.md` (agent), `lone-skill/SKILL.md` (skill).

## Files

- `.claude/agents/*.md` — 9 agent stubs at root
- `.claude/agents/engineering/*.md` — 4 domain-folder agents
- `.claude/skills/lone-skill/SKILL.md` — 1 skill
- `.claude/projects/framework-fixture/session-1.jsonl` — 3-line session with two
  `Task` tool_use blocks for gsd-planner + gsd-executor
- `.claude.json` — empty `{}` to suppress MCP scan
- `v1-2-1-envelope.json` — one-shot-captured v1.2.1-shape envelope for TEST-07
  Prong A (captured by `apps/ccaudit/scripts/capture-v1-2-1-envelope.mjs` in
  Task 2 Step 0, not this task)

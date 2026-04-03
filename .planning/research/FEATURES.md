# Feature Landscape: ccaudit

**Domain:** CLI developer diagnostic/audit tool (Claude Code ghost inventory)
**Researched:** 2026-04-03
**Overall Confidence:** HIGH

---

## Table Stakes

Features users expect from any well-behaved CLI audit/diagnostic tool. Missing any of these and the tool feels amateur or untrustworthy.

### CLI UX Foundations

| Feature | Why Expected | Complexity | Status in Plan | Notes |
|---------|--------------|------------|----------------|-------|
| `--help` / `-h` on every command | clig.dev standard; users scan help text to learn tool | Low | Implicit (gunshi) | gunshi handles this natively |
| Meaningful exit codes | 0 = clean, non-zero = ghosts found; CI integration depends on this | Low | **NOT IN PLAN** | Critical gap -- every audit tool uses exit codes for CI gating |
| `--json` and `--csv` export | Machine-readable output for piping, dashboards, scripting | Low | v1.0 | Already planned |
| `NO_COLOR` / `--no-color` support | clig.dev standard; CI environments break without it | Low | **NOT IN PLAN** | Table stakes per clig.dev -- respect `NO_COLOR` env var |
| `--quiet` / `-q` flag | Suppress non-essential output; scripts need data-only mode | Low | **NOT IN PLAN** | Script consumers expect this |
| `--verbose` / `-v` flag | Show debug info (which JSONL files parsed, timing, skip reasons) | Low | **NOT IN PLAN** | Debugging and trust-building; users want to see what was scanned |
| Human-readable default output | Pretty tables when TTY, plain when piped | Low | v1.0 (cli-table3) | Already planned |
| Graceful error handling | Malformed JSONL silently skipped; missing dirs = clear message, not stacktrace | Low | v1.0 (silent skip) | Already planned for JSONL; extend to all error paths |
| Progress indicator for long scans | Spinner or progress bar for large JSONL histories | Low | **NOT IN PLAN** | Any operation >1s needs feedback per clig.dev |
| Version flag (`--version`) | Standard convention | Low | Implicit (gunshi) | gunshi handles this |

### Audit Tool Foundations

| Feature | Why Expected | Complexity | Status in Plan | Notes |
|---------|--------------|------------|----------------|-------|
| Clear defined/used/unused categorization | Core audit output -- users need to see what's live vs dead | Med | v1.0 (Defined/Used/Ghost columns) | Already planned |
| Time-window filtering (`--since`) | Different users care about different timeframes | Low | v1.0 | Already planned |
| Per-project breakdown | Users have multiple projects; global-only is useless | Med | v1.0 | Already planned |
| Summary statistics | Total ghosts, total tokens wasted, overall health score | Low | v1.0 (token waste calculator) | Already planned |
| Idempotent analysis | Running twice produces identical results | Low | Implicit | Architecture concern, not a feature flag |
| Read-only by default | Audit tools that modify without explicit opt-in lose trust immediately | Low | v1.0 | Already planned -- entire v1.0 is read-only |

### Safety & Trust (for tools that modify files)

| Feature | Why Expected | Complexity | Status in Plan | Notes |
|---------|--------------|------------|----------------|-------|
| Dry-run before modification | Users demand preview before filesystem changes | Med | v1.1 | Already planned |
| Reversible operations | Archive/backup, not delete | Med | v1.2 | Already planned (archive not delete) |
| Restore/undo capability | Must be able to undo any change | Med | v1.2 | Already planned |
| Explicit dangerous flag naming | Destructive ops must be opt-in with obvious naming | Low | v1.2 (`--dangerously-bust-ghosts`) | Already planned |

### Table Stakes Gap Summary

**Three gaps to close before v1.0 ships:**
1. **Exit codes** -- non-zero when ghosts found. CI integration depends on this. Without it, ccaudit cannot be used in pre-commit hooks or CI pipelines.
2. **`NO_COLOR` / `--no-color`** -- without this, piped output and CI logs contain ANSI garbage.
3. **`--quiet` / `--verbose`** -- script consumers need quiet mode; debugging users need verbose mode.

**One gap to address as polish:**
4. **Progress indicator** -- for users with large JSONL histories (months of sessions), silence during parsing feels broken.

---

## Differentiators

Features that set ccaudit apart from competitors. Not expected by default, but these are why someone would choose ccaudit over who-ran-what, ccboard, or agent-usage-analyzer.

### Primary Differentiators (Planned)

| Feature | Value Proposition | Complexity | Status | Competitive Edge |
|---------|-------------------|------------|--------|-----------------|
| Token cost attribution per ghost | "This agent costs you 3,200 tokens every session" -- quantifies the problem | Med | v1.0 | **UNIQUE** -- no competitor does this. who-ran-what shows usage counts, not token cost. |
| `--dangerously-bust-ghosts` remediation | One command to fix the problem, not just report it | High | v1.2 | **UNIQUE** -- no competitor offers remediation. who-ran-what and agent-usage-analyzer are report-only. |
| Viral flag naming | `--dangerously-bust-ghosts` appears in every screenshot; "I accept full responsibility" is shareable | N/A | v1.2 | **UNIQUE** -- deliberate memetic engineering. No competitor has a memorable CLI gesture. |
| Before/after token numbers | "108k tokens -> 12k tokens" is the hook | Low | v1.2 (post-bust summary) | **UNIQUE** -- quantified outcome. Competitors show stats but not savings. |
| Hash-based checkpoint gate | Dry-run hash must match current state before bust runs; prevents stale dry-run execution | Med | v1.1-v1.2 | **UNIQUE** -- stronger safety than time-based expiry. |
| `npx ccaudit` zero-install | Try in 5 seconds, no commitment | Low | v1.0 | **Shared with ccusage** but NOT available for ccboard (Rust binary) or who-ran-what (git clone + shell). |
| `ccaudit contribute` (PR payload for mcp-token-estimates.json) | Users improve the tool for everyone; community flywheel | Med | v1.2 | **UNIQUE** -- no competitor has a contribution loop. |
| Companion framing with ccusage | "ccusage = what you spent, ccaudit = what you're wasting" -- instant comprehension | N/A | v1.0 | **UNIQUE** positioning. |
| MCP ghost detection with `--live` exact counts | Connect to actual MCP servers to measure real token overhead | High | v1.0 | **UNIQUE** -- all competitors use static estimates or ignore MCP entirely. |

### Potential Additional Differentiators (Not Yet Planned)

| Feature | Value Proposition | Complexity | Should Add? | Notes |
|---------|-------------------|------------|-------------|-------|
| `ccaudit score` (health score 0-100) | Single number for README badges, CI gates, team dashboards | Low | **YES -- v1.0** | Knip-like pattern. "Your Claude Code health score: 73/100" is more shareable than a table. |
| CI mode (`--ci`) | Exit code + minimal output + JSON for CI pipelines | Low | **YES -- v1.0** | Combine exit codes + quiet + json into one ergonomic flag. Many audit tools offer this. |
| `ccaudit share` (SVG/image output) | Screenshot-ready output for social sharing | Med | **MAYBE -- v1.1+** | who-ran-what has `wr share` for SVG. Strengthens viral loop but not core value. |
| Config file (`.ccauditrc`) | Project-level overrides (ignore specific agents, custom thresholds) | Med | **YES -- v1.1** | Expected for any tool that runs in CI. Users need to allowlist agents that look unused but are seasonal. |
| `ccaudit watch` (file watcher mode) | Re-run analysis when session files change | Med | **NO** | Over-engineering. Users run audits periodically, not continuously. |
| Multi-platform support (Gemini CLI, Codex CLI) | who-ran-what already supports 4 platforms | High | **LATER -- v2.0+** | Significant scope increase. who-ran-what's breadth is a threat but ccaudit's depth (token cost + fix) is the counter. |

### Differentiator Strength Assessment

**ccaudit's moat is three-layered:**
1. **Quantification layer** -- token cost attribution (no competitor has this)
2. **Remediation layer** -- actually fixes the problem (no competitor has this)
3. **Viral layer** -- `--dangerously-bust-ghosts` + before/after numbers + triple confirmation (no competitor has a memorable gesture)

**The moat is narrow in the analysis layer.** who-ran-what's `wr clean` already identifies unused items. ccboard's Plugins tab does dead code detection. The analysis itself is replicable. The moat is in what happens AFTER analysis.

---

## Anti-Features (Deliberately Excluded)

Features to explicitly NOT build. Each exclusion protects scope, preserves the tool's identity, or avoids architectural complexity that would slow shipping.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **GUI / web dashboard** | ccboard already covers TUI+web. Competing on presentation is a losing strategy when your moat is in analysis+remediation. | Stay CLI-only. Let ccboard be the dashboard. |
| **Real-time session monitoring** | ccboard does live session tracking with SQLite caching. This is their core competence. | ccaudit is a point-in-time audit, not a monitor. |
| **Multi-agent orchestration** | Out of domain. ccaudit reads history, it doesn't orchestrate agents. | Refer users to agent orchestration tools. |
| **Usage dashboards / analytics** | ccusage and ccboard already do this well. Duplicating their charts adds maintenance without differentiation. | Position as companion to ccusage, not replacement. |
| **Automatic session-start invocation** | Already in Out of Scope. Users should choose when to audit. Auto-run creates noise and trust issues. | Provide `--ci` flag for intentional automation. |
| **Non-Claude Code platforms (v1)** | who-ran-what supports 4 platforms. Matching their breadth dilutes focus. Ship depth on Claude Code first. | v2.0+ consideration after Claude Code depth is proven. |
| **Cloud sync / remote storage** | Violates zero-install philosophy. Adds auth, infra, and privacy concerns. | Local-only. Files stay on user's machine. |
| **Plugin system / extensibility API** | Premature abstraction. Ship the 4 ghost categories first, add extensibility only if community demands it. | Hard-code the 4 categories (agents, skills, MCP, memory). |
| **Token cost for non-ghost items** | "What does my entire config cost?" is ccusage territory. ccaudit answers "what's wasted?" | Only report token cost for ghost items. |
| **Scheduled/cron execution** | Users can add ccaudit to cron themselves. Building scheduling into the tool is scope creep. | Document cron usage in README. |
| **Interactive TUI mode** | ccboard is the TUI. ccaudit is a one-shot command. Mixing modalities creates confusion. | CLI with flags, not interactive prompts (except triple confirmation for bust). |
| **"Smart" auto-remediation** | "ccaudit auto-fixes for you" is dangerous and erodes trust. Users must see the plan and confirm. | Dry-run gate + explicit flag + triple confirmation. |
| **Integration with external services** | No Slack notifications, no webhook pushes, no API server. | Provide `--json` for consumers to build on. |

---

## Community Growth Vectors

Features that create contribution loops, turning users into contributors and contributors into advocates.

### Planned

| Feature | Growth Mechanic | Complexity | Phase |
|---------|-----------------|------------|-------|
| `mcp-token-estimates.json` (community-maintained) | Users run `ccaudit contribute` to submit their real MCP token measurements. Each contributor improves accuracy for everyone. | Med | v1.2 |
| `--dangerously-bust-ghosts` screenshot sharing | The flag name and triple confirmation are inherently shareable. Before/after numbers create "look what I saved" social proof. | N/A | v1.2 |
| ccusage companion framing | Every ccusage user is a potential ccaudit user. Cross-promotion in READMEs, npm keywords, and community channels. | N/A | v1.0 |

### Potential (Not Yet Planned)

| Feature | Growth Mechanic | Complexity | Recommendation |
|---------|-----------------|------------|----------------|
| Health score badge for README | `![Claude Code Health](https://img.shields.io/badge/...)` -- users put badges in their repos, creating passive discovery. | Low | **ADD to v1.0** -- nearly free to implement, high visibility |
| `ccaudit share` SVG output | Users post terminal screenshots to Twitter/X, Discord, dev.to. who-ran-what already has this. | Med | **ADD to v1.1** -- strengthens viral loop |
| GitHub Action / pre-commit hook | `ccaudit --ci` in CI pipeline = every team member sees ghost count. Normalizes the tool across teams. | Med | **ADD to v1.1** -- CI adoption is a multiplier |
| Leaderboard / community stats | "Average Claude Code user has 3.2 ghost agents" -- aggregate anonymized stats | High | **DEFER** -- privacy concerns, infra needed |

### Growth Vector Priority

1. **Highest leverage:** `--dangerously-bust-ghosts` virality (already planned)
2. **Cheapest win:** Health score badge for README (near-zero cost, passive discovery)
3. **Community flywheel:** `mcp-token-estimates.json` contribution loop (already planned)
4. **CI multiplier:** GitHub Action / `--ci` flag (team-level adoption)

---

## Competitive Threat Features

What competitors could add to close the gap with ccaudit. Ordered by threat severity.

### Critical Threats

| Competitor | Threat Move | Impact on ccaudit | Likelihood | Mitigation |
|------------|-------------|-------------------|------------|------------|
| **ccboard** | Add ghost detection + `npx` distribution | HIGH -- ccboard already has MCP tab, Plugins tab (dead code), and broad adoption. Adding ghost framing + npx would match ccaudit's analysis layer. | MEDIUM -- ccboard is Rust, adding npx means a Node wrapper or WASM build. Architectural friction. | **Ship v1.0 fast.** First-mover on "ghost" framing + token cost attribution. ccboard would still lack remediation. |
| **ccboard** | Add remediation (archive/restore) | CRITICAL -- if ccboard adds ghost detection + fix, they become the all-in-one tool. | LOW -- ccboard's identity is "monitoring dashboard," not "fix tool." Adding destructive ops to a TUI is risky UX. | **Ship v1.2 within 2 months of v1.0.** Remediation is ccaudit's long-term moat. |
| **who-ran-what** | Add token cost attribution | HIGH -- `wr clean` already shows unused items. Adding token cost per ghost makes it functionally equivalent to ccaudit's analysis. | HIGH -- this is a straightforward feature addition. No architectural barrier. | **Ship v1.0 first.** Token cost + remediation together is the moat. Token cost alone is copyable in a weekend. |
| **Anthropic (upstream)** | Built-in ghost detection in Claude Code itself | EXISTENTIAL -- if `/context` shows "3 ghost agents costing 4.2k tokens" natively, ccaudit's analysis layer becomes redundant. | MEDIUM -- Anthropic has defer_loading and tool search now; built-in ghost detection is a logical next step. | **Remediation is the insurance policy.** Even if Anthropic shows ghosts, they won't ship `--dangerously-bust-ghosts`-style destructive ops in the main CLI. ccaudit becomes the "fix" tool. |

### Moderate Threats

| Competitor | Threat Move | Impact | Likelihood | Mitigation |
|------------|-------------|--------|------------|------------|
| **who-ran-what** | Add multi-platform as moat | MEDIUM -- "works with Claude + Gemini + Codex + OpenCode" vs ccaudit's Claude-only | Already happening | Depth > breadth messaging. "who-ran-what tells you what ran. ccaudit tells you what's wasting tokens and fixes it." |
| **who-ran-what** | Add `wr fix` remediation | HIGH -- closes the remediation gap | LOW -- who-ran-what is shell-based, not a robust enough foundation for safe file operations | Ship remediation first, make safety the differentiator |
| **New entrant** | Rust-based ghost buster with npx via WASM | MEDIUM -- could be faster and have the same feature set | LOW -- significant engineering effort for marginal gain | Community + contribution loop + viral branding are harder to replicate than code |

### Low Threats

| Competitor | Threat Move | Impact | Likelihood |
|------------|-------------|--------|------------|
| **agent-usage-analyzer** | Add ghost framing | LOW -- skill-first analysis, no broader scope | LOW |
| **Generic LLM cost tools** | Add Claude Code support | LOW -- different problem domain (API cost vs context window waste) | LOW |

### Upstream Risk: Anthropic's `defer_loading`

**Context:** As of 2026, Anthropic's `defer_loading` / Tool Search reduces MCP tool definition overhead by ~85%. MCP tools marked `defer_loading: true` are not loaded into context until discovered on demand.

**Impact on ccaudit:**
- **MCP ghost detection remains relevant** -- `defer_loading` reduces tool definition overhead but doesn't address: registered-but-never-invoked MCP servers (still consume connection overhead, startup time, and residual context), ghost agents (not affected by defer_loading), ghost skills (not affected), or stale memory files (not affected).
- **Token cost estimates for MCP may decrease** -- the "token waste" number for MCP servers will be lower with defer_loading. ccaudit's `--live` flag measuring actual overhead becomes MORE valuable (shows real vs estimated savings).
- **Messaging adjustment needed** -- the 108k->12k pitch may need updating as Anthropic's own improvements reduce baseline overhead. Frame ccaudit as "what defer_loading doesn't catch."

---

## Feature Dependencies

```
Exit codes ─────────────────────────────> CI mode (--ci)
                                              │
--json export ──────────────────────────> CI mode (--ci)
                                              │
--quiet flag ───────────────────────────> CI mode (--ci)
                                              │
                                              v
                                     GitHub Action / pre-commit hook

Ghost detection (v1.0) ────────────────> Token cost attribution (v1.0)
        │                                     │
        v                                     v
   Dry-run (v1.1) ────────────────────> Checkpoint hash (v1.1)
        │                                     │
        v                                     v
   Remediation (v1.2) ────────> Checkpoint validation (v1.2)
        │                                     │
        v                                     v
   Restore (v1.2)              `ccaudit contribute` (v1.2)
                                              │
                                              v
                               mcp-token-estimates.json community file

Health score ──────────────────────────> README badge
                                              │
                                              v
                                     Share/SVG output
```

---

## MVP Recommendation

### v1.0 Must-Ship (analysis-only)

**Prioritize (already planned):**
1. Ghost detection across 4 categories (agents, skills, MCP, memory)
2. Token cost attribution per ghost (the key differentiator)
3. Per-project + global view
4. `--json` / `--csv` export
5. `--since` time window
6. `ccaudit ghost` (default), `inventory`, `mcp`, `trend`

**Add to v1.0 (table stakes gaps):**
7. Exit codes (non-zero when ghosts found)
8. `NO_COLOR` / `--no-color` support
9. `--quiet` / `--verbose` flags
10. Progress indicator for large JSONL sets

**Consider for v1.0 (cheap differentiators):**
11. Health score (0-100) -- single shareable number
12. `--ci` flag (combines exit code + quiet + json)

### Defer

- `ccaudit share` (SVG output) -- v1.1, after core is proven
- Config file (`.ccauditrc`) -- v1.1, needed for CI adoption
- GitHub Action -- v1.1, after `--ci` flag exists
- Multi-platform support -- v2.0+, after depth is proven

---

## Sources

- [clig.dev - Command Line Interface Guidelines](https://clig.dev/) -- CLI UX conventions (HIGH confidence)
- [Knip - Find unused files, dependencies, exports](https://knip.dev/) -- Analogous "unused stuff" detection tool (HIGH confidence)
- [ccboard GitHub](https://github.com/florianbruniaux/ccboard) -- Competitor feature analysis (HIGH confidence)
- [who-ran-what GitHub](https://github.com/mylee04/who-ran-what) -- Competitor feature analysis (HIGH confidence)
- [Anthropic - Advanced Tool Use / defer_loading](https://www.anthropic.com/engineering/advanced-tool-use) -- Upstream platform changes (HIGH confidence)
- [CLI UX best practices - Evil Martians](https://evilmartians.com/chronicles/cli-ux-best-practices-3-patterns-for-improving-progress-displays) -- Progress display patterns (MEDIUM confidence)
- [Atlassian - 10 design principles for delightful CLIs](https://www.atlassian.com/blog/it-teams/10-design-principles-for-delightful-clis) -- CLI design principles (MEDIUM confidence)
- [IBM audit-ci](https://github.com/IBM/audit-ci) -- CI integration patterns for audit tools (HIGH confidence)
- [depcheck](https://github.com/depcheck/depcheck) -- Analogous "unused dependencies" detection tool (HIGH confidence)
- [Heroku CLI Style Guide](https://devcenter.heroku.com/articles/cli-style-guide) -- CLI conventions (HIGH confidence)

---

**Confidence:** HIGH -- Features landscape is well-understood from both the CLI tooling domain (clig.dev, Knip, depcheck patterns) and the Claude Code ecosystem (direct competitor analysis of ccboard, who-ran-what). The upstream risk from Anthropic's defer_loading is the main uncertainty, but ccaudit's moat (remediation + viral naming) is orthogonal to that improvement.

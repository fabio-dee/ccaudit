# Pitfalls Research -- ccaudit

**Domain:** TypeScript CLI tool for Claude Code ghost inventory audit + reversible filesystem remediation
**Researched:** 2026-04-03
**Overall confidence:** HIGH (critical pitfalls verified against official Claude Code docs and confirmed GitHub issues)

---

## Critical (Data Loss Risk)

Pitfalls that could cause irreversible user harm or break Claude Code entirely.

### Pitfall C1: MCP Config File Identity Crisis -- settings.json vs .claude.json

**What goes wrong:** PROJECT.md says "Comment-out MCP servers in `settings.json`" but MCP server configurations live in `~/.claude.json` (user scope) and `.mcp.json` (project scope), NOT in `settings.json`. Targeting the wrong file means either (a) ccaudit modifies `settings.json` and nothing changes for MCP, or (b) ccaudit reads `settings.json` for MCP servers and finds zero -- reporting all servers as "not configured" rather than "ghost."

**Why it happens:** Claude Code's config is spread across multiple files with confusing naming. The official docs (https://code.claude.com/docs/en/settings, scope table) confirm:
- `settings.json` -- permissions, hooks, plugins, general settings
- `~/.claude.json` -- MCP servers (user scope), OAuth session, per-project state, caches
- `.mcp.json` -- MCP servers (project scope, shared with team)

**Consequences:** At read time (v1.0): MCP ghost count is wrong -- either zero (if reading wrong file) or inflated. At write time (v1.2): either nothing is disabled (wrong file) or `~/.claude.json` is corrupted (contains OAuth token, project state, all MCP configs -- far bigger blast radius than settings.json alone).

**Why this is data loss risk:** `~/.claude.json` contains the user's OAuth token. A malformed write means Claude Code cannot start AND the user must re-authenticate. Multiple GitHub issues confirm `.claude.json` corruption from concurrent writes (issues #28842, #29217, #28847) causes "JSON Parse error: Unexpected EOF" on startup.

**Prevention:**
1. Read MCP servers from `~/.claude.json` (root `mcpServers` + `projects.<path>.mcpServers`) and `.mcp.json` for project scope
2. For remediation: use Claude Code's native `_disabled_mcpServers` pattern (move server config from `mcpServers` to `_disabled_mcpServers` key) -- this is what `/mcp disable` does internally
3. Back up the entire `~/.claude.json` before any mutation
4. Use atomic write (write-to-temp-then-rename) for all mutations

**Detection:** Integration test that verifies which file ccaudit reads/writes MCP config from. Schema validation on read.

**Phase:** Must be correct in v1.0 (read path) and v1.2 (write path). Getting this wrong in v1.0 means the MCP ghost count is zero, which destroys the "108k tokens" viral number.

**Severity:** CRITICAL -- corrupting `~/.claude.json` breaks Claude Code entirely + loses OAuth session.

**Confidence:** HIGH -- verified against official docs at https://code.claude.com/docs/en/settings (Feature/MCP servers row).

---

### Pitfall C2: Comment-Out Strategy Is Impossible in JSON

**What goes wrong:** PROJECT.md says "Comment-out MCP servers in `settings.json` with `// ccaudit-disabled` prefix." JSON does not support comments. Claude Code's config files are standard JSON. Writing `//` into a `.json` file makes it unparseable. Claude Code will crash on next startup or silently ignore the entire config.

**Why it happens:** The "comment-out" metaphor is intuitive for developers but technically impossible in standard JSON. There is an open feature request (anthropics/claude-code#29370) to support JSONC in settings.json, but it is not implemented. Even if JSONC support were added for `settings.json`, the MCP configs live in `.claude.json` which has no JSONC support.

**Consequences:** Claude Code startup failure. Confirmed failure modes from GitHub issues:
- Issue #1506: "Invalid JSON Configuration Causing Startup Crash"
- Issue #2835: "Silent Failure on Malformed JSON settings.json Files"
- Issue #33650: "settings.local.json corrupted by improperly escaped entries"

**Prevention:** Use Claude Code's native disable pattern:
```json
{
  "mcpServers": { /* only active servers */ },
  "_disabled_mcpServers": { /* ccaudit-archived servers, preserving full config */ }
}
```
This is the exact pattern Claude Code uses when you run `/mcp disable <server>`. It preserves the full server config, is recognized by Claude Code's internal tooling, and round-trips safely through JSON.parse/JSON.stringify.

**Detection:** Parse the output file with `JSON.parse()` after every write. If it throws, rollback immediately before returning.

**Phase:** v1.2 design decision -- must be resolved before any remediation code is written.

**Severity:** CRITICAL -- broken JSON = Claude Code won't start. Users will file "ccaudit broke my Claude Code" issues within hours.

**Confidence:** HIGH -- JSON spec, verified against Claude Code behavior.

---

### Pitfall C3: Non-Atomic Filesystem Mutations During Archive

**What goes wrong:** If ccaudit archives agents by moving files one-by-one and the process is interrupted (Ctrl+C, crash, disk full, SIGKILL), the user ends up in a half-archived state: some agents moved, some not, the inventory hash no longer matches either the pre-archive or post-archive state, and `ccaudit restore` cannot determine what to undo.

**Why it happens:** Node.js `fs.rename` is atomic for single files on the same filesystem, but a multi-file archive operation (move N agent files to `_archived/`) is not atomic as a batch. Power loss, Ctrl+C, or process termination mid-operation leaves partial state.

**Consequences:** User has a corrupted agent setup. Some agents are gone from the active directory, some are in `_archived/`, and there is no manifest of what was moved. The "restore" command cannot reconstruct the pre-archive state.

**Prevention:**
1. Write a manifest file FIRST (before any moves) listing every file to be archived: source path, destination path, sha256 hash
2. Perform all file moves
3. Write a completion marker to the manifest
4. On `restore`: read the manifest, move everything back, verify hashes
5. On ANY ccaudit invocation: if manifest exists but completion marker is missing, detect interrupted archive -- offer to complete forward or rollback
6. Register a SIGINT/SIGTERM handler to detect interruption and write a partial-state marker

**Detection:** Check for manifest without completion marker on every ccaudit run. Warn user.

**Phase:** v1.2 -- core remediation architecture. Manifest pattern must be designed before any file-move code.

**Severity:** CRITICAL -- partial archive = broken Claude Code setup + no clear recovery path.

**Confidence:** HIGH -- standard filesystem safety concern.

---

### Pitfall C4: ~/.claude.json Race Condition with Running Claude Code

**What goes wrong:** If the user runs `ccaudit --dangerously-bust-ghosts` while Claude Code is running, both processes may write to `~/.claude.json` simultaneously. Claude Code uses `.claude.json` for session state and caches. Concurrent writes without file locking produce truncated JSON.

**Why it happens:** Neither Claude Code nor ccaudit implement file locking on `.claude.json`. Node.js `fs.writeFile` is not atomic -- it truncates the file then writes. If Claude Code reads the file mid-write, it gets truncated content.

**Consequences:** `~/.claude.json` becomes `{}` or gets truncated mid-JSON, causing "JSON Parse error: Unexpected EOF" on Claude Code's next read. This can wipe the OAuth session, requiring re-authentication. Confirmed by issues #28842, #29217, #28847.

**Prevention:**
1. Detect running Claude Code processes before mutation (`pgrep -f "claude"` or check for lock files in `~/.claude/`)
2. Refuse to mutate if Claude Code appears to be running -- print clear error with instructions to close Claude Code first
3. Use write-to-temp-then-rename pattern: `writeFileSync(tmpPath, content)` then `renameSync(tmpPath, targetPath)` -- rename is atomic on POSIX
4. On Windows: be aware that antivirus (Windows Defender) can hold file locks on recently-written files, causing EPERM on rename. Consider retry logic with exponential backoff (up to 3 retries).

**Detection:** Pre-flight check in `--dangerously-bust-ghosts` flow before any writes.

**Phase:** v1.2 -- must be a hard gate before any `.claude.json` mutation.

**Severity:** CRITICAL -- concurrent write = corrupted config = Claude Code startup failure.

**Confidence:** HIGH -- confirmed by multiple Claude Code GitHub issues documenting this exact failure mode.

---

### Pitfall C5: Runtime Dependencies Leaking Into Published Package

**What goes wrong:** A library ends up in `dependencies` instead of `devDependencies`, breaking the zero-runtime-deps invariant. Users running `npx ccaudit` download transitive deps, adding install time and supply chain risk.

**Why it happens:** Muscle memory -- developers add imports to `dependencies`. Workspace package references (`workspace:*`) can also leak if `clean-pkg-json` is misconfigured.

**Consequences:** Install time balloons (defeating the "try in 5 seconds" pitch). Supply chain attack surface increases. Breaks parity with ccusage.

**Prevention:**
1. Never add a `dependencies` field to `apps/ccaudit/package.json`. Only `devDependencies`.
2. Use `clean-pkg-json` in prepack to strip dev fields.
3. CI check: `npm pack --dry-run` + verify no runtime deps in published tarball.
4. pnpm catalog strict mode prevents ad-hoc version additions.

**Detection:** `npm pack --dry-run | grep -c "dependencies"` in CI. If non-zero, fail.

**Phase:** Scaffold phase and every release.

**Severity:** CRITICAL -- breaks the zero-install promise and distribution model.

**Confidence:** HIGH -- well-known npm packaging pitfall.

---

## High (Trust Damage)

Pitfalls that would kill adoption or the viral mechanic.

### Pitfall H1: False Positive Ghosts Kill the Viral Number

**What goes wrong:** The "108k -> 12k tokens" before/after number is the viral hook. If ccaudit reports an agent as a "ghost" when the user actually uses it (just not in the `--since 7d` window), the user loses trust immediately. One false positive in a viral screenshot = "ccaudit reports wrong numbers" narrative.

**Why it happens:** The `--since` window creates a fundamental observation bias. A user who runs a weekly code review agent on Fridays will see it flagged as a ghost if they run ccaudit on Thursday. An agent used 8 days ago with `--since 7d` is a ghost by definition but not by intent.

**Consequences:** Users tweet "ccaudit told me to delete my most-used agent." Trust dies. The before/after numbers become suspect.

**Prevention:**
1. Show "last invoked" date in the ghost table -- show WHEN it was last used, not just ghost/not ghost
2. Display the `--since` window prominently in every output: "Ghosts (no invocations in last 7 days)"
3. Consider a "likely ghost" vs "definite ghost" tier (e.g., >30d = definite, 7-30d = likely)
4. For the viral before/after numbers: calculate "tokens loaded per session" vs "tokens from items invoked at least once in any session" -- this is a lifetime metric, not windowed
5. Never show "you could save X tokens" based on a windowed ghost count alone

**Detection:** Compare ghost lists across different `--since` values in tests. Manual QA with real user data.

**Phase:** v1.0 -- the ghost detection algorithm and its presentation must be trustworthy from day one.

**Severity:** HIGH -- false positive ghosts = viral mechanic dies.

**Confidence:** HIGH -- logical analysis of the observation window problem.

---

### Pitfall H2: Token Cost Estimates Are Guesses (and Users Will Quote Them as Facts)

**What goes wrong:** The `mcp-token-estimates.json` starts with engineering guesses. Users will take these as authoritative: "ccaudit says my GitHub MCP costs 15k tokens." If the real number is 8k or 30k, the tool's credibility collapses. Blog posts cite wrong numbers. Someone measures actual tokens and posts "ccaudit's numbers are 3x off."

**Why it happens:** There is no public API to query "how many tokens does this MCP server's tool manifest consume." The only way to know is to count tokens from the actual tool definitions sent in the system prompt, which requires a live MCP connection and a tokenizer.

**Consequences:** Blog posts and tweets cite wrong numbers. Users make decisions based on bad data. Competitors point out the inaccuracy.

**Prevention:**
1. Label ALL estimates with `~` prefix everywhere: "~15k tokens (estimated)"
2. Add a confidence indicator per estimate: "measured" vs "estimated" vs "community-reported"
3. Implement `ccaudit mcp --live` in v1.0 (not deferred) to give users a way to get real numbers
4. The `--live` numbers should auto-correct the estimates file via `ccaudit contribute`
5. Show methodology: "Estimates based on typical tool definition sizes. Run `ccaudit mcp --live` for exact counts."
6. Never show a single "you waste X tokens" total without qualifying it as estimated

**Detection:** Compare `--live` results against estimates for all popular MCP servers. Track and publish drift.

**Phase:** v1.0 must clearly label estimates. `--live` should be a v1.0 feature, not deferred.

**Severity:** HIGH -- inaccurate numbers = credibility death for a tool whose value proposition IS the numbers.

**Confidence:** MEDIUM -- the severity is certain, but actual accuracy of estimates is unknown until measured.

---

### Pitfall H3: JSONL Schema Evolution Breaks Parser Silently

**What goes wrong:** Claude Code's JSONL schema is undocumented and changes without notice. A Claude Code update could rename `tool_use` to `tool_call`, change the `isSidechain` field, alter the MCP naming convention from `mcp__<server>__<tool>`, or add new message types. ccaudit would silently produce wrong results rather than failing loudly.

**Why it happens:** The JSONL format is an internal implementation detail of Claude Code, not a public API. Anthropic has no obligation to maintain backward compatibility. Known changes/issues:
- Cross-session contamination (issue #26964): records from other sessions bleed into JSONL files
- Subagent compaction (issue #16944): `compactMetadata` and `preTokens` fields added without documentation
- Session continuation format: prefix records from parent sessions have different sessionId than filename
- Desktop import failure when first JSONL line has no `cwd` (issue #41723)

**Consequences:** ccaudit reports zero invocations for an agent that was used 50 times (because the field name changed). Or ccaudit crashes on a new JSONL line format. Either way, the ghost count is wrong and the viral numbers are unreliable.

**Prevention:**
1. Valibot `safeParse` with explicit schemas -- every field access goes through validation
2. Use `v.looseObject()` for top-level JSONL line schema -- accept extra fields silently
3. Log (do not throw) when a JSONL line fails validation -- count skipped lines
4. Report skip rate in output: "Parsed 1,247 sessions (3 lines skipped)"
5. If skip rate exceeds threshold (>10%), warn loudly: "Many session records could not be parsed. ccaudit may need an update for your Claude Code version."
6. Pin critical field expectations (`type: 'tool_use'`, `name` presence) but be lenient on everything else
7. Integration tests against real JSONL samples from multiple Claude Code versions
8. Monitor Claude Code changelog for format changes

**Detection:** Skip rate monitoring. Integration tests with JSONL fixtures from different CC versions.

**Phase:** v1.0 -- foundational. Parser resilience must be there from the start.

**Severity:** HIGH -- silent wrong results are worse than crashing.

**Confidence:** HIGH -- confirmed by documented JSONL format changes in Claude Code issues.

---

### Pitfall H4: npx Cache Serves Stale Version

**What goes wrong:** Users run `npx ccaudit` (without `@latest`) and get a cached old version. The old version may have known bugs, wrong token estimates, or incompatible JSONL parsing. Users file issues against the current version that cannot be reproduced.

**Why it happens:** npx caches packages in `~/.npm/_npx/`. Once cached, subsequent `npx ccaudit` invocations use the cache, not the registry. This is a long-standing npm issue (npm/cli#4108, npm/rfcs#700) with no fix planned. ccusage explicitly recommends `@latest` suffix.

**Consequences:** Support burden. Users report bugs fixed 3 versions ago. Token estimates diverge from published values. The "run with npx" zero-install promise becomes a footgun.

**Prevention:**
1. README prominently shows `npx ccaudit@latest` (not `npx ccaudit`)
2. Add a version check on startup: compare running version against npm registry latest -- warn if stale
3. Print version in every output header: `ccaudit v1.2.3 (latest: v1.2.5 -- run npx ccaudit@latest)`
4. Recommend `bunx ccaudit` as alternative (bunx handles caching better, per ccusage's experience)
5. Issue template asks for `ccaudit --version` output

**Detection:** Version check on startup (HTTP GET to npm registry, with timeout fallback to skip silently).

**Phase:** v1.0 -- the version warning should ship from day one.

**Severity:** HIGH -- stale versions produce wrong results and untraceable bug reports.

**Confidence:** HIGH -- confirmed by ccusage's experience and npm/cli issues.

---

### Pitfall H5: Shebang Missing from Built Binary

**What goes wrong:** `npx ccaudit` fails with "cannot execute" or runs as a non-executable file. On Unix, the file lacks `#!/usr/bin/env node`. On Windows, npm's `.cmd` wrapper fails to find the entry point.

**Why it happens:** tsdown does NOT add shebangs automatically (unlike tsup which has `--shims`). You must use `outputOptions.banner`.

**Consequences:** Zero-install distribution completely broken. Users see cryptic errors on first run.

**Prevention:**
1. `outputOptions: { banner: '#!/usr/bin/env node\n' }` in tsdown.config.ts
2. `bin: { "ccaudit": "./dist/index.js" }` in package.json
3. CI test: `node dist/index.js --help` must exit 0 after build
4. `npm pack --dry-run` and inspect tarball structure

**Detection:** CI step that runs the built binary with `--help`.

**Phase:** Scaffold phase -- must be correct from first build.

**Severity:** HIGH -- completely prevents usage if broken.

**Confidence:** HIGH -- known tsdown limitation.

---

## Medium (Quality Issues)

Pitfalls that would create bad UX, inaccurate results, or angry GitHub issues.

### Pitfall M1: Cross-Session Contamination in JSONL

**What goes wrong:** Claude Code has a confirmed bug (issue #26964) where JSONL entries from one session bleed into another session's file when multiple sessions are active in the same project. ccaudit may count the same tool invocation twice or attribute it to the wrong project.

**Prevention:**
1. Deduplicate by `uuid` field -- each JSONL record has a unique `uuid`
2. Verify `sessionId` matches the filename's session UUID for each record
3. For session continuations: records at the START of a file with a different `sessionId` are prefix copies from the parent session -- handle explicitly per the session continuation spec (these carry the parent's `sessionId`)

**Phase:** v1.0 -- parser must handle this.

**Severity:** MEDIUM -- produces inaccurate counts but not dangerous.

**Confidence:** HIGH -- confirmed by Claude Code issue #26964.

---

### Pitfall M2: Subagent Sessions in Nested Directory Structure

**What goes wrong:** Subagent sessions (`isSidechain=true`) are stored in `subagents/` subdirectories. If ccaudit only scans top-level session files, it misses all subagent invocations, underreporting usage and creating false positive ghosts.

**Prevention:**
1. Glob pattern must include subdirectories: `**/*.jsonl` not `*.jsonl`
2. Parse `isSidechain` field to properly attribute subagent invocations
3. Test with real session data that includes subagent usage

**Phase:** v1.0 -- missing subagent data means wrong ghost counts.

**Severity:** MEDIUM -- underreports usage, creating false positive ghosts.

**Confidence:** HIGH -- confirmed from JSONL schema and project context.

---

### Pitfall M3: Memory File "Staleness" Heuristic Is Misleading

**What goes wrong:** PROJECT.md defines stale memory files by "no recent modification (mod-date heuristic)." A CLAUDE.md file written once and never changed is not "stale" -- it is loaded every session and may be essential. Modification date does not indicate usage because Claude Code reads CLAUDE.md automatically at session start without logging a tool_use event.

**Consequences:** ccaudit flags a critical CLAUDE.md as "stale" because it was written 6 months ago. User follows recommendation and disables it. Claude Code sessions lose all project context.

**Prevention:**
1. CLAUDE.md and rules/ files should NEVER appear in the "ghost" category -- they have no invocation signal
2. Show them in a separate "always loaded" category with token cost and last-modified date
3. Let users make their own judgment -- do not recommend disabling them
4. Clearly explain: "These files are loaded every session. No usage signal is available."

**Phase:** v1.0 -- categorization must be correct from the start.

**Severity:** MEDIUM -- flagging essential config as "stale" damages trust and could cause user to disable important context.

**Confidence:** HIGH -- there is no JSONL signal for CLAUDE.md reads, confirmed by schema analysis.

---

### Pitfall M4: Hash-Based Checkpoint TOCTOU Window

**What goes wrong:** The dry-run checkpoint captures a hash of agents/skills/settings directories. Between dry-run and `--dangerously-bust-ghosts`, the user (or Claude Code) may add/remove/modify files. The hash comparison at bust time may pass against the stored checkpoint even though actual files changed.

**Prevention:**
1. Re-hash at the START of `--dangerously-bust-ghosts`, compare against stored checkpoint
2. If re-hash differs: abort with "Your inventory has changed since the dry-run. Please re-run --dry-run first."
3. This minimizes the TOCTOU window to milliseconds between hash computation and first file move

**Phase:** v1.1 (checkpoint design) and v1.2 (enforcement).

**Severity:** MEDIUM -- unlikely in practice but consequences are confusing when it happens.

**Confidence:** HIGH -- TOCTOU is a well-understood filesystem race condition pattern.

---

### Pitfall M5: The `--dangerously-bust-ghosts` Flag Is Too Fun to Auto-Trigger

**What goes wrong:** The flag name is designed to be viral and shareable. But if the confirmation can be mashed through (three "y" presses), users who copy commands from Twitter/HN paste and confirm reflexively.

**Prevention:**
1. Triple confirmation must include DIFFERENT inputs, not just "y" three times
2. Require typing a specific phrase: "I accept full responsibility" (as in PROJECT.md)
3. Show a summary of what will be changed DURING confirmation, not just before it
4. Add a mandatory 3-second pause between confirmations (not skippable via piping)
5. `--yes` / `--force` flags must NOT exist for this command
6. Detect if stdin is not a TTY (piped input) and refuse to proceed -- prevent scripted confirmation bypass

**Phase:** v1.2 -- confirmation UX design.

**Severity:** MEDIUM -- the checkpoint hash gate prevents the worst case, but poor confirmation UX still creates angry users.

**Confidence:** HIGH -- UX design principle.

---

### Pitfall M6: Windows Path Handling

**What goes wrong:** Path separator mismatches cause file discovery to fail on Windows, or JSONL `cwd` field comparison fails because one path uses `\` and the other uses `/`. Also: `fs.rename` on Windows can fail with EPERM due to antivirus file locks (Windows Defender real-time scanning).

**Prevention:**
1. Use `path.join()` for filesystem ops, `path.posix.join()` for glob patterns
2. Normalize JSONL `cwd` values with `path.normalize()` before comparison
3. Use `os.homedir()` instead of `process.env.HOME` (Windows uses `USERPROFILE`)
4. For v1.2 remediation on Windows: add retry logic for EPERM on rename (exponential backoff, 3 retries)
5. Consider `windows-latest` in CI matrix

**Phase:** v1.0 (path handling) and v1.2 (Windows rename retries).

**Severity:** MEDIUM -- Windows users are a meaningful segment of Claude Code users.

**Confidence:** MEDIUM -- confirmed by Node.js issues (#29481 EPERM on Windows).

---

### Pitfall M7: XDG vs Legacy Path Discovery Incomplete

**What goes wrong:** ccaudit must scan both `~/.claude/` (legacy) and `~/.config/claude/` (XDG). If it only checks one, it misses sessions from users who have migrated or have a split configuration.

**Prevention:**
1. Always scan BOTH paths
2. Deduplicate by session ID (same sessionId = same session, regardless of path)
3. Check for symlinks (`fs.lstat` + `fs.readlink`) -- one path may symlink to the other
4. Handle the case where either path does not exist gracefully

**Phase:** v1.0 -- path discovery is foundational.

**Severity:** MEDIUM -- incomplete data, only affects users on specific path configurations.

**Confidence:** MEDIUM -- XDG migration status not fully documented by Anthropic.

---

### Pitfall M8: Per-Project MCP Scope in ~/.claude.json

**What goes wrong:** `~/.claude.json` stores MCP servers at both root level (global) AND per-project (`projects.<encoded-path>.mcpServers`). ccaudit may only check root-level `mcpServers` and miss project-scoped servers, or vice versa.

**Prevention:**
1. Parse both `mcpServers` (root) and `projects.<path>.mcpServers` in `~/.claude.json`
2. For ghost detection: match invocations against the correct scope (global vs project-specific)
3. For remediation: disable servers at the correct scope level

**Phase:** v1.0 (read) and v1.2 (write).

**Severity:** MEDIUM -- edge case for users with project-scoped MCP configs in the global file.

**Confidence:** MEDIUM -- confirmed by docs but exact nested schema needs verification against real files.

---

### Pitfall M9: import.meta.vitest Not Stripped in Production

**What goes wrong:** In-source test code ships in the published bundle, increasing size and potentially exposing test utilities.

**Prevention:**
1. Configure tsdown to define `import.meta.vitest` as `undefined` (enables dead code elimination)
2. Verify bundle size in CI -- sudden size increase = test code leaked
3. Check built `dist/index.js` for vitest imports as CI step

**Phase:** Scaffold phase -- configure once, verify always.

**Severity:** MEDIUM -- bloated bundle, not dangerous but embarrassing.

**Confidence:** HIGH -- known vitest in-source testing concern.

---

### Pitfall M10: Workspace Package References in Published Tarball

**What goes wrong:** Published package.json contains `"@ccaudit/internal": "workspace:*"` which npm cannot resolve. Users get install errors.

**Prevention:**
1. `clean-pkg-json` in prepack strips workspace references
2. tsdown bundles workspace packages into output -- they must NOT appear in published deps
3. CI: `npm pack --dry-run` and grep for `workspace:` -- fail if found

**Phase:** Every release.

**Severity:** MEDIUM -- prevents installation entirely if broken.

**Confidence:** HIGH -- well-known pnpm workspace pitfall.

---

## Low (Nice to Know)

### Pitfall L1: Large JSONL Files Cause Memory Pressure

**What goes wrong:** Power users may have JSONL files that are hundreds of MB. Loading entire files into memory causes OOM.

**Prevention:** Stream-parse with `node:readline` async generators (constant memory). Never `readFileSync` + `split('\n')`. Early-exit: if session's first timestamp is outside `--since` window, skip entire file.

**Phase:** v1.0 -- parser implementation.

**Severity:** LOW -- only affects power users with very large session histories.

---

### Pitfall L2: Timezone-Dependent Test Failures

**What goes wrong:** Tests pass locally but fail in CI because `--since 7d` date calculations depend on timezone.

**Prevention:** `TZ=UTC vitest` in package.json scripts. Use UTC internally for all date comparisons. Parse `--since` relative to UTC.

**Phase:** v1.0 -- test configuration.

**Severity:** LOW -- annoying CI failures, not user-facing.

---

### Pitfall L3: MCP Server Name Parsing Edge Cases

**What goes wrong:** Tool name `mcp__server-with-dashes__tool_name` splits incorrectly if server or tool name contains double underscores.

**Prevention:** Split on first two `__` only: `const [, server, tool] = name.split('__', 3)`. Fixture tests for edge cases including servers with hyphens, numbers, and unusual characters.

**Phase:** v1.0 -- MCP detection.

**Severity:** LOW -- edge case but easy to handle.

---

### Pitfall L4: `_archived/` Directory Name Collision

**What goes wrong:** User already has an `_archived/` directory in their agents/ folder. ccaudit overwrites or conflicts.

**Prevention:** Use a ccaudit-specific archive directory (e.g., `.ccaudit-archive/`). Check for existing files before moving. Never overwrite -- append timestamp suffix if collision detected.

**Phase:** v1.2 -- archive implementation.

**Severity:** LOW -- unlikely but easy to prevent.

---

### Pitfall L5: gunshi Breaking Changes

**What goes wrong:** gunshi is pre-1.0 (0.29.x). API may change between minor versions.

**Prevention:** Pin to `^0.29.x` in catalog. Check changelog before upgrading. In-source tests cover command definitions.

**Phase:** Scaffold phase and ongoing.

**Severity:** LOW -- contained risk, only affects CLI definition layer.

---

### Pitfall L6: npx Stale Cache -- Windows-Specific Path

**What goes wrong:** On Windows the npx cache lives at `%LocalAppData%/npm-cache/_npx`. The "clear your cache" troubleshooting advice that references `~/.npm/_npx` does not work on Windows.

**Prevention:** Document platform-specific cache clearing in troubleshooting FAQ. Consider a `ccaudit --clear-cache` helper.

**Phase:** Post-v1.0 -- documentation.

**Severity:** LOW -- support friction, not functional.

---

## Recommended Mitigations Per Phase

### Scaffold Phase

| Pitfall | Mitigation | Priority |
|---------|-----------|----------|
| C5: Runtime deps leak | Zero `dependencies`, CI check with `npm pack --dry-run` | P0 |
| H5: Shebang missing | `outputOptions.banner` in tsdown config, CI test | P0 |
| M9: vitest in production | Define `import.meta.vitest` as `undefined` in build | P1 |
| M10: Workspace refs in tarball | `clean-pkg-json` + CI grep | P1 |
| L5: gunshi breaking changes | Pin version in pnpm catalog | P2 |

### v1.0 -- Analysis (Read-Only)

| Pitfall | Mitigation | Priority |
|---------|-----------|----------|
| C1: MCP config location | Read from `~/.claude.json` and `.mcp.json`, NOT `settings.json` | P0 |
| H1: False positive ghosts | Show last-invoked date, qualify `--since` window in all output | P0 |
| H2: Token estimates | Label with `~`, show "estimated" vs "measured", ship `--live` | P0 |
| H3: JSONL schema evolution | valibot safeParse, skip rate monitoring, looseObject schemas | P0 |
| H4: npx stale cache | Version check on startup, recommend `@latest` | P1 |
| M1: Cross-session contamination | Deduplicate by uuid, verify sessionId matches filename | P1 |
| M2: Subagent sessions | Recursive glob `**/*.jsonl` | P1 |
| M3: Memory file heuristic | Separate "always loaded" category, never flag as ghost | P1 |
| M6: Windows paths | Normalize paths, test with Windows-format paths | P1 |
| M7: XDG + legacy paths | Scan both, deduplicate by sessionId | P1 |
| M8: Per-project MCP scope | Parse nested `projects.<path>.mcpServers` | P2 |
| L1: Large files | Stream-parse with readline | P1 |
| L2: Timezone tests | `TZ=UTC vitest` | P2 |
| L3: MCP name parsing | Split with limit of 3 | P2 |

### v1.1 -- Dry-Run

| Pitfall | Mitigation | Priority |
|---------|-----------|----------|
| M4: TOCTOU checkpoint | Hash at dry-run, re-hash at bust, abort on mismatch | P0 |

### v1.2 -- Remediation

| Pitfall | Mitigation | Priority |
|---------|-----------|----------|
| C2: Comment-out impossible | Use `_disabled_mcpServers` pattern, not JSON comments | P0 |
| C3: Non-atomic archive | Manifest-first with completion marker, SIGINT handler | P0 |
| C4: Concurrent Claude Code | Detect running CC, refuse to mutate, atomic writes | P0 |
| M4: TOCTOU re-hash | Re-hash at start of bust, abort on mismatch | P0 |
| M5: Confirmation UX | Typed phrase, mandatory pauses, no `--yes` flag, TTY check | P1 |
| M6: Windows rename | Retry logic for EPERM with exponential backoff | P1 |
| L4: Archive directory collision | ccaudit-specific directory name, collision detection | P2 |

---

## Sources

### Official Documentation (HIGH confidence)
- [Claude Code Settings](https://code.claude.com/docs/en/settings) -- Configuration scopes, file locations, MCP server storage locations
- [Claude Code MCP](https://code.claude.com/docs/en/mcp) -- MCP server configuration, disable/enable patterns
- [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) -- Schema and feature changes
- [Valibot safeParse](https://valibot.dev/api/safeParse/) -- Non-throwing validation API

### Claude Code GitHub Issues (HIGH confidence, confirmed bugs)
- [#1506](https://github.com/anthropics/claude-code/issues/1506) -- Invalid JSON causing startup crash
- [#2835](https://github.com/anthropics/claude-code/issues/2835) -- Silent failure on malformed settings.json
- [#26964](https://github.com/anthropics/claude-code/issues/26964) -- JSONL cross-session contamination
- [#28842](https://github.com/anthropics/claude-code/issues/28842) -- .claude.json corruption from concurrent writes
- [#29217](https://github.com/anthropics/claude-code/issues/29217) -- Race condition on .claude.json
- [#29370](https://github.com/anthropics/claude-code/issues/29370) -- JSONC support request (not implemented)
- [#33650](https://github.com/anthropics/claude-code/issues/33650) -- settings.local.json corrupted by unescaped content
- [#41723](https://github.com/anthropics/claude-code/issues/41723) -- Desktop fails when first JSONL line has no cwd
- [#16944](https://github.com/anthropics/claude-code/issues/16944) -- Undocumented subagent compaction fields

### npm/npx Cache Issues (HIGH confidence)
- [npm/cli#4108](https://github.com/npm/cli/issues/4108) -- npx not using latest version
- [npm/rfcs#700](https://github.com/npm/rfcs/issues/700) -- npx not getting latest version (confirmed wontfix)
- [ccusage installation guide](https://ccusage.com/guide/installation) -- recommends `@latest` suffix

### Node.js Filesystem Safety (HIGH confidence)
- [write-file-atomic](https://github.com/npm/write-file-atomic) -- Atomic write pattern reference
- [Node.js #29481](https://github.com/nodejs/node/issues/29481) -- EPERM on Windows with fs.rename
- [Node.js fs docs](https://nodejs.org/api/fs.html) -- rename atomicity guarantees

### Reference Implementations (MEDIUM confidence)
- [ccusage architecture](https://deepwiki.com/ryoppippi/ccusage) -- JSONL parsing patterns, zero-dep bundling
- [ccusage data processing](https://deepwiki.com/ryoppippi/ccusage/4.1-data-processing) -- Error handling approach (safeParse, Result type)

### General References (MEDIUM confidence)
- [TOCTOU - Wikipedia](https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use) -- Race condition pattern
- [json5/json5#177](https://github.com/json5/json5/issues/177) -- Comments not preserved on parse/stringify
- [clig.dev](https://clig.dev/) -- CLI UX conventions

---

**Confidence:** HIGH

The five Critical pitfalls (C1-C5) are verified against official Claude Code documentation and confirmed GitHub issues. The five High-severity pitfalls (H1-H5) are well-understood failure modes specific to this project's domain. Medium and Low pitfalls are a mix of confirmed issues and defensive engineering recommendations.

**Single most important finding:** C1+C2 together reveal that the PROJECT.md's remediation strategy of "comment-out MCP servers in settings.json" is fundamentally wrong on two independent axes -- wrong file (`settings.json` vs `~/.claude.json`) and wrong mechanism (JSON comments vs `_disabled_mcpServers` pattern). This must be corrected in the project plan before any remediation code is written.

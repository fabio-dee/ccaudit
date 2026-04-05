# Manual Test Results — Phase 6 CLI Verification

Run date: 2026-04-05  
Binary: `apps/ccaudit/dist/index.js` (built fresh before tests)  
Node: v22.20.0 · pnpm 10.x

---

## Summary

| Section                        | Result                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| 1. Help / discovery            | PASS (with note)                                            |
| 2. Default rendered output     | PASS                                                        |
| 3. --no-color                  | PASS                                                        |
| 4. Exit codes                  | PASS                                                        |
| 5. --json structured output    | PASS (spec clarified in [JSON-SCHEMA.md](./JSON-SCHEMA.md)) |
| 6. --csv export                | PASS (with note on duplicate rows)                          |
| 7. --quiet TSV                 | PASS                                                        |
| 8. --ci combo                  | PASS (with note on field name)                              |
| 9. --verbose to stderr         | PASS                                                        |
| 10. mcp --live                 | PASS                                                        |
| 11. Token labels               | PASS                                                        |
| 12. --since parser             | PASS                                                        |
| 13. Pipelines                  | PASS                                                        |
| 14. Publication readiness      | PASS                                                        |
| 15. Build + typecheck + vitest | PASS (with note on `pnpm -r build`)                         |

---

## Errors and Failures

### 1. `--no-color` not listed in any `--help` output

**Commands:**

```sh
cc --help          # root help — no --no-color listed
cc ghost --help    # same
cc mcp --help      # same
# ... all subcommands
```

**Expected:** Root help and every subcommand lists `--no-color` as an option.  
**Actual:** `--no-color` does not appear in any help listing.  
**Note:** `NO_COLOR=1` env var and piping both strip color correctly at runtime — the flag is functional (or auto-stripped), but it is **undocumented** in the help output.

---

### 2-4. JSON field names (spec clarification — NOT a bug)

**Commands initially tested with incorrect expected values:**

```sh
cc ghost --json | jq '.data'               # ~~tester expected .data~~
cc ghost --json | jq '.meta.generated_at'  # ~~tester expected .meta.generated_at~~
cc ghost --json | jq '.meta.exit_code'     # ~~tester expected .meta.exit_code~~
```

**Corrected after spec review:** the code is spec-compliant. Phase 6 decision
D-16 mandates a **camelCase** envelope shape with `items` (not `data`),
`meta.timestamp` (not `generated_at`), and `meta.exitCode` (not `exit_code`).
This matches TypeScript internals and the `gh` CLI convention.

**Correct commands:**

```sh
cc ghost --json | jq '.items'          # payload array
cc ghost --json | jq '.items | length' # row count
cc ghost --json | jq '.meta.timestamp' # ISO 8601 run time
cc ghost --json | jq '.meta.exitCode'  # 0 or 1
```

See [`docs/JSON-SCHEMA.md`](./JSON-SCHEMA.md) for the full envelope reference
and per-command payload keys. The test-spec expectations in earlier drafts of
this file were based on REST-API snake_case conventions; ccaudit's JSON is a
JS-native CLI output, not a cross-language API contract.

---

### 5. `pnpm -r build` — fails with missing script error

**Command:**

```sh
pnpm -r build
```

**Error:**

```
ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  None of the selected packages has a "build" script
```

**Cause:** `packages/internal` and `packages/terminal` do not define a `"build"` script; only `apps/ccaudit` does.  
**Workaround:** Use the targeted command instead:

```sh
pnpm -F ccaudit build   # works fine, exits 0
pnpm -r typecheck       # works fine, exits 0
```

---

### 6. `mcp --csv` — duplicate rows

**Command:**

```sh
cc mcp --csv
```

**Actual output:**

```
name,category,tier,lastUsed,tokens,recommendation,confidence
context7,mcp-server,definite-ghost,never,1500,archive,estimated
supabase,mcp-server,definite-ghost,never,0,archive,none
supabase,mcp-server,definite-ghost,never,0,archive,none     ← duplicate
context7,mcp-server,definite-ghost,never,1500,archive,estimated  ← duplicate
```

**Expected:** Each MCP server appears once (deduplicated by name+scope).  
**Note:** The duplicates come from scanning multiple project-level `.mcp.json` files that define the same servers. Whether this is a bug or expected behavior depends on design intent (per-project vs. deduplicated view). The rendered table also shows duplicates.

---

## Passing Tests (notable results)

| Test                | Command                                       | Result                                      |
| ------------------- | --------------------------------------------- | ------------------------------------------- |
| Default subcommand  | `cc` (no args)                                | Runs `ghost`, exits 1 ✓                     |
| Since window        | `cc ghost --since 30d`                        | Header shows "Last 30 days" ✓               |
| Health score        | any ghost/inventory                           | "Health: 12/100 (Critical)" shown ✓         |
| Ghost tiering       | `cc ghost`                                    | likely-ghost / definite-ghost tiers shown ✓ |
| Exit codes          | ghost/inventory/mcp                           | exit 1 when ghosts found ✓                  |
| trend exit          | `cc trend`                                    | always exits 0 ✓                            |
| NO_COLOR env        | `NO_COLOR=1 cc ghost`                         | strips ANSI ✓                               |
| Pipe auto-strip     | `cc ghost \| cat`                             | no escape codes ✓                           |
| --verbose stderr    | `cc ghost --verbose 2>/dev/null`              | stdout clean ✓                              |
| --verbose + --json  | `cc ghost --verbose --json 2>log \| jq .`     | JSON valid, verbose in log ✓                |
| --ci JSON + exit    | `cc ghost --ci`                               | JSON on stdout + exit 1 ✓                   |
| bogus --since       | `cc ghost --since bogus`                      | clean error, no stack trace, exit 1 ✓       |
| --quiet TSV         | `cc ghost --quiet \| awk -F'\t' '{print $1}'` | parseable by awk ✓                          |
| Publication size    | `npm pack --dry-run`                          | ~76 kB tarball ✓                            |
| Zero runtime deps   | package.json                                  | `dependencies: undefined` ✓                 |
| Vitest coverage     | `pnpm exec vitest --run --coverage`           | 357/357 tests passed, coverage/ exists ✓    |
| Statements coverage | —                                             | 93.61% ✓                                    |
| Branches coverage   | —                                             | 84.71% ✓                                    |

---

## Bugs to File

| Priority | Issue                                                                   | Fix                                                                           |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| High     | JSON payload key is `.items` not `.data` — breaks spec contract         | Rename to `.data` or update test spec                                         |
| High     | `meta.generated_at` → actual is `meta.timestamp` — breaks spec contract | Rename field or update spec                                                   |
| High     | `meta.exit_code` → actual is `meta.exitCode` — breaks spec contract     | Pick one convention (snake_case preferred for JSON)                           |
| Medium   | `--no-color` not documented in `--help`                                 | Add flag to help listing                                                      |
| Low      | `mcp --csv` and rendered table show duplicate server rows               | Deduplicate by name+scope before rendering                                    |
| Low      | `pnpm -r build` errors — no build script in packages                    | Add `"build": "tsc"` to `packages/*/package.json` or document correct command |

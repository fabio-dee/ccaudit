# Phase 4: Token Cost Attribution - Research

**Researched:** 2026-04-04
**Domain:** Token estimation, MCP protocol (JSON-RPC 2.0 over stdio), bundled data files, context window measurement
**Confidence:** HIGH (core estimation logic), MEDIUM (live MCP measurement)

## Summary

Phase 4 enriches every `ScanResult` from Phase 3 with a token cost estimate. The primary mechanism is a bundled `mcp-token-estimates.json` lookup file containing community-maintained per-item token costs, with a confidence tier label on every number. The secondary mechanism is `ccaudit mcp --live`, which spawns each configured MCP server as a child process, performs the MCP `tools/list` JSON-RPC call, and counts the tokens in the returned tool definitions.

The key insight from research is that token costs for ghost items fall into distinct categories with different estimation approaches: (1) MCP servers -- tool definitions injected into context, measurable via `tools/list`; (2) agents -- markdown content loaded into system prompt, estimable by file size; (3) skills -- SKILL.md loaded on-demand (only description + trigger info in context at start); (4) memory files -- CLAUDE.md and rules loaded verbatim into context, estimable by file size. The `mcp-token-estimates.json` handles MCP servers (the most variable category); agents, skills, and memory files can be estimated from file size using a ~4 chars/token heuristic for English text.

**Primary recommendation:** Implement a `TokenEstimator` module in `packages/internal/` that enriches `ScanResult[]` with token costs from three sources: (1) file-size heuristic for agents/skills/memory, (2) `mcp-token-estimates.json` lookup for MCP servers, (3) live measurement via minimal JSON-RPC client for `--live`. All estimates carry `ConfidenceTier` and display with `~` prefix. The `--live` flag spawns MCP servers directly using `node:child_process` (no SDK dependency).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TOKN-01 | Per-item token cost estimated from embedded `mcp-token-estimates.json` (community-maintained, bundled at build) | JSON import natively supported by tsdown/rolldown. Schema designed below. Lookup function maps server name to token estimate. |
| TOKN-02 | All estimates labeled with `~` prefix everywhere ("~15k tokens (estimated)") -- never bare numbers | Formatting function in token-estimator module. Prefix applied at data layer, not just display. |
| TOKN-03 | Confidence tier shown per estimate: "estimated" / "measured" / "community-reported" | `ConfidenceTier` type already exists in `types.ts`. Attached to every `TokenEstimate` result. |
| TOKN-04 | `ccaudit mcp --live` connects to running MCP servers for exact token count (ships v1.0) | MCP protocol is JSON-RPC 2.0 over stdio. Minimal client implementation using `node:child_process` -- no SDK needed. Spawn server, send `initialize` + `tools/list`, count tokens in response. |
| TOKN-05 | Total ghost overhead calculated and displayed as both token count and percentage of 200k context window | Sum all ghost item token costs. Divide by 200,000 for percentage. Display in summary line. |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

### Locked Decisions (from PROJECT.md / STATE.md)
- All token estimates labeled `~` with confidence tier (research C5)
- `--live` ships in v1.0 (Phase 4), not deferred (research C5)
- Zero runtime dependencies -- all deps as devDependencies, bundled by tsdown
- Tech stack: TypeScript/Node, gunshi CLI, valibot, cli-table3, tsdown, vitest in-source tests
- Monorepo: `packages/internal/` for shared logic, `apps/ccaudit/` for CLI

### Existing Architecture Decisions
- `ConfidenceTier` type already defined in `packages/internal/src/types.ts`: `'estimated' | 'measured' | 'community-reported'`
- `ScanResult` interface holds `item`, `tier`, `lastUsed`, `invocationCount` -- needs extension with token cost
- MCP server config is read from `~/.claude.json` + `.mcp.json` (already implemented in `scan-mcp.ts`)
- `readClaudeConfig()` already parses the config and returns `ClaudeConfig` with `mcpServers` entries

### What NOT to Use
- `@modelcontextprotocol/sdk` -- pulls in zod, express, hono, cors, jose, ajv (60+ transitive deps). Violates zero-dep constraint.
- zod -- CLAUDE.md explicitly forbids it; project uses valibot
- Any external tokenizer library -- use file-size heuristic (chars/4) for estimates, only Anthropic's API for measured values

## Standard Stack

### Core (No New Dependencies)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:child_process` | Node 20+ built-in | Spawn MCP servers for `--live` | Zero deps, already available |
| `node:readline` | Node 20+ built-in | Read newline-delimited JSON-RPC responses from MCP stdio | Already used in JSONL parser |
| `node:fs/promises` | Node 20+ built-in | Read agent/skill/memory files for size-based estimation | Already used throughout |
| JSON import | tsdown built-in | Bundle `mcp-token-estimates.json` into output | Rolldown natively handles `.json` imports with tree-shaking |

### Already In Stack (used by this phase)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| valibot | ^1.3.x | Validate `mcp-token-estimates.json` schema at load | safeParse for JSON data validation |
| vitest | ^4.1.x | In-source tests for estimation logic | Test token estimator, JSON-RPC client |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw JSON-RPC client | `@modelcontextprotocol/sdk` | SDK brings 60+ transitive deps (zod, express, hono). ccaudit only needs `initialize` + `tools/list` -- two JSON-RPC calls. Custom client is ~100 lines. |
| File-size heuristic | Anthropic `count_tokens` API | API requires auth key, rate limits, network. File-size/4 is accurate within 10-20% for English markdown. Label as "estimated" is honest. |
| Bundled JSON lookup | Runtime HTTP fetch of estimates | Offline-first matters. Zero network dependency. File bundled at build time. |

**Installation:** No new packages required. All functionality uses Node built-ins and existing stack.

## Architecture Patterns

### Recommended Module Structure
```
packages/internal/
  src/
    token/
      index.ts                    # barrel export
      types.ts                    # TokenEstimate, TokenCostResult, McpTokenEntry
      estimate.ts                 # enrichScanResults(), estimateTokenCost()
      mcp-estimates-data.ts       # import + validate mcp-token-estimates.json
      file-size-estimator.ts      # estimateFromFileSize() -- chars/4 heuristic
      mcp-live-client.ts          # spawnMcpServer(), listTools(), measureTokens()
      format.ts                   # formatTokenEstimate() -- "~15k tokens (estimated)"
    data/
      mcp-token-estimates.json    # bundled community token data
```

### Pattern 1: Token Estimation Pipeline
**What:** A pipeline that takes `ScanResult[]` and returns `TokenCostResult[]` (ScanResult + token estimate).
**When to use:** After `scanAll()` completes, before report rendering.
**Example:**
```typescript
// packages/internal/src/token/types.ts
export interface TokenEstimate {
  /** Estimated token count */
  tokens: number;
  /** Confidence tier for this estimate */
  confidence: ConfidenceTier;
  /** Human-readable source description */
  source: string;
}

export interface TokenCostResult extends ScanResult {
  /** Token cost estimate for this item, null if unknown */
  tokenEstimate: TokenEstimate | null;
}

// packages/internal/src/token/estimate.ts
export async function enrichScanResults(
  results: ScanResult[],
  options?: { live?: boolean },
): Promise<TokenCostResult[]> {
  // 1. Load mcp-token-estimates.json (bundled)
  // 2. For each result:
  //    - MCP server: lookup in estimates data, or measure if --live
  //    - Agent/Skill/Memory: estimate from file size (fs.stat)
  // 3. Return enriched results
}
```

### Pattern 2: Minimal MCP JSON-RPC Client
**What:** A bare-bones MCP client that spawns a server process, performs initialization handshake, calls `tools/list`, and extracts tool definitions.
**When to use:** Only for `ccaudit mcp --live`.
**Example:**
```typescript
// packages/internal/src/token/mcp-live-client.ts
import { spawn } from 'node:child_process';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Spawn an MCP server, perform JSON-RPC initialize + tools/list,
 * return the raw tool definitions for token counting.
 */
export async function listMcpTools(
  config: McpServerConfig,
  timeoutMs?: number,
): Promise<McpToolDefinition[]> {
  // 1. spawn(config.command, config.args, { stdio: ['pipe', 'pipe', 'pipe'] })
  // 2. Send JSON-RPC initialize request
  // 3. Wait for initialize response
  // 4. Send initialized notification
  // 5. Send tools/list request
  // 6. Parse tools/list response
  // 7. Kill child process
  // 8. Return tool definitions
}
```

### Pattern 3: File-Size Token Heuristic
**What:** Estimate tokens from file byte size using ~4 bytes per token for English markdown.
**When to use:** For agents (full .md content loaded), skills (SKILL.md description only), and memory files (full content loaded).
**Example:**
```typescript
// packages/internal/src/token/file-size-estimator.ts
const BYTES_PER_TOKEN = 4; // Conservative for English markdown

export async function estimateFromFileSize(
  filePath: string,
): Promise<TokenEstimate | null> {
  try {
    const stat = await fs.stat(filePath);
    const tokens = Math.ceil(stat.size / BYTES_PER_TOKEN);
    return {
      tokens,
      confidence: 'estimated',
      source: `file size (${stat.size} bytes / ${BYTES_PER_TOKEN} bytes per token)`,
    };
  } catch {
    return null; // File not accessible
  }
}
```

### Pattern 4: Bundled JSON Data File
**What:** Import `mcp-token-estimates.json` directly in TypeScript; tsdown/rolldown bundles it into the output.
**When to use:** Load community MCP token estimates at module initialization.
**Example:**
```typescript
// packages/internal/src/token/mcp-estimates-data.ts
import rawEstimates from '../data/mcp-token-estimates.json';
import * as v from 'valibot';

const McpEstimateSchema = v.object({
  name: v.string(),
  toolCount: v.number(),
  estimatedTokens: v.number(),
  confidence: v.picklist(['estimated', 'measured', 'community-reported']),
  lastUpdated: v.optional(v.string()),
  notes: v.optional(v.string()),
});

const EstimatesFileSchema = v.object({
  version: v.number(),
  generatedAt: v.string(),
  contextWindowSize: v.number(), // 200000
  entries: v.array(McpEstimateSchema),
});

// Validate at module load (fail fast if data is corrupt)
const parsed = v.safeParse(EstimatesFileSchema, rawEstimates);
if (!parsed.success) {
  throw new Error('Corrupt mcp-token-estimates.json: ' + JSON.stringify(parsed.issues));
}

const estimatesMap = new Map(
  parsed.output.entries.map(e => [e.name, e]),
);

export function lookupMcpEstimate(serverName: string) {
  return estimatesMap.get(serverName) ?? null;
}
```

### Anti-Patterns to Avoid
- **Bare numbers without confidence labels:** Every token number MUST have a `ConfidenceTier`. The formatting function must enforce the `~` prefix. Never expose raw numbers without context.
- **SDK-heavy MCP client:** Using `@modelcontextprotocol/sdk` would add 60+ transitive deps. MCP `tools/list` is two JSON-RPC 2.0 messages -- implement directly.
- **Async JSON import at runtime:** Bundle the JSON at build time via static import. Do not `readFile` at runtime.
- **Modifying ScanResult directly:** Create a new `TokenCostResult` that extends `ScanResult` rather than adding optional fields to the existing interface. Keeps Phase 3 types stable.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON schema validation | Custom validator | valibot `safeParse()` | Already in stack. Tree-shakeable. Catches corrupt estimates file. |
| Token counting (measured) | Custom tokenizer | Anthropic `count_tokens` API (future) or char-count heuristic | No local tokenizer for Claude's vocabulary exists. Char/4 is honest when labeled "estimated". |
| MCP server process lifecycle | Complex process manager | `node:child_process.spawn` + timeout | Two JSON-RPC calls, then kill. No need for keepalive or reconnection. |
| JSON-RPC framing | Protocol library | Manual JSON parse/stringify over stdio | MCP stdio uses newline-delimited JSON. Two messages out, two messages in. Trivial. |
| Number formatting | Custom formatter | Single function with rounding rules | "~15k", "~1.2k", "~350" -- simple rounding + prefix. |

**Key insight:** The MCP protocol is trivially simple for read-only operations. The `tools/list` call is a single JSON-RPC request/response pair (after initialization). Building a minimal client is far simpler than managing the SDK dependency tree.

## Common Pitfalls

### Pitfall 1: Token Estimates Quoted as Facts
**What goes wrong:** Users treat estimated numbers as precise measurements. Blog posts cite "ccaudit says my MCP costs 15k tokens" when the real number is 8k or 30k.
**Why it happens:** No public API for exact token counts. Estimates are inherently approximate.
**How to avoid:** (1) `~` prefix on EVERY number, (2) confidence tier label on every estimate, (3) `--live` available from v1.0 as verification path, (4) methodology note in output: "Estimates based on file size and community data. Run `ccaudit mcp --live` for exact counts."
**Warning signs:** Any display path that shows a bare number without `~` or confidence tier.

### Pitfall 2: MCP Server Spawn Hangs Forever
**What goes wrong:** `ccaudit mcp --live` spawns a server process that never responds (bad config, missing binary, permission error). The CLI hangs indefinitely.
**Why it happens:** MCP servers are user-configured. Bad commands, missing npx packages, expired tokens, network-dependent servers.
**How to avoid:** Hard timeout per server (default: 10 seconds). Kill child process on timeout. Report server as "unreachable" with a clear error message. Never block on a single server.
**Warning signs:** No timeout in the spawn logic. Using `execSync` instead of async spawn with timeout.

### Pitfall 3: JSON Import Not Bundled
**What goes wrong:** `mcp-token-estimates.json` exists at dev time but isn't included in the published `dist/` bundle. `npx ccaudit` fails at runtime with "cannot find module".
**Why it happens:** tsdown/rolldown may not automatically resolve JSON imports depending on configuration. The file might be in `packages/internal/src/data/` but not in the entry points.
**How to avoid:** (1) Use static `import` (not dynamic `require` or `readFile`), (2) Verify with `npm pack --dry-run` that the JSON data is included in the bundle, (3) Add a build-time test that imports the data and validates its schema.
**Warning signs:** Using `readFile` with `__dirname` or `import.meta.url` to load the JSON at runtime instead of static import.

### Pitfall 4: Double-Counting Tokens for MCP Servers
**What goes wrong:** Token count includes both the tool definition overhead AND the shared system prompt overhead that Claude adds per-tool. Reports inflated numbers like `/context` did before Anthropic fixed it.
**Why it happens:** Anthropic's `count_tokens` API counts per-tool system overhead separately. When summed, shared instructions are counted N times (once per tool).
**How to avoid:** For `--live`, count only the `tools/list` response content (tool names + descriptions + schemas). Do NOT multiply by a per-tool system overhead. Label clearly: "Token cost of tool definitions only."
**Warning signs:** Token counts that seem 2-3x higher than expected for a given number of tools.

### Pitfall 5: Category-Specific Estimation Confusion
**What goes wrong:** Applying MCP estimation logic to agents, or file-size logic to MCP servers.
**Why it happens:** Each category loads differently: MCP servers inject tool definitions, agents load file content, skills load on-demand (only description at start), memory files load verbatim.
**How to avoid:** Explicit per-category estimation strategy:
- **MCP servers:** Lookup `mcp-token-estimates.json` OR `--live` measurement
- **Agents:** File size / 4 (full .md content loaded into context)
- **Skills:** SKILL.md first ~50 lines / 4 (only description loaded, not full skill content)
- **Memory files:** File size / 4 (full content loaded into context)
**Warning signs:** A single `estimateTokens()` function that doesn't branch on `ItemCategory`.

### Pitfall 6: MCP Server Config Format Variance
**What goes wrong:** `--live` assumes all MCP servers use `stdio` transport, but some use `http` or `sse` endpoints. Spawning an HTTP server's URL as a command fails.
**Why it happens:** `~/.claude.json` has both `"type": "stdio"` (spawn process) and `"type": "http"` (connect to URL) server configs.
**How to avoid:** Check the `type` field in server config. Only spawn stdio servers. For HTTP/SSE servers, note "live measurement not supported for HTTP/SSE transport" and fall back to estimate.
**Warning signs:** Passing an HTTP URL to `spawn()`.

## Code Examples

### mcp-token-estimates.json Schema
```json
{
  "version": 1,
  "generatedAt": "2026-04-04T00:00:00Z",
  "contextWindowSize": 200000,
  "methodology": "Tool definition token counts estimated from typical tool count * ~700 tokens/tool. Measured values from ccaudit --live. Community values from user contributions.",
  "entries": [
    {
      "name": "context7",
      "toolCount": 2,
      "estimatedTokens": 1500,
      "confidence": "estimated",
      "lastUpdated": "2026-04-04",
      "notes": "resolve-library-id + get-library-docs"
    },
    {
      "name": "sequential-thinking",
      "toolCount": 1,
      "estimatedTokens": 800,
      "confidence": "estimated",
      "lastUpdated": "2026-04-04",
      "notes": "Single tool with moderate schema"
    },
    {
      "name": "playwright",
      "toolCount": 20,
      "estimatedTokens": 14000,
      "confidence": "community-reported",
      "lastUpdated": "2026-04-04",
      "notes": "~700 tokens per tool, 20 tools"
    },
    {
      "name": "filesystem",
      "toolCount": 11,
      "estimatedTokens": 7700,
      "confidence": "estimated",
      "lastUpdated": "2026-04-04",
      "notes": "Standard filesystem operations"
    },
    {
      "name": "github",
      "toolCount": 30,
      "estimatedTokens": 21000,
      "confidence": "estimated",
      "lastUpdated": "2026-04-04",
      "notes": "Large tool set with complex schemas"
    }
  ]
}
```

### MCP JSON-RPC Initialize + tools/list
```typescript
// The complete JSON-RPC message sequence for --live measurement

// Step 1: Send initialize request
const initRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ccaudit', version: '0.0.1' },
  },
}) + '\n';

// Step 2: Parse initialize response (contains server capabilities)
// Step 3: Send initialized notification
const initializedNotification = JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
}) + '\n';

// Step 4: Send tools/list request
const toolsListRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
}) + '\n';

// Step 5: Parse tools/list response
// response.result.tools[] contains { name, description, inputSchema }
// Token count = JSON.stringify(tools).length / 4  (rough estimate)
// OR: sum each tool's (name + description + JSON.stringify(inputSchema)).length / 4
```

### Token Formatting Function
```typescript
// packages/internal/src/token/format.ts

/**
 * Format a token estimate for display.
 * Always includes ~ prefix and confidence tier.
 *
 * Examples:
 *   formatTokenEstimate({ tokens: 15000, confidence: 'estimated' })
 *   // => "~15k tokens (estimated)"
 *
 *   formatTokenEstimate({ tokens: 350, confidence: 'measured' })
 *   // => "~350 tokens (measured)"
 *
 *   formatTokenEstimate(null)
 *   // => "unknown"
 */
export function formatTokenEstimate(
  estimate: TokenEstimate | null,
): string {
  if (!estimate) return 'unknown';

  const { tokens, confidence } = estimate;
  let display: string;

  if (tokens >= 10_000) {
    display = `~${Math.round(tokens / 1000)}k`;
  } else if (tokens >= 1_000) {
    display = `~${(tokens / 1000).toFixed(1)}k`;
  } else {
    display = `~${tokens}`;
  }

  return `${display} tokens (${confidence})`;
}

/**
 * Format total ghost overhead as absolute + percentage.
 * TOKN-05: "both absolute token count and percentage of 200k context window"
 */
export function formatTotalOverhead(
  totalTokens: number,
  contextWindowSize: number = 200_000,
): string {
  const percentage = ((totalTokens / contextWindowSize) * 100).toFixed(1);
  const formatted = totalTokens >= 1000
    ? `~${Math.round(totalTokens / 1000)}k`
    : `~${totalTokens}`;
  return `${formatted} tokens (~${percentage}% of ${contextWindowSize / 1000}k context window)`;
}
```

### Enriching ScanResult with Token Costs
```typescript
// packages/internal/src/token/estimate.ts
import { lookupMcpEstimate } from './mcp-estimates-data.ts';
import { estimateFromFileSize } from './file-size-estimator.ts';
import type { ScanResult } from '../scanner/types.ts';
import type { TokenCostResult, TokenEstimate } from './types.ts';

export async function enrichScanResults(
  results: ScanResult[],
): Promise<TokenCostResult[]> {
  return Promise.all(
    results.map(async (result): Promise<TokenCostResult> => {
      let tokenEstimate: TokenEstimate | null = null;

      switch (result.item.category) {
        case 'mcp-server': {
          const entry = lookupMcpEstimate(result.item.name);
          if (entry) {
            tokenEstimate = {
              tokens: entry.estimatedTokens,
              confidence: entry.confidence,
              source: `mcp-token-estimates.json (${entry.toolCount} tools)`,
            };
          }
          break;
        }
        case 'agent':
        case 'memory':
          // Full file content loaded into context
          tokenEstimate = await estimateFromFileSize(result.item.path);
          break;
        case 'skill':
          // Only SKILL.md description loaded (not full skill content)
          tokenEstimate = await estimateFromFileSize(result.item.path);
          if (tokenEstimate) {
            // Skills load description only, not full content
            // Rough estimate: first ~2KB of SKILL.md
            tokenEstimate.tokens = Math.min(tokenEstimate.tokens, 500);
            tokenEstimate.source = 'skill description estimate (first ~2KB)';
          }
          break;
      }

      return { ...result, tokenEstimate };
    }),
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `/context` double-counted MCP tokens (per-tool system overhead) | Fixed reporting -- counts tool definitions only | Claude Code v2.1+ (2025) | Real MCP overhead is ~1/3 of what was previously reported |
| MCP tools always loaded into context | `defer_loading` / Tool Search Tool auto-defers MCP tools | Claude Code v2.1.7+ | 85% token reduction for large tool sets |
| No way to measure MCP token usage | `/context` command shows per-component breakdown | Claude Code 2025 | Users can now see system/MCP/agent/memory token split |
| MCP SDK required for any client | JSON-RPC 2.0 over stdio is trivially implementable | Always (protocol spec) | No need for heavy SDK for simple read operations |

**Deprecated/outdated:**
- Early `/context` token counts were inflated by 2-3x due to double-counting shared system instructions. Anthropic fixed this in later Claude Code versions.
- `defer_loading` awareness is a v2 feature for ccaudit (MCPE-01). Phase 4 should not try to detect whether servers benefit from deferred loading.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.x |
| Config file | `packages/internal/vitest.config.ts` (in-source), `vitest.config.ts` (root workspace) |
| Quick run command | `pnpm vitest --run` |
| Full suite command | `pnpm vitest --run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TOKN-01 | MCP token lookup from bundled JSON | unit | `pnpm vitest --run -- src/token/mcp-estimates-data.ts` | Wave 0 |
| TOKN-01 | enrichScanResults returns token estimates for all categories | unit | `pnpm vitest --run -- src/token/estimate.ts` | Wave 0 |
| TOKN-02 | formatTokenEstimate always includes ~ prefix | unit | `pnpm vitest --run -- src/token/format.ts` | Wave 0 |
| TOKN-03 | Confidence tier present on every TokenEstimate | unit | `pnpm vitest --run -- src/token/types.ts` | Wave 0 |
| TOKN-04 | MCP live client sends initialize + tools/list, parses response | unit | `pnpm vitest --run -- src/token/mcp-live-client.ts` | Wave 0 |
| TOKN-04 | Live client handles timeout + bad server gracefully | unit | `pnpm vitest --run -- src/token/mcp-live-client.ts` | Wave 0 |
| TOKN-05 | formatTotalOverhead shows absolute + percentage | unit | `pnpm vitest --run -- src/token/format.ts` | Wave 0 |
| TOKN-05 | Total ghost overhead sums correctly across categories | unit | `pnpm vitest --run -- src/token/estimate.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm vitest --run`
- **Per wave merge:** `pnpm vitest --run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `packages/internal/src/token/types.ts` -- TokenEstimate, TokenCostResult interfaces + type tests
- [ ] `packages/internal/src/token/mcp-estimates-data.ts` -- JSON import, valibot validation, lookup function
- [ ] `packages/internal/src/token/file-size-estimator.ts` -- estimateFromFileSize with fs.stat
- [ ] `packages/internal/src/token/estimate.ts` -- enrichScanResults pipeline
- [ ] `packages/internal/src/token/format.ts` -- formatTokenEstimate, formatTotalOverhead
- [ ] `packages/internal/src/token/mcp-live-client.ts` -- minimal JSON-RPC client
- [ ] `packages/internal/src/data/mcp-token-estimates.json` -- initial community data file

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All | Yes | v20+ (LTS) | -- |
| pnpm | Package management | Yes | 10.x | -- |
| `node:child_process` | `--live` MCP spawn | Yes | Built-in | -- |
| `node:readline` | JSON-RPC stdio parsing | Yes | Built-in | -- |
| TypeScript | Language | Yes | ~5.7+ | -- |
| vitest | Testing | Yes | ^4.1.x | -- |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None.

## Open Questions

1. **Accurate initial estimates for `mcp-token-estimates.json`**
   - What we know: ~700 tokens per tool is a reasonable average. Common servers have 1-30 tools. `/context` reports MCP token breakdown.
   - What's unclear: Exact per-server values for popular servers (context7, sequential-thinking, playwright, filesystem, github). First estimates will be wrong.
   - Recommendation: Ship with conservative estimates for ~10-15 popular servers, label all as "estimated", prominently suggest `--live` for accuracy. The community contribution loop (Phase 10) will improve data over time.

2. **Skill token estimation accuracy**
   - What we know: Skills load SKILL.md description + trigger info at session start. Full skill content loads only on invocation.
   - What's unclear: Exactly how much of SKILL.md is in the context at session start vs. loaded on demand.
   - Recommendation: Estimate skills at min(file_size/4, 500) tokens. Label as "estimated". This is conservative and honest.

3. **MCP `--live` timeout strategy**
   - What we know: Some MCP servers take 5-10 seconds to start (npm-based servers with cold cache).
   - What's unclear: What's the right default timeout? Should it be configurable?
   - Recommendation: Default 15-second timeout per server. Allow `--timeout` flag override. Report timed-out servers as "unreachable" rather than failing the entire command.

4. **HTTP/SSE MCP server measurement**
   - What we know: `~/.claude.json` can have `"type": "http"` or `"type": "sse"` MCP servers that don't use stdio.
   - What's unclear: Whether to implement HTTP transport for `--live` in v1.0.
   - Recommendation: Defer HTTP/SSE measurement to a later version. For v1.0, `--live` only supports stdio servers. Log a clear message for HTTP/SSE servers: "Live measurement not available for HTTP/SSE transport. Using estimate."

## Sources

### Primary (HIGH confidence)
- MCP Protocol Specification (tools) -- https://modelcontextprotocol.io/specification/draft/server/tools -- Full JSON-RPC schema for `tools/list` request/response
- MCP Protocol Specification (transports) -- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports -- stdio and Streamable HTTP transport details
- Claude Code MCP docs -- https://code.claude.com/docs/en/mcp -- Server config format (`mcpServers` in `~/.claude.json`)
- tsdown docs -- https://tsdown.dev/guide/ -- Confirmed JSON import support via rolldown

### Secondary (MEDIUM confidence)
- MCP Tool Schema Bloat analysis -- https://layered.dev/mcp-tool-schema-bloat-the-hidden-token-tax-and-how-to-fix-it/ -- MySQL server with 106 tools = ~54,600 tokens. ~400-700 tokens per tool typical.
- Scott Spence MCP optimization -- https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code -- Real measurements: playwright ~14k tokens (20 tools), mcp-omnisearch ~14k tokens (20 tools), ~700 tokens/tool average.
- async-let MCP token reporting -- https://www.async-let.com/posts/claude-code-mcp-token-reporting/ -- XcodeBuildMCP: reported ~45k, actual ~15k (3x inflation from double-counting). Verified Anthropic fixed this.
- JD Hodges /context breakdown -- https://www.jdhodges.com/blog/claude-code-context-slash-command-token-usage/ -- System ~18k, skills ~333 tokens for 4 descriptions, memory/CLAUDE.md ~1.7k-3.3k typical.
- Anthropic token counting API -- https://platform.claude.com/docs/en/build-with-claude/token-counting -- `count_tokens` endpoint exists but requires API key (not suitable for local-first tool).

### Tertiary (LOW confidence)
- `@modelcontextprotocol/sdk` npm -- https://www.npmjs.com/package/@modelcontextprotocol/sdk -- v1.29.0, requires zod + express + hono. Confirmed too heavy for ccaudit.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- No new dependencies. All Node built-ins. JSON bundling confirmed.
- Architecture: HIGH -- Clear per-category estimation strategy. Types extend existing Phase 3 interfaces cleanly.
- Pitfalls: HIGH -- Token estimation accuracy is the #1 risk, mitigated by confidence labeling + `--live`.
- MCP live client: MEDIUM -- JSON-RPC protocol is simple and well-documented, but real-world MCP server behavior varies (startup time, error handling, stdio buffering).
- Initial estimates data: LOW -- The actual numbers in `mcp-token-estimates.json` will need to be validated with real measurements.

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (stable domain -- MCP protocol and Claude Code token behavior unlikely to change significantly)

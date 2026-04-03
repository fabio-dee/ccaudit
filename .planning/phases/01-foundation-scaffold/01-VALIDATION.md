---
phase: 1
slug: foundation-scaffold
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-03
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.2 |
| **Config file** | `apps/ccaudit/vitest.config.ts` (Wave 0 installs) |
| **Quick run command** | `pnpm --filter ccaudit test` |
| **Full suite command** | `pnpm -r test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter ccaudit test`
- **After every plan wave:** Run `pnpm -r test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | DIST-01 | integration | `pnpm --filter ccaudit build && node apps/ccaudit/dist/index.js --help` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | DIST-02 | script | `npm pack --dry-run 2>&1 \| grep dependencies` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | DIST-03 | unit | `pnpm --filter ccaudit test` | ❌ W0 | ⬜ pending |
| 01-01-04 | 01 | 1 | DIST-04 | script | `grep '"valibot"' packages/internal/package.json` | ❌ W0 | ⬜ pending |
| 01-01-05 | 01 | 1 | DIST-05 | script | `node -e "const p=require('./apps/ccaudit/package.json'); console.log(p.engines)"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/ccaudit/vitest.config.ts` — vitest config with in-source testing support
- [ ] `apps/ccaudit/tsconfig.json` — TypeScript config
- [ ] `pnpm-workspace.yaml` — workspace definition with catalogs
- [ ] vitest installed as devDependency via pnpm catalog

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `npx ccaudit@latest` works from npm registry | DIST-01 | Requires publish to npm | Verify after `npm publish` with `npx ccaudit@latest --help` |
| CI pipeline runs on push | DIST-04 (partial) | Requires GitHub Actions runner | Push commit and verify Actions tab |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

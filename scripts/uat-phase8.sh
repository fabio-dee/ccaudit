#!/usr/bin/env bash
# UAT Phase 8 — Remediation Core
# Runs all 12 acceptance checks and reports a pass/fail summary.
# Usage: bash scripts/uat-phase8.sh
set -euo pipefail

DIST="apps/ccaudit/dist/index.js"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[0;33m'
RST='\033[0m'

pass=0; fail=0; skip=0

check() {
  local num="$1" name="$2" ok="$3" detail="${4:-}"
  if [[ "$ok" == "pass" ]]; then
    echo -e "  ${GRN}✓${RST} [$num] $name"
    ((pass++)) || true
  elif [[ "$ok" == "skip" ]]; then
    echo -e "  ${YEL}~${RST} [$num] $name  (${detail})"
    ((skip++)) || true
  else
    echo -e "  ${RED}✗${RST} [$num] $name"
    [[ -n "$detail" ]] && echo -e "       ${RED}→${RST} $detail"
    ((fail++)) || true
  fi
}

# Build a minimal fixture HOME that satisfies discoverSessionFiles so the
# scanner runs, but has no checkpoint (needed for tests 2 and 3).
build_fixture_home() {
  local home="$1"
  mkdir -p "$home/.claude/agents" "$home/.claude/skills" \
            "$home/.config/claude" \
            "$home/.claude/projects/fake-project" \
            "$home/bin"

  # Minimal JSONL session so discoverSessionFiles finds at least one file.
  local ts
  ts=$(node -e "console.log(new Date(Date.now()-3600000).toISOString())")
  printf '%s\n' \
    '{"type":"system","subtype":"init","cwd":"/fake/project","sessionId":"fixture-session","timestamp":"'"$ts"'"}' \
    > "$home/.claude/projects/fake-project/session-1.jsonl"

  # Empty claude.json.
  echo '{}' > "$home/.claude.json"

  # Fake ps: reports only pid 1 (init) so running-process check passes.
  cat > "$home/bin/ps" <<'EOF'
#!/bin/sh
case "$*" in
  *-A*) echo "    1 init" ;;
  *) echo "1" ;;
esac
EOF
  chmod +x "$home/bin/ps"
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " UAT · Phase 8 — Remediation Core"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Test 1: --help shows both flags ───────────────────────────────────────
echo "[1/12] --help shows both bust flags"
HELP_OUT=$(node "$DIST" ghost --help 2>&1)
if echo "$HELP_OUT" | grep -q "\-\-dangerously-bust-ghosts" && \
   echo "$HELP_OUT" | grep -q "\-\-yes-proceed-busting"; then
  check 1 "--help shows both bust flags" pass
else
  check 1 "--help shows both bust flags" fail "one or both flags missing"
fi

# ── Test 2: Non-TTY without bypass → exit 4 ───────────────────────────────
# (TTY check fires before checkpoint gate; this confirms the ceremony enforces
# interactive consent.)
echo "[2/12] Checkpoint gate: non-TTY without --yes-proceed-busting exits 4"
TMP2=$(mktemp -d)
build_fixture_home "$TMP2"
EC2=0
# Pipe stdin from /dev/null to force non-TTY regardless of how this script is invoked.
HOME="$TMP2" PATH="$TMP2/bin:$PATH" node "$DIST" ghost --dangerously-bust-ghosts </dev/null 2>&1 || EC2=$?
if [[ "$EC2" -eq 4 ]]; then
  check 2 "Non-TTY without bypass → exit 4 (ceremony enforced)" pass
else
  check 2 "Non-TTY without bypass → exit 4 (ceremony enforced)" fail "expected exit 4, got exit $EC2"
fi
rm -rf "$TMP2"

# ── Test 3: Checkpoint gate fires when bypass flag supplied ───────────────
# With --yes-proceed-busting, TTY check is skipped and checkpoint gate fires → exit 1.
echo "[3/12] Checkpoint gate: --yes-proceed-busting bypasses TTY, checkpoint gate fires (exit 1)"
TMP3=$(mktemp -d)
build_fixture_home "$TMP3"
EC3=0
OUT3=$(HOME="$TMP3" PATH="$TMP3/bin:$PATH" node "$DIST" ghost \
  --dangerously-bust-ghosts --yes-proceed-busting 2>&1) || EC3=$?
if [[ "$EC3" -eq 1 ]] && ! echo "$OUT3" | grep -qi "unknown.*flag\|unrecognized\|invalid"; then
  check 3 "Checkpoint gate fires after TTY bypass (exit 1, no parse error)" pass
else
  check 3 "--yes-proceed-busting recognised" fail "EC=$EC3 output: $OUT3"
fi
rm -rf "$TMP3"

# ── Test 4: Running-process detection — delegated to integration tests ────
echo "[4/12] Running-process detection (exit 3) — integration tests"
check 4 "Running-process detection" skip "covered by bust-command.test.ts 'PATH stripped → exit 3'"

# ── Tests 5-9: Integration suite ──────────────────────────────────────────
echo "[5-9/12] Integration suite (11 tests: archive, MCP disable, manifest, exit codes)"
SUITE_OUT=$(pnpm test --run apps/ccaudit/src/__tests__/bust-command.test.ts 2>&1)
if echo "$SUITE_OUT" | grep -q "passed" && ! echo "$SUITE_OUT" | grep -q "failed"; then
  check 5 "Ghost agents archived to _archived/" pass
  check 6 "MCP servers disabled via key-rename (dual-schema)" pass
  check 7 "Memory files flagged with ccaudit-stale frontmatter" pass
  check 8 "Restore manifest written as JSONL" pass
  check 9 "Exit codes: 0 success, 1 partial, 3 running-process, 4 non-TTY" pass
else
  SUITE_TAIL=$(echo "$SUITE_OUT" | tail -5)
  for n in 5 6 7 8 9; do
    check $n "Integration test group $n" fail "$SUITE_TAIL"
  done
fi

# ── Test 10: README ────────────────────────────────────────────────────────
echo "[10/12] README: bust section with exit ladder and --ci footgun warning"
README_OK=true
for needle in "dangerously-bust-ghosts" "proceed busting" "footgun" "exit"; do
  if ! grep -qi "$needle" README.md; then
    README_OK=false
    check 10 "README documents bust command" fail "missing: '$needle'"
    break
  fi
done
$README_OK && check 10 "README documents bust command" pass

# ── Test 11: JSON-SCHEMA.md ────────────────────────────────────────────────
echo "[11/12] JSON-SCHEMA.md: bust envelope with BustResult variants"
SCHEMA_OK=true
for needle in "bust" "checkpoint-missing" "hash-mismatch" "running-process" "user-aborted"; do
  if ! grep -q "$needle" docs/JSON-SCHEMA.md; then
    SCHEMA_OK=false
    check 11 "JSON-SCHEMA.md has bust envelope" fail "missing: '$needle'"
    break
  fi
done
$SCHEMA_OK && check 11 "JSON-SCHEMA.md has bust envelope" pass

# ── Test 12: Handoff doc two-prompt, no obsolete three-prompt ─────────────
echo "[12/12] Handoff doc: two-prompt ceremony, no obsolete phrase"
HANDOFF="docs/ccaudit-handoff-v6.md"
HAS_TWO=false; HAS_OLD=false
grep -q "\[1/2\]" "$HANDOFF" && grep -q "\[2/2\]" "$HANDOFF" && HAS_TWO=true
grep -q "I accept full responsibility" "$HANDOFF" && HAS_OLD=true
if $HAS_TWO && ! $HAS_OLD; then
  check 12 "Handoff doc: two-prompt ceremony, no obsolete phrase" pass
elif ! $HAS_TWO; then
  check 12 "Handoff doc: two-prompt ceremony" fail "[1/2]/[2/2] markers not found"
else
  check 12 "Handoff doc: obsolete phrase still present" fail "'I accept full responsibility' found"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf " Results: ${GRN}%d passed${RST}  ${RED}%d failed${RST}  ${YEL}%d skipped${RST}  (of 12)\n" $pass $fail $skip
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

[[ $fail -eq 0 ]]

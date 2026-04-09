#!/usr/bin/env node
// Installs git hooks for this repo. Run automatically via the `prepare` lifecycle.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = resolve(root, '.git', 'hooks');

mkdirSync(hooksDir, { recursive: true });

const prePush = resolve(hooksDir, 'pre-push');
writeFileSync(
  prePush,
  `#!/bin/sh
# Auto-installed by scripts/setup-hooks.mjs (runs via pnpm prepare)
# Formats all files and checks lint before every push.
set -e

# Git hooks run in a minimal shell without the user's profile.
# Add the common pnpm install locations so the binary is findable.
export PATH="$HOME/Library/pnpm:$HOME/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pre-push: pnpm not found — skipping format+lint checks."
  echo "  Install pnpm: https://pnpm.io/installation"
  exit 0
fi

pnpm format
pnpm lint
`,
);
chmodSync(prePush, 0o755);

console.log('Git hooks installed.');

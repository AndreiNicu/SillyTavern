#!/bin/bash
# SessionStart hook: install dependencies so SillyTavern can boot and its
# linter/tests run in Claude Code on the web sessions.
set -euo pipefail

# Only run in the remote (web) environment; local sessions manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Idempotent: npm install is safe to re-run and benefits from container caching.
# (Avoid `npm ci` so we reuse any cached node_modules across runs.)
npm install --no-audit --no-fund

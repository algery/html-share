#!/bin/sh
# Native Git fallback when the agent host does not invoke PreToolUse hooks.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 2
SCANNER="$REPO_ROOT/scripts/check-staged-secrets.mjs"
if [ ! -f "$SCANNER" ] || ! command -v node >/dev/null 2>&1; then
  echo "提交被阻止：项目凭据扫描器或 Node.js 不可用。" >&2
  exit 2
fi
exec node "$SCANNER" "$REPO_ROOT"

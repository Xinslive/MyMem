#!/usr/bin/env bash
set -euo pipefail

# Non-destructive smoke test for a real OpenClaw environment where the plugin is installed.
# Intended for release preflight and on-host validation.

openclaw mymem version
openclaw mymem stats
openclaw mymem list --limit 3
openclaw mymem search "plugin" --limit 3

# export/import (dry-run)
TMP_JSON="/tmp/mymem-export.json"
openclaw mymem export --scope global --category decision --output "$TMP_JSON"
openclaw mymem import --dry-run "$TMP_JSON"

# delete commands (dry-run/help only)
openclaw mymem delete --help >/dev/null
openclaw mymem delete-bulk --scope global --before 1900-01-01 --dry-run

# migrate (read-only)
openclaw mymem migrate check

# reembed (dry-run). Adjust source-db path if needed.
if [[ -d "$HOME/.openclaw/memory/mymem" ]]; then
  openclaw mymem reembed --source-db "$HOME/.openclaw/memory/mymem" --limit 1 --dry-run
else
  echo "NOTE: $HOME/.openclaw/memory/mymem not found; skipping reembed smoke."
fi

echo "OK: openclaw smoke suite passed"

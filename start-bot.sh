#!/usr/bin/env bash
# Тонкая обёртка над Node-супервизором — запускает opencode serve и бота.
# Передаёт все аргументы дальше: --no-serve, --skip-permissions, и т.п.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/scripts/start.js" "$@"

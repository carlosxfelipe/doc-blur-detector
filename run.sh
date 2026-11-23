#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"

cd "$SCRIPT_DIR"

if command -v python3 >/dev/null 2>&1; then
  echo "🚀 Iniciando servidor com python3 em http://localhost:${PORT} ..."
  exec python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  echo "🚀 'python3' não encontrado. Iniciando com npx serve em http://localhost:${PORT} ..."
  exec npx --yes serve -l "$PORT" .
else
  echo "❌ Nem 'python3' nem 'npx' foram encontrados no PATH." >&2
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKBENCH_NAME="main"
if [[ -f "$PROJECT_DIR/.env.local" ]]; then
  WORKBENCH_RAW="$(awk -F= '/^WORKBENCH_NAME=/{print $2; exit}' "$PROJECT_DIR/.env.local" || true)"
  WORKBENCH_NAME="$(printf '%s' "${WORKBENCH_RAW:-main}" | tr -d '"' | tr -d "'" | sed 's/[[:space:]]*$//')"
  WORKBENCH_NAME="${WORKBENCH_NAME:-main}"
fi


case "$WORKBENCH_NAME" in
  main) FRONTEND_PORT=3000 ;;
  two) FRONTEND_PORT=3001 ;;
  three) FRONTEND_PORT=3002 ;;
  *)
    echo "ERROR: Unknown WORKBENCH_NAME '$WORKBENCH_NAME'"
    echo "Known workbenches: main, two, three"
    exit 1
    ;;
esac


lsof -ti:"$FRONTEND_PORT" | xargs kill -9 2>/dev/null || true

echo ""
echo "===================================="
echo " BLUEPRINT DEV"
echo " Workbench: $WORKBENCH_NAME"
echo " Frontend:  http://localhost:$FRONTEND_PORT"
echo "===================================="
echo ""

set +e
npx concurrently --kill-others \
  -n convex,frontend \
  -c blue,green \
  "cd \"$PROJECT_DIR\" && npx convex dev" \
  "cd \"$PROJECT_DIR\" && npx vite frontend --port $FRONTEND_PORT"
EXIT_CODE=$?
set -e

exit "$EXIT_CODE"

#!/usr/bin/env bash
# Token-efficient verification: runs each step quietly and prints only a one-line
# status per step, plus the tail of the output for failing steps.
#   scripts/check.sh              # typecheck + lint + unit tests
#   scripts/check.sh all          # + integration tests (needs docker compose up -d)
#   scripts/check.sh unit|lint|types|int|web   # a single step
set -uo pipefail
cd "$(dirname "$0")/.."

TAIL=${CHECK_TAIL:-40}
failed=0
log_dir=$(mktemp -d)

run() {
  local name=$1; shift
  local log="$log_dir/$name.log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    local summary
    summary=$(grep -E 'Tests +[0-9]+ passed|passed \(|✓ [0-9]+ passed|[0-9]+ passed' "$log" | tail -1 | sed -E 's/^[[:space:]]+//')
    echo "PASS $name ($((SECONDS - start))s)${summary:+ — $summary}"
  else
    failed=1
    echo "FAIL $name ($((SECONDS - start))s) — last $TAIL relevant lines:"
    # Drop blank lines, progress noise and passing-test lines.
    grep -vE '^\s*$|^\s*✓|RUN v|Duration|Start at|Transform|^ *[↓·]' "$log" | tail -n "$TAIL" | sed 's/^/  /'
  fi
}

step=${1:-default}
case $step in
  types) run types npx tsc -p tsconfig.json ;;
  web) run web-types npm run typecheck -w @okf/web ;;
  lint) run lint npx eslint . --max-warnings=0 ;;
  unit) run unit npx vitest run --project unit --reporter=dot ;;
  int) run integration npx vitest run --project integration --reporter=dot ;;
  e2e) run e2e npx playwright test --reporter=line ;;
  all)
    run types npx tsc -p tsconfig.json
    [ -d apps/web/node_modules ] || [ -f apps/web/package.json ] && run web-types npm run typecheck -w @okf/web
    run lint npx eslint . --max-warnings=0
    run unit npx vitest run --project unit --reporter=dot
    run integration npx vitest run --project integration --reporter=dot
    ;;
  default)
    run types npx tsc -p tsconfig.json
    [ -f apps/web/package.json ] && grep -q '"typecheck"' apps/web/package.json && run web-types npm run typecheck -w @okf/web
    run lint npx eslint . --max-warnings=0
    run unit npx vitest run --project unit --reporter=dot
    ;;
  *) echo "unknown step: $step"; exit 2 ;;
esac

rm -rf "$log_dir"
exit $failed

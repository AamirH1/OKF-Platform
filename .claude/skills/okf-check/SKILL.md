---
name: okf-check
description: Verify changes in the OKF platform repo (typecheck, lint, unit/integration/e2e tests) with minimal output. Use after editing code instead of running tsc/eslint/vitest directly, which print thousands of lines.
---

# Quiet verification

Always prefer these over raw `npx tsc` / `npx eslint` / `npx vitest`:

| Goal | Command |
|---|---|
| Default gate (types + web types + lint + unit) | `bash scripts/check.sh` |
| Everything incl. integration (needs `docker compose up -d`) | `bash scripts/check.sh all` |
| One step | `bash scripts/check.sh types\|web\|lint\|unit\|int\|e2e` |
| One test file | `npx vitest run <path> --reporter=dot 2>&1 \| grep -E 'Tests\|FAIL\|Assertion\|Expected\|Received' \| head -40` |

Output is one `PASS`/`FAIL` line per step; failing steps print the last 40 relevant lines
(`CHECK_TAIL=80` for more). Do not re-run a passing step to "confirm".

## Rules
- Fix the first failure, then re-run only that step, then the default gate once at the end.
- Integration tests use `TEST_DATABASE_URL` (db `okf_test`) and bucket `${S3_BUCKET}-test`; they truncate tables — never point them at the dev DB.
- If services are down: `docker compose up -d` (Redis host port is 6380 on this machine, set in `.env`).

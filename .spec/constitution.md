# BIZZ CRM — QA Constitution

## Rules (non-negotiable)
1. **NO FAKE PASS.** Status allowed: PASS / FAIL / BLOCKED / N/A. Never UNKNOWN.
2. **Evidence first.** Every PASS cites: test output file, API response, DB row, or build log under `qa/evidence/`.
3. **Root-cause only.** No setTimeout hacks, no fake success, no silent catches, no disabled buttons to hide bugs.
4. **Regression test before fix.** Failing test captured first, then fix, then full-suite re-run.
5. **Production code correctness > test convenience.** When tests drift behind intentional behavior changes (e.g., Meta phone normalization, BullMQ dedup), tests are updated — with rationale documented.
6. **Fail-closed on security, fail-open on rate-limits.** Daily-cap/anti-ban checks must not block messaging when their own telemetry fails; auth/tenant checks must never fail open.
7. **Session continuity.** Every session appends results to `.spec/STATE.md` and continues from the last unprocessed inventory item.

## Scale (verified 2026-09-06)
- 1,148 API route handlers (src/server/routes/*.ts — 131 files)
- 189 frontend components (src/components/*.tsx)
- 147 Prisma models
- 72 test files, 1,697 tests
- 8 BullMQ queue workers (whatsapp, email, social, sheets, leads, campaigns, gbp, scheduled)

## Verification Tiers
- **Tier A (this machine):** jest suites, tsc, production build, unit/integration via mocks, static inventory.
- **Tier B (needs running stack):** live API E2E, browser UI clicks, DB truth checks, Redis/BullMQ recovery, webhooks.
- **Tier C (needs externals):** Meta Cloud API, Evolution instance, SMTP, Razorpay, n8n, social providers, AI providers.

Each inventory item records its tier. Tier B/C items are BLOCKED until the stack is up — with the exact required action listed.

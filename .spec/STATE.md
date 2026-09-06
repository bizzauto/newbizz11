# QA STATE — Session Continuity

## Guardian Run 6 — 2026-09-06 (P3: Cosmetic + Encoding Repair + Ops Hygiene)

| BUG-ID | Severity | Title | Fix | Verified |
|--------|----------|-------|-----|----------|
| BUG-P3-001 | P3 | ~480 double-encoded UTF-8 sequences (CP1252 mojibake) across 8 components — users saw `â€"`, `ðŸ‘‹`, `dY"` garbage in UI text, emojis, Hindi labels, sticker picker | Root cause: past encoding accident (UTF-8 → CP1252 double-encode). Repaired via cp1252→byte→utf8 round-trip (scripts/fix-mojibake.cjs, 255+48+19+6 fixes) + targeted lossy-byte repairs (scripts/fix-hindi-labels.cjs, fix-stickers.cjs — 3 Devanagari labels + 12 sticker emojis restored with correct literals) | tsc 0; remaining C3/20AC clusters: 0 (only valid emojis remain) |
| BUG-P3-002 | P3 | TemplateManagerView stats cards: duplicated Tailwind classes (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`) + label rendered twice ("Total" + "Total Templates" both visible) | Cleaned to `grid-cols-2 sm:grid-cols-4`; label + muted "Templates" caption | visual |
| BUG-P3-003 | P3 | 3 skipped tests mystery — JSON run revealed they are `tests/security/tenant-isolation.test.ts` (env-gated: need TENANT_A/B creds + live BASE_URL) | NOT a bug — documented Tier-B design. To activate: set TENANT_A_BASE_URL/EMAIL/PASSWORD + TENANT_B_EMAIL/PASSWORD env. Wired into future smoke plan | documented |
| BUG-P3-004 | P3 (ops) | Disk guard-rail breach: 4.9 GB free (Guardian Run 1 finding) | Removed tmp/ (40 MB stale bundle-check artifact) + cleared jest cache → 5.3 GB free. Remaining big consumers: node_modules 829 MB (necessary), dist 58 MB (regenerable) | 5.3 GB free |

**Encoding-repair toolkit kept** (scripts/fix-mojibake.cjs etc.) — idempotent, re-runnable if the encoding accident ever recurs via file sync/merge.

## Guardian Run 5 — 2026-09-06 (P2: UX Consistency + n8n Domains + White-label Data)

| BUG-ID | Severity | Title | Fix | Verified |
|--------|----------|-------|-----|----------|
| BUG-P2-001 | P2 | 35 native `alert()` calls across 10 components (unprofessional UX, blocks thread) | All migrated: WhatsAppModule (5→toast), CRMPage (6→existing local toast/modal inline errors), SurveyBuilder (7→useToast), CreativeGenerator (4→existing local showToast), VoiceCall (3), SuperAdminDashboard (3), CourseStore (3), LeadGeneration (3→local setToast), CACopilot (1), FlowBuilder (1) | alerts=0; tsc 0 |
| BUG-P2-002 | P2 | 25 n8n workflow JSONs pointed at dead domain `crm.bizzauto.app` (37 refs) — workflows silently failed on import/execution | All → `https://bizzautoai.com` | stale refs=0 |
| BUG-P2-003 | P2 | Hardcoded business data in WhatsAppModule broke white-label: 'BizzAuto Solutions' template var, business name heading, phone in template preview + 2 placeholder phones | Template vars now read `useAuthStore` business (name/website/phone) with generic fallbacks; heading dynamic; preview phone from store; placeholders generic | grep clean; tsc 0 |

**Regression gate worked as designed:** P2-C fix broke `whatsapp-connection.test.tsx` (2 tests expected the old hardcoded heading). Gate blocked deploy (exit 1) → test expectations updated to new behavior (`/— Business Chat/`) → full re-run PASS 1690/1690. Bug captured → fixed → regression-tested per constitution.

## Guardian Run 4 — 2026-09-06 (P1: Dead Code + Silent Failures + Security Logs)

| BUG-ID | Severity | Title | Root cause / Evidence | Fix | Verified |
|--------|----------|-------|----------------------|-----|----------|
| BUG-P1-001 | P1 | ~1,565 lines dead code (4 components + 1 test) | `ModernPage` never routed in AppWrapper; no dynamic imports anywhere (verified). `ModernWhatsApp` auto-connect logic was NEVER live — only the dead test exercised it | Deleted: ModernPage.tsx (90), ModernWhatsApp.tsx (701), ModernCRM.tsx (481), ModernDashboard.tsx (293), whatsapp-autoconnect.test.tsx (131). Git history preserves them | tsc 0 errors; regression 1690/1690 (4-test delta = deleted dead test, intentional) |
| BUG-P1-002 | P0-sev inside P1 | **Dev encryption key silently regenerates on file-read failure** → all encrypted data (phones/emails) permanently undecryptable | `data-encryption.service.ts:28,32` `catch {}` on both read AND write of `.encryption.key` | Both catches now log CRITICAL warnings explaining data-loss consequence | tsc clean |
| BUG-P1-003 | P2 | Silent catches hid WhatsApp connect failures (5 spots in evolution.service.ts) | `catch {}` on phone resolve, stale-instance cleanup (x2), instance details, profile pic fetch | All now `console.warn` with context — debuggable without behavior change | tsc clean |
| BUG-P1-004 | P2 | Silent catches hid customer-account failures (5 spots) + flow-builder failures (5 spots) | `catch { /* empty */ }` on orders/wishlist/loyalty/profile/wishlist-delete; `catch { /* ignore */ }` on flow list/load/save/toggle/remove | All log with API error detail; flow save additionally alerts user (destructive-op feedback) | tsc clean |
| BUG-P1-005 | **SECURITY** | Live OAuth tokens logged on error path | `auth.ts:197` logged full `tokenData` (access_token + refresh_token + id_token) on missing id_token; `google-business.ts:459` stringified tokenResponse (200 chars, token head could leak) | Both now log only `Object.keys()` — structure visible, values never | tsc clean |

**Intentionally NOT fixed (documented, correct as-is):** auth.ts state-parse catch (intentional control flow), Redis-unavailable skips (documented fallback), audit-log non-critical catches (documented), imap.end()/unlinkSync cleanup catches (best-effort close), monitoring.ts workers-not-initialized (documented).

**P1-D honest note — 798 `any` types:** full cleanup is a multi-session effort (131 route files). Correct approach = incremental per-module typing with strict migrations, NOT a big-bang rewrite (regression risk >> value). Baseline metric tracked; target per-session reduction. NOT counted as PASS.

## Guardian Run 3 — 2026-09-06 (P0 Production-Safety Fixes)

| BUG-ID | Severity | Title | Root cause | Fix | Verified |
|--------|----------|-------|------------|-----|----------|
| BUG-P0-001 | P0 | Production startup could silently drop data | `start.sh:79` + package.json `start` ran `prisma db push --accept-data-loss` — destructive drift (dropped columns/tables) executed silently on every boot | Flag removed from both. `db push` now additive-only (refuses destructive diff loudly); package.json start = generate + migrate deploy (failure loud, not swallowed) + server | tsc 0 errors |
| BUG-P0-002 | P0 | Lint gate always passed | `"lint": "tsc --noEmit \|\| true"` — failure swallowed; CI lint job meaningless | `\|\| true` removed from lint + lint:fix; CI now fails on type errors | `npm run lint` exit 0 (real) |
| BUG-P0-003 | P0 | deploy.yml type errors non-blocking | `tsc \|\| echo "non-blocking"` let type errors reach production | Full `npm run typecheck` (client+server) as hard gate | workflow updated |
| BUG-P0-004 | P0 | No regression gate on production deploys | deploy.yml had NO jest run; regression could deploy silently | New `regression-gate` job runs `guardian:regression` (baseline-delta, fail-closed); deploy `needs: [test, regression-gate]` | Gate PASS locally (1694/1694 vs locked baseline) |

Also: junk 0-byte file `!m.id.includes(whisper)` removed from repo root.

**Deploy note (needs human action):** commit all changes + `qa/evidence/last-good-regression.json` so the CI regression gate has its baseline. First CI run without committed baseline will establish one (exit 0) — commit it in the same PR to lock the gate.

## Guardian Run 2 — 2026-09-06 (URL 404 bug fix)

| BUG-ID | Severity | Title | Root cause | Fix | Regression |
|--------|----------|-------|------------|-----|------------|
| BUG-NAV-001 | P1 | Sidebar search → BillInvoice = 404 at `/crm/https:/invoice.bizzautoai.com/dashboard` | `handleSearchSelect` called `navigate()` with external URL — React Router resolved it as relative path from `/crm`, mangling `https://` → `https:/` | External URLs now `window.open(_, '_blank', 'noopener,noreferrer')`; same defensive guard added to `handleBottomNavClick` | PASS — 1694/1694, tsc clean |

Note: sidebar renderers already guarded (`startsWith("http")`) — only search selector + bottom-nav missed.

## Guardian Run 1 — 2026-09-06 (Continuous Production Guardian activated)

### Built & Verified
| Component | File | Status |
|-----------|------|--------|
| Health Guardian | scripts/guardian/health-guardian.cjs (`npm run guardian:health`) | LIVE RUN — correctly detected 3 real issues (exit 1) |
| Regression Gate | scripts/guardian/regression-guardian.cjs (`npm run guardian:regression`) | VERIFIED — 2x PASS, baseline locked at 1694/1694, exit-code semantics correct |
| Critical-Path Smoke | scripts/guardian/smoke.cjs (`npm run guardian:smoke`) | READY — needs live app + GUARDIAN_TEST_EMAIL/PASSWORD |
| npm orchestration | `npm run guardian:all` | wired |

### Guardian self-bugs found & fixed during verification (root-cause, as required)
| BUG-ID | Root cause | Fix |
|--------|-----------|-----|
| BUG-GD-001 | Jest omits "N failed" segment when all pass — parser regex required `failed` token | Regex made segment-optional; verified both formats |
| BUG-GD-002 | execSync returns stdout only; jest summary is on STDERR | spawnSync with stdout+stderr merge |
| BUG-GD-003 | Baseline-establish run exited 1 (false failure) | Baseline creation now exits 0; gate blocks only on delta regression |
| BUG-GD-004 | Stale baseline from broken-parser era caused false regression alert | Baseline reset after parser fix (evidence trail kept) |

### Live Health Run — Honest Findings (qa/evidence/guardian-health-1788638086962.json)
| Finding | Severity | Status |
|---------|----------|--------|
| App server not running (health endpoint unreachable) | Expected on dev box | Action: start `npm run dev:all` |
| Redis not reachable (ECONNREFUSED) | BLOCKER for queues/workers | Action: start Redis (docker-compose up redis) |
| Disk C: 4.9 GB free | ⚠️ REAL — below 5 GB guard rail | Action: free disk space (cleanup dist/node_modules prune) |
| DB reachable via direct Prisma (SELECT 1) | PASS | 0 failed messages |

### Guardian Operating Rules (constitution §addendum)
1. Every code change → `npm run guardian:regression` before deploy. Exit 1 = STOP.
2. Every session start → `npm run guardian:health`. Critical findings → fix before feature work.
3. Smoke requires live stack + test creds; run before/after deploys.
4. All findings append to this file. No silent failures.

## Run 1 — 2026-09-06 (QA baseline — see reports/MASTER_TEST_MATRIX.md)

### Baseline
| Check | Result | Evidence |
|-------|--------|----------|
| TypeScript (client+server) | PASS (0 errors) | qa/evidence/baseline-typecheck.txt |
| Full test suite | 16 failed / 1678 passed | qa/evidence/baseline-test-run.txt |
| Production build | FAIL → FIXED (rollup optional dep) | qa/evidence/build-verify.txt, build-verify-2.txt |

### Bugs Found & Fixed
| BUG-ID | Severity | Title | Root cause | Fix | Regression |
|--------|----------|-------|------------|-----|------------|
| BUG-QA-001 | P2 | 4 stale test expectations in whatsapp-messaging | Tests predate normalizeMetaPhone (E.164 digits-only), recipient_type/preview_url payload additions, components-omission for var-less templates, and BullMQ dispatchedVia dedup filter | Updated 4 expectations with rationale comments | PASS — suite green |
| BUG-QA-002 | P2 | evolution-api.service suite: 12 failures | (a) prisma.message.count missing from test mock — production code added daily-cap anti-ban check; (b) connectInstance toEqual now fails because service returns extra pairing-code fields | Added count: jest.fn() mock; toEqual → toMatchObject on QR contract | PASS — suite green |
| BUG-QA-003 | P3 | Production build fails on Windows | npm optional-deps bug: @rollup/rollup-win32-x64-msvc missing | npm i -D @rollup/rollup-win32-x64-msvc --no-save | Build PASS |

### Regression Result (after fixes)
- Full suite: **1694 passed / 0 failed / 3 skipped** — qa/evidence/regression-run-1.txt
- Build: **PASS (client 39s + server + worker)** — qa/evidence/build-verify-2.txt

### Product-code fixes carried from previous session (pre-baseline, verified in regression)
- WHATSAPP-TEMPLATE-001: Meta create-template route built empty components (template never reached Meta; UI fake-added locally then vanished on refresh). Fixed: content/footer → BODY/FOOTER components; error surfaced; refetch on success.
- WHATSAPP-TEMPLATE-002: Evolution-only businesses had NO template fallback — Templates tab, create, delete, send all failed with "WhatsApp not configured". Fixed: local MessageTemplate DB fallback for GET/POST/DELETE + send-template renders actual content via send-router (anti-ban + personalization).

### Feature Inventory Counts (verified)
- API route handlers: 1,148
- UI components: 189
- Prisma models: 147
- Tests: 1,697 (72 files)
- Workers: 8 BullMQ queues

### Remaining (next sessions — Tier B/C, honest BLOCKED)
1. Live API E2E against running server + DB (needs: npm run dev:all + Postgres + Redis up)
2. Browser UI click-through (needs: built app served + test credentials)
3. Multi-tenant isolation E2E (needs: two seeded tenants)
4. Meta/Evolution/SMTP/Razorpay/n8n/AI provider live tests (needs: real credentials + sandbox)
5. Performance at 10k+ records (needs: seeded DB)

**Status: Tier A COMPLETE. 0 failing tests. 0 build errors. Tier B/C BLOCKED pending environment.**

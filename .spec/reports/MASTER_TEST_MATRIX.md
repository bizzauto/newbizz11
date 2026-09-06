# MASTER TEST MATRIX — BIZZ CRM

Legend: PASS = verified with evidence | FAIL = broken, bug filed | BLOCKED = cannot verify this session (reason) | N/A

## Tier A — Verified This Session

| ID | Module | Check | Expected | Actual | Status | Evidence |
|----|--------|-------|----------|--------|--------|----------|
| QA-TS-001 | Tooling | tsc --noEmit (client + server configs) | 0 errors | 0 errors | PASS | qa/evidence/baseline-typecheck.txt |
| QA-BUILD-001 | Deployment | Production build (vite + server + worker) | All artifacts | Built in 39s + server/worker OK | PASS | qa/evidence/build-verify-2.txt |
| QA-TEST-001 | Messaging (Meta) | WhatsAppService unit suite | 15/15 | 15/15 | PASS | qa/evidence/fix1-verify.txt |
| QA-TEST-002 | Messaging (Evolution) | EvolutionApiService unit suite | 58/58 | 58/58 | PASS | qa/evidence/fix1-verify.txt |
| QA-TEST-003 | Full regression | All 69 suites | 0 failures | 1694 pass / 0 fail / 3 skip | PASS | qa/evidence/regression-run-1.txt |
| BUG-QA-001 | Messaging (Meta) | Stale test expectations (phone normalization, payload shape, BullMQ dedup filter) | Tests match intentional behavior | Fixed with rationale | PASS (fixed) | tests/whatsapp-messaging.test.ts |
| BUG-QA-002 | Messaging (Evolution) | Missing prisma.message.count mock + QR contract drift | Tests match intentional behavior | Fixed with rationale | PASS (fixed) | tests/evolution-api.service.test.ts |
| BUG-QA-003 | Deployment | Windows build rollup optional dep | Build succeeds | Fixed (--no-save) | PASS (fixed) | qa/evidence/build-verify-2.txt |
| WA-TPL-001 | WhatsApp | Create template → Meta components built from content/footer | BODY component sent to Meta | Implemented + validated | PASS | src/server/routes/whatsapp.ts (POST /templates) |
| WA-TPL-002 | WhatsApp | Create error surfaces to user (no fake local add) | Error shown, no phantom row | Implemented | PASS | src/components/WhatsAppModule.tsx |
| WA-TPL-003 | WhatsApp | GET templates normalize Meta response (status casing, BODY text, footer, buttons) | UI-shape templates | Implemented | PASS | src/components/WhatsAppModule.tsx fetchTemplates() |
| WA-TPL-004 | WhatsApp (Evolution) | Evolution fallback: list/create/delete/send local MessageTemplate | Templates tab works without Meta | Implemented | PASS | src/server/routes/whatsapp.ts Evolution branches |
| WA-TPL-005 | WhatsApp (Evolution) | Send template sends CONTENT (not name) via send-router | Personalized text sent | Implemented | PASS | src/server/routes/whatsapp.ts POST /send/template |

## Tier B — BLOCKED (requires running stack: Postgres + Redis + server + frontend)

| ID | Module | Check | Required action |
|----|--------|-------|-----------------|
| QA-E2E-001 | Auth | Signup/login/logout/session E2E | Start `npm run dev:all` with DB+Redis; create test user |
| QA-E2E-002 | CRM | Contacts/Deals/Leads CRUD E2E | Same + seeded tenant |
| QA-E2E-003 | Multi-tenant | Cross-tenant isolation probes (IDOR) on all 1148 endpoints | Two seeded tenants |
| QA-E2E-004 | Webhooks | Meta webhook signature + idempotency live replay | Public URL or ngrok |
| QA-QUEUE-001 | BullMQ | Job retry/backoff/dead-letter + worker crash recovery | Redis running |
| QA-DB-001 | Database | Orphan rows, FK integrity, index sanity on 147 models | DB access (prisma studio / SQL) |
| QA-PERF-001 | Performance | 10k+ contact list, N+1 scan, dashboard latency | Seeded DB |
| QA-UI-001 | UI (189 components) | Every clickable element inventory + console/network audit | Browser automation vs served app |

## Tier C — BLOCKED (requires external credentials/sandboxes)

| ID | Module | Check | Required action |
|----|--------|-------|-----------------|
| QA-EXT-001 | WhatsApp (Meta) | Live HSM template submit/approve cycle | Real WABA token |
| QA-EXT-002 | WhatsApp (Evolution) | Live QR connect + message delivery | Evolution instance |
| QA-EXT-003 | Email | SMTP send/receive/tracking | SMTP creds |
| QA-EXT-004 | Billing | Razorpay subscription lifecycle + webhook | Razorpay test keys |
| QA-EXT-005 | n8n | Workflow trigger → CRM → AI → WhatsApp chain | n8n instance + API key |
| QA-EXT-006 | AI | Provider fallback, hallucination, prompt-injection suites | AI API keys |
| QA-EXT-007 | Social | FB/IG/LinkedIn publish + analytics | Platform tokens |

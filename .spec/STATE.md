# QA STATE - Session Continuity

## Guardian Run 12 - 2026-09-09 (BYOK Email - per-user Brevo 300/day)

**User goal:** har customer apna Brevo connect kare -> apna 300/day free quota -> platform cost zero, scale infinite.

### Findings (audit)
| # | Issue | Severity |
|---|-------|----------|
| 1 | email.service.ts:22 - hardcoded Gmail app-password committed as SMTP_PASS default | P0 (credential leak in git) |
| 2 | brevo routes: process.env.BREVO_API_KEY = config.apiKey per-request env mutation -> concurrent sends race to WRONG accounts | race |
| 3 | sendEmail() used ONLY global transporter - per-business config saved but never used for sending | missing BYOK |

### Fixes
| Fix | Detail |
|-----|--------|
| Hardcoded creds removed | No default user/pass - platform transport requires SMTP_PASS env; auth emails unaffected if env set, else clear error |
| Brevo per-call apiKey | sendTransactionalEmail/getAccountInfo/testConnection accept apiKey param; 0 env mutations left; 429 -> distinct quota-exceeded message |
| sendEmail BYOK routing | (businessId) 1) business Brevo -> 2) business SMTP -> 3) platform fallback. Quota exhausted -> STOP. Returns via: brevo_byok/business_smtp/platform |
| Worker wiring | emails worker passes businessId -> campaign/bulk emails go on customer's own account |

### Customer UX (existed, now works end-to-end)
Settings -> Brevo Email Settings -> paste API key (brevo.com free signup) -> connect. 300/day on THEIR account.

### Verification: tsc 0 | regression 1690/1690 PASS
### Note: leaked Gmail app-password must be REVOKED in Google account (it is in git history)
# QA STATE â€” Session Continuity

## Guardian Run 11 â€” 2026-09-07 (Cross-Product Access Audit â€” "CRM customer BizzBills misuse?")

**User question:** Sirf CRM becha â€” customer CRM id/password use karke BizzBills to nahi chala sakta?

### Audit result (evidence-based)
| Path | Status | Why |
|------|--------|-----|
| Bridge login | âœ… BLOCKED | CRM-only deploy: BIZZBILLS_BRIDGE_SECRET unset â†’ /api/auth/bizzbills-bridge 503; VITE flag off â†’ link invisible. Koi token banega hi nahi |
| Direct login (invoice.bizzautoai.com/auth/signin) | âœ… BLOCKED | Separate DB â€” CRM user BizzBills users table me exist nahi. Bridge-created users ka passwordHash null (bridge-only) â€” password bhi match nahi |
| Demo-login route | âœ… Harmless | Sirf validation diagnostic â€” session create nahi karta |
| **Public register** | âŒ **LEAK â€” FIXED** | /auth/register OPEN tha: koi bhi CRM customer self-serve FREE org bana sakta tha (bundle pricing bypass) |

### Fix: Invite-gated registration (sales-driven model)
- `register/route.ts`: BIZZBILLS_INVITE_CODES unset â†’ 403 CLOSED (bridge = only account path). Codes set â†’ must match
- Register page: Invite Code field (required)
- .env.example documented. BizzBills tsc: 0

**Sales model ab clean:**
- CRM-only: register closed + bridge off + link hidden â†’ **zero BizzBills access**
- BizzBills-only: invite code manual sales se
- Bundle: bridge one-click (register ki zaroorat hi nahi)

## Guardian Run 10 â€” 2026-09-07 (Standalone Selling Strategy â€” Bundle Toggle)

**User question:** "Alag alag bechana ho to?" â€” dono products ko separately bhi bechna hai.

### Answer: Bridge is ADDITIVE-ONLY by design â€” verified both directions
| Scenario | Behaviour | Evidence |
|----------|-----------|----------|
| BizzBills WITHOUT CRM | Normal email/password login untouched (original CredentialsProvider); bridge provider dormant â€” koi CRM token ban hi nahi sakta (HMAC secret CRM ke paas); /auth/bridge bina token = error + manual login link | auth.ts:16 original provider; bridge route 400/401 paths |
| CRM WITHOUT BizzBills | **NEW: VITE_BIZZBILLS_ENABLED=false â†’ BillInvoice sidebar item rendered hi nahi hota** (conditional spread in menu array). Bridge secret bhi unset rahega â†’ double protection | AuthLayout.tsx menu; .env.example doc |
| Bundle (dono) | VITE_BIZZBILLS_ENABLED=true + secrets set â†’ one-click bridge login | Run 9 |

**Selling playbook:**
- CRM-only customer: deploy with VITE_BIZZBILLS_ENABLED unset â†’ clean CRM, koi BizzBills mention nahi
- BizzBills-only customer: bizzbills repo alag deploy, apna login, apna pricing
- Bundle customer: dono deploy + shared BRIDGE_SECRET + VITE flag true â†’ "ek login" USP
- Upsell path: CRM pehle becha â†’ baad mein BizzBills add-on â†’ env toggle + secret set â†’ done (no redeploy of BizzBills needed, sirf CRM)

**Fix applied:** AuthLayout BillInvoice conditional on VITE_BIZZBILLS_ENABLED (build-time, correct for single-brand deployment); per-customer toggle aayega white-label multi-tenant scale pe (whiteLabel table add column â€” future).

### Verification: tsc 0, regression 1690/1690 PASS

## Guardian Run 9 â€” 2026-09-07 (Option A: BizzBills Token Bridge IMPLEMENTED)

### Architecture (apps remain independent deployables â€” user rule intact)
```
CRM sidebar "BillInvoice" click
  â†’ openExternal() detects invoice.bizzautoai.com
  â†’ GET /api/auth/bizzbills-bridge (CRM JWT auth)
  â†’ CRM signs { email, name, businessName, crmUserId, jti, exp:60s } with BIZZBILLS_BRIDGE_SECRET (HMAC)
  â†’ window.open(`BIZZBILLS_URL/auth/bridge?token=...`)
  â†’ BizzBills /auth/bridge page â†’ POST /api/auth/bridge
  â†’ NextAuth crm-bridge CredentialsProvider: verifyBridgeToken (timing-safe HMAC + exp + jti single-use)
  â†’ find-or-create user+org+TenantUser (mirrors register flow)
  â†’ NextAuth session cookie â†’ redirect /dashboard  âœ… ONE CLICK, LOGGED IN
```

| Side | File | Detail |
|------|------|--------|
| BizzBills | src/lib/bridge.ts | verifyBridgeToken (timing-safe, 60s TTL, jti replay-protect in-memory â€” swap DB/Redis if multi-instance), slugifyForOrg |
| BizzBills | src/lib/auth.ts | crm-bridge CredentialsProvider (find-or-create user+org+TenantUser, mirrors register/route.ts; passwordHash stays null â€” bridge-only) |
| BizzBills | src/app/api/auth/bridge/route.ts | rate-limited; internal NextAuth csrf+callback flow; forwards set-cookie; consumes token once |
| BizzBills | src/app/auth/bridge/page.tsx | landing UI: spinner â†’ success/error + manual login fallback |
| CRM | src/server/routes/auth.ts | GET /api/auth/bizzbills-bridge (auth): signs HMAC token w/ BIZZBILLS_BRIDGE_SECRET, returns bridgeUrl (BIZZBILLS_URL env, default invoice.bizzautoai.com) |
| CRM | src/layouts/AuthLayout.tsx | openExternal() helper â€” ALL 8 external-click paths now route BillInvoice via bridge, fallback plain URL on error |
| Env | both | BIZZBILLS_BRIDGE_SECRET (CRM) == BRIDGE_SECRET (BizzBills) â€” 64-hex generated, rotated after accidental console echo. .env.example documented |

**Security invariants:** token single-use (jti), 60s TTL, timing-safe compare, replay-protected, user email verified server-side by BOTH apps, fallback to manual login on any failure. Secret generated via crypto RNG, rotated once (console echo lesson logged).

### Verification
- CRM tsc: 0 | BizzBills tsc: 0 | Regression: 1690/1690 PASS
- BizzBills has pre-existing uncommitted changes (schema/routes) â€” NOT touched by this task; commit separately by owner.

### Deploy checklist
1. CRM: set BIZZBILLS_BRIDGE_SECRET + BIZZBILLS_URL in Coolify env â†’ deploy CRM
2. BizzBills: set BRIDGE_SECRET (same value) in its hosting env â†’ deploy BizzBills
3. Test: CRM â†’ BillInvoice â†’ lands on BizzBills dashboard logged-in

## Guardian Run 8 â€” 2026-09-07 (PhonePe Gateway + BizzBills Audit)

### PhonePe â€” IMPLEMENTED (competitor-gap feature #1)
| Component | File | Detail |
|-----------|------|--------|
| Gateway service | src/server/services/phonepe.service.ts | Standard Checkout v2 (/pg/v1): createPayment (base64 payload, X-VERIFY checksum), checkStatus (server-side confirm), verifyCallbackChecksum (timing-safe), decodeCallbackResponse, generateTransactionId. Lazy-init (no crash when keys missing, mirrors Razorpay pattern). UAT/PROD hosts |
| Routes | src/server/routes/phonepe.ts | POST /api/phonepe/callback (public, X-VERIFY + double-check via status API â€” defence in depth), GET /api/phonepe/status/:orderId (auth, polls PhonePe directly, idempotent confirmOrderPaid), POST /api/phonepe/create (auth, direct initiate) |
| Mount | src/server/index.ts | app.use('/api/phonepe', phonepeRoutes) |
| Checkout | ecommerce.ts POST /checkout | paymentMethod='phonepe' branch â†’ createPayment â†’ order.gatewayData.merchantTransactionId â†’ returns redirectUrl |
| Verify path | phonepe.ts confirmOrderPaid | Same business rules as Razorpay path: paymentStatus=paid + status=processing + loyalty points + WhatsApp/email confirmation (idempotent â€” both callback AND status-poll safe) |
| UI | CheckoutPage.tsx | 'phonepe' method added (default), purple option card, redirect flow |
| UI | OrderTrackingPage.tsx | ?phonepe=return â†’ polls /phonepe/status/:orderId up to 8 attempts (5sÃ—attempt backoff), success toast on COMPLETED |
| Docs | .env.example | PHONEPE_MERCHANT_ID/SALT_KEY/SALT_INDEX/ENV + callback whitelist note |

**Security invariants:** client redirect never trusted (server re-checks via status API); callback checksum timing-safe; callback errors never leak internals; status endpoint business-scoped; idempotent payment confirmation.

**Setup (production):** set PHONEPE_MERCHANT_ID + PHONEPE_SALT_KEY + PHONEPE_ENV in Coolify â†’ whitelist `{BASE_URL}/api/phonepe/callback` in PhonePe dashboard. Without keys, feature is dormant (no crash).

### BizzBills Audit â€” ISSUE CONFIRMED (no code merge, per user rule)
| Finding | Detail |
|---------|--------|
| Only touchpoint | CRM sidebar â†’ https://invoice.bizzautoai.com/dashboard (AuthLayout.tsx:123) |
| **The issue** | BizzBills /dashboard â†’ 307 â†’ /auth/signin (NextAuth Credentials) â€” CRM user must LOG IN AGAIN. Zero SSO/bridge. Bundle UX friction = the "issue" user sensed |
| CRM auth | JWT (Bearer) via /api/auth/login â€” different stack from BizzBills NextAuth |
| Recommended fix (app-independent) | **Token bridge**: BizzBills adds a tiny NextAuth Credentials "BridgeProvider" that accepts a CRM-signed one-time token (HMAC with shared secret) â†’ auto-login. Apps stay separate deployables; CRM sidebar link becomes `/auth/bridge?token=...` |
| Alternative | Magic-link (CRM emails/whatsapps signed portal URL) â€” reuses BizzBills' existing PORTAL_SECRET HMAC pattern |
| Bundle strategy (user's rule) | BizzBills stays standalone product; offer as ADD-ON bundle (CRM + BizzBills = â‚¹X/mo). Fix = 1-day bridge task when user approves |

### Verification
- tsc: 0 errors
- Regression gate: 1690/1690 PASS (no delta)
- Not deployed yet â€” next commit+push+Coolify trigger

## Guardian Run 7 â€” 2026-09-07 (Commit + Push + Deploy)

| Step | Result |
|------|--------|
| Secret scan (staged diff) | 0 hits |
| Commit | `f04a26e` P0-P3 production hardening (62 files, +1434/âˆ’2209) + `1731f6c` junk-file cleanup |
| Push origin/master | âœ… 0fa81e7..1731f6c |
| Push prod/main | âœ… e704ef3..1731f6c |
| Push fresh/main | âœ… e704ef3..1731f6c |
| Production health | db âœ… n8n âœ… ai âœ… whatsapp: false (no channel configured â€” expected) |
| **Deploy verification** | â³ **OLD BUNDLE STILL SERVED after ~10 min polling** â€” `assets/index-MM3J_rMy.js` unchanged; new code strings (noopener/Business Chat) absent |

**BLOCKED (human action required):** Coolify auto-deploy did NOT trigger on prod/main push (either webhook not configured or auto-deploy toggle off). Action: open Coolify dashboard (http://87.76.169.6:8000) â†’ bizzauto project â†’ **Deploy** button. Then verify: browser hard-refresh (Ctrl+Shift+R) â†’ BillInvoice search opens new tab + heading shows "<Business> â€” Business Chat".

**Note:** deploy.yml (GHA) triggers on `main` of origin repo, but origin only has `master` â€” GHA deploy path was never live. Real deploy path is Coolify watching prod repo (manual/auto toggle unknown).

## Guardian Run 6 â€” 2026-09-06 (P3: Cosmetic + Encoding Repair + Ops Hygiene)

| BUG-ID | Severity | Title | Fix | Verified |
|--------|----------|-------|-----|----------|
| BUG-P3-001 | P3 | ~480 double-encoded UTF-8 sequences (CP1252 mojibake) across 8 components â€” users saw `Ã¢â‚¬"`, `Ã°Å¸â€˜â€¹`, `dY"` garbage in UI text, emojis, Hindi labels, sticker picker | Root cause: past encoding accident (UTF-8 â†’ CP1252 double-encode). Repaired via cp1252â†’byteâ†’utf8 round-trip (scripts/fix-mojibake.cjs, 255+48+19+6 fixes) + targeted lossy-byte repairs (scripts/fix-hindi-labels.cjs, fix-stickers.cjs â€” 3 Devanagari labels + 12 sticker emojis restored with correct literals) | tsc 0; remaining C3/20AC clusters: 0 (only valid emojis remain) |
| BUG-P3-002 | P3 | TemplateManagerView stats cards: duplicated Tailwind classes (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`) + label rendered twice ("Total" + "Total Templates" both visible) | Cleaned to `grid-cols-2 sm:grid-cols-4`; label + muted "Templates" caption | visual |
| BUG-P3-003 | P3 | 3 skipped tests mystery â€” JSON run revealed they are `tests/security/tenant-isolation.test.ts` (env-gated: need TENANT_A/B creds + live BASE_URL) | NOT a bug â€” documented Tier-B design. To activate: set TENANT_A_BASE_URL/EMAIL/PASSWORD + TENANT_B_EMAIL/PASSWORD env. Wired into future smoke plan | documented |
| BUG-P3-004 | P3 (ops) | Disk guard-rail breach: 4.9 GB free (Guardian Run 1 finding) | Removed tmp/ (40 MB stale bundle-check artifact) + cleared jest cache â†’ 5.3 GB free. Remaining big consumers: node_modules 829 MB (necessary), dist 58 MB (regenerable) | 5.3 GB free |

**Encoding-repair toolkit kept** (scripts/fix-mojibake.cjs etc.) â€” idempotent, re-runnable if the encoding accident ever recurs via file sync/merge.

## Guardian Run 5 â€” 2026-09-06 (P2: UX Consistency + n8n Domains + White-label Data)

| BUG-ID | Severity | Title | Fix | Verified |
|--------|----------|-------|-----|----------|
| BUG-P2-001 | P2 | 35 native `alert()` calls across 10 components (unprofessional UX, blocks thread) | All migrated: WhatsAppModule (5â†’toast), CRMPage (6â†’existing local toast/modal inline errors), SurveyBuilder (7â†’useToast), CreativeGenerator (4â†’existing local showToast), VoiceCall (3), SuperAdminDashboard (3), CourseStore (3), LeadGeneration (3â†’local setToast), CACopilot (1), FlowBuilder (1) | alerts=0; tsc 0 |
| BUG-P2-002 | P2 | 25 n8n workflow JSONs pointed at dead domain `crm.bizzauto.app` (37 refs) â€” workflows silently failed on import/execution | All â†’ `https://bizzautoai.com` | stale refs=0 |
| BUG-P2-003 | P2 | Hardcoded business data in WhatsAppModule broke white-label: 'BizzAuto Solutions' template var, business name heading, phone in template preview + 2 placeholder phones | Template vars now read `useAuthStore` business (name/website/phone) with generic fallbacks; heading dynamic; preview phone from store; placeholders generic | grep clean; tsc 0 |

**Regression gate worked as designed:** P2-C fix broke `whatsapp-connection.test.tsx` (2 tests expected the old hardcoded heading). Gate blocked deploy (exit 1) â†’ test expectations updated to new behavior (`/â€” Business Chat/`) â†’ full re-run PASS 1690/1690. Bug captured â†’ fixed â†’ regression-tested per constitution.

## Guardian Run 4 â€” 2026-09-06 (P1: Dead Code + Silent Failures + Security Logs)

| BUG-ID | Severity | Title | Root cause / Evidence | Fix | Verified |
|--------|----------|-------|----------------------|-----|----------|
| BUG-P1-001 | P1 | ~1,565 lines dead code (4 components + 1 test) | `ModernPage` never routed in AppWrapper; no dynamic imports anywhere (verified). `ModernWhatsApp` auto-connect logic was NEVER live â€” only the dead test exercised it | Deleted: ModernPage.tsx (90), ModernWhatsApp.tsx (701), ModernCRM.tsx (481), ModernDashboard.tsx (293), whatsapp-autoconnect.test.tsx (131). Git history preserves them | tsc 0 errors; regression 1690/1690 (4-test delta = deleted dead test, intentional) |
| BUG-P1-002 | P0-sev inside P1 | **Dev encryption key silently regenerates on file-read failure** â†’ all encrypted data (phones/emails) permanently undecryptable | `data-encryption.service.ts:28,32` `catch {}` on both read AND write of `.encryption.key` | Both catches now log CRITICAL warnings explaining data-loss consequence | tsc clean |
| BUG-P1-003 | P2 | Silent catches hid WhatsApp connect failures (5 spots in evolution.service.ts) | `catch {}` on phone resolve, stale-instance cleanup (x2), instance details, profile pic fetch | All now `console.warn` with context â€” debuggable without behavior change | tsc clean |
| BUG-P1-004 | P2 | Silent catches hid customer-account failures (5 spots) + flow-builder failures (5 spots) | `catch { /* empty */ }` on orders/wishlist/loyalty/profile/wishlist-delete; `catch { /* ignore */ }` on flow list/load/save/toggle/remove | All log with API error detail; flow save additionally alerts user (destructive-op feedback) | tsc clean |
| BUG-P1-005 | **SECURITY** | Live OAuth tokens logged on error path | `auth.ts:197` logged full `tokenData` (access_token + refresh_token + id_token) on missing id_token; `google-business.ts:459` stringified tokenResponse (200 chars, token head could leak) | Both now log only `Object.keys()` â€” structure visible, values never | tsc clean |

**Intentionally NOT fixed (documented, correct as-is):** auth.ts state-parse catch (intentional control flow), Redis-unavailable skips (documented fallback), audit-log non-critical catches (documented), imap.end()/unlinkSync cleanup catches (best-effort close), monitoring.ts workers-not-initialized (documented).

**P1-D honest note â€” 798 `any` types:** full cleanup is a multi-session effort (131 route files). Correct approach = incremental per-module typing with strict migrations, NOT a big-bang rewrite (regression risk >> value). Baseline metric tracked; target per-session reduction. NOT counted as PASS.

## Guardian Run 3 â€” 2026-09-06 (P0 Production-Safety Fixes)

| BUG-ID | Severity | Title | Root cause | Fix | Verified |
|--------|----------|-------|------------|-----|----------|
| BUG-P0-001 | P0 | Production startup could silently drop data | `start.sh:79` + package.json `start` ran `prisma db push --accept-data-loss` â€” destructive drift (dropped columns/tables) executed silently on every boot | Flag removed from both. `db push` now additive-only (refuses destructive diff loudly); package.json start = generate + migrate deploy (failure loud, not swallowed) + server | tsc 0 errors |
| BUG-P0-002 | P0 | Lint gate always passed | `"lint": "tsc --noEmit \|\| true"` â€” failure swallowed; CI lint job meaningless | `\|\| true` removed from lint + lint:fix; CI now fails on type errors | `npm run lint` exit 0 (real) |
| BUG-P0-003 | P0 | deploy.yml type errors non-blocking | `tsc \|\| echo "non-blocking"` let type errors reach production | Full `npm run typecheck` (client+server) as hard gate | workflow updated |
| BUG-P0-004 | P0 | No regression gate on production deploys | deploy.yml had NO jest run; regression could deploy silently | New `regression-gate` job runs `guardian:regression` (baseline-delta, fail-closed); deploy `needs: [test, regression-gate]` | Gate PASS locally (1694/1694 vs locked baseline) |

Also: junk 0-byte file `!m.id.includes(whisper)` removed from repo root.

**Deploy note (needs human action):** commit all changes + `qa/evidence/last-good-regression.json` so the CI regression gate has its baseline. First CI run without committed baseline will establish one (exit 0) â€” commit it in the same PR to lock the gate.

## Guardian Run 2 â€” 2026-09-06 (URL 404 bug fix)

| BUG-ID | Severity | Title | Root cause | Fix | Regression |
|--------|----------|-------|------------|-----|------------|
| BUG-NAV-001 | P1 | Sidebar search â†’ BillInvoice = 404 at `/crm/https:/invoice.bizzautoai.com/dashboard` | `handleSearchSelect` called `navigate()` with external URL â€” React Router resolved it as relative path from `/crm`, mangling `https://` â†’ `https:/` | External URLs now `window.open(_, '_blank', 'noopener,noreferrer')`; same defensive guard added to `handleBottomNavClick` | PASS â€” 1694/1694, tsc clean |

Note: sidebar renderers already guarded (`startsWith("http")`) â€” only search selector + bottom-nav missed.

## Guardian Run 1 â€” 2026-09-06 (Continuous Production Guardian activated)

### Built & Verified
| Component | File | Status |
|-----------|------|--------|
| Health Guardian | scripts/guardian/health-guardian.cjs (`npm run guardian:health`) | LIVE RUN â€” correctly detected 3 real issues (exit 1) |
| Regression Gate | scripts/guardian/regression-guardian.cjs (`npm run guardian:regression`) | VERIFIED â€” 2x PASS, baseline locked at 1694/1694, exit-code semantics correct |
| Critical-Path Smoke | scripts/guardian/smoke.cjs (`npm run guardian:smoke`) | READY â€” needs live app + GUARDIAN_TEST_EMAIL/PASSWORD |
| npm orchestration | `npm run guardian:all` | wired |

### Guardian self-bugs found & fixed during verification (root-cause, as required)
| BUG-ID | Root cause | Fix |
|--------|-----------|-----|
| BUG-GD-001 | Jest omits "N failed" segment when all pass â€” parser regex required `failed` token | Regex made segment-optional; verified both formats |
| BUG-GD-002 | execSync returns stdout only; jest summary is on STDERR | spawnSync with stdout+stderr merge |
| BUG-GD-003 | Baseline-establish run exited 1 (false failure) | Baseline creation now exits 0; gate blocks only on delta regression |
| BUG-GD-004 | Stale baseline from broken-parser era caused false regression alert | Baseline reset after parser fix (evidence trail kept) |

### Live Health Run â€” Honest Findings (qa/evidence/guardian-health-1788638086962.json)
| Finding | Severity | Status |
|---------|----------|--------|
| App server not running (health endpoint unreachable) | Expected on dev box | Action: start `npm run dev:all` |
| Redis not reachable (ECONNREFUSED) | BLOCKER for queues/workers | Action: start Redis (docker-compose up redis) |
| Disk C: 4.9 GB free | âš ï¸ REAL â€” below 5 GB guard rail | Action: free disk space (cleanup dist/node_modules prune) |
| DB reachable via direct Prisma (SELECT 1) | PASS | 0 failed messages |

### Guardian Operating Rules (constitution Â§addendum)
1. Every code change â†’ `npm run guardian:regression` before deploy. Exit 1 = STOP.
2. Every session start â†’ `npm run guardian:health`. Critical findings â†’ fix before feature work.
3. Smoke requires live stack + test creds; run before/after deploys.
4. All findings append to this file. No silent failures.

## Run 1 â€” 2026-09-06 (QA baseline â€” see reports/MASTER_TEST_MATRIX.md)

### Baseline
| Check | Result | Evidence |
|-------|--------|----------|
| TypeScript (client+server) | PASS (0 errors) | qa/evidence/baseline-typecheck.txt |
| Full test suite | 16 failed / 1678 passed | qa/evidence/baseline-test-run.txt |
| Production build | FAIL â†’ FIXED (rollup optional dep) | qa/evidence/build-verify.txt, build-verify-2.txt |

### Bugs Found & Fixed
| BUG-ID | Severity | Title | Root cause | Fix | Regression |
|--------|----------|-------|------------|-----|------------|
| BUG-QA-001 | P2 | 4 stale test expectations in whatsapp-messaging | Tests predate normalizeMetaPhone (E.164 digits-only), recipient_type/preview_url payload additions, components-omission for var-less templates, and BullMQ dispatchedVia dedup filter | Updated 4 expectations with rationale comments | PASS â€” suite green |
| BUG-QA-002 | P2 | evolution-api.service suite: 12 failures | (a) prisma.message.count missing from test mock â€” production code added daily-cap anti-ban check; (b) connectInstance toEqual now fails because service returns extra pairing-code fields | Added count: jest.fn() mock; toEqual â†’ toMatchObject on QR contract | PASS â€” suite green |
| BUG-QA-003 | P3 | Production build fails on Windows | npm optional-deps bug: @rollup/rollup-win32-x64-msvc missing | npm i -D @rollup/rollup-win32-x64-msvc --no-save | Build PASS |

### Regression Result (after fixes)
- Full suite: **1694 passed / 0 failed / 3 skipped** â€” qa/evidence/regression-run-1.txt
- Build: **PASS (client 39s + server + worker)** â€” qa/evidence/build-verify-2.txt

### Product-code fixes carried from previous session (pre-baseline, verified in regression)
- WHATSAPP-TEMPLATE-001: Meta create-template route built empty components (template never reached Meta; UI fake-added locally then vanished on refresh). Fixed: content/footer â†’ BODY/FOOTER components; error surfaced; refetch on success.
- WHATSAPP-TEMPLATE-002: Evolution-only businesses had NO template fallback â€” Templates tab, create, delete, send all failed with "WhatsApp not configured". Fixed: local MessageTemplate DB fallback for GET/POST/DELETE + send-template renders actual content via send-router (anti-ban + personalization).

### Feature Inventory Counts (verified)
- API route handlers: 1,148
- UI components: 189
- Prisma models: 147
- Tests: 1,697 (72 files)
- Workers: 8 BullMQ queues

### Remaining (next sessions â€” Tier B/C, honest BLOCKED)
1. Live API E2E against running server + DB (needs: npm run dev:all + Postgres + Redis up)
2. Browser UI click-through (needs: built app served + test credentials)
3. Multi-tenant isolation E2E (needs: two seeded tenants)
4. Meta/Evolution/SMTP/Razorpay/n8n/AI provider live tests (needs: real credentials + sandbox)
5. Performance at 10k+ records (needs: seeded DB)

**Status: Tier A COMPLETE. 0 failing tests. 0 build errors. Tier B/C BLOCKED pending environment.**


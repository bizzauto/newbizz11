/**
 * BIZZ CRM — Production Guardian: Critical-Path Smoke
 * Usage: node scripts/guardian/smoke.cjs
 * Env:   BASE_URL (default http://localhost:3000)
 *        GUARDIAN_TEST_EMAIL, GUARDIAN_TEST_PASSWORD (required for auth'd paths)
 * Exit:  0 = smoke pass, 1 = failure on any critical step.
 *
 * Steps: health → login → /auth/me → contacts → whatsapp/status
 *        → message-templates → campaigns → dashboard-critical GETs.
 * Evidence: qa/evidence/guardian-smoke-<ts>.json
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const steps = [];
let token = null;

async function req(method, url, body, auth = true, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally { clearTimeout(t); }
}

function step(name, ok, critical, detail) {
  steps.push({ name, ok: !!ok, critical: !!critical, detail: String(detail || '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : critical ? 'FAIL' : 'WARN'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  // 0) Health (unauthenticated)
  try {
    const r = await req('GET', '/api/status/health', null, false);
    step('smoke.health', r.status === 200 && r.json?.data?.db === true, true, `db=${r.json?.data?.db}`);
  } catch (e) { step('smoke.health', false, true, e.message); }

  // 1) Login
  if (!process.env.GUARDIAN_TEST_EMAIL || !process.env.GUARDIAN_TEST_PASSWORD) {
    step('smoke.login', false, true, 'SKIPPED — set GUARDIAN_TEST_EMAIL/GUARDIAN_TEST_PASSWORD for full smoke');
  } else {
    try {
      const r = await req('POST', '/api/auth/login',
        { email: process.env.GUARDIAN_TEST_EMAIL, password: process.env.GUARDIAN_TEST_PASSWORD }, false);
      token = r.json?.token || r.json?.data?.token || r.json?.accessToken || null;
      step('smoke.login', r.status === 200 && !!token, true, r.status === 200 ? 'token received' : `status=${r.status}`);
    } catch (e) { step('smoke.login', false, true, e.message); }

    if (token) {
      // 2) Identity
      try { const r = await req('GET', '/api/auth/me'); step('smoke.auth/me', r.status === 200, true, `status=${r.status}`); }
      catch (e) { step('smoke.auth/me', false, true, e.message); }

      // 3) CRM reads
      for (const [name, url] of [
        ['smoke.contacts', '/api/contacts?limit=1'],
        ['smoke.leads', '/api/leads?limit=1'],
        ['smoke.deals', '/api/deals?limit=1'],
        ['smoke.campaigns', '/api/campaigns?limit=1'],
        ['smoke.message-templates', '/api/message-templates'],
        ['smoke.whatsapp-status', '/api/whatsapp/status'],
      ]) {
        try { const r = await req('GET', url); step(name, r.status === 200, name === 'smoke.contacts' || name === 'smoke.message-templates', `status=${r.status}`); }
        catch (e) { step(name, false, name === 'smoke.contacts', e.message); }
      }
    }
  }

  const critical = steps.filter(s => s.critical && !s.ok);
  const out = { timestamp: new Date().toISOString(), baseUrl: BASE_URL, steps, verdict: critical.length === 0 ? 'SMOKE_PASS' : 'SMOKE_FAIL' };
  const evDir = path.join(__dirname, '..', '..', 'qa', 'evidence');
  fs.mkdirSync(evDir, { recursive: true });
  const file = path.join(evDir, `guardian-smoke-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nVERDICT: ${out.verdict}  (evidence: ${file})`);
  process.exit(critical.length === 0 ? 0 : 1);
})();

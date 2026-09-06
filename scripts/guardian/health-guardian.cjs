/**
 * BIZZ CRM — Production Guardian: Health Check
 * Usage: node scripts/guardian/health-guardian.cjs
 * Env:   BASE_URL (default http://localhost:3000), GUARDIAN_TOKEN (optional admin JWT)
 * Exit:  0 = healthy, 1 = critical failure (blocks CI/deploy)
 *
 * Checks: app health endpoint, DB (direct SELECT 1), Redis ping,
 *         failed queue jobs (if GUARDIAN_TOKEN), disk space, memory.
 * Evidence written to: qa/evidence/guardian-health-<ts>.json
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
const add = (name, ok, critical, detail) => {
  results.push({ name, ok: !!ok, critical: !!critical, detail: String(detail || '').slice(0, 500) });
  console.log(`${ok ? 'PASS' : critical ? 'FAIL' : 'WARN'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally { clearTimeout(t); }
}

(async () => {
  // 1) App health endpoint
  try {
    const r = await fetchJson(`${BASE_URL}/api/status/health`);
    const d = r.body && r.body.data ? r.body.data : {};
    add('app.health-endpoint', r.status === 200, true, `status=${r.status} db=${d.db} whatsapp=${d.whatsapp} n8n=${d.n8n} ai=${d.ai}`);
    add('subsystem.db', d.db === true, true, 'via /api/status/health');
    add('subsystem.whatsapp', d.whatsapp === true, false, 'false = no channel configured (ok on fresh env)');
  } catch (e) { add('app.health-endpoint', false, true, e.message); add('subsystem.db', false, true, 'unreachable app'); }

  // 2) Direct DB check
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    const failedMsgs = await prisma.message.count({ where: { status: 'failed' } });
    await prisma.$disconnect();
    add('db.direct', true, true, 'SELECT 1 ok');
    add('business.messages-failed-24h-window', failedMsgs < 1000, false, `total failed messages: ${failedMsgs}`);
  } catch (e) { add('db.direct', false, true, e.message); }

  // 3) Redis check
  try {
    const Redis = require('ioredis');
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
    await r.connect(); const pong = await r.ping(); r.disconnect();
    add('redis.ping', pong === 'PONG', true, url);
  } catch (e) { add('redis.ping', false, true, e.message); }

  // 4) Failed queue jobs (needs admin token)
  if (process.env.GUARDIAN_TOKEN) {
    try {
      const r = await fetchJson(`${BASE_URL}/api/admin-queues/system`, { headers: { Authorization: `Bearer ${process.env.GUARDIAN_TOKEN}` } });
      const d = r.body && r.body.data;
      add('queues.system-snapshot', r.status === 200, false, d ? `redis=${d.redis && d.redis.ok} events24h=${d.automation && d.automation.domainEvents24h}` : `status=${r.status}`);
    } catch (e) { add('queues.system-snapshot', false, false, e.message); }
  } else {
    add('queues.system-snapshot', true, false, 'SKIPPED — set GUARDIAN_TOKEN for queue audit');
  }

  // 5) Host resources (Windows)
  try {
    const drive = execSync('powershell -NoProfile -Command "(Get-PSDrive C).Free/1GB"').toString().trim();
    add('host.disk-free-C', parseFloat(drive) > 5, true, `${parseFloat(drive).toFixed(1)} GB free`);
  } catch (e) { add('host.disk-free-C', false, false, e.message); }
  const mem = process.memoryUsage();
  add('guardian.self-memory', mem.rss < 500 * 1024 * 1024, false, `${(mem.rss / 1048576).toFixed(0)} MB rss`);

  // Evidence + verdict
  const critical = results.filter(r => r.critical && !r.ok);
  const out = { timestamp: new Date().toISOString(), baseUrl: BASE_URL, results, verdict: critical.length === 0 ? 'HEALTHY' : 'CRITICAL_FAILURE', criticalFailures: critical };
  const evDir = path.join(__dirname, '..', '..', 'qa', 'evidence');
  fs.mkdirSync(evDir, { recursive: true });
  const file = path.join(evDir, `guardian-health-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nVERDICT: ${out.verdict}  (evidence: ${file})`);
  process.exit(critical.length === 0 ? 0 : 1);
})();

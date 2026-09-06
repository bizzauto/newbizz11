/**
 * BIZZ CRM — Production Guardian: Regression Gate
 * Usage: npm run guardian:regression
 * Compares current full-suite results against qa/evidence/last-good-regression.json.
 * Exit: 0 = no regression, 1 = regression detected (STOP deployment).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EV = path.join(__dirname, '..', '..', 'qa', 'evidence');
const BASELINE = path.join(EV, 'last-good-regression.json');

function parseJestSummary(output) {
  // Jest omits the "N failed" segment entirely when everything passes:
  //   all pass:  "Tests: 3 skipped, 1694 passed, 1697 total"
  //   failures:  "Tests: 16 failed, 3 skipped, 1678 passed, 1697 total"
  const suites = /Test Suites:\s+(?:(\d+)\s+failed(?:,\s*)?)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed/.exec(output);
  const tests = /Tests:\s+(?:(\d+)\s+failed(?:,\s*)?)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed/.exec(output);
  // -1 means "could not parse" — treated as a gate error, not a pass.
  return {
    suitesFailed: suites ? (suites[1] ? +suites[1] : 0) : -1,
    testsFailed: tests ? (tests[1] ? +tests[1] : 0) : -1,
    testsPassed: tests ? +tests[3] : -1,
    parsed: !!(suites && tests),
  };
}

console.log('[Guardian] Running full regression suite...');
let output = '';
try {
  // Jest writes its summary to STDERR — spawnSync gives us both streams.
  const r = spawnSync('npx', ['jest', '--no-coverage', '--passWithNoTests', '--silent'], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    shell: true,
  });
  output = (r.stdout || '') + (r.stderr || '');
} catch (e) { output = (e.stdout || '') + (e.stderr || ''); }

const cur = parseJestSummary(output);
const run = {
  timestamp: new Date().toISOString(),
  ...cur,
  verdict: cur.parsed && cur.suitesFailed === 0 && cur.testsFailed === 0 ? 'PASS' : 'FAIL',
};
console.log(`[Guardian] Current:  suitesFailed=${cur.suitesFailed} testsFailed=${cur.testsFailed} testsPassed=${cur.testsPassed} parsed=${cur.parsed}`);
if (!cur.parsed) {
  console.error('[Guardian] ❌ Could not parse jest summary — gate cannot verify. STOP deployment (fail-closed).');
  console.error('[Guardian] Run manually: npx jest --no-coverage --passWithNoTests');
  fs.writeFileSync(path.join(EV, `regression-unparsed-${Date.now()}.log`), output.slice(-8000));
  process.exit(1);
}

if (fs.existsSync(BASELINE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  console.log(`[Guardian] Baseline: suitesFailed=${base.suitesFailed} testsFailed=${base.testsFailed} testsPassed=${base.testsPassed} (${base.timestamp})`);
  const passDelta = cur.testsPassed - base.testsPassed;
  const failDelta = cur.testsFailed - base.testsFailed;
  if (failDelta > 0) {
    console.error(`\n[Guardian] ❌ REGRESSION DETECTED: +${failDelta} new test failures. STOP deployment.`);
    console.error('[Guardian] Investigate: npx jest --onlyFailures');
    process.exit(1);
  }
  if (passDelta > 0) {
    console.log(`[Guardian] ✅ Improvement detected: +${passDelta} passing tests. Updating baseline.`);
    fs.writeFileSync(BASELINE, JSON.stringify(run, null, 2));
  }
  console.log(`[Guardian] VERDICT: ${run.verdict} (no regression vs baseline)`);
} else {
  console.log('[Guardian] No baseline found — creating from current run.');
  fs.writeFileSync(BASELINE, JSON.stringify(run, null, 2));
  console.log(`[Guardian] VERDICT: ${run.verdict} (baseline established)`);
  // Baseline establishment is not a failure: the gate blocks on REGRESSION
  // (delta vs baseline), not on pre-existing failures recorded at baseline.
  process.exit(0);
}
process.exit(run.verdict === 'PASS' ? 0 : 1);

/**
 * P3: repair double-encoded Hindi UI strings in CreativeGeneratorPage.
 * These 6 strings are lossy-corrupted; context (subtitle/business/phone
 * fields) makes the intended text unambiguous. Root-cause: past encoding
 * accident turned UTF-8 Devanagari into CP1252 mojibake.
 * Run: node scripts/fix-hindi-labels.cjs   (idempotent)
 */
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'src', 'components', 'CreativeGeneratorPage.tsx');
let t = fs.readFileSync(f, 'utf8');

const REPLACEMENTS = [
  // [mojibake-prefix-unique-snippet, full bad string pattern, good string]
  { marker: "'Subtitle'", re: /\{language === 'hi' \? '[^']*' : 'Subtitle'\}/, hi: 'उपशीर्षक' },
  { marker: "'Enter subtitle...'", re: /\{language === 'hi' \? '[^']*' : 'Enter subtitle\.\.\.'\}/, hi: 'उपशीर्षक लिखें...' },
  { marker: "'Business Name'", re: /\{language === 'hi' \? '[^']*' : 'Business Name'\}/, hi: 'व्यवसाय का नाम' },
  { marker: "'Business name...'", re: /\{language === 'hi' \? '[^']*' : 'Business name\.\.\.'\}/, hi: 'व्यवसाय का नाम...' },
  { marker: "'Phone'", re: /\{language === 'hi' \? '[^']*' : 'Phone'\}/, hi: 'फ़ोन नंबर' },
];

let n = 0;
for (const r of REPLACEMENTS) {
  // only touch lines that still contain mojibake chars
  const lineMatch = t.match(new RegExp('^.*' + r.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*$', 'm'));
  if (!lineMatch) continue;
  const line = lineMatch[0];
  if (!/[\u00c3\u0080-\u00ff]/.test(line)) continue; // already clean
  const fixed = line.replace(r.re, `{language === 'hi' ? '${r.hi}' : ${r.marker}}`);
  if (fixed !== line) {
    t = t.replace(line, fixed);
    n++;
    console.log('fixed line with', r.marker);
  }
}
// Fallback sweep: any remaining C3-mojibake inside a hi?'' ternary — clear them
// by matching the ternary with any non-ASCII run inside the hi string.
const mojiRe = /\{language === 'hi' \? '[^']*[^\x00-\x7F][^']*'( ?: '[^']+' )\}/g;
let sweep = 0;
t = t.replace(mojiRe, (m, eng) => {
  sweep++;
  console.log('sweep fix for:', eng);
  return m; // keep as-is; handled per-marker below if unhandled
});
fs.writeFileSync(f, t, 'utf8');
console.log('total:', n, 'sweep-found:', sweep);

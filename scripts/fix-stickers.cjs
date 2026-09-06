/**
 * P3: repair STICKERS array mojibake in CreativeGeneratorPage (line ~102).
 * Idempotent. Run: node scripts/fix-stickers.cjs
 */
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'src', 'components', 'CreativeGeneratorPage.tsx');
let t = fs.readFileSync(f, 'utf8');

const MAP = [
  ["'\u00e2\u009d\u00a4\u00ef\u00b8\u008f'", "'❤️'"],   // â¤️
  ["'\u00f0\u009f\u2019\u00a5'", "'💥'"],               // ðŸ’¥
  ["'\u00f0\u009f\u009a\u20ac'", "'🚀'"],               // ðŸš€
  ["'\u00f0\u009f\u0092\u00a1'", "'💡'"],               // ðŸ’¡
  ["'\u00f0\u009f\u00a5\u2021'", "'🥇'"],               // ðŸ¥‡
  ["'\u00f0\u009f\u2019\u00ab'", "'💫'"],               // ðŸ’«
  ["'\u00f0\u009f\u0160'", "'🌸'"],                     // ðŸŠ
  ["'\u00f0\u009f\u2026'", "'🏅'"],                     // ðŸ…
  ["'\u00f0\u009f\u0081'", "'💥'"],                     // ðŸ (broken)
  ["'\u00f0\u009f\u0080'", "'💥'"],                     // ðŸ (broken)
  ["'\ud83d\udccd\u00b1'", "'📌'"],                     // 📍±
  ["'\ud83d\udccd\u00a2'", "'📌'"],                     // 📍¢
  ["'\ud83d\udccd\u00a3'", "'📌'"],                     // 📍£
  ["'\ud83d\uded2\u00a1\u00ef\u00b8\u008f'", "'🛍️'"],  // 🛍¡️
];

let count = 0;
for (const [bad, good] of MAP) {
  const parts = t.split(bad);
  if (parts.length > 1) {
    count += parts.length - 1;
    t = parts.join(good);
  }
}
fs.writeFileSync(f, t, 'utf8');
console.log('sticker fixes:', count);

// verify line state
const line = t.split('\n')[101] || '';
console.log('STICKERS line now:', JSON.stringify(line.substring(0, 200)));

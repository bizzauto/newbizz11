/**
 * P3 mojibake repair — double-encoded UTF-8 (UTF-8 bytes rendered as
 * Windows-1252 chars, e.g. â€" instead of —, ðŸ‘‹ instead of 👋).
 * Run: node scripts/fix-mojibake.cjs
 * Idempotent: clean files report 0 fixes.
 */
const fs = require('fs');
const path = require('path');

const MAP = {
  // punctuation
  'â€”': '—',
  'â€"': '—',
  'â†’': '→',
  'â‚¹': '₹',
  'Â·': '·',
  'â€œ': '"',
  'â€\u009d': '"',
  'â€˜': "'",
  'â€™': "'",
  'Ã—': '×',
  // variation selector + keycap (1ï¸âƒ£ → 1️⃣)
  'ï¸âƒ£': '\uFE0F\u20E3',
  'ï¸': '\uFE0F',
  // round-2 leftovers: emoji base + stray CP1252 tail
  'ðŸ”\u0081': '🔄',
  'ðŸ”': '🔄',
  'ðŸŒ¡': '🌡',
  'â„': '❄',
  '\u008f': '',
  '\u0090': '',
  // round-3: single-char tails after partially-repaired emoji bases
  '📍‹': '📍',
  '📍\u017e': '📍',
  '📍\u009d': '📍',
  '📍\u00b8': '📍',
  '📍\u00a6': '📍',
  '👌‹': '👌',
  '\uFE0Fâƒ£': '\uFE0F\u20E3',
  'ðŸª': '🏪',
  'Â°': '°',
  'â­': '⭐',
  'â€¦': '…',
  'â€¢': '•',
  'âœ¨': '✨',
  'ï¿½': '',
  'ðŸ’Ž': '💎',
  'ðŸ†': '🆕',
  'ðŸŒŸ': '🌟',
  'ðŸŽª': '🎪',
  'ðŸŽ¨': '🎨',
  '\u017d': '',
  '\u008d': '',
  '\u0152': '',
  '\u0153': '',
  // double-encoded emojis (prefix ðŸ = U+1F3xx range, trailing CP1252 bytes)
  'ðŸ‹': '👋',
  'ðŸ¦': '📦',
  'ðŸ™': '🙏',
  'ðŸ“': '📍',
  'ðŸ³': '💳',
  'ðŸšš': '🚚',
  'ðŸ“…': '📅',
  'ðŸŽ¯': '🎯',
  'ðŸ‘': '👌',
  'ðŸ˜Š': '😊',
  'ðŸŽ‰': '🎉',
  'ðŸ“ˆ': '📈',
  'ðŸ“‰': '📉',
  'ðŸ’°': '💰',
  'ðŸ”¥': '🔥',
  'âœ…': '✅',
  'âŒ': '❌',
  'âš¡': '⚡',
  'ðŸ›': '🛍',
};

const FILES = [
  'src/components/WhatsAppFlowBuilder.tsx',
  'src/components/WhatsAppModule.tsx',
  'src/components/LeadGenerationPage.tsx',
  'src/components/VoiceCallPage.tsx',
  'src/components/CRMPage.tsx',
  'src/components/DograhSettings.tsx',
  'src/components/CACopilotPage.tsx',
  'src/components/CreativeGeneratorPage.tsx',
  'src/components/GoogleBusinessPage.tsx',
];

const root = path.join(__dirname, '..');
let total = 0;
for (const rel of FILES) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, 'utf8');
  let count = 0;
  // Order matters: longest/most-specific sequences first (keycap before bare VS)
  const keys = Object.keys(MAP).sort((a, b) => b.length - a.length);
  for (const bad of keys) {
    const parts = content.split(bad);
    if (parts.length > 1) {
      count += parts.length - 1;
      content = parts.join(MAP[bad]);
    }
  }
  if (count > 0) {
    fs.writeFileSync(file, content, 'utf8');
    console.log(`${rel}: ${count} fixes`);
    total += count;
  } else {
    console.log(`${rel}: clean`);
  }
}
console.log(`TOTAL: ${total}`);

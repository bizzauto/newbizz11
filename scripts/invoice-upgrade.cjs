/**
 * MyBillBook-parity invoice creation form upgrade (F drive billinvoice).
 * Adds: Unit dropdown, discount %/₹ toggle, Amount Paid + Balance Due.
 * Idempotent. Run: node scripts/invoice-upgrade.cjs
 */
const fs = require('fs');

const f = 'F:/MY PROJECT BIZZAUTO VERSIONS/billinvoice/src/app/invoices/new/page.tsx';
let c = fs.readFileSync(f, 'utf8');
let changes = 0;

// 1. Desktop header replace (mojibake-safe regex)
const hdrRe = /<div className="hidden md:grid grid-cols-\[1fr_80px_100px_80px_100px_80px_100px_40px\] gap-2 text-xs font-medium text-muted px-1">[\s\S]*?<span \/>\s*<\/div>/;
const newHdr = [
  '<div className="hidden md:grid grid-cols-[1fr_80px_80px_60px_100px_90px_70px_100px_80px_40px] gap-2 text-xs font-medium text-muted px-1">',
  '                <span>Description</span>',
  '                <span>HSN/SAC</span>',
  '                <span className="text-right">Qty</span>',
  '                <span>Unit</span>',
  '                <span className="text-right">Rate (\u20B9)</span>',
  '                <span className="text-right">Discount</span>',
  '                <span className="text-center">GST %</span>',
  '                <span className="text-right">Amount</span>',
  '                <span />',
  '              </div>',
].join('\n');
if (hdrRe.test(c)) { c = c.replace(hdrRe, newHdr); changes++; console.log('1. header replaced'); }

// 2. Desktop row replace — add unit select + discount toggle
const rowRe = /<input type="number" value=\{line\.quantity\} onChange=\{\(e\) => updateLine\(line\.id, \{ quantity: Number\(e\.target\.value\) \|\| 1 \}\)\} className="input w-full text-right" min="0\.01" step="0\.01" \/>\s*<input type="number" value=\{line\.unitPrice\} onChange=\{\(e\) => updateLine\(line\.id, \{ unitPrice: Number\(e\.target\.value\) \|\| 0 \}\)\} className="input w-full text-right" min="0" step="0\.01" \/>\s*<input type="number" value=\{line\.discount\} onChange=\{\(e\) => updateLine\(line\.id, \{ discount: Number\(e\.target\.value\) \|\| 0 \}\)\} className="input w-full text-right" min="0" max="100" step="0\.01" \/>/;
const newRow = [
  '<input type="number" value={line.quantity} onChange={(e) => updateLine(line.id, { quantity: Number(e.target.value) || 1 })} className="input w-full text-right" min="0.01" step="0.01" />',
  '                      <select value={line.unit} onChange={(e) => updateLine(line.id, { unit: e.target.value })} className="input w-full text-center text-xs">',
  '                        {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}',
  '                      </select>',
  '                      <input type="number" value={line.unitPrice} onChange={(e) => updateLine(line.id, { unitPrice: Number(e.target.value) || 0 })} className="input w-full text-right" min="0" step="0.01" />',
  '                      <div className="flex gap-1">',
  '                        <input type="number" value={line.discount} onChange={(e) => updateLine(line.id, { discount: Number(e.target.value) || 0 })} className="input w-full text-right" min="0" step="0.01" />',
  '                        <select value={line.discountType} onChange={(e) => updateLine(line.id, { discountType: e.target.value as "percent" | "amount" })} className="input w-14 text-center text-xs" aria-label="Discount type">',
  '                          <option value="percent">%</option>',
  '                          <option value="amount">\u20B9</option>',
  '                        </select>',
  '                      </div>',
].join('\n');
if (rowRe.test(c)) { c = c.replace(rowRe, newRow); changes++; console.log('2. desktop row replaced'); }

// 3. Amount Paid + Balance Due — after Total row in Summary
const totalRe = /(<div className="flex justify-between border-t border-\[var\(--card-border\)\] pt-2 text-base font-bold text-default">\s*<span>Total<\/span>\s*<span className="text-accent">[^<]*<\/span>\s*<\/div>)(\s*<p className="text-xs text-muted italic mt-2">\{calculations\.amountInWords\}<\/p>)/;
const totalNew = '$1' + '\n\n              {/* Payment status (My BillBook style) */}\n' +
  '              <label className="flex items-center justify-between gap-2 pt-2">\n' +
  '                <span className="text-muted text-sm">Amount Paid</span>\n' +
  '                <input\n' +
  '                  type="number"\n' +
  '                  value={form.amountPaid || ""}\n' +
  '                  onChange={(e) => updateField("amountPaid", Number(e.target.value) || 0)}\n' +
  '                  className="input w-28 text-right text-sm"\n' +
  '                  min="0"\n' +
  '                  step="0.01"\n' +
  '                  placeholder="0"\n' +
  '                />\n' +
  '              </label>\n' +
  '              {form.amountPaid > 0 && (\n' +
  '                <div className={`flex justify-between text-sm font-semibold ${form.amountPaid >= calculations.grandTotal ? "text-green-500" : "text-orange-500"}`}>\n' +
  '                  <span>Balance Due</span>\n' +
  '                  <span>\u20B9{Math.max(0, calculations.grandTotal - form.amountPaid).toFixed(2)}</span>\n' +
  '                </div>\n' +
  '              )}\n' + '$2';
if (totalRe.test(c)) { c = c.replace(totalRe, totalNew); changes++; console.log('3. amountPaid + balance added'); }

// 4. Mobile row: unit select after qty
const mobRe = /(value=\{line\.quantity\}\s*onChange=\{\(e\) => updateLine\(line\.id, \{ quantity: Number\(e\.target\.value\) \|\| 1 \}\)\}\s*className="input w-16 text-center text-sm"\s*min="0\.01"\s*step="0\.01"\s*\/>)/;
const mobNew = '$1\n' + [
  '                        <select',
  '                          value={line.unit}',
  '                          onChange={(e) => updateLine(line.id, { unit: e.target.value })}',
  '                          className="input w-16 text-center text-xs py-1"',
  '                          aria-label="Unit"',
  '                        >',
  '                          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}',
  '                        </select>',
].join('\n');
if (mobRe.test(c)) { c = c.replace(mobRe, mobNew); changes++; console.log('4. mobile unit select added'); }

fs.writeFileSync(f, c, 'utf8');
console.log(`DONE: ${changes} changes`);

/**
 * F-drive billinvoice: API route — save unit + discountType + amountPaid.
 * Idempotent. Run: node scripts/invoice-api-upgrade.cjs
 */
const fs = require('fs');
const f = 'F:/MY PROJECT BIZZAUTO VERSIONS/billinvoice/src/app/api/invoices/route.ts';
let c = fs.readFileSync(f, 'utf8');
let n = 0;

// 1. Lines create/update mapping — add unit + discountType after quantity line
const qtyRe = /(\n(\s+)quantity: line\.quantity,\n(\s+)unitPrice: line\.unitPrice,)/g;
c = c.replace(qtyRe, (m, a, ind1, ind2) => {
  n++;
  return `${a}${ind1}unit: line.unit ?? "PCS",${ind2}discountType: line.discountType ?? "percent",${ind2}unitPrice: line.unitPrice,`;
});

// 2. amountPaid — after amountInWords mapping (create + update spots)
const awRe = /(\n(\s+)amountInWords: clean\.amountInWords \?\? "",)/g;
c = c.replace(awRe, (m, a, ind) => {
  n++;
  return `${a}${ind}amountPaid: clean.amountPaid ?? 0,`;
});

fs.writeFileSync(f, c, 'utf8');
console.log(`API route fixes: ${n}`);
const unitCount = (c.match(/unit: line\.unit/g) || []).length;
const paidCount = (c.match(/amountPaid/g) || []).length;
console.log(`verify: unit mappings=${unitCount}, amountPaid refs=${paidCount}`);

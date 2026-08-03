/**
 * 生成一个最小但合法的 2 页 PDF（带 ASCII 文本层），写入 e2e/fixtures/sample.pdf。
 * 用法：node scripts/generate-sample-pdf.mjs
 * 生成的 PDF 供 pdf-preview.spec.ts 断言文本层与翻页。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const content1 = 'BT /F1 24 Tf 72 720 Td (Hello PDF - Page 1) Tj ET';
const content2 = 'BT /F1 24 Tf 72 720 Td (Hello PDF - Page 2) Tj ET';

const objects = [
  null,
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let out = '%PDF-1.4\n';
const offsets = [0];
for (let i = 1; i <= 7; i++) {
  offsets[i] = Buffer.byteLength(out, 'latin1');
  out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(out, 'latin1');
out += `xref\n0 8\n0000000000 65535 f \n`;
for (let i = 1; i <= 7; i++) {
  out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
out += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const outDir = join(__dirname, '..', 'e2e', 'fixtures');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'sample.pdf'), out);
console.log(`wrote ${join(outDir, 'sample.pdf')} (${Buffer.byteLength(out, 'latin1')} bytes)`);

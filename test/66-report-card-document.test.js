import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { drawReportCard, scaleLine } from '../src/services/documents/reportcard.js';

const look = { name: 'Delhi Public School, Rajkot', addressLine: 'Kalawad Road, Rajkot', contactLine: '0281 2345678', affiliationNo: '430123', color: '#1e3a8a', logo: null };
const scale = [{ min: 90, grade: 'A+' }, { min: 80, grade: 'A' }, { min: 33, grade: 'D' }, { min: 0, grade: 'F' }];
const base = { examName: 'Unit Test 1', yearName: '2026-2027', version: 1, name: 'Aadhya Banerjee', admissionNo: 'ADM1', classLine: 'Class 8 · A', rollNo: '07', issuedOn: '2026-11-02', generatedOn: '2026-11-25', totalObtained: 0, totalMax: 0, resultStatus: 'pass', scale, passPercentage: 33 };
const sub = (n, extra = {}) => ({ subject: n, components: [{ label: 'Written', value: 40, max: 50 }, { label: 'Practical', value: 20, max: 25 }], obtained: 60, max: 75, percentage: 80, grade: 'A', passed: true, ...extra });
const render = (d) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 0 }); const chunks = [];
  doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
  drawReportCard(doc, look, d); doc.end();
});

describe('the report card document', () => {
  it('the grading line is built from the school\'s own scale', () => {
    expect(scaleLine(scale, 33)).toBe('Grading: A+ 90–100  ·  A 80–89  ·  D 33–79  ·  F 0–32   |   Pass mark 33%');
  });
  it('draws on one A4 page for any amount of data: none, many, very long names, Hindi, absent, exempt, revised', async () => {
    const cases = {
      none: { ...base, subjects: [] },
      many: { ...base, subjects: Array.from({ length: 14 }, (_, i) => sub(`Subject number ${i + 1}`)) },
      long: { ...base, name: 'A Very Long Student Name That Goes On And On Without Stopping For Anyone', subjects: [sub('An extremely long subject name that cannot possibly fit in its own column of the table', { remarks: 'A remark that is also far too long to fit on one line of the table for sure' })], teacherRemark: 'x'.repeat(600) },
      mixed: { ...base, version: 3, correctionReason: 'Marks corrected', rank: 2, outOf: 40, subjects: [sub('हिन्दी'), sub('Sanskrit', { absent: true, obtained: null, percentage: null, grade: 'AB', passed: false }), sub('Art', { exempt: true, grade: 'EX', obtained: null, percentage: null })], resultStatus: 'fail', guardian: 'Mr. Parent', dob: '2013-03-14', attendanceLine: '93% · 27 of 29 days' },
    };
    for (const [name, d] of Object.entries(cases)) {
      const buf = await render(d);
      expect(buf.subarray(0, 4).toString(), name).toBe('%PDF');
      expect(buf.length, name).toBeGreaterThan(5000);
      expect((buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, `${name}: pages`).toBe(1);
    }
  });
});

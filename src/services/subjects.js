import { Subject, SubjectOffering } from '../models/index.js';
import { DEFAULT_COMPONENTS } from '../core/components.js';
import { escapeRegex, bad } from '../core/utils.js';

/**
 * Subjects are not maintained as a separate master list: they come into existence when a teacher is
 * given a subject (teacher profile or section assignment). Same name (case-insensitive) = same subject.
 */
export async function findOrCreateSubject(tenantId, rawName) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw bad('Enter the subject name');
  const existing = await Subject.findOne({ tenantId, name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (existing) {
    if (existing.status !== 'active') { existing.status = 'active'; await existing.save(); }
    return existing;
  }
  const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();
  const base = (name.includes(' ') ? name.split(' ').map((w) => w[0]).join('').toUpperCase().padEnd(3, letters.slice(1)).slice(0, 5) : letters.slice(0, 4)) || 'SUB';
  let code = base; let n = 2;
  while (await Subject.exists({ tenantId, code })) code = `${base}${n++}`;
  return Subject.create({ tenantId, name, code });
}

/** The class × subject × year row (periods per week, default exam fields) is created on first assignment. */
export async function ensureOffering(tenantId, { yearId, classId, subjectId }, weeklyPeriods = 5) {
  let offering = await SubjectOffering.findOne({ tenantId, yearId, classId, subjectId });
  if (!offering) {
    offering = await SubjectOffering.create({ tenantId, yearId, classId, subjectId, weeklyPeriods, assessment: { components: DEFAULT_COMPONENTS, passMarks: 33 } });
  }
  return offering;
}

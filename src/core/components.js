import { z } from 'zod';
import { bad } from './utils.js';

/**
 * An exam subject's marks are made of configurable fields ("components"), e.g.
 * [{label:'Written', max:40}, {label:'Oral', max:10}] — nothing is hard-coded to theory/practical.
 */
export const DEFAULT_COMPONENTS = [{ key: 'marks', label: 'Marks', max: 100 }];

export const componentsInput = z.array(z.object({
  label: z.string().trim().min(1, 'Field name is required').max(30),
  max: z.number().positive('Maximum must be above zero').max(1000),
})).min(1, 'Add at least one marks field').max(8, 'At most 8 marks fields');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'field';

/** Validate user-supplied fields and give each a stable key (derived from its label). */
export function normaliseComponents(list) {
  const seenLabels = new Set(); const seenKeys = new Set();
  return list.map((c) => {
    const label = String(c.label).trim();
    if (seenLabels.has(label.toLowerCase())) throw bad(`Marks field "${label}" is listed twice`);
    seenLabels.add(label.toLowerCase());
    let key = slug(label); let n = 2;
    while (seenKeys.has(key)) key = `${slug(label)}_${n++}`;
    seenKeys.add(key);
    const max = Number(c.max);
    if (!Number.isFinite(max) || max <= 0) throw bad(`Maximum for "${label}" must be above zero`);
    return { key, label, max };
  });
}

export const totalMax = (components = []) => components.reduce((n, c) => n + (c.max || 0), 0);
export const sameComponents = (a = [], b = []) => a.length === b.length && a.every((c, i) => c.key === b[i].key && c.max === b[i].max);

import { School } from '../models/index.js';
import { bad } from '../core/utils.js';

/**
 * Switches for features that can be turned on per school without a new release. Each has a default for every school; the Platform Admin can
 * override it for one school. Add a line here, then ask `flagOn(settings, 'name')` where the feature starts.
 */
export const FLAGS = {
  onlinePayments: { default: true, label: 'Online fee payment', description: 'Families can pay fees online (needs the payment gateway to be set up)' },
  periodAttendance: { default: false, label: 'Period-wise attendance', description: 'Each teacher marks their own period' },
  documentImages: { default: true, label: 'Stamps and signatures on documents', description: 'Receipts and payslips can carry uploaded stamps and signatures' },
};

/** Is the feature on for this school? `settings` is the school's settings object (ctx.settings). Unknown names are off. */
export function flagOn(settings, name) {
  const f = FLAGS[name];
  if (!f) return false;
  const v = settings?.flags?.[name];
  return typeof v === 'boolean' ? v : f.default;
}

export function flagsView(settings) {
  return Object.entries(FLAGS).map(([name, f]) => ({ name, label: f.label, description: f.description, default: f.default, value: flagOn(settings, name), overridden: typeof settings?.flags?.[name] === 'boolean' }));
}

export async function setFlags(schoolId, changes) {
  for (const k of Object.keys(changes)) if (!FLAGS[k]) throw bad(`Unknown feature switch "${k}"`);
  const school = await School.findById(schoolId);
  if (!school) return null;
  const flags = { ...(school.settings?.flags || {}) };
  for (const [k, v] of Object.entries(changes)) { if (v === null) delete flags[k]; else flags[k] = !!v; }
  school.set('settings', { ...(school.settings || {}), flags }); school.markModified('settings');
  await school.save();
  return flagsView(school.settings);
}

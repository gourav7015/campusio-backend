/**
 * The only classes a school can have: LKG, UKG and Class 1-12. In Classes 11 and 12 a school also has the streams (Medical, Non-Medical,
 * Commerce, Arts), each of them a class of its own with its own subjects and date sheet. The level (used to order classes and to decide
 * who is promoted into what) always comes from the name, never from user input.
 */
export const STREAMS = [
  { key: 'medical', label: 'Medical', note: 'Science with Biology (PCB)' }, { key: 'non_medical', label: 'Non-Medical', note: 'Science with Mathematics (PCM)' },
  { key: 'commerce', label: 'Commerce', note: 'Accountancy, Business Studies, Economics' }, { key: 'arts', label: 'Arts', note: 'Humanities' },
];
export const GRADES = [
  { name: 'LKG', level: -2 }, { name: 'UKG', level: -1 },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `Class ${i + 1}`, level: i + 1 })),
  ...[11, 12].flatMap((level) => STREAMS.map((st) => ({ name: `Class ${level} ${st.label}`, level, stream: st.key }))),
];
export const GRADE_NAMES = GRADES.map((g) => g.name);
export const levelOf = (name) => GRADES.find((g) => g.name === name)?.level;
export const streamOf = (name) => GRADES.find((g) => g.name === name)?.stream || null;

/** "class 8", "CLASS 8", "8", "lkg" -> "Class 8", "Class 8", "Class 8", "LKG"; anything else -> the input unchanged (then rejected). */
export function canonicalGrade(input) {
  if (typeof input !== 'string') return input;
  const t = input.trim().replace(/\s+/g, ' ');
  const plain = (x) => x.toLowerCase().replace(/[\s-]+/g, ' '); // "class 11 non medical" and "Class 11 Non-Medical" are the same
  const hit = GRADE_NAMES.find((n) => plain(n) === plain(t));
  if (hit) return hit;
  const m = /^(?:class\s*)?(\d{1,2})$/i.exec(t);
  return m ? `Class ${Number(m[1])}` : t;
}

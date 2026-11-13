/**
 * The only classes a school can have: LKG, UKG and Class 1-12. The level (used to order classes and to decide
 * who is promoted into what) always comes from the name, never from user input.
 */
export const GRADES = [
  { name: 'LKG', level: -2 }, { name: 'UKG', level: -1 },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `Class ${i + 1}`, level: i + 1 })),
];
export const GRADE_NAMES = GRADES.map((g) => g.name);
export const levelOf = (name) => GRADES.find((g) => g.name === name)?.level;

/** "class 8", "CLASS 8", "8", "lkg" -> "Class 8", "Class 8", "Class 8", "LKG"; anything else -> the input unchanged (then rejected). */
export function canonicalGrade(input) {
  if (typeof input !== 'string') return input;
  const t = input.trim().replace(/\s+/g, ' ');
  const hit = GRADE_NAMES.find((n) => n.toLowerCase() === t.toLowerCase());
  if (hit) return hit;
  const m = /^(?:class\s*)?(\d{1,2})$/i.exec(t);
  return m ? `Class ${Number(m[1])}` : t;
}

/** The dates a class runs on in an academic year: its own window when the school set one, else the whole school year. */
export function classSpan(year, classId) {
  const w = classId ? (year?.classWindows || []).find((x) => String(x.classId) === String(classId)) : null;
  return w ? { startDate: w.startDate, endDate: w.endDate, custom: true } : { startDate: year.startDate, endDate: year.endDate, custom: false };
}

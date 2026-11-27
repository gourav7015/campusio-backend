import { todayStr } from '../core/utils.js';

/**
 * How a school takes STUDENT attendance: once a day (the class teacher's register) or period by period (each period's teacher).
 * The way can change over time, so it is a schedule of changes, never a single switch: `attendance.modeSchedule` = [{ from, periodWise, at, byName }], oldest first.
 * Any date before the first entry is "once a day". Old schools that only have the former tick box (`periodWise: true`, no schedule) are period by period for every date.
 * Staff attendance is a different thing and never reads this.
 */
export const DEFAULT_DAY_RULE = { presentPct: 75, halfPct: 40 };

const sorted = (att) => [...(att?.modeSchedule || [])].sort((a, b) => a.from.localeCompare(b.from));

/** true when attendance for `date` is taken period by period. */
export function modeOn(att, date) {
  const sched = sorted(att);
  if (!sched.length) return !!att?.periodWise;
  let on = false;
  for (const e of sched) if (e.from <= date) on = !!e.periodWise;
  return on;
}

/** What the screens need to know about the way, as of `today`: the way now, since when, and a change that is already booked. */
export function modeSummary(att, today) {
  const sched = sorted(att);
  const now = modeOn(att, today);
  const past = sched.filter((e) => e.from <= today);
  const next = sched.find((e) => e.from > today) || null;
  return { periodWise: now, since: past.length ? past[past.length - 1].from : null, pending: next ? { from: next.from, periodWise: !!next.periodWise } : null, schedule: sched.map((e) => ({ from: e.from, periodWise: !!e.periodWise, byName: e.byName || '' })) };
}

/** The day rule with defaults filled in. */
export const dayRuleOf = (att) => ({ ...DEFAULT_DAY_RULE, ...(att?.dayRule || {}) });

/** The first date that period-by-period may start on in a school's own time: today if no daily register has been started yet, else tomorrow. */
export const todayOf = (settings, now) => todayStr(settings.timezone, now);

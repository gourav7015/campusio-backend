import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parse } from '../src/core/utils.js';
import { levelPatch } from '../src/modules/payroll/payroll.validation.js';

describe('an update schema never fills in defaults for fields that were not sent (zod 3 behaviour kept under zod 4)', () => {
  const body = z.object({
    name: z.string(), authority: z.enum(['state', 'central']).default('state'), tags: z.array(z.string()).default([]),
    nested: z.object({ on: z.boolean().default(true), n: z.number().default(5) }).default({ on: true, n: 5 }),
    rows: z.array(z.object({ label: z.string(), kind: z.enum(['a', 'b']).default('a') })).default([]),
  });
  it('partial() leaves a missing field missing, at every depth', () => {
    expect(parse(body.partial(), { name: 'x' })).toEqual({ name: 'x' });
    expect(parse(body.partial(), {})).toEqual({});
    expect(parse(body.partial(), { authority: 'central' })).toEqual({ authority: 'central' });
    // a nested partial too
    const outer = z.object({ policy: z.object({ on: z.boolean().default(true), n: z.number().default(5) }).partial() }).partial();
    expect(parse(outer, { policy: { n: 9 } })).toEqual({ policy: { n: 9 } });
  });
  it('a field that was sent is kept, and creating still gets every default', () => {
    expect(parse(body.partial(), { tags: ['a'], rows: [{ label: 'L' }] })).toEqual({ tags: ['a'], rows: [{ label: 'L', kind: 'a' }] }); // an array row is a new row: it gets its own defaults
    expect(parse(body, { name: 'x' })).toEqual({ name: 'x', authority: 'state', tags: [], nested: { on: true, n: 5 }, rows: [] });
    expect(parse(body.partial().extend({ status: z.string().optional() }), {})).toEqual({});
  });
  it('a payroll level patch does not wipe allowances that were not sent', () => {
    expect(parse(levelPatch, { name: 'Senior' })).toEqual({ name: 'Senior' });
  });
});

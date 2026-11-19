import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, reset, api, makeSuperAdmin, seedWorld } from './helpers.js';

describe('Timetable download: every section, one class, or one section; PDF or CSV', () => {
  let root; let W;
  const get = (qs) => api().get(`/api/school/timetable/export?${qs}`).set(W.h).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  beforeAll(async () => {
    await setup(); await reset(); root = await makeSuperAdmin(); W = await seedWorld(root, 'ttd');
    const put = (sec, day, p, asg, room) => api().post('/api/school/timetable/entries').set(W.h).send({ sectionId: sec, day, periodId: W.periods[p]._id, assignmentId: asg, room });
    expect((await put(W.sec8A._id, 1, 0, W.asgM._id, '101')).status).toBe(201);
    expect((await put(W.sec8A._id, 2, 1, W.asgE._id, '101')).status).toBe(201);
  });
  afterAll(teardown);

  it('a CSV lists every lesson with class, section, day, period, times, subject, teacher and room', async () => {
    const r = await get(`format=csv&sectionId=${W.sec8A._id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toContain('timetable-class-8-a.csv');
    const lines = r.body.toString().split('\n');
    expect(lines[0]).toBe('Class,Section,Day,Period,Start,End,Subject,Teacher,Room');
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).join('\n')).toContain('Class 8,A,Monday,Period 1');
    expect(lines.join('\n')).toContain('Mathematics,Mr Sharma,101');
    expect(lines.join('\n')).toContain('English,Mrs Gupta');
  });

  it('a PDF has a page per section; a class or the whole school is chosen by the filters', async () => {
    const one = await get(`sectionId=${W.sec8A._id}`);
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toMatch(/application\/pdf/);
    expect(one.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(one.headers['content-disposition']).toContain('timetable-class-8-a.pdf');
    const pages = (b) => (b.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    expect(pages(one.body)).toBe(1);
    const cls = await get(`classId=${W.c8._id}`);
    expect(pages(cls.body)).toBe(2); // 8-A and 8-B
    expect(cls.headers['content-disposition']).toContain('timetable-class-8.pdf');
    const all = await get('format=pdf');
    expect(pages(all.body)).toBe(2); // Class 9 has no sections this year
    expect(all.headers['content-disposition']).toContain('timetable-all-sections.pdf');
    const csvAll = await get('format=csv');
    expect(csvAll.body.toString().split('\n')).toHaveLength(3); // only the two lessons are filled in
  });

  it('bad requests and other people are refused', async () => {
    expect((await get('format=docx')).status).toBe(400);
    expect((await get('sectionId=nope')).status).toBe(400);
    expect((await get(`sectionId=${'0'.repeat(24)}`)).status).toBe(404);
    expect((await api().get('/api/school/timetable/export').set(W.teacher1.h)).status).toBe(403);
    expect((await api().get('/api/school/timetable/export')).status).toBe(401);
  });
});

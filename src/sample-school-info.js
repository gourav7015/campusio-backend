/**
 * Fills a school's "School information" page with sample content: its story, the principal's message, extra sections, a gallery of pictures
 * and the licences and approvals it holds. It goes through the app's own API, exactly like the School Admin would, so it works against
 * any running server. Anything already filled in is left alone, so it is safe to run twice.
 *
 *   node src/sample-school-info.js http://localhost:4000 admin@dpsr.school Admin@12345
 *
 * Test data only: never run it for a real school.
 */
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';

const [BASE = 'http://localhost:4000', LOGIN = 'admin@dpsr.school', PASSWORD = 'Admin@12345'] = process.argv.slice(2);

// ── a tiny PNG writer, so the sample pictures need no image library ──
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = pixel(x, y); const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; } }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const W = 960; const H = 600;
/** Simple illustrated scenes: a sky, the ground, and one thing that tells you what the picture is about. */
const SCENES = {
  building: (x, y) => { // the school building
    const sky = mix([120, 180, 235], [220, 238, 252], y / H); if (y > 470) return mix([86, 150, 80], [62, 120, 60], (y - 470) / 130);
    if (x > 220 && x < 740 && y > 210 && y < 470) { if (y < 250 && x > 400 && x < 560) return [196, 86, 62]; const win = (x - 250) % 80 < 44 && (y - 250) % 70 < 40 && y > 250 && y < 440; return win ? [255, 232, 160] : [236, 214, 170]; }
    if (x > 400 && x < 560 && y > 380 && y < 470) return [120, 72, 44];
    if (Math.hypot(x - 840, y - 110) < 50) return [255, 214, 84];
    return sky;
  },
  playground: (x, y) => { // a field with goalposts
    if (y < 260) return mix([130, 190, 240], [210, 232, 250], y / 260); const g = mix([66, 150, 74], [46, 120, 56], (y - 260) / 340);
    if (Math.abs(x - 480) < 3 && y > 300) return [255, 255, 255]; if (Math.hypot(x - 480, y - 440) < 62 && Math.hypot(x - 480, y - 440) > 57) return [255, 255, 255];
    if ((x > 150 && x < 156 || x > 804 && x < 810) && y > 330 && y < 430) return [250, 250, 250]; if (y > 330 && y < 336 && x > 150 && x < 810 && (x < 160 || x > 800)) return [250, 250, 250];
    return g;
  },
  library: (x, y) => { // shelves of books
    const wall = [92, 64, 44]; if (y % 120 < 12) return [60, 40, 28]; const shelf = Math.floor(y / 120); const book = Math.floor(x / 34);
    const palette = [[198, 70, 62], [64, 112, 190], [226, 170, 60], [84, 160, 110], [150, 96, 180], [220, 120, 70]]; const hgt = 70 + ((book * 37 + shelf * 17) % 36);
    return (x % 34 > 3 && y % 120 > 12 && y % 120 < 12 + hgt + 20) ? palette[(book + shelf * 2) % palette.length] : wall;
  },
  lab: (x, y) => { // a bench with flasks
    const wall = mix([226, 238, 246], [196, 214, 230], y / H); if (y > 400) return mix([150, 120, 92], [120, 92, 68], (y - 400) / 200);
    for (const [cx, col] of [[240, [90, 180, 230]], [420, [240, 120, 120]], [600, [120, 210, 140]], [760, [240, 200, 90]]]) {
      if (y > 250 && y < 400 && Math.abs(x - cx) < 40 + (y - 250) * 0.25 && !(y < 300 && Math.abs(x - cx) > 14)) return y > 330 ? col : [250, 252, 255];
    }
    return wall;
  },
  stage: (x, y) => { // annual day: a stage with curtains
    if (y > 470) return [120, 70, 46]; if (x < 190 || x > 770) return (Math.floor(x / 24) % 2) ? [150, 28, 44] : [120, 20, 36]; if (y < 90) return [150, 28, 44];
    const spot = Math.hypot(x - 480, y - 330); return spot < 190 ? mix([255, 236, 170], [60, 50, 90], spot / 190) : [48, 40, 86];
  },
  track: (x, y) => { // sports day: running track lanes
    const lane = Math.floor((y - 80) / 62); if (y < 80) return mix([140, 195, 240], [210, 232, 250], y / 80); if (y > 460) return [70, 150, 80];
    if ((y - 80) % 62 < 4) return [255, 255, 255]; return lane % 2 ? [196, 86, 62] : [210, 100, 74];
  },
};
const PICTURES = [
  ['building', 'The main school building'], ['playground', 'The playground and football field'], ['library', 'The library: over 12,000 books'],
  ['lab', 'The science laboratory'], ['stage', 'Annual Day on the school stage'], ['track', 'Sports Day: the 200 metre race'],
];

/** A one-page sample certificate, so each licence has a copy to open. */
const certificate = (title, number, authority) => new Promise((resolve) => {
  const doc = new PDFDocument({ size: 'A4', margin: 60 }); const parts = [];
  doc.on('data', (d) => parts.push(d)); doc.on('end', () => resolve(Buffer.concat(parts)));
  doc.rect(40, 40, doc.page.width - 80, doc.page.height - 80).lineWidth(2).stroke('#444');
  doc.fontSize(12).fillColor('#666').text('SAMPLE DOCUMENT FOR TESTING', 60, 70, { align: 'center' });
  doc.moveDown(3).fontSize(26).fillColor('#111').text(title, { align: 'center' });
  doc.moveDown(1).fontSize(14).text(`Issued by ${authority}`, { align: 'center' });
  doc.moveDown(2).fontSize(16).text(`Certificate no. ${number}`, { align: 'center' });
  doc.moveDown(6).fontSize(11).fillColor('#666').text('This page was generated for testing. It is not a real certificate.', { align: 'center' });
  doc.end();
});

// ── talk to the app ──
let token = '';
const call = async (method, path, body, form) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(form ? {} : { 'Content-Type': 'application/json' }) }, body: form || (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.error || ''}`);
  return data;
};
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function main() {
  const login = await call('POST', '/api/auth/login', { loginId: LOGIN, password: PASSWORD, portal: 'admin' });
  token = login.token;
  const info = await call('GET', '/api/school/school-info');
  const name = info.name || 'the school';
  const has = info.profile;

  if (!has.about) {
    await call('PUT', '/api/school/school-info', {
      tagline: 'Learning with curiosity, growing with character',
      about: `${name} began in 1998 with 120 children in a rented building and a belief that every child can do well when teachers know them by name. Today more than two thousand students learn here, from the first day of kindergarten to the board examinations.\n\nWe teach the national curriculum with a lot of practical work: every child from Class 3 spends two periods a week in the science and computer labs, reads a book a fortnight from our library, and takes part in at least one sport and one club. Our teachers meet every month to talk about each class and each child who needs extra help.`,
      address: '12, Race Course Road, Rajkot, Gujarat 360001', phone: '+91 281 555 0142', email: 'office@school.example', website: 'www.school.example',
      board: 'CBSE', affiliationNo: '2430118', established: '1998', principalName: 'Dr. Meera Kulkarni',
      principalMessage: 'Dear parents and students,\n\nA school is not a building but a community. Here, we ask every child three questions each day: what did you learn, who did you help, and what will you try tomorrow? We keep our classes small enough for teachers to notice each child, and we measure success by how confident and kind our students become, as well as by their marks.\n\nPlease visit us, ask questions and tell us how we can do better.\n\nDr. Meera Kulkarni, Principal',
      sections: [
        { title: 'Our mission', body: 'To give every child a strong start in reading, numbers and curiosity, and to send young people into the world who are honest, capable and kind.' },
        { title: 'Facilities', body: 'Science, computer and mathematics labs; a library of over 12,000 books; a football field, basketball and cricket nets; a music room; a medical room with a visiting doctor every Tuesday and Friday; CCTV and a guarded campus; and a fleet of 30 GPS-tracked school buses.' },
        { title: 'Admissions', body: 'Admissions open every January for LKG and for Classes 1 to 9. Please bring the child\'s birth certificate, previous report card (from Class 2 upwards), and two photographs to the school office between 9 am and 1 pm, Monday to Saturday.' },
        { title: 'Achievements', body: '96% of our Class 10 students scored above 75% last year. Our under-14 football team were district champions, and our robotics club reached the state finals in 2026.' },
        { title: 'School timings', body: 'Classes: 8:00 am to 2:30 pm (Monday to Friday) and 8:00 am to 12:30 pm on Saturday. The office is open from 8:30 am to 3:30 pm.' },
      ],
    });
    console.log('✓ story, principal\'s message and five sections added');
  } else console.log('• the page already has its story: left as it is');

  if (!(has.gallery || []).length) {
    for (const [scene, caption] of PICTURES) {
      const form = new FormData(); form.append('caption', caption);
      form.append('file', new Blob([png(W, H, SCENES[scene])], { type: 'image/png' }), `${scene}.png`);
      await call('POST', '/api/school/school-info/gallery', null, form);
    }
    console.log(`✓ ${PICTURES.length} gallery pictures added`);
  } else console.log('• the gallery already has pictures: left as it is');

  const have = new Set((info.licenses || []).map((l) => l.name));
  const LICENCES = [
    { name: 'CBSE affiliation', authority: 'central', issuedBy: 'Central Board of Secondary Education', number: 'AFF/2430118', issuedOn: '2019-04-01', validUntil: inDays(900), notes: 'Senior secondary affiliation, renewed every five years.' },
    { name: 'State recognition', authority: 'state', issuedBy: 'Gujarat Education Department', number: 'GJ/EDU/RJK/1998/044', issuedOn: '1998-06-15', notes: 'Permanent recognition, no expiry date.' },
    { name: 'No Objection Certificate (NOC)', authority: 'state', issuedBy: 'State Government', number: 'NOC/GJ/2430118', issuedOn: '2018-03-10', validUntil: inDays(1500) },
    { name: 'Fire safety certificate', authority: 'local', issuedBy: 'Rajkot Municipal Fire Department', number: 'FS/RMC/2025/7781', issuedOn: inDays(-345), validUntil: inDays(20), notes: 'Renewal is due: the inspection is booked.' },
    { name: 'Building safety certificate', authority: 'local', issuedBy: 'Rajkot Municipal Corporation', number: 'BSC/RMC/2024/3302', issuedOn: inDays(-760), validUntil: inDays(-30), notes: 'Expired: the renewal application is with the corporation.' },
    { name: 'Trust registration', authority: 'other', issuedBy: 'Charity Commissioner, Gujarat', number: 'E/1234/Rajkot', issuedOn: '1997-11-02' },
    { name: 'Water quality test report', authority: 'local', issuedBy: 'Rajkot Public Health Laboratory', number: 'WQ/2026/0412', issuedOn: inDays(-100), validUntil: inDays(265) },
  ];
  let added = 0;
  for (const l of LICENCES) {
    if (have.has(l.name)) continue;
    const made = await call('POST', '/api/school/licenses', l);
    const form = new FormData();
    form.append('file', new Blob([await certificate(l.name, l.number, l.issuedBy)], { type: 'application/pdf' }), `${l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`);
    await call('POST', `/api/school/licenses/${made._id}/file`, null, form);
    added++;
  }
  console.log(added ? `✓ ${added} licences added, each with a copy to open` : '• the licences are already there: left as they are');
}
main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });

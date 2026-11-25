import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The rule that keeps pictures and documents visible on the live site: every upload goes through `saveFile`, which writes the bytes to the database (or R2)
 * and removes the temporary copy. A route that took the upload and kept it on the server's own disk would work on one computer and show broken pictures everywhere else.
 */
const SRC = path.resolve(import.meta.dirname, '../src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const files = walk(SRC).filter((f) => !f.includes(`${path.sep}scripts${path.sep}`));

describe('uploads are kept in the database, never on the server disk', () => {
  it('File records are created in one place only: saveFile', () => {
    const makers = files.filter((f) => /\bFile\.(create|insertMany)\(|new File\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
    expect(makers).toEqual(['services/files.js']);
  });
  it('every route that accepts an upload saves it with saveFile', () => {
    const bad = [];
    for (const f of files.filter((x) => x.endsWith('.routes.js'))) {
      const txt = fs.readFileSync(f, 'utf8');
      const uploads = (txt.match(/upload\.(single|array|any|fields)\(/g) || []).length;
      const saves = (txt.match(/\bsaveFile\(/g) || []).length;
      if (uploads && saves < 1) bad.push(`${path.relative(SRC, f)}: ${uploads} upload route(s), no saveFile`);
    }
    expect(bad).toEqual([]);
  });
  it('the multer temporary copy is always removed after the bytes are stored', () => {
    const txt = fs.readFileSync(path.join(SRC, 'services/files.js'), 'utf8');
    expect(txt).toMatch(/storeBytes\([\s\S]*unlink\(file\.path\)/);
  });
});

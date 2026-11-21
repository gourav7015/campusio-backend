// Writes docs/API.md: every route the API answers, grouped by portal and file, read from the source. Run:  npm run docs:api
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'modules');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.routes\.js$|^client-errors\.js$/.test(f.name)) files.push(p); } })(modules);
const re = /\b(\w+)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
let md = `# API reference

Generated from the source by \`npm run docs:api\` (do not edit by hand). Every address also works as \`/api/v1/...\`.
Routes are listed per file; the file is mounted under a portal prefix in \`src/modules/index.js\` (\`/api/school\`, \`/api/teacher\`, \`/api/student\`, \`/api/finance\`, \`/api/library\`, \`/api/transport\`, \`/api/staff\`, \`/api/platform\`, \`/api/auth\`). Bodies are validated with zod in the matching \`*.validation.js\` or at the top of the routes file. Errors are \`{ error, code, details? }\`; a \`Idempotency-Key\` header makes a POST safe to repeat.\n`;
let total = 0;
for (const f of files.sort()) {
  const src = fs.readFileSync(f, 'utf8'); const rows = [];
  for (const m of src.matchAll(re)) { if (['app', 'res', 'req'].includes(m[1])) continue; rows.push(`| ${m[2].toUpperCase()} | \`${m[3]}\` |`); }
  if (!rows.length) continue;
  total += rows.length;
  md += `\n## ${path.relative(modules, f)}\n\n| Method | Path |\n|---|---|\n${[...new Set(rows)].join('\n')}\n`;
}
md += `\n_${total} routes in ${files.length} files._\n`;
fs.mkdirSync(path.resolve(root, '../docs'), { recursive: true });
fs.writeFileSync(path.resolve(root, '../docs/API.md'), md);
console.log(`docs/API.md written: ${total} routes`);

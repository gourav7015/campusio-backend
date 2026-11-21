/**
 * Zod 4 fills in a field's default when an "update" schema (built with .partial()) leaves the field out, which would reset saved values to their
 * defaults on every PATCH. The code was written for zod 3, where a missing field in a partial schema simply stays missing.
 *
 * After parsing, any field that is `optional(default(x))` (that is what .partial() makes of a field with a default) and was not in the input is
 * removed from the result again, at every depth. A field written as a plain `.default(x)` is untouched, so creating still gets its defaults.
 */
const defOf = (s) => s?._zod?.def;
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function unwrap(s) { // optional / nullable / default / readonly wrappers down to the real schema
  let d = defOf(s);
  while (d && ['optional', 'nullable', 'default', 'prefault', 'readonly'].includes(d.type) && d.innerType) { s = d.innerType; d = defOf(s); }
  return s;
}

export function stripPartialDefaults(schema, input, output) {
  const s = unwrap(schema); const d = defOf(s);
  if (!d) return output;
  if (d.type === 'object' && isPlainObject(output) && isPlainObject(input)) {
    for (const [key, field] of Object.entries(d.shape || {})) {
      const fd = defOf(field);
      if (!(key in input) && fd?.type === 'optional' && defOf(fd.innerType)?.type === 'default') { delete output[key]; continue; }
      if (key in output && key in input) output[key] = stripPartialDefaults(field, input[key], output[key]);
    }
  } else if (d.type === 'array' && Array.isArray(output) && Array.isArray(input)) {
    output.forEach((o, i) => { output[i] = stripPartialDefaults(d.element, input[i], o); });
  }
  return output;
}

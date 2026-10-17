import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from './errors.mjs';

// The `suggest` and `enrich` keys of <dir>/config.json. They are validated here and nowhere else, so a typo in them
// never breaks cli/local-config.mjs loadLocalConfig (import, add, review). No npm dependencies.

export const SUGGEST_DEFAULTS = Object.freeze({
  suggest: {
    enabled: false,
    hosted: false,
    url: null,
    maxSuggestions: 2,
    deadlineMs: { local: 1000, hosted: 3000 },
    rule: { maxRanks: null, minSimilarity: null, localMinGap: null },
    includeUnreviewed: true,
    retiredPlugins: [],
    disabledPaths: [],
  },
  enrich: { enabled: false, model: 'openai/gpt-5-mini' },
});

// Always retired, whatever the file says.
const CODE_RETIRED_PLUGINS = ['superpowers@superpowers-marketplace'];
const DEADLINE_MIN_MS = 200;
const DEADLINE_MAX_MS = 8000;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = (v) => structuredClone(v);

const configFile = (dir) => path.join(dir, 'config.json');

// Parsed <dir>/config.json; a missing file is {}.
async function readConfigObject(dir) {
  const file = configFile(dir);
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new UserError(`${file}: not a valid JSON object`);
  }
  if (!isObject(data)) throw new UserError(`${file}: not a valid JSON object`);
  return data;
}

// One validator per key. Each returns the value to keep or throws a UserError naming the key.
function validator(file) {
  const fail = (key, want) => new UserError(`${file}: "${key}" must be ${want}`);
  const bool = (v, key) => { if (typeof v !== 'boolean') throw fail(key, 'true or false'); return v; };
  const num = (v, key) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw fail(key, 'a number'); return v; };
  const numOrNull = (v, key) => (v === null ? null : num(v, key));
  const strings = (v, key) => {
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw fail(key, 'an array of strings');
    return [...v];
  };
  const section = (v, key) => { if (!isObject(v)) throw fail(key, 'an object'); return v; };
  const url = (v, key) => {
    if (v === null) return null;
    let parsed;
    try { parsed = typeof v === 'string' ? new URL(v) : null; } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) throw fail(key, 'null or an absolute http(s) URL');
    return v;
  };
  const maxSuggestions = (v, key) => {
    if (!Number.isInteger(v) || v < 1) throw fail(key, 'a positive integer');
    return v;
  };
  const deadline = (v, key) => Math.min(DEADLINE_MAX_MS, Math.max(DEADLINE_MIN_MS, num(v, key)));
  const nonEmptyString = (v, key) => { if (typeof v !== 'string' || !v) throw fail(key, 'a non-empty string'); return v; };

  // Merges `given` over `defaults` with `schema` ({ key: validator | nested schema }); unknown keys are ignored.
  const apply = (given, defaults, schema, prefix) => {
    const out = {};
    for (const [key, rule] of Object.entries(schema)) {
      const name = `${prefix}.${key}`;
      if (!Object.hasOwn(given, key)) { out[key] = clone(defaults[key]); continue; }
      out[key] = typeof rule === 'function'
        ? rule(given[key], name)
        : apply(section(given[key], name), defaults[key], rule, name);
    }
    return out;
  };

  const suggestSchema = {
    enabled: bool,
    hosted: bool,
    url,
    maxSuggestions,
    deadlineMs: { local: deadline, hosted: deadline },
    rule: { maxRanks: numOrNull, minSimilarity: numOrNull, localMinGap: numOrNull },
    includeUnreviewed: bool,
    retiredPlugins: strings,
    disabledPaths: strings,
  };
  const enrichSchema = { enabled: bool, model: nonEmptyString };

  return (data) => {
    const given = (key) => (Object.hasOwn(data, key) ? section(data[key], key) : {});
    const suggest = apply(given('suggest'), SUGGEST_DEFAULTS.suggest, suggestSchema, 'suggest');
    const enrich = apply(given('enrich'), SUGGEST_DEFAULTS.enrich, enrichSchema, 'enrich');
    suggest.retiredPlugins = [...new Set([...CODE_RETIRED_PLUGINS, ...suggest.retiredPlugins])];
    return { suggest, enrich };
  };
}

// Defaults merged under the file's `suggest` and `enrich`. A missing file or key gives the defaults; a wrong type
// throws a UserError naming the key (e.g. suggest.deadlineMs.local). deadlineMs is clamped to [200, 8000].
export async function loadSuggestConfig(dir) {
  return validator(configFile(dir))(await readConfigObject(dir));
}

// Plain objects merge key by key; anything else (arrays included) in the patch replaces.
function merge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return clone(patch);
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = Object.hasOwn(base, key) ? merge(base[key], value) : clone(value);
  return out;
}

// Merges `patch` into the file's `suggest` / `enrich` and writes the whole file back atomically (temp file in the
// same directory, mode 0600, rename), keeping every other top-level key and sub-key. The merged result is validated
// first: an invalid patch, or a file that is not a JSON object, throws a UserError and writes nothing.
export async function editSuggestConfig(dir, patch) {
  const data = await readConfigObject(dir);
  const next = { ...data };
  for (const key of ['suggest', 'enrich']) {
    if (patch[key] !== undefined) next[key] = merge(Object.hasOwn(data, key) ? data[key] : {}, patch[key]);
  }
  validator(configFile(dir))(next);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `config.json.${process.pid}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, configFile(dir));
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

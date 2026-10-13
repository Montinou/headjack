import { readFile, writeFile, rename, mkdir, realpath, lstat, stat, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../lib/errors.mjs';

async function resolveTarget(file) {
  try { return await realpath(file); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    let st = null;
    try { st = await lstat(file); } catch (e2) { if (e2.code !== 'ENOENT') throw e2; }
    if (st?.isSymbolicLink()) throw new UserError(`${file} is a broken symlink; not touching it`);
    return file;
  }
}

// enabledPlugins of a settings file; {} when it does not exist. Malformed → UserError (same wording as setPluginsEnabled).
export async function readEnabledPlugins(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  let data;
  try { data = JSON.parse(raw); } catch { throw new UserError(`${file} is not valid JSON; not touching it`); }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new UserError(`${file} is not a JSON object; not touching it`);
  return data.enabledPlugins ?? {};
}

export async function setPluginsEnabled(file, updates) {
  const target = await resolveTarget(file);
  let data = {};
  let raw = null;
  try { raw = await readFile(target, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (raw !== null) {
    try { data = JSON.parse(raw); } catch { throw new UserError(`${file} is not valid JSON; not touching it`); }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new UserError(`${file} is not a JSON object; not touching it`);
  }
  data.enabledPlugins = { ...(data.enabledPlugins ?? {}), ...updates };
  await mkdir(path.dirname(target), { recursive: true });
  const mode = raw !== null ? (await stat(target)).mode & 0o777 : undefined;
  const tmp = `${target}.${process.pid}.headjack.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', mode === undefined ? undefined : { mode });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

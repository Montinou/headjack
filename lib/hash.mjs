import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED = new Set(['.git', '.DS_Store']);

export function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function listFiles(root) {
  const out = [];
  async function walk(rel) {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`symlink not allowed: ${r}`);
      if (e.isDirectory()) {
        await walk(r);
      } else if (e.isFile()) {
        const abs = path.join(root, r);
        const st = await lstat(abs);
        out.push({ path: r, mode: st.mode & 0o111 ? 0o755 : 0o644, data: await readFile(abs) });
      }
    }
  }
  await walk('');
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

export function hashFiles(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => comparePaths(a.path, b.path))) {
    const content = createHash('sha256').update(f.data).digest('hex');
    h.update(`${f.path}\0${f.mode.toString(8).padStart(4, '0')}\0${content}\n`);
  }
  return h.digest('hex');
}

export async function hashDir(root) {
  return hashFiles(await listFiles(root));
}

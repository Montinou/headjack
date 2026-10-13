import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules']);

export async function findSkillDirs(root, maxDepth = 6) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) { out.push(dir); return; }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return out.sort();
}

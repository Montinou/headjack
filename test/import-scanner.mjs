import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

// Module specifiers in a source file: static `import … from`, `export … from`, side-effect `import 'x'` and
// dynamic `import('x')` with a string literal.
export function specifiers(src) {
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]));
}

// Static import graph from an entry file (relative to `root`, the repo root by default): relative specifiers are followed, the
// rest are returned. `root` lets a guard walk a checkout of another git ref.
export async function importGraph(entry, { root = ROOT } = {}) {
  const seen = new Set();
  const external = new Set();
  const walk = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await readFile(file, 'utf8');
    for (const spec of specifiers(src)) {
      if (spec.startsWith('.')) await walk(path.resolve(path.dirname(file), spec));
      else external.add(spec);
    }
  };
  await walk(path.join(root, entry));
  return { files: [...seen].map((f) => path.relative(root, f)), external: [...external] };
}

// A line the static closure scan cannot follow: a computed import(), any require( or createRequire.
export const escapesScan = (line) => /\bimport\s*\(\s*(?![\s'"])|\brequire\s*\(|\bcreateRequire\b/.test(line);

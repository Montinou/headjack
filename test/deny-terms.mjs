// Deny-list helpers shared by test/unit/no-personal-data.test.mjs and any script that checks instance values. Node built-ins
// only, so a script can import this file without installing packages. Nothing here ever returns or prints a term in a
// message: a hit is `<path>:<line>`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_DENY_FILE = ['.config', 'claude-methodology', 'public-export-deny.txt'];

export const fold = (text) => text.normalize('NFKC').toLowerCase();

// One term per line: trimmed, blank lines and `#` lines dropped, case folded, duplicates collapsed.
export function parseDenyTerms(text) {
  const terms = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const term = raw.trim();
    if (term === '' || term.startsWith('#')) continue;
    terms.add(fold(term));
  }
  return [...terms];
}

// Where the terms come from: HEADJACK_DENY_LIST when its trimmed value is non-empty (GitHub Actions hands a missing secret to a
// fork pull request as ""), otherwise the file named by PUBLIC_EXPORT_DENY or the default under `home`. null when neither exists.
export function resolveDenySource({ env, home }) {
  const list = env.HEADJACK_DENY_LIST;
  if (typeof list === 'string' && list.trim() !== '') return { kind: 'env', terms: parseDenyTerms(list) };
  const file = env.PUBLIC_EXPORT_DENY || path.join(home, ...DEFAULT_DENY_FILE);
  if (!existsSync(file)) return null;
  return { kind: 'file', terms: parseDenyTerms(readFileSync(file, 'utf8')), path: file };
}

// `git ls-files` for `root`, keeping the files that exist on disk (a staged deletion is listed until committed).
export function trackedFiles(root) {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  return listed.filter((rel) => existsSync(path.join(root, rel))).sort();
}

// Text as UTF-8; a binary file (a NUL byte) is read both as UTF-8 and byte for byte, so an ASCII term in its metadata counts.
function linesOf(root, rel) {
  const data = readFileSync(path.join(root, rel));
  const texts = data.includes(0) ? [data.toString('utf8'), data.toString('latin1')] : [data.toString('utf8')];
  return texts.map((text) => text.split('\n'));
}

// `<path>:<line>` of every line in `files` that holds a term, case-insensitively, in file then line order.
export function scanTree({ root, files, terms }) {
  const hits = new Set();
  for (const rel of files) {
    for (const lines of linesOf(root, rel)) {
      lines.forEach((line, index) => {
        const folded = fold(line);
        if (terms.some((term) => folded.includes(term))) hits.add(`${rel}:${index + 1}`);
      });
    }
  }
  return [...hits];
}

export const hitMessage = (hits) => `instance values from the deny list found at:\n${hits.join('\n')}`;

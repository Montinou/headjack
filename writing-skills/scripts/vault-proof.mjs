#!/usr/bin/env node
// The proof tools of the writing-skills skill. Node built-ins only; needs Node 22.16+ (local vaults use node:sqlite).
//
//   node vault-proof.mjs scratch <dir> [--copy-vault] <skill-dir>…
//     Builds a throwaway sandbox in <dir>: a temp HOME, a local vault, a `headjack` wrapper that appends every call to
//     <dir>/commands.log, and <dir>/env.sh to source before each command. --copy-vault first copies the user's local
//     vault ($HEADJACK_HOME or ~/.headjack, read-only) so the skill competes with the real catalog. Each <skill-dir> is
//     then published with `headjack review` (answers: not work content, approve). Nothing outside <dir> changes.
//
//   node vault-proof.mjs check <dir> <slug> <requests-file>
//     One request per line: "+ <request>" must find <slug> first in `headjack search` and get it suggested by
//     `headjack suggest`; "- <request>" must do neither. Blank lines and "#" lines are skipped.
//     Exit 0 when every line passes, 1 naming each failure, 2 on usage.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

class Usage extends Error {}

// The CLI next to this skill (the Headjack plugin ships cli/ beside writing-skills/), else `headjack` on PATH.
function headjackCommand() {
  const bundled = path.resolve(HERE, '../../cli/headjack.mjs');
  if (existsSync(bundled)) return [process.execPath, bundled];
  return ['headjack'];
}

// The sandbox's environment: every HEADJACK_* of the caller removed, then pointed at the sandbox.
function sandboxEnv(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HEADJACK_')));
  return { ...env, HOME: path.join(dir, 'home'), HEADJACK_HOME: path.join(dir, 'state'), HEADJACK_MODE: 'local' };
}

function runCli(dir, args, input) {
  const [cmd, ...pre] = headjackCommand();
  return new Promise((resolve) => {
    const child = execFile(cmd, [...pre, ...args], { env: sandboxEnv(dir), maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

// Copies the user's local vault with VACUUM INTO, which only reads the source.
async function copyVault(dest) {
  const source = path.join(process.env.HEADJACK_HOME || path.join(os.homedir(), '.headjack'), 'vault.db');
  if (!existsSync(source)) throw new Error(`no local vault at ${source} to copy (hosted users: run without --copy-vault)`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare('vacuum into ?').run(dest);
    const { n } = db.prepare("select count(*) as n from skills where current_version_id is not null").get();
    return { source, n };
  } finally {
    db.close();
  }
}

async function scratch(argv) {
  const copy = argv.includes('--copy-vault');
  const [dir, ...skills] = argv.filter((a) => a !== '--copy-vault');
  if (!dir || skills.length === 0) throw new Usage();
  const box = path.resolve(dir);
  if (existsSync(box) && (await readdir(box)).length) throw new Error(`${box} is not empty`);
  for (const d of ['home', 'state', 'bin']) await mkdir(path.join(box, d), { recursive: true });
  if (copy) {
    const { source, n } = await copyVault(path.join(box, 'state', 'vault.db'));
    console.log(`copied ${source} (${n} skills)`);
  }
  const log = path.join(box, 'commands.log');
  await writeFile(log, '');
  const [cmd, ...pre] = headjackCommand();
  const wrapper = path.join(box, 'bin', 'headjack');
  await writeFile(wrapper, `#!/bin/sh\nprintf 'headjack %s\\n' "$*" >> ${q(log)}\nexec ${[cmd, ...pre].map(q).join(' ')} "$@"\n`);
  await chmod(wrapper, 0o755);
  const env = sandboxEnv(box);
  await writeFile(path.join(box, 'env.sh'), [
    `export HOME=${q(env.HOME)}`, `export HEADJACK_HOME=${q(env.HEADJACK_HOME)}`, 'export HEADJACK_MODE=local',
    'unset HEADJACK_URL HEADJACK_TOKEN', `export PATH=${q(path.join(box, 'bin'))}:"$PATH"`, '',
  ].join('\n'));
  let failed = false;
  for (const skill of skills) {
    const r = await runCli(box, ['review', path.resolve(skill)], 'n\na\nscratch proof\n');
    const published = /✓ (\S+) published/.exec(r.stdout);
    const unchanged = /^== (\S+) .*\n[\s\S]*no changes from the approved version/m.exec(r.stdout);
    if (published) console.log(`${published[1]}: approved`);
    else if (unchanged) console.log(`${unchanged[1]}: approved (unchanged)`);
    else {
      failed = true;
      console.log(`${skill}: not approved\n${r.stdout}${r.stderr}`.trimEnd());
    }
    // review prints each flag as "[severity] rule file[:line] …", sometimes on the same line as a piped prompt.
    for (const m of r.stdout.matchAll(/\[(high|medium|low)\][^\n]*/g)) console.log(`  flag: ${m[0].trim()}`);
  }
  console.log(`sandbox ready: source ${path.join(box, 'env.sh')} && headjack …`);
  return failed ? 1 : 0;
}

async function check(argv) {
  const [dir, slug, file] = argv;
  if (!dir || !slug || !file) throw new Usage();
  const box = path.resolve(dir);
  if (!existsSync(path.join(box, 'env.sh'))) throw new Usage();
  const lines = (await readFile(file, 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let passed = 0;
  for (const line of lines) {
    const m = /^([+-])\s*(.+)$/.exec(line);
    if (!m) {
      console.log(`SKIP ${line} (start the line with + or -)`);
      continue;
    }
    const [, sign, request] = m;
    const search = JSON.parse((await runCli(box, ['search', request, '--json'])).stdout || '[]');
    const suggest = JSON.parse((await runCli(box, ['suggest', request, '--json'])).stdout || '{}');
    const first = search[0]?.slug ?? null;
    const suggested = (suggest.suggestions ?? []).map((s) => s.slug);
    const found = first === slug;
    const offered = suggested.includes(slug);
    // A skipped suggest (a request under 25 characters, no vault) tested nothing: it fails either sign.
    const skipped = String(suggest.outcome ?? '').startsWith('skipped');
    const ok = !skipped && (sign === '+' ? found && offered : !found && !offered);
    const detail = `search first: ${first ?? 'none'}; suggest: ${skipped ? `suggest skipped (${suggest.outcome})` : suggested.join(', ') || suggest.outcome || 'none'}`;
    console.log(`${ok ? 'pass' : 'FAIL'} ${sign} ${request}  (${detail})`);
    if (ok) passed++;
  }
  console.log(`${passed}/${lines.length} passed`);
  return passed === lines.length ? 0 : 1;
}

const USAGE = 'usage: node vault-proof.mjs scratch <dir> [--copy-vault] <skill-dir>…\n       node vault-proof.mjs check <dir> <slug> <requests-file>';

try {
  const [command, ...rest] = process.argv.slice(2);
  const code = command === 'scratch' ? await scratch(rest) : command === 'check' ? await check(rest) : (() => { throw new Usage(); })();
  process.exitCode = code;
} catch (error) {
  if (error instanceof Usage) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    console.error(`vault-proof: ${error.message}`);
    process.exitCode = 1;
  }
}

// The process the plugin hooks run: `node cli/hook-entry.mjs prompt|warmup|skill-used` (spec §4.1). The hooks fire on every
// Claude Code prompt, also for people who never turned suggestions on, so this file imports almost nothing: a disabled
// `prompt` or `warmup` ends after reading the suggest config, without loading cli/hook.mjs or the pipeline behind it.
// `skill-used` is local and cheap, so it always runs. A hook never blocks or breaks a session: every failure is no output
// and exit 0. `headjack hook <name>` delegates to hookMain. Node built-ins and two small modules only.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSuggestConfig } from '../lib/suggest-config.mjs';
import { stateDir } from './local-config.mjs';

export const HOOK_NAMES = ['prompt', 'warmup', 'skill-used'];
const STDIN_TIMEOUT_MS = 2000;
const STDIN_MAX_BYTES = 8 * 1024 * 1024;

// All of stdin as text; '' when it is bigger than the cap or does not end within the timeout.
async function readStdin() {
  const chunks = [];
  let size = 0;
  let oversize = false;
  let timer;
  const read = (async () => {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > STDIN_MAX_BYTES) { oversize = true; return; }
      chunks.push(chunk);
    }
  })();
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), STDIN_TIMEOUT_MS); });
  try {
    if ((await Promise.race([read.then(() => 'done', () => 'error'), timeout])) !== 'done' || oversize) return '';
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// False only when the config was read and suggestions are off. A config that cannot be read counts as possibly on: the full
// hook knows how to log it (once per session) and then does nothing.
async function mayBeEnabled(dir) {
  try {
    return (await loadSuggestConfig(dir)).suggest.enabled === true;
  } catch {
    return true;
  }
}

// Runs one hook, prints its output and exits 0 whatever happens. It exits explicitly: a hosted call stuck in a credential
// refresh (which takes no abort signal) would otherwise keep the process alive past the deadline.
export async function hookMain(name, { env = process.env } = {}) {
  process.stdout.on('error', () => {});
  let stdout = '';
  try {
    if (HOOK_NAMES.includes(name)) {
      const home = env.HOME;
      const dir = stateDir({ env, home });
      const stdin = await readStdin();
      if (name === 'skill-used' || (await mayBeEnabled(dir))) {
        const { runHook } = await import('./hook.mjs');
        ({ stdout } = await runHook(name, { stdin, env, home, dir }));
      }
    }
  } catch {
    stdout = '';
  }
  if (stdout) await new Promise((resolve) => { process.stdout.write(stdout, resolve); });
  process.exit(0);
}

// Run as a script, not when headjack.mjs imports it. realpath: the plugin directory may be reached through a symlink.
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) await hookMain(process.argv[2]);

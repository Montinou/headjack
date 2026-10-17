// Where `headjack suggest --save` gets the prompt (spec §5.4): piped stdin, or on a terminal $VISUAL then $EDITOR. Never
// argv (shell history). The text only goes to the cases file; nothing here logs it. Node built-ins only.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import { UserError } from '../lib/errors.mjs';

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Runs `editor file` the way git does: through the shell, so the value may carry arguments ("code -w"). The file path
// is an argument of the shell script, never spliced into it. `exec` makes the editor replace the shell, so signals reach
// the editor itself on every sh (a dash that forks would die of Ctrl+C on its own and orphan the editor). Like git's launch_editor, while the editor runs this
// process ignores SIGINT and SIGQUIT (Ctrl+C goes to the editor, which decides what it means) and, on SIGTERM or SIGHUP,
// removes `dir` synchronously before exiting, because the `finally` of the caller would not run.
function runEditor(editor, file, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', `exec ${editor} "$1"`, 'sh', file], { stdio: 'inherit' });
    const ignore = () => {};
    const ends = ['SIGTERM', 'SIGHUP'].map((signal) => [signal, () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
      process.exit(128 + osConstants.signals[signal]);
    }]);
    const handlers = [['SIGINT', ignore], ['SIGQUIT', ignore], ...ends];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = (fn) => (...args) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      fn(...args);
    };
    child.on('error', done(reject));
    child.on('close', done((code, signal) => {
      if (code === 0) resolve();
      else reject(new UserError(`the editor (${editor}) did not finish cleanly (${signal ?? `exit ${code}`}); nothing was saved`));
    }));
  });
}

// Reads the prompt to save. `stdin` and `env` are the process's. The editor gets a file in a fresh temp directory
// (mkdtemp creates it 0700) that is removed afterwards, whatever the editor does.
export async function readPrompt({ stdin = process.stdin, env = process.env } = {}) {
  let text;
  if (!stdin.isTTY) text = await readAll(stdin);
  else {
    const editor = [env.VISUAL, env.EDITOR].find((v) => typeof v === 'string' && v.trim() !== '');
    if (!editor) throw new UserError('--save on a terminal opens $VISUAL or $EDITOR and neither is set; set one or pipe the prompt on stdin');
    const dir = await mkdtemp(path.join(tmpdir(), 'headjack-case-'));
    try {
      const file = path.join(dir, 'prompt.txt');
      await writeFile(file, '', { mode: 0o600 });
      await runEditor(editor, file, dir);
      text = await readFile(file, 'utf8');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  text = text.trim();
  if (!text) throw new UserError('the prompt is empty; nothing was saved');
  return text;
}

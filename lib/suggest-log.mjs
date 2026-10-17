import { appendFile, chmod, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

// The suggest session log: <dir>/suggest/log.jsonl, one JSON event per line (shapes: spec 5.1, owned by the writers).
// Never holds prompt text. Best-effort: a logging failure must never break a hook or a command. No npm dependencies.

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const logDir = (dir) => path.join(dir, 'suggest');
export const logFile = (dir) => path.join(logDir(dir), 'log.jsonl');
const previousFile = (dir) => path.join(logDir(dir), 'log.1.jsonl');
export const casesFile = (dir) => path.join(logDir(dir), 'cases.jsonl');

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Appends one event. Never throws. When the current file is over `maxBytes` it becomes log.1.jsonl first,
// replacing the previous one, so at most one previous file is kept.
export async function appendEvent(dir, event, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  try {
    if (!isObject(event)) return;
    const line = `${JSON.stringify(event)}\n`;
    await mkdir(logDir(dir), { recursive: true, mode: DIR_MODE });
    await chmod(logDir(dir), DIR_MODE);
    const file = logFile(dir);
    let size = 0;
    try { size = (await stat(file)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (size > maxBytes) await rename(file, previousFile(dir));
    await appendFile(file, line, { mode: FILE_MODE });
  } catch {
    // best effort
  }
}

// Saves one calibration case { q, slug, lang, at } to <dir>/suggest/cases.jsonl (spec 5.4): the only file that holds prompt
// text, never uploaded and never rotated. Unlike appendEvent it throws, because a case the user asked to keep must not
// be dropped silently.
export async function appendCase(dir, { q, slug, lang, at }) {
  await mkdir(logDir(dir), { recursive: true, mode: DIR_MODE });
  await chmod(logDir(dir), DIR_MODE);
  const file = casesFile(dir);
  await appendFile(file, `${JSON.stringify({ q, slug, lang, at })}\n`, { mode: FILE_MODE });
  await chmod(file, FILE_MODE);
}

async function readLines(file) {
  try { return (await readFile(file, 'utf8')).split('\n'); } catch { return []; }
}

// Events from log.1.jsonl then log.jsonl (oldest first), skipping lines that are not a JSON object. With `since`,
// only events whose `at` is at or after it.
export async function readEvents(dir, { since } = {}) {
  const lines = [...await readLines(previousFile(dir)), ...await readLines(logFile(dir))];
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isObject(event)) continue;
    if (since && !(Date.parse(event.at) >= since.getTime())) continue;
    events.push(event);
  }
  return events;
}

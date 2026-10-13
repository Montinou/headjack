import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'sv-') {
  return mkdtemp(path.join(tmpdir(), prefix));
}

// entries: { 'rel/path': 'content' | Buffer | { content, mode } }
export async function makeDir(entries, root) {
  root ??= await tempDir();
  for (const [rel, v] of Object.entries(entries)) {
    const { content, mode } = typeof v === 'string' || Buffer.isBuffer(v) ? { content: v } : v;
    const p = path.join(root, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
    if (mode) await chmod(p, mode);
  }
  return root;
}

export function file(p, content, mode = 0o644) {
  return { path: p, mode, data: Buffer.from(content) };
}

export function scriptedPrompt(answers) {
  const queue = [...answers];
  const asked = [];
  const fn = async (question) => {
    asked.push(question);
    if (!queue.length) throw new Error(`unexpected prompt: ${question}`);
    return queue.shift();
  };
  fn.asked = asked;
  fn.remaining = queue;
  return fn;
}

export function captureLog() {
  const lines = [];
  const fn = (m) => lines.push(String(m));
  fn.lines = lines;
  fn.text = () => lines.join('\n');
  return fn;
}

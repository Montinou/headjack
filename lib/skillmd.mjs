const MAX_CHUNKS = 40;
const MAX_LEN = 1000;

function unquote(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) return v.slice(1, -1);
  return v;
}

function parseYamlish(src) {
  const meta = {};
  let key = null;
  let mode = null;
  for (const line of src.split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (top) {
      key = top[1];
      const v = top[2].trim();
      if (/^[|>][-+]?$/.test(v)) {
        meta[key] = '';
        mode = v[0];
      } else {
        meta[key] = unquote(v);
        mode = 'plain';
      }
      continue;
    }
    if (key && /^\s+\S/.test(line)) {
      const t = line.trim();
      const sep = mode === '|' ? '\n' : ' ';
      meta[key] = meta[key] ? meta[key] + sep + t : t;
    }
  }
  for (const k of Object.keys(meta)) meta[k] = meta[k].trim();
  return meta;
}

export function parseSkillMd(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  return { meta: parseYamlish(m[1]), body: m[2] };
}

function firstParagraph(body) {
  const lines = body.split(/\r?\n/);
  let i = 0;
  const skip = (l) => !l.trim() || /^#{1,6}\s/.test(l);
  while (i < lines.length && skip(lines[i])) i++;
  const para = [];
  while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i])) para.push(lines[i++].trim());
  return para.join(' ');
}

export function readSkillInfo(files, fallbackName) {
  const f = files.find((x) => x.path === 'SKILL.md');
  if (!f) throw new Error('SKILL.md not found at the skill root');
  const { meta, body } = parseSkillMd(f.data.toString('utf8'));
  const name = meta.name || fallbackName;
  const description = meta.description || firstParagraph(body) || name;
  return { name, description, body };
}

export function chunkSkill({ name, description, body }) {
  const chunks = [`${name}: ${description}`.slice(0, MAX_LEN)];
  const lines = body.split(/\r?\n/);
  const isFence = (l) => /^\s*```/.test(l);
  let inFence = false;
  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS; i++) {
    if (isFence(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = lines[i].match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!h) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const para = [];
    while (j < lines.length && lines[j].trim() && !/^#{1,6}\s/.test(lines[j]) && !isFence(lines[j])) para.push(lines[j++].trim());
    chunks.push(`${name} — ${h[1]}: ${para.join(' ')}`.slice(0, MAX_LEN));
  }
  return chunks;
}

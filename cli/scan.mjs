import path from 'node:path';

const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts']);

const TEXT_RULES = [
  { id: 'pipe-to-shell', severity: 'high', re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo(\s+-\S+)*\s+)?(ba|z)?sh\b/ },
  { id: 'remote-exec', severity: 'high', re: /<\(\s*(curl|wget)\b|\b(eval|(ba|z)?sh\s+-c)\s+["']?\$\(\s*(curl|wget)\b/ },
  { id: 'eval', severity: 'high', re: /\beval\s*\(|\beval\s+["'$`]/ },
  { id: 'base64-decode', severity: 'high', re: /base64\s+(-d|--decode)\b/ },
  { id: 'sensitive-read', severity: 'high', re: /(~\/\.ssh|\$HOME\/\.ssh|\bid_rsa\b|\bauth\.json\b|(^|[\s'"`/=])\.env\b)/ },
  { id: 'prompt-injection', severity: 'high', re: /ignore\s+(all\s+)?(the\s+)?previous\s+instructions|do\s+not\s+tell\s+the\s+user|don'?t\s+tell\s+the\s+user/i },
  { id: 'settings-write', severity: 'high', re: /(writeFile\w*|(?<![-=>])>>?|\btee\b)[^\n]{0,80}settings(\.local)?\.json/ },
  { id: 'external-url', severity: 'low', re: /https?:\/\/[^\s)'"`<>\]]+/ },
  { id: 'secret-env', severity: 'low', re: /\b[A-Z][A-Z0-9_]*(TOKEN|KEY|SECRET)[A-Z0-9_]*\b/ },
];

const SECRET_PATTERNS = [
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { id: 'neon-api-key', re: /\bnapi_[A-Za-z0-9]{20,}/ },
  // user:password@ with a literal password; template placeholders ($x, <x>, {x}, [x]) and the words password/pass are docs, not secrets
  { id: 'connection-string', re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^\s:@\/]*:(?!(password|pass)@)(?![$<{\[])[^\s@\/]+@/i },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/ },
  { id: 'slack-token', re: /\bxox[aeopbr]-[A-Za-z0-9-]{10,}/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SECRET_FILE = /^(\.env(\.(?!(example|sample)$)[^/]+)?|.+\.(pem|key|p12|pfx)|id_(rsa|dsa|ed25519|ecdsa)|\.npmrc|\.netrc|credentials\.json)$/i;

export function isBinary(data) {
  return data.subarray(0, 8000).includes(0);
}

export function scanFiles(files) {
  const flags = [];
  for (const f of files) {
    if (path.posix.basename(f.path) === 'hooks.json') flags.push({ rule: 'hooks-file', severity: 'high', file: f.path, line: 0 });
    if (SCRIPT_EXT.has(path.posix.extname(f.path))) flags.push({ rule: 'script-file', severity: 'low', file: f.path, line: 0 });
    if (f.mode === 0o755) flags.push({ rule: 'executable', severity: 'low', file: f.path, line: 0 });
    if (isBinary(f.data)) {
      flags.push({ rule: 'binary', severity: 'low', file: f.path, line: 0 });
      continue;
    }
    f.data.toString('utf8').split('\n').forEach((text, i) => {
      for (const r of TEXT_RULES) {
        const m = text.match(r.re);
        if (m) flags.push({ rule: r.id, severity: r.severity, file: f.path, line: i + 1, match: m[0].slice(0, 120) });
      }
    });
  }
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

export function findSecrets(files) {
  const found = [];
  for (const f of files) {
    if (SECRET_FILE.test(path.posix.basename(f.path))) found.push({ pattern: 'secret-file', file: f.path, line: 0 });
    if (isBinary(f.data)) continue;
    f.data.toString('utf8').split('\n').forEach((text, i) => {
      for (const p of SECRET_PATTERNS) if (p.re.test(text)) found.push({ pattern: p.id, file: f.path, line: i + 1 });
    });
  }
  return found;
}

// The configured root (as written) that p is inside of, compared case-insensitively on a path-segment boundary
// against every form of each root (see resolveExcludedRoots); null when none.
export function excludedRootOf(p, roots) {
  const q = path.resolve(p).toLowerCase();
  const inside = (f) => q === f || q.startsWith(f.endsWith(path.sep) ? f : f + path.sep);
  return roots.find((r) => r.forms.some(inside))?.written ?? null;
}

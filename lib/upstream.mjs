export function parseGithub(url) {
  const m = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function parseRefs(body, ref) {
  const refs = new Map();
  for (const m of body.matchAll(/([0-9a-f]{40}) (HEAD|refs\/[^\s\0]+)/g)) if (!refs.has(m[2])) refs.set(m[2], m[1]);
  const sha = ref === 'HEAD' ? refs.get('HEAD') : refs.get(`refs/heads/${ref}`) ?? refs.get(ref);
  if (!sha) throw new Error(`ref ${ref} not found`);
  return sha;
}

// IPv4 literal (already canonical dotted-quad from WHATWG URL) in loopback, link-local or RFC1918.
function blockedIPv4(host) {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// IPv6 literal (canonical, lowercase, no brackets): ::1, fe80::/10, or IPv4-mapped forms of the IPv4 ranges.
function blockedIPv6(host) {
  if (host === '::1') return true;
  if ((parseInt(host.split(':')[0] || '0', 16) & 0xffc0) === 0xfe80) return true;
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped) return false;
  const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return blockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
}

// SSRF guard: https only, no local/private IP literals, no localhost. No DNS resolution (single-user vault).
function assertFetchable(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`unsupported upstream url: ${url}`); }
  if (u.protocol !== 'https:') throw new Error(`unsupported upstream url: ${url}`);
  const host = u.hostname.replace(/\.$/, '');
  const blocked = host.startsWith('[')
    ? blockedIPv6(host.slice(1, -1))
    : host === 'localhost' || host.endsWith('.localhost') || blockedIPv4(host);
  if (blocked) throw new Error(`upstream host not allowed: ${url}`);
}

async function fetchNoRedirect(fetchImpl, target, headers, url) {
  const res = await fetchImpl(target, { headers, redirect: 'manual' });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new Error(`upstream redirect ${res.status} for ${url}`);
  }
  return res;
}

export async function resolveHead({ kind, url, default_ref }, fetchImpl = fetch, githubToken) {
  assertFetchable(url);
  const ref = default_ref || 'HEAD';
  const gh = parseGithub(url);
  if (kind === 'github' || gh) {
    if (!gh) throw new Error(`not a github url: ${url}`);
    const headers = { accept: 'application/vnd.github.sha', 'user-agent': 'headjack' };
    if (githubToken) headers.authorization = `Bearer ${githubToken}`;
    const res = await fetchNoRedirect(fetchImpl, `https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${encodeURIComponent(ref)}`, headers, url);
    if (!res.ok) throw new Error(`github ${res.status} for ${url}`);
    return (await res.text()).trim();
  }
  const res = await fetchNoRedirect(fetchImpl, `${url.replace(/\/$/, '')}/info/refs?service=git-upload-pack`, { 'user-agent': 'git/2.0 headjack' }, url);
  if (!res.ok) throw new Error(`git ${res.status} for ${url}`);
  return parseRefs(await res.text(), ref);
}

const encodePath = (segments) => segments.map(encodeURIComponent).join('/');

// Cached GitHub API GET: URL -> Promise of the parsed JSON body, or null on 404. Other non-2xx reject.
// The cache key is the URL alone, leaving out the token and the owner. That is fine while one global GITHUB_TOKEN
// serves every owner; it must include the token/owner if per-owner tokens are ever added.
function githubGetter({ url, fetchImpl, githubToken, cache }) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'headjack' };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  return (apiUrl) => {
    if (!cache.has(apiUrl)) {
      cache.set(apiUrl, (async () => {
        const res = await fetchNoRedirect(fetchImpl, apiUrl, headers, url);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`github ${res.status} for ${url}`);
        return res.json();
      })());
    }
    return cache.get(apiUrl);
  };
}

// Tree sha of the directory `segments` at `ref`, read from its parent's listing; null when the parent or entry is absent.
async function dirTreeSha(get, api, segments, ref) {
  const parent = encodePath(segments.slice(0, -1));
  const body = await get(`${api}/contents${parent ? `/${parent}` : ''}?ref=${encodeURIComponent(ref)}`);
  const name = segments[segments.length - 1];
  const entry = Array.isArray(body) ? body.find((e) => e.name === name && e.type === 'dir') : null;
  return entry?.sha ?? null;
}

// Decides update_available per skill: the git tree sha of the skill's own directory at the reviewed commit vs at the
// source's ref, so commits elsewhere in the repo don't flag it. `cache` is shared across one cron run.
export async function checkUpstream(target, fetchImpl = fetch, githubToken, cache = new Map()) {
  const { url, default_ref, commit_sha, source_path } = target;
  assertFetchable(url);
  const ref = default_ref || 'HEAD';
  const gh = parseGithub(url);
  // `.` and empty segments are dropped: the importer stores '.' for a SKILL.md at the repo root, which is the repo-root case.
  const segments = String(source_path ?? '').split('/').filter((seg) => seg && seg !== '.');
  if (gh) {
    const get = githubGetter({ url, fetchImpl, githubToken, cache });
    const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
    if (!segments.length) {
      const head = await get(`${api}/commits/${encodeURIComponent(ref)}`);
      if (head === null) throw new Error(`github 404 for ${url}`);
      if (commit_sha == null || head.sha === commit_sha) return { latest: head.sha, updateAvailable: false };
      const reviewed = await get(`${api}/commits/${encodeURIComponent(commit_sha)}`);
      return { latest: head.sha, updateAvailable: reviewed?.commit?.tree?.sha !== head.commit.tree.sha };
    }
    const path = segments.join('/');
    const notFound = () => new Error(`path ${path} not found at ${ref} in ${url}`);
    const commits = await get(`${api}/commits?sha=${encodeURIComponent(ref)}&path=${encodePath(segments)}&per_page=1`);
    if (commits === null) throw new Error(`github 404 for ${url}`);
    const latest = commits[0]?.sha;
    if (!latest) throw notFound();
    if (commit_sha == null || latest === commit_sha) return { latest, updateAvailable: false };
    const [before, after] = await Promise.all([dirTreeSha(get, api, segments, commit_sha), dirTreeSha(get, api, segments, ref)]);
    if (after === null) throw notFound();
    return { latest, updateAvailable: before !== after };
  }
  const latest = await resolveHead(target, fetchImpl, githubToken);
  return { latest, updateAvailable: commit_sha != null && latest !== commit_sha };
}

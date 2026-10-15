// Local HTTP proxy for the CLI smoke test against a protected preview deployment: forwards every request to TARGET
// and adds Vercel's automation bypass header, so the unmodified CLI can talk to the preview.
//   TARGET=https://<preview>.vercel.app VERCEL_AUTOMATION_BYPASS_SECRET=<secret> node scripts/bypass-proxy.mjs [port]
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';

export function startProxy({ target, secret, port = 0, fetchImpl = fetch }) {
  const base = new URL(target);
  const server = http.createServer(async (req, res) => {
    try {
      // Only origin-form targets ("/path"): "//host", "/\host" and absolute-form targets would resolve to
      // another host and carry the bypass secret there. Build on base.origin and re-check the origin anyway.
      const url = /^\/(?![/\\])/.test(req.url) ? new URL(base.origin + req.url) : null;
      if (!url || url.origin !== base.origin) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('bad request target');
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = { ...req.headers, host: base.host, 'x-vercel-protection-bypass': secret };
      delete headers['content-length'];
      delete headers.connection;
      const upstream = await fetchImpl(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        redirect: 'manual',
      });
      const out = {};
      upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy error: ${e.message}`);
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const { TARGET, VERCEL_AUTOMATION_BYPASS_SECRET } = process.env;
  if (!TARGET || !VERCEL_AUTOMATION_BYPASS_SECRET) { console.error('set TARGET and VERCEL_AUTOMATION_BYPASS_SECRET'); process.exit(2); }
  const server = await startProxy({ target: TARGET, secret: VERCEL_AUTOMATION_BYPASS_SECRET, port: Number(process.argv[2] ?? 8787) });
  console.log(`HEADJACK_URL=http://127.0.0.1:${server.address().port}  →  ${TARGET}`);
}

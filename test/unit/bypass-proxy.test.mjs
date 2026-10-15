import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProxy } from '../../scripts/bypass-proxy.mjs';

test('the smoke proxy forwards method, path, body and auth, and adds the bypass header', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body?.toString() });
    return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', 'x-skill-sha256': 'abc' } });
  };
  const server = await startProxy({ target: 'https://preview.example.vercel.app', secret: 's3cret', fetchImpl });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/skills/a%40b/download?x=1`, { method: 'POST', body: 'payload', headers: { authorization: 'Bearer t' } });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-skill-sha256'), 'abc');
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(seen[0].url, 'https://preview.example.vercel.app/api/skills/a%40b/download?x=1');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, 'payload');
    assert.equal(seen[0].headers['x-vercel-protection-bypass'], 's3cret');
    assert.equal(seen[0].headers.authorization, 'Bearer t');
    assert.equal(seen[0].headers.host, 'preview.example.vercel.app');
  } finally {
    server.close();
  }
});

test('the smoke proxy refuses request targets that would leave the preview host, without calling upstream', async () => {
  const http = await import('node:http');
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('leak', { status: 200 }); };
  const server = await startProxy({ target: 'https://preview.example.vercel.app', secret: 's3cret', fetchImpl });
  try {
    const { port } = server.address();
    const send = (path) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { authorization: 'Bearer t' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    for (const path of ['//other.host/x', '/\\other.host/x', 'http://other.host/x', 'https://other.host/x', '*']) {
      assert.equal(await send(path), 400, path);
    }
    assert.equal(calls, 0);
  } finally {
    server.close();
  }
});

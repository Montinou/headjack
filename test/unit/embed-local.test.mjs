// Local embeddings go through one AI Gateway fetch. No test makes a network call.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { embedTexts } from '../../cli/embed-local.mjs';

const URL = 'https://ai-gateway.vercel.sh/v1/embeddings';
const KEY = 'gw-test-key-0123456789';
const MODEL = 'openai/text-embedding-3-small';
const PHRASE = 'kilnstone-secret-phrase';
const BODY_MARKER = 'gateway-body-marker-not-for-logs';

function floats(length, fill) {
  const values = Array(length).fill(fill);
  if (length > 0) values[0] = fill;
  if (length > 1) values[length - 1] = fill === 0 ? 0 : -fill;
  return values;
}

// The documented embeddings object, including fields this code does not read.
function gatewayPayload(rows, model = MODEL) {
  return {
    object: 'list',
    data: rows.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model,
    usage: { prompt_tokens: 3, total_tokens: 3 },
    marker: BODY_MARKER,
  };
}

function recorder(rows, { status = 200, reorder, model } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const payload = gatewayPayload(rows, model);
    if (reorder) payload.data = reorder.map((index) => payload.data[index]);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

function bodyRecorder(data) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      object: 'list',
      data,
      model: MODEL,
      usage: { prompt_tokens: 3, total_tokens: 3 },
      marker: BODY_MARKER,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

function rejectsWithoutLeak(error) {
  const blob = logged([], error);
  return error instanceof Error
    && !blob.includes(PHRASE)
    && !blob.includes(BODY_MARKER)
    && !blob.includes(KEY);
}

function authorization(headers) {
  return headers?.Authorization ?? headers?.authorization;
}

const methods = ['log', 'info', 'warn', 'error', 'debug'];

async function withLogger(run) {
  const lines = [];
  const log = (...args) => {
    lines.push(args.map((arg) => {
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' '));
  };
  const saved = new Map(methods.map((name) => [name, console[name]]));
  for (const name of methods) console[name] = log;
  try {
    return { lines, result: await run(log) };
  } finally {
    for (const [name, fn] of saved) console[name] = fn;
  }
}

function logged(lines, error) {
  return [lines.join('\n'), error?.message, error?.stack].filter(Boolean).join('\n');
}

describe('local embedder', { concurrency: false }, () => {
  test('embedTexts posts texts, dimensions 1536, and the bearer key to the embeddings URL', async () => {
    const texts = [PHRASE, 'second chunk'];
    const fetchImpl = recorder([floats(1536, 0.25), floats(1536, 0.5)]);
    await embedTexts({ texts, key: KEY, model: MODEL, fetchImpl });

    assert.equal(fetchImpl.calls.length, 1);
    const [call] = fetchImpl.calls;
    assert.equal(call.url, URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(authorization(call.init.headers), `Bearer ${KEY}`);
    assert.equal(call.body.model, MODEL);
    assert.equal(call.body.dimensions, 1536);
    assert.deepEqual(call.body.input, texts);
  });

  test('embedTexts uses the model argument, else EMBED_MODEL, else openai/text-embedding-3-small', async () => {
    const texts = ['chunk'];
    const previous = process.env.EMBED_MODEL;
    try {
      process.env.EMBED_MODEL = 'openai/from-env';
      const explicit = recorder([floats(1536, 0.2)], { model: 'openai/from-arg' });
      await embedTexts({ texts, key: KEY, model: 'openai/from-arg', fetchImpl: explicit });
      assert.equal(explicit.calls[0].body.model, 'openai/from-arg');

      const fromEnv = recorder([floats(1536, 0.2)], { model: 'openai/from-env' });
      await embedTexts({ texts, key: KEY, fetchImpl: fromEnv });
      assert.equal(fromEnv.calls[0].body.model, 'openai/from-env');

      delete process.env.EMBED_MODEL;
      const fallback = recorder([floats(1536, 0.2)]);
      await embedTexts({ texts, key: KEY, fetchImpl: fallback });
      assert.equal(fallback.calls[0].body.model, MODEL);
    } finally {
      if (previous === undefined) delete process.env.EMBED_MODEL;
      else process.env.EMBED_MODEL = previous;
    }
  });

  test('embedTexts resolves every 1536-float vector in input order', async () => {
    const first = floats(1536, 0.25);
    const second = floats(1536, 0.5);
    const fetchImpl = recorder([first, second], { reorder: [1, 0] });
    const result = await embedTexts({
      texts: [PHRASE, 'second chunk'],
      key: KEY,
      model: MODEL,
      fetchImpl,
    });
    assert.deepEqual(result, [first, second]);
  });

  test('embedTexts rejects a missing embedding index instead of pairing by array position', async () => {
    const first = floats(1536, 1);
    const second = floats(1536, 2);
    const fetchImpl = bodyRecorder([
      { object: 'embedding', index: 1, embedding: second },
      { object: 'embedding', embedding: first },
    ]);
    await assert.rejects(
      embedTexts({ texts: ['first', 'second'], key: KEY, model: MODEL, fetchImpl }),
      rejectsWithoutLeak,
    );
  });

  test('embedTexts rejects duplicate embedding indexes', async () => {
    const fetchImpl = bodyRecorder([
      { object: 'embedding', index: 0, embedding: floats(1536, 1) },
      { object: 'embedding', index: 0, embedding: floats(1536, 2) },
    ]);
    await assert.rejects(
      embedTexts({ texts: ['first', 'second'], key: KEY, model: MODEL, fetchImpl }),
      rejectsWithoutLeak,
    );
  });

  test('embedTexts rejects gapped embedding indexes', async () => {
    const first = floats(1536, 1);
    const second = floats(1536, 2);
    const fetchImpl = bodyRecorder([
      { object: 'embedding', index: 2, embedding: second },
      { object: 'embedding', index: 0, embedding: first },
    ]);
    await assert.rejects(
      embedTexts({ texts: ['first', 'second'], key: KEY, model: MODEL, fetchImpl }),
      rejectsWithoutLeak,
    );
  });

  test('embedTexts rejects a 1536-length vector filled with null', async () => {
    const fetchImpl = recorder([Array(1536).fill(null)]);
    await assert.rejects(
      embedTexts({ texts: [PHRASE], key: KEY, model: MODEL, fetchImpl }),
      rejectsWithoutLeak,
    );
  });

  test('embedTexts rejects a 1536-length vector filled with numeric strings', async () => {
    const fetchImpl = recorder([Array(1536).fill('1.5')]);
    await assert.rejects(
      embedTexts({ texts: [PHRASE], key: KEY, model: MODEL, fetchImpl }),
      rejectsWithoutLeak,
    );
  });

  test('embedTexts rejects when any vector length is not 1536', async () => {
    const texts = [PHRASE, 'second chunk'];
    for (const length of [0, 2, 1535, 1537]) {
      const fetchImpl = recorder([floats(Math.max(length, 1), 0.1).slice(0, length)]);
      await assert.rejects(
        embedTexts({ texts: [PHRASE], key: KEY, model: MODEL, fetchImpl }),
        (error) => error instanceof Error && !logged([], error).includes(PHRASE) && !logged([], error).includes(BODY_MARKER),
      );
    }
    const mixed = recorder([floats(1536, 0.25), floats(3, 0.5)]);
    await assert.rejects(embedTexts({ texts, key: KEY, model: MODEL, fetchImpl: mixed }));
    assert.equal(mixed.calls.length, 1);
  });

  test('embedTexts does not log the input text or the response body', async () => {
    const texts = [PHRASE];
    const ok = recorder([floats(1536, 0.25)]);
    const success = await withLogger((log) => embedTexts({ texts, key: KEY, model: MODEL, fetchImpl: ok, log }));
    assert.equal(success.result[0].length, 1536);
    assert.equal(logged(success.lines).includes(PHRASE), false);
    assert.equal(logged(success.lines).includes(BODY_MARKER), false);
    assert.equal(logged(success.lines).includes(KEY), false);

    const bad = recorder([floats(2, 0.25)]);
    const failure = await withLogger(async (log) => {
      try {
        await embedTexts({ texts, key: KEY, model: MODEL, fetchImpl: bad, log });
        return null;
      } catch (error) {
        return error;
      }
    });
    assert.ok(failure.result instanceof Error);
    const blob = logged(failure.lines, failure.result);
    assert.equal(blob.includes(PHRASE), false);
    assert.equal(blob.includes(BODY_MARKER), false);
    assert.equal(blob.includes(KEY), false);

    const denied = recorder([floats(1536, 0.25)], { status: 401 });
    const http = await withLogger(async (log) => {
      try {
        await embedTexts({ texts, key: KEY, model: MODEL, fetchImpl: denied, log });
        return null;
      } catch (error) {
        return error;
      }
    });
    assert.ok(http.result instanceof Error);
    const httpBlob = logged(http.lines, http.result);
    assert.equal(httpBlob.includes(PHRASE), false);
    assert.equal(httpBlob.includes(BODY_MARKER), false);
    assert.equal(httpBlob.includes(KEY), false);
  });
});

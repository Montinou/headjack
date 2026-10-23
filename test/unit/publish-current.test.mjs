// A new current version is enriched and embedded after the version commits. No test calls the network.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { file, tempDir } from '../helpers.mjs';
import { localSupported, localTest } from '../local-helpers.mjs';
import { createLocalApi } from '../../lib/local/api.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault } from '../../lib/local/schema.mjs';
import { createSqliteRepo } from '../../lib/local/sqlite-repo.mjs';
import { publishCurrent } from '../../lib/local/publish-current.mjs';
import { ENRICHMENT_VERSION } from '../../lib/enrich-prompt.mjs';
import { pack } from '../../lib/tar.mjs';

const { DatabaseSync } = (await localSupported) ? await runtimeCheck() : {};

const DIM = 1536;
const KEY = 'gateway-test-key';
const SECRET = `sk-${'a'.repeat(24)}`;
const KILN_MD = [
  '---',
  'name: Kiln',
  'description: Fires clay',
  '---',
  '# Heat',
  'Raise the temperature.',
  '# Cool',
  'Lower it slowly.',
  '',
].join('\n');
// Hand-derived from chunkSkill: name/description, then each heading's first paragraph. Em dash, not hyphen.
const KILN_CHUNKS = [
  'Kiln: Fires clay',
  'Kiln — Heat: Raise the temperature.',
  'Kiln — Cool: Lower it slowly.',
];
const LOCAL_QUERIES = ['busca el horno', 'enciende la pieza'];

function sha(byte) {
  return byte.repeat(32);
}

function vendorPath() {
  const cliDir = path.dirname(fileURLToPath(new URL('../../cli/headjack.mjs', import.meta.url)));
  const ext = process.platform === 'darwin' ? 'dylib' : 'so';
  return path.join(cliDir, 'vendor', `vec0.${process.platform}-${process.arch}.${ext}`);
}

function vector(seed) {
  const values = Array(DIM).fill(0);
  values[seed % DIM] = 1;
  return values;
}

function gateway({ queries = LOCAL_QUERIES, embedStatus = 200, onEmbed } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).includes('/chat/completions')) {
      return Response.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ queries_es: queries }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    if (onEmbed) await onEmbed(body);
    if (embedStatus !== 200) {
      return new Response(JSON.stringify({ error: { message: 'no' } }), {
        status: embedStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    const input = Array.isArray(body.input) ? body.input : [];
    return Response.json({
      object: 'list',
      data: input.map((_, index) => ({ object: 'embedding', index, embedding: vector(index + 1) })),
      model: body.model,
      usage: { prompt_tokens: input.length, total_tokens: input.length },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function manifest({ slug, sha256, status = 'approved', kind = 'skill', plugin_slug = null, name, description, chunks }) {
  return {
    slug,
    name: name ?? slug,
    description: description ?? 'A useful skill',
    kind,
    plugin_slug,
    sha256,
    status,
    tags: ['kiln'],
    source: { kind: 'local' },
    chunks: chunks ?? ['fallback chunk'],
  };
}

async function open(allowExtension = true) {
  const dir = await tempDir('sv-pub-');
  const db = openVault({ dir, DatabaseSync, allowExtension });
  return { dir, db, repo: createSqliteRepo(db) };
}

function plain(row) {
  return row ? { ...row } : null;
}

function chunkRows(db) {
  return db.prepare('select id, skill_id, version_id, text, kind from chunks order by id').all().map(plain);
}

function skillRow(db, skillId) {
  return plain(db.prepare('select id, current_version_id, queries_es_text, enrichment_v from skills where id = ?').get(skillId));
}

function docBody(db, skillId) {
  return db.prepare('select body from skill_docs where rowid = ?').get(skillId)?.body ?? null;
}

function docEs(db, skillId) {
  return db.prepare('select queries from skill_docs_es where rowid = ?').get(skillId)?.queries ?? null;
}

function vecTable(db) {
  return db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n === 1;
}

function vecRows(db) {
  if (!vecTable(db)) return [];
  return db.prepare('select rowid, skill_id, version_id from chunk_vecs order by rowid').all().map(plain);
}

const kilnFiles = [file('SKILL.md', KILN_MD)];
const kilnTarball = pack(kilnFiles);

localTest('a rejected manifest stores the review and does not replace current chunks or call the gateway', async () => {
  const { db, repo } = await open();
  const fetchImpl = gateway();
  try {
    const current = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('aa'), chunks: [{ text: 'kept heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'kept heading', kind: 'content' }],
      key: null,
      fetchImpl,
    });
    const rejected = await publishCurrent({
      repo, db,
      manifest: manifest({
        slug: 'kiln', sha256: sha('bb'), status: 'rejected',
        chunks: [{ text: 'rejected heading', kind: 'content' }],
      }),
      tarball: null,
      chunks: [{ text: 'rejected heading', kind: 'content' }],
      key: KEY,
      fetchImpl,
    });
    assert.equal(db.prepare('select status from versions where id = ?').get(rejected.versionId).status, 'rejected');
    assert.equal(skillRow(db, current.skillId).current_version_id, current.versionId);
    assert.deepEqual(chunkRows(db).map((row) => row.text), ['kept heading']);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    db.close();
  }
});

localTest('a plugin manifest stores its heading chunks, not only name and description', async () => {
  const { db, repo } = await open();
  const headings = ['Plug — Setup: turn the kiln', 'Plug — Use: fire the clay'];
  try {
    await publishCurrent({
      repo, db,
      manifest: manifest({
        slug: 'plug', sha256: sha('ac'), kind: 'plugin', name: 'Plug', description: 'A plugin',
        chunks: headings.map((text) => ({ text, kind: 'content' })),
      }),
      tarball: null,
      chunks: headings.map((text) => ({ text, kind: 'content' })),
      key: null,
      fetchImpl: gateway(),
    });
    assert.deepEqual(chunkRows(db).map((row) => ({ text: row.text, kind: row.kind })), headings.map((text) => ({ text, kind: 'content' })));
    assert.equal(chunkRows(db).some((row) => row.text === 'Plug: A plugin'), false);
  } finally {
    db.close();
  }
});

localTest('an empty plugin chunk list stores one name and description chunk', async () => {
  const { db, repo } = await open();
  try {
    await publishCurrent({
      repo, db,
      manifest: manifest({
        slug: 'bare', sha256: sha('ad'), kind: 'plugin', name: 'Bare Plug', description: 'No headings', chunks: [],
      }),
      tarball: null,
      chunks: [],
      key: null,
      fetchImpl: gateway(),
    });
    assert.deepEqual(chunkRows(db).map((row) => row.text), ['Bare Plug: No headings']);
  } finally {
    db.close();
  }
});

localTest('a gateway failure leaves the new content chunks, deletes previous vectors, and stores no generated spanish', async () => {
  const { db, repo } = await open();
  const generated = ['texto generado unico', 'otra frase generada'];
  try {
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('ae'), kind: 'plugin', chunks: [{ text: 'old heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'old heading', kind: 'content' }],
      key: KEY,
      fetchImpl: gateway(),
    });
    assert.ok(vecRows(db).length > 0);
    const failed = gateway({ queries: generated, embedStatus: 502 });
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('af'), kind: 'plugin', chunks: [{ text: 'new heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'new heading', kind: 'content' }],
      key: KEY,
      fetchImpl: failed,
    });
    const chunks = chunkRows(db);
    assert.deepEqual(chunks.map((row) => row.text), ['new heading']);
    assert.equal(chunks.every((row) => row.kind === 'content'), true);
    assert.equal(vecRows(db).length, 0);
    const skill = skillRow(db, chunks[0].skill_id);
    assert.equal(skill.enrichment_v, null);
    assert.equal(skill.queries_es_text, '');
    assert.equal(docEs(db, skill.id), null);
    const stored = `${skill.queries_es_text}\n${chunks.map((row) => row.text).join('\n')}\n${docBody(db, skill.id)}`;
    for (const query of generated) assert.equal(stored.includes(query), false);
    assert.ok(failed.calls.some((call) => call.url.includes('/chat/completions')));
  } finally {
    db.close();
  }
});

localTest('a successful publish stores one vector per chunk, the enrichment version, and a content-only body', async () => {
  const { dir, db, repo } = await open();
  let sawCommittedVersion = false;
  const fetchImpl = gateway({
    onEmbed: async (body) => {
      assert.equal(body.dimensions, DIM);
      assert.deepEqual(body.input, [...KILN_CHUNKS, ...LOCAL_QUERIES]);
      const other = new DatabaseSync(path.join(dir, 'vault.db'), { readOnly: true, timeout: 1000 });
      try {
        const row = other.prepare("select current_version_id from skills where slug = 'kiln'").get();
        sawCommittedVersion = row?.current_version_id != null;
      } finally {
        other.close();
      }
      assert.equal(db.prepare("select count(*) as n from sqlite_master where name = 'chunk_vecs'").get().n, 1);
      // Occupy the rowids the new chunks will use. A number bind is rejected; INSERT OR REPLACE does not replace.
      const plant = db.prepare('insert into chunk_vecs(rowid, embedding, skill_id, version_id) values (?, ?, ?, ?)');
      for (let id = 1n; id <= 5n; id++) plant.run(id, JSON.stringify(vector(0)), 999n, 999n);
    },
  });
  try {
    const published = await publishCurrent({
      repo, db,
      manifest: manifest({
        slug: 'kiln', sha256: sha('ba'), name: 'Kiln', description: 'Fires clay',
        chunks: [{ text: 'WRONG CHUNK', kind: 'content' }],
      }),
      tarball: kilnTarball,
      chunks: [{ text: 'WRONG CHUNK', kind: 'content' }],
      key: KEY,
      fetchImpl,
    });
    assert.equal(sawCommittedVersion, true);
    const chunks = chunkRows(db);
    assert.deepEqual(chunks.filter((row) => row.kind === 'content').map((row) => row.text), KILN_CHUNKS);
    assert.deepEqual(chunks.filter((row) => row.kind === 'query').map((row) => row.text), LOCAL_QUERIES);
    assert.equal(chunks.some((row) => row.text === 'WRONG CHUNK'), false);
    const vecs = vecRows(db);
    assert.deepEqual(vecs.map((row) => Number(row.rowid)), chunks.map((row) => row.id));
    assert.equal(vecs.every((row) => Number(row.skill_id) === published.skillId && Number(row.version_id) === published.versionId), true);
    const skill = skillRow(db, published.skillId);
    assert.equal(skill.enrichment_v, ENRICHMENT_VERSION);
    assert.equal(skill.queries_es_text, LOCAL_QUERIES.join(' '));
    assert.equal(docBody(db, published.skillId), KILN_CHUNKS.join('\n'));
    for (const query of LOCAL_QUERIES) assert.equal(docBody(db, published.skillId).includes(query), false);
    assert.equal(docEs(db, published.skillId), LOCAL_QUERIES.join(' '));
    assert.equal(fetchImpl.calls.filter((call) => call.url.includes('/embeddings')).length, 1);
  } finally {
    db.close();
  }
});

localTest('a missing key stores the new content chunks and no vectors', async () => {
  const { db, repo } = await open();
  const fetchImpl = gateway();
  try {
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('bb'), kind: 'plugin', chunks: [{ text: 'old heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'old heading', kind: 'content' }],
      key: KEY,
      fetchImpl: gateway(),
    });
    assert.ok(vecRows(db).length > 0);
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('bc'), kind: 'plugin', chunks: [{ text: 'offline heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'offline heading', kind: 'content' }],
      key: null,
      fetchImpl,
    });
    assert.deepEqual(chunkRows(db).map((row) => row.text), ['offline heading']);
    assert.equal(vecRows(db).length, 0);
    const skill = skillRow(db, chunkRows(db)[0].skill_id);
    assert.equal(skill.enrichment_v, null);
    assert.equal(skill.queries_es_text, '');
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    db.close();
  }
});

localTest('a current version change during the gateway call leaves the new chunks unwritten', async () => {
  const { db, repo } = await open();
  try {
    const first = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('bd'), kind: 'plugin', chunks: [{ text: 'first heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'first heading', kind: 'content' }],
      key: KEY,
      fetchImpl: gateway(),
    });
    const fetchImpl = gateway({
      onEmbed: () => {
        db.prepare('update skills set current_version_id = ? where id = ?').run(first.versionId, first.skillId);
      },
    });
    const second = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('be'), kind: 'plugin', chunks: [{ text: 'second heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'second heading', kind: 'content' }],
      key: KEY,
      fetchImpl,
    });
    assert.notEqual(second.versionId, first.versionId);
    assert.equal(db.prepare('select count(*) as n from chunks where version_id = ?').get(second.versionId).n, 0);
    assert.deepEqual(chunkRows(db).map((row) => row.text), ['first heading', ...LOCAL_QUERIES]);
    assert.equal(vecRows(db).length, chunkRows(db).length);
    assert.equal(vecRows(db).every((row) => Number(row.version_id) === first.versionId), true);
  } finally {
    db.close();
  }
});

localTest('an already-current hosted queries string is one query chunk, spaces included', async () => {
  const { db, repo } = await open();
  const fetchImpl = gateway();
  try {
    const published = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('bf'), kind: 'plugin', chunks: [{ text: 'hosted heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'hosted heading', kind: 'content' }],
      queriesEs: 'hola mundo',
      enrichmentV: ENRICHMENT_VERSION,
      key: KEY,
      fetchImpl,
    });
    const queries = chunkRows(db).filter((row) => row.kind === 'query');
    assert.deepEqual(queries.map((row) => row.text), ['hola mundo']);
    assert.equal(skillRow(db, published.skillId).queries_es_text, 'hola mundo');
    assert.equal(fetchImpl.calls.some((call) => call.url.includes('/chat/completions')), false);
    const embed = fetchImpl.calls.find((call) => call.url.includes('/embeddings'));
    assert.deepEqual(embed.body.input, ['hosted heading', 'hola mundo']);
  } finally {
    db.close();
  }
});

localTest('a local enrichment list stores one query chunk per string and ignores a stale hosted string', async () => {
  const { db, repo } = await open();
  const fetchImpl = gateway();
  try {
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('ca'), kind: 'plugin', chunks: [{ text: 'local heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'local heading', kind: 'content' }],
      queriesEs: 'hola mundo',
      enrichmentV: null,
      key: KEY,
      fetchImpl,
    });
    assert.deepEqual(chunkRows(db).filter((row) => row.kind === 'query').map((row) => row.text), LOCAL_QUERIES);
    assert.equal(chunkRows(db).some((row) => row.text === 'hola mundo'), false);
    assert.equal(fetchImpl.calls.some((call) => call.url.includes('/chat/completions')), true);
  } finally {
    db.close();
  }
});

localTest('a secret in a content chunk or a generated query stores content only and does not embed', async () => {
  const { db, repo } = await open();
  try {
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('cb'), kind: 'plugin', chunks: [{ text: 'clean heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'clean heading', kind: 'content' }],
      key: KEY,
      fetchImpl: gateway(),
    });
    const leaked = gateway();
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('cc'), kind: 'plugin', chunks: [{ text: SECRET, kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: SECRET, kind: 'content' }],
      key: KEY,
      fetchImpl: leaked,
    });
    assert.equal(leaked.calls.length, 0);
    assert.deepEqual(chunkRows(db).map((row) => row.text), [SECRET]);
    assert.equal(vecRows(db).length, 0);
    assert.equal(skillRow(db, chunkRows(db)[0].skill_id).enrichment_v, null);

    const generated = gateway({ queries: ['una consulta normal', SECRET] });
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('cd'), kind: 'plugin', chunks: [{ text: 'after secret', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'after secret', kind: 'content' }],
      key: KEY,
      fetchImpl: generated,
    });
    assert.equal(generated.calls.some((call) => call.url.includes('/chat/completions')), true);
    assert.equal(generated.calls.some((call) => call.url.includes('/embeddings')), false);
    const texts = chunkRows(db).map((row) => row.text);
    assert.deepEqual(texts, ['after secret']);
    assert.equal(texts.some((text) => text.includes(SECRET)), false);
    assert.equal(skillRow(db, chunkRows(db)[0].skill_id).queries_es_text, '');
    assert.equal(vecRows(db).length, 0);
  } finally {
    db.close();
  }
});

localTest('a connection without allowExtension does not load sqlite-vec and still stores content chunks', async () => {
  assert.equal(process.env.HEADJACK_VEC_PATH ?? '', '');
  assert.equal(existsSync(vendorPath()), true);
  const { db, repo } = await open(false);
  const calls = [];
  const original = db.loadExtension.bind(db);
  db.loadExtension = (loadable) => {
    calls.push(loadable);
    return original(loadable);
  };
  const fetchImpl = gateway();
  try {
    const published = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('ce'), kind: 'plugin', chunks: [{ text: 'no extension', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'no extension', kind: 'content' }],
      key: KEY,
      fetchImpl,
    });
    assert.equal(published.skillId > 0, true);
    assert.deepEqual(calls, []);
    assert.equal(vecTable(db), false);
    assert.deepEqual(chunkRows(db).map((row) => row.text), ['no extension']);
    assert.equal(skillRow(db, published.skillId).enrichment_v, null);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    db.close();
  }
});

localTest('a chunk_vecs error after sqlite-vec loaded does not fail the publish', async () => {
  const { db, repo } = await open();
  const fetchImpl = gateway({
    onEmbed: () => {
      db.exec('drop table chunk_vecs');
    },
  });
  try {
    const published = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('cf'), kind: 'plugin', chunks: [{ text: 'still published', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'still published', kind: 'content' }],
      key: KEY,
      fetchImpl,
    });
    assert.equal(published.versionId > 0, true);
    assert.deepEqual(chunkRows(db).map((row) => ({ text: row.text, kind: row.kind })), [{ text: 'still published', kind: 'content' }]);
    assert.equal(skillRow(db, published.skillId).enrichment_v, null);
    assert.equal(skillRow(db, published.skillId).queries_es_text, '');
    assert.equal(vecRows(db).length, 0);
  } finally {
    db.close();
  }
});

localTest('the local api publishes an approved skill through chunk storage even when enrich is disabled', async () => {
  const dir = await tempDir('sv-pub-api-');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ enrich: { enabled: false, model: 'openai/gpt-5-mini' } }));
  const fetchImpl = gateway();
  const { api, close } = await createLocalApi({
    dir,
    env: { AI_GATEWAY_API_KEY: KEY },
    fetchImpl,
  });
  try {
    const published = await api.publish(manifest({
      slug: 'api-plug',
      sha256: sha('da'),
      kind: 'plugin',
      name: 'Api Plug',
      description: 'Routes things',
      chunks: ['Api Plug — Setup: wire the route'],
    }));
    assert.equal(typeof published.skillId, 'number');
  } finally {
    await close();
  }
  const db = openVault({ dir, DatabaseSync });
  try {
    const chunks = chunkRows(db);
    assert.deepEqual(chunks.filter((row) => row.kind === 'content').map((row) => row.text), ['Api Plug — Setup: wire the route']);
    assert.deepEqual(chunks.filter((row) => row.kind === 'query').map((row) => row.text), LOCAL_QUERIES);
    assert.equal(fetchImpl.calls.some((call) => call.url.includes('/chat/completions')), true);
    assert.equal(skillRow(db, chunks[0].skill_id).enrichment_v, ENRICHMENT_VERSION);
  } finally {
    db.close();
  }
});

localTest('a standalone tarball with no root SKILL.md fails before that sha is current, so a later valid tarball is not already published', async () => {
  const { db, repo } = await open();
  const badSha = sha('ea');
  const badTarball = pack([file('nested/SKILL.md', KILN_MD)]);
  try {
    const previous = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('e9'), kind: 'plugin', chunks: [{ text: 'previous heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'previous heading', kind: 'content' }],
      key: null,
      fetchImpl: gateway(),
    });
    await assert.rejects(
      () => publishCurrent({
        repo, db,
        manifest: manifest({ slug: 'kiln', sha256: badSha, name: 'Kiln', description: 'Fires clay', chunks: ['ignored heading'] }),
        tarball: badTarball,
        chunks: ['ignored heading'],
        key: KEY,
        fetchImpl: gateway(),
      }),
      /SKILL.md not found at the skill root/,
    );
    const published = await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: badSha, name: 'Kiln', description: 'Fires clay', chunks: ['ignored heading'] }),
      tarball: kilnTarball,
      chunks: ['ignored heading'],
      key: null,
      fetchImpl: gateway(),
    });
    assert.equal(skillRow(db, previous.skillId).current_version_id, published.versionId);
    const rows = chunkRows(db);
    assert.deepEqual(rows.map((row) => row.text), KILN_CHUNKS);
    assert.equal(rows.every((row) => Number(row.version_id) === published.versionId), true);
    assert.equal(db.prepare('select count(*) as n from versions where sha256 = ?').get(badSha).n, 1);
  } finally {
    db.close();
  }
});

localTest('a NUL before a secret in an embeddings input stores content chunks and does not post the text', async () => {
  const { db, repo } = await open();
  const hidden = `\0${' '.repeat(64)}${SECRET}`;
  try {
    const pluginFetch = gateway();
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('eb'), kind: 'plugin', chunks: [{ text: hidden, kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: hidden, kind: 'content' }],
      key: KEY,
      fetchImpl: pluginFetch,
    });
    assert.equal(pluginFetch.calls.some((call) => call.url.includes('/embeddings')), false);
    assert.deepEqual(chunkRows(db).filter((row) => row.kind === 'content').map((row) => row.text), [hidden]);
    assert.equal(vecRows(db).length, 0);

    const hostedFetch = gateway();
    await publishCurrent({
      repo, db,
      manifest: manifest({ slug: 'kiln', sha256: sha('ec'), kind: 'plugin', chunks: [{ text: 'visible heading', kind: 'content' }] }),
      tarball: null,
      chunks: [{ text: 'visible heading', kind: 'content' }],
      queriesEs: hidden,
      enrichmentV: ENRICHMENT_VERSION,
      key: KEY,
      fetchImpl: hostedFetch,
    });
    assert.equal(hostedFetch.calls.some((call) => call.url.includes('/embeddings')), false);
    assert.deepEqual(chunkRows(db).filter((row) => row.kind === 'content').map((row) => row.text), ['visible heading']);
    assert.equal(vecRows(db).length, 0);
  } finally {
    db.close();
  }
});

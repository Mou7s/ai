import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { refresh } from '../worker/index.mjs';

test('API serves stored snapshot and falls back when KV is unavailable', async () => {
  const request = new Request('https://example.com/api/data');
  const response = await worker.fetch(request, { MODEL_DATA: { get: async () => '{"models":["stored"]}' } });
  assert.deepEqual(await response.json(), { models: ['stored'] });
  const fallback = await worker.fetch(request, { MODEL_DATA: { get: async () => null } });
  assert.ok((await fallback.json()).models.length >= 100);
});

test('failed source fetch never overwrites last good snapshot; valid data is published', async () => {
  const originalFetch = globalThis.fetch;
  const writes = [];
  const env = { MODEL_DATA: { put: async (...args) => writes.push(args) } };
  try {
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(refresh(env), /503/);
    assert.equal(writes.length, 0);
    globalThis.fetch = async () => new Response('page structure changed');
    await assert.rejects(refresh(env), /initialData missing/);
    assert.equal(writes.length, 0);
    const models = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `Model ${i}`, creator: { name: 'Test' }, intelligenceIndex: 10, intelligenceIndexCostPerTask: { cost: { total: 1 } }, intelligenceIndexTimePerTask: 60, releaseDate:'2026-10-01' }));
    models[1].release_date='2026-10-02';delete models[1].releaseDate;
    const flight = `"initialData":${JSON.stringify(models)}`;
    globalThis.fetch = async () => new Response(`self.__next_f.push([1,${JSON.stringify(flight)}])`);
    await refresh(env);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0][1]).models.length, 100);
    assert.equal(JSON.parse(writes[0][1]).models[0].releaseDate, '2026-10-01');
    assert.equal(JSON.parse(writes[0][1]).models[1].releaseDate, '2026-10-02');
  } finally { globalThis.fetch = originalFetch; }
});

test('/api/chat injects matched model data into Cloudflare Workers AI prompt', async () => {
  let capturedModel = null;
  let capturedInput = null;
  const env = {
    MODEL_DATA: {
      get: async () => JSON.stringify({
        retrievedAt: '2026-10-28T00:00:00.000Z',
        models: [
          { id: '1', name: 'Alpha-1', creator: 'OpenAI', intelligence: 45.5, cost: 1.2, timeSeconds: 30, openWeights: false, releaseDate: '2026-09-01' },
          { id: '2', name: 'Beta-2', creator: 'Anthropic', intelligence: 42.0, cost: 0.5, timeSeconds: 15, openWeights: true, releaseDate: '2026-09-15' }
        ]
      })
    },
    AI: {
      run: async (model, input) => {
        capturedModel = model;
        capturedInput = input;
        return { response: 'Alpha-1 has higher intelligence while Beta-2 is cheaper and faster.' };
      }
    }
  };

  const req = new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'compare Alpha-1 and Beta-2' }] })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply, 'Alpha-1 has higher intelligence while Beta-2 is cheaper and faster.');
  assert.ok(capturedModel.startsWith('@cf/'));
  assert.ok(capturedInput.messages[0].content.includes('Alpha-1'));
  assert.ok(capturedInput.messages[0].content.includes('Beta-2'));
});

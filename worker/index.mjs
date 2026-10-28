import fallbackData from '../src/data.json' with { type: 'json' };
import { fetchSnapshot } from '../lib/model-data.mjs';

const SNAPSHOT_KEY = 'models:latest';
const AI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-8b-instruct'
];

export async function refresh(env) {
  // Only replace the previous snapshot after the complete fetch passes validation.
  const data = await fetchSnapshot();
  await env.MODEL_DATA.put(SNAPSHOT_KEY, JSON.stringify(data));
  console.log(JSON.stringify({ event: 'data-refreshed', retrievedAt: data.retrievedAt, models: data.models.length }));
  return data;
}

async function loadSnapshotData(env) {
  try {
    const raw = await env.MODEL_DATA?.get(SNAPSHOT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.models)) return parsed;
    }
  } catch (error) {
    console.error('Snapshot read failed', error);
  }
  return fallbackData;
}

function formatModelLine(m) {
  const intel = typeof m.intelligence === 'number' && Number.isFinite(m.intelligence) ? m.intelligence.toFixed(2) : 'N/A';
  const cost = typeof m.cost === 'number' && Number.isFinite(m.cost) ? `$${m.cost.toFixed(4)}` : 'N/A';
  const time = typeof m.timeSeconds === 'number' && Number.isFinite(m.timeSeconds) ? `${(m.timeSeconds / 60).toFixed(2)} min (${m.timeSeconds.toFixed(1)}s)` : 'N/A';
  const weights = m.openWeights ? 'Open-weights' : 'Proprietary';
  const date = m.releaseDate ? m.releaseDate.slice(0, 10) : 'Unknown';
  return `- ${m.name} (Creator: ${m.creator} | Intelligence Index: ${intel} | Cost per Task: ${cost} | Time per Task: ${time} | ${weights} | Released: ${date})`;
}

function buildModelContext(snapshot, messages) {
  const allModels = Array.isArray(snapshot?.models) ? snapshot.models : [];
  const userText = messages.map(m => m.content || '').join(' ').normalize('NFKC').toLowerCase();
  const rawTokens = userText.match(/\p{L}+|\d+(?:\.\d+)*/gu) || [];
  const stopWords = new Set(['compare', 'vs', 'versus', 'and', 'or', 'the', 'model', 'models', 'which', 'is', 'better', 'best', 'between', 'what', 'how', 'cost', 'price', 'fast', 'faster', 'speed', 'intelligence', 'smart', 'for', 'with', 'in', 'to', 'of', 'a', 'an']);
  const tokens = [...new Set(rawTokens.filter(t => (t.length >= 2 || /\d/.test(t)) && !stopWords.has(t)))];

  const scored = [];
  for (const m of allModels) {
    if (!m || typeof m !== 'object' || !m.name) continue;
    const hay = `${m.name} ${m.shortName || ''} ${m.slug || ''} ${m.creator || ''}`.normalize('NFKC').toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (hay.includes(token)) {
        score += token.length >= 4 ? 3 : 1.5;
      }
    }
    if (score > 0) scored.push({ model: m, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.model.intelligence ?? -1) - (a.model.intelligence ?? -1));

  const matched = scored.slice(0, 35).map(s => s.model);
  const completeModels = allModels.filter(m => m && typeof m.intelligence === 'number' && typeof m.cost === 'number' && typeof m.timeSeconds === 'number');
  const topByIntel = [...completeModels].sort((a, b) => b.intelligence - a.intelligence).slice(0, 20);
  const seen = new Set(matched.map(m => m.id));
  const topExtra = topByIntel.filter(m => !seen.has(m.id)).slice(0, 15);

  return [
    `Snapshot updated at: ${snapshot?.retrievedAt || 'Unknown'} (Total models in leaderboard: ${allModels.length})`,
    matched.length ? `Matched models from query:\n${matched.map(formatModelLine).join('\n')}` : '',
    topExtra.length ? `Top leaderboard reference models (by Intelligence Index):\n${topExtra.map(formatModelLine).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

async function handleChat(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  if (!env.AI || typeof env.AI.run !== 'function') {
    return Response.json(
      { error: 'Cloudflare Workers AI binding (env.AI) is not available in this environment.' },
      { status: 503 }
    );
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
  const sanitized = rawMessages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, 2000) }));

  if (!sanitized.length || sanitized.at(-1).role !== 'user') {
    return Response.json({ error: 'A user message is required.' }, { status: 400 });
  }

  const snapshot = await loadSnapshotData(env);
  const context = buildModelContext(snapshot, sanitized);
  const systemPrompt = [
    'You are the AI Model Leaderboard Assistant integrated into a 3D AI Model Chart (X: Intelligence Index, Y: Cost per Task in USD, Z: Time per Task in minutes; source: Artificial Analysis).',
    'Use the provided real-time leaderboard snapshot data below to accurately answer questions, compare models across Intelligence Index, Cost per Task, Time per Task, release dates, and open-weights status, and recommend trade-offs.',
    'Keep responses concise, structured, and easy to scan in a compact dialog (use short bullet points). Reply in the same language the user used in their question.',
    'If a specific model is missing metrics (N/A) or not in the snapshot, state that clearly rather than guessing numbers.',
    '',
    context
  ].join('\n');

  const aiMessages = [{ role: 'system', content: systemPrompt }, ...sanitized];
  let lastError = null;
  for (const modelId of AI_MODELS) {
    try {
      const result = await env.AI.run(modelId, {
        messages: aiMessages,
        max_tokens: 700,
        temperature: 0.2
      });
      const reply = typeof result?.response === 'string'
        ? result.response.trim()
        : result?.choices?.[0]?.message?.content?.trim() || '';
      if (reply) {
        return Response.json({ reply, model: modelId });
      }
    } catch (error) {
      lastError = error;
      console.error(`AI model ${modelId} failed`, error);
    }
  }

  return Response.json(
    { error: lastError?.message || 'Failed to generate a response from Cloudflare Workers AI.' },
    { status: 502 }
  );
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/chat') return handleChat(request, env);
    if (pathname !== '/api/data') return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    let data;
    try { data = await env.MODEL_DATA.get(SNAPSHOT_KEY); }
    catch (error) { console.error('Snapshot read failed', error); }
    return new Response(request.method === 'HEAD' ? null : (data || JSON.stringify(fallbackData)), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};

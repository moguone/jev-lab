// 静的ファイル配信 + TypeSafe (Jev) API へのプロキシ。依存パッケージなし。
// API キーをブラウザに渡さないため、呼び出しは必ずここを経由する。
// TYPESAFE_API_KEY が無い場合は MOCK 応答（ランダム）を返し、画面の動作確認だけできるようにする。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.TYPESAFE_API_KEY ?? '';
const BASE_URL = process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai';
const MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest';
const MOCK = process.env.MOCK === '1' || !API_KEY;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callJev(body) {
  const payload = JSON.stringify({ model: MODEL, state: body.state, questions: body.questions });
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = performance.now() - started;
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      await sleep(200 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) return { status: res.status, json: { error: `TypeSafe API ${res.status}: ${text.slice(0, 500)}` } };
    return { status: 200, json: { ...JSON.parse(text), latencyMs, retries: attempt, mock: false } };
  }
}

// ドキュメント記載のレスポンス形に合わせたダミー回答
async function mockJev(body) {
  const latencyMs = 80 + Math.random() * 170;
  await sleep(latencyMs);
  const answers = {};
  for (const [id, q] of Object.entries(body.questions ?? {})) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: Math.random() };
    } else if (q.type === 'score') {
      const weights = q.criteria.map(() => Math.random());
      const sum = weights.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(weights.map((w, i) => [i, w / sum]));
      const score = weights.reduce((acc, w, i) => acc + (i * w) / sum, 0);
      answers[id] = { type: 'score', score, confidence: Math.random(), legend: { ...q.criteria }, probabilities };
    } else {
      const options = Object.keys(q.criteria);
      const weights = options.map(() => Math.random() ** 3);
      const sum = weights.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(options.map((o, i) => [o, weights[i] / sum]));
      const choice = options[weights.indexOf(Math.max(...weights))];
      answers[id] = { type: 'choice', choice, confidence: Math.max(...weights) / sum, probabilities };
    }
  }
  const input_tokens = Math.round(JSON.stringify(body).length / 4);
  return { status: 200, json: { model: 'mock', answers, usage: { input_tokens, output_tokens: 0 }, latencyMs, retries: 0, mock: true } };
}

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(json));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/status') {
      return send(res, 200, { mock: MOCK, model: MOCK ? 'mock' : MODEL });
    }
    if (url.pathname === '/api/decide' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const { status, json } = await (MOCK ? mockJev(body) : callJev(body));
      return send(res, status, json);
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return send(res, 404, { error: 'not found' });
    send(res, 502, { error: String(err.message ?? err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Maze Runner: http://localhost:${PORT}  (${MOCK ? 'MOCK モード: TYPESAFE_API_KEY 未設定' : `model=${MODEL}`})`);
});

// 静的ファイル配信 + Jev を使う 2 つの API（自由回答の解釈・未知の候補の学習）。依存パッケージなし。
// API キーをブラウザに渡さないため、Jev の呼び出しは必ずここを経由する。
// 確率行列 (data/matrix.json) が無ければ正解表から作った MOCK 行列で動き、API キーが無ければ Jev 呼び出しもダミーになる。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUESTIONS } from './public/data.js';
import { MOCK, MODEL, askAboutAnimal, interpretReply, loadLearned, resolveMatrix, saveLearned } from './lib.mjs';

const PORT = Number(process.env.PORT ?? 8788);
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockInterpret(reply) {
  await sleep(120);
  const value = /いいえ|ない|違|ちが|no/i.test(reply) ? 0.1 : /はい|そう|うん|yes/i.test(reply) ? 0.9 : 0.5;
  return { value, confidence: Math.random(), latencyMs: 120, mock: true };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(json));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      const { source, model, matrix } = await resolveMatrix();
      return send(res, 200, { matrixSource: source, matrixModel: model, liveApi: !MOCK, matrix, learned: await loadLearned() });
    }
    if (url.pathname === '/api/interpret' && req.method === 'POST') {
      const { q, reply } = await readBody(req);
      const question = QUESTIONS[q];
      if (!question || typeof reply !== 'string' || !reply.trim()) return send(res, 400, { error: 'q と reply が必要' });
      return send(res, 200, await (MOCK ? mockInterpret(reply) : interpretReply(question, reply.slice(0, 200))));
    }
    if (url.pathname === '/api/learn' && req.method === 'POST') {
      const name = String((await readBody(req)).name ?? '').trim().slice(0, 60);
      if (!name) return send(res, 400, { error: 'name が必要' });
      const row = MOCK ? QUESTIONS.map(() => Math.random()) : (await askAboutAnimal(name)).row;
      const learned = (await loadLearned()).filter((x) => x.name !== name);
      learned.push({ name, row: Object.fromEntries(QUESTIONS.map((q, i) => [q.id, Number(row[i].toFixed(4))])), mock: MOCK });
      await saveLearned(learned);
      return send(res, 200, { learned });
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

server.listen(PORT, '127.0.0.1', async () => {
  const { source } = await resolveMatrix();
  console.log(`Twenty Questions: http://localhost:${PORT}  (行列=${source} / ${MOCK ? 'Jev 呼び出しは MOCK' : `model=${MODEL}`})`);
  if (source === 'mock') console.log('  data/matrix.json が無いか不完全なので MOCK 行列で動作中。npm run build-matrix で生成する。');
});

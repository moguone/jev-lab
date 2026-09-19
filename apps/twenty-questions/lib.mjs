// サーバとスクリプトで共有する部分: TypeSafe (Jev) API 呼び出し、Jev への質問の組み立て、確率行列の読み書き。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ANIMALS, QUESTIONS, TRUTH } from './public/data.js';
import { mulberry32 } from './public/engine.js';

export const API_KEY = process.env.TYPESAFE_API_KEY ?? '';
export const BASE_URL = process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai';
export const MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest';
export const MOCK = process.env.MOCK === '1' || !API_KEY;

const ROOT = dirname(fileURLToPath(import.meta.url));
export const MATRIX_FILE = join(ROOT, 'data', 'matrix.json');
export const LEARNED_FILE = join(ROOT, 'data', 'learned.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callJev(state, questions) {
  const payload = JSON.stringify({ model: MODEL, state, questions });
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = performance.now() - started;
    if ((res.status === 429 || res.status === 529) && attempt < 4) {
      await sleep(300 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${text.slice(0, 500)}`);
    return { ...JSON.parse(text), latencyMs, retries: attempt };
  }
}

// 候補 1 件について全質問を 1 リクエストで fan-out する。state は候補名だけに絞る。
export const animalState = (name) => ({ animal: name });
export const animalQuestions = () =>
  Object.fromEntries(
    QUESTIONS.map((q) => [
      q.id,
      {
        type: 'noul',
        instructions: `Consider the animal named in \`animal\`. ${q.en}`,
        criteria: {
          true: 'Yes for a typical member of this kind of animal.',
          false: 'No for a typical member of this kind of animal.',
        },
      },
    ]),
  );

export async function askAboutAnimal(name) {
  const res = await callJev(animalState(name), animalQuestions());
  return { row: QUESTIONS.map((q) => res.answers[q.id].noul), usage: res.usage, latencyMs: res.latencyMs, model: res.model };
}

// プレイヤーの自由回答を「はい度」(0..1) に直す
const REPLY_LEVELS = [
  'A clear no.',
  'Leaning no: probably not, mostly not, or not really.',
  'Neither yes nor no: the player does not know, says it depends, or the reply does not answer the question.',
  'Leaning yes: probably, mostly, or sort of yes.',
  'A clear yes.',
];
export async function interpretReply(question, reply) {
  const res = await callJev(
    { question_asked: question.en, question_asked_in_japanese: question.ja, player_reply: reply },
    {
      reply: {
        type: 'score',
        instructions:
          'A player is thinking of an animal and was asked `question_asked`. `player_reply` is what the player typed, usually in Japanese. How much does `player_reply` answer yes to the question?',
        criteria: REPLY_LEVELS,
      },
    },
  );
  const a = res.answers.reply;
  return { value: a.score / (REPLY_LEVELS.length - 1), confidence: a.confidence, probabilities: a.probabilities, latencyMs: res.latencyMs };
}

// 正解表にノイズを乗せた MOCK 用の行列。API キーなしでも画面とシミュレーションを動かすためのもの。
export function mockRow(truthRow, rand) {
  return truthRow.map((t) => {
    const base = t === 1 ? 0.88 : t === 0 ? 0.08 : 0.5;
    return Math.min(0.99, Math.max(0.01, base + (rand() - 0.5) * 0.3));
  });
}
export function mockMatrix(seed = 1) {
  const rand = mulberry32(seed);
  return TRUTH.map((row) => mockRow(row, rand));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// data/matrix.json は質問 id をキーに持つので、質問の追加や並べ替えをしても読める。足りない分は null。
export async function loadMatrixFile() {
  return readJson(MATRIX_FILE, null);
}
export async function saveMatrixFile(json) {
  await mkdir(dirname(MATRIX_FILE), { recursive: true });
  await writeFile(MATRIX_FILE, JSON.stringify(json, null, 1));
}

export async function loadLearned() {
  return readJson(LEARNED_FILE, []);
}
export async function saveLearned(list) {
  await mkdir(dirname(LEARNED_FILE), { recursive: true });
  await writeFile(LEARNED_FILE, JSON.stringify(list, null, 1));
}

// 画面とスクリプトが使う行列を組み立てる。source は 'jev' か 'mock'。
export async function resolveMatrix() {
  // 生成済みの行列があれば API キーなしでも使う。MOCK=1 のときだけ明示的に無視する。
  const file = process.env.MOCK === '1' ? null : await loadMatrixFile();
  const rows = file && ANIMALS.map((a) => QUESTIONS.map((q) => file.rows[a.id]?.[q.id] ?? null));
  if (rows && rows.every((row) => row.every((p) => p !== null))) return { source: 'jev', model: file.model, matrix: rows };
  return { source: 'mock', model: 'mock', matrix: mockMatrix(), incomplete: Boolean(file) };
}

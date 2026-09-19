// 候補 × 質問の確率行列を Jev に作らせて data/matrix.json に保存する。
// 候補 1 件につき 1 リクエスト（全質問を Noul で fan-out）。既に埋まっている候補は飛ばすので、質問を足したあとの再実行にも使える。
// 使い方: node scripts/build-matrix.mjs [--force] [--only=lion,tiger] [--concurrency=6]
import { ANIMALS, QUESTIONS, validateData } from '../public/data.js';
import { API_KEY, askAboutAnimal, loadMatrixFile, saveMatrixFile } from '../lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const problems = validateData();
if (problems.length) throw new Error(`data.js に問題がある:\n${problems.join('\n')}`);
if (!API_KEY) throw new Error('TYPESAFE_API_KEY が未設定。リポジトリ直下の .env に設定する。');

const file = (!args.force && (await loadMatrixFile())) || { model: null, rows: {} };
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const todo = ANIMALS.filter((a) => (!only || only.has(a.id)) && (args.force || QUESTIONS.some((q) => file.rows[a.id]?.[q.id] == null)));
console.log(`対象 ${todo.length} / ${ANIMALS.length} 件、質問 ${QUESTIONS.length} 個`);

let tokens = 0;
let done = 0;
const queue = [...todo];
async function worker() {
  for (let a = queue.shift(); a; a = queue.shift()) {
    const { row, usage, model } = await askAboutAnimal(a.en);
    file.model = model;
    file.rows[a.id] = Object.fromEntries(QUESTIONS.map((q, i) => [q.id, Number(row[i].toFixed(4))]));
    tokens += usage.input_tokens;
    process.stdout.write(`\r${++done}/${todo.length} ${a.id.padEnd(14)}`);
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency ?? 6) }, worker));
file.builtAt = new Date().toISOString();
await saveMatrixFile(file);
console.log(`\n保存: data/matrix.json  (入力トークン合計 ${tokens})`);

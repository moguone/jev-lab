// 正解表どおりに答えるプレイヤーで全候補を 1 回ずつ当てさせ、行列の作り方ごとに成績を比べる。
//   soft  : Jev の確率をそのまま尤度に使う
//   hard  : Jev の確率を 0/1 に丸めて使う（確率を返すことの価値を測る比較対象）
//   truth : 人手の正解表をそのまま使う（この質問セットでの上限の目安）
// 使い方: node scripts/sim.mjs [--flip=0.05] [--runs=5] [--noise=0.1]
import { ANIMALS, TRUTH, validateData } from '../public/data.js';
import { Engine, hardened, mulberry32, simulate } from '../public/engine.js';
import { resolveMatrix } from '../lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const flip = Number(args.flip ?? 0);
const runs = Number(args.runs ?? (flip > 0 ? 5 : 1));
const options = args.noise ? { noise: Number(args.noise) } : {};

const problems = validateData();
if (problems.length) throw new Error(problems.join('\n'));

const { source, model, matrix } = await resolveMatrix();
console.log(`行列: ${source} (${model}) / 言い間違い率 flip=${flip} / ${runs} 周`);

const variants = { soft: matrix, hard: hardened(matrix), truth: TRUTH };
const rows = {};
const failures = {};
for (const [name, m] of Object.entries(variants)) {
  const engine = new Engine(m, options);
  const rand = mulberry32(7);
  const results = [];
  failures[name] = [];
  for (let r = 0; r < runs; r++) {
    ANIMALS.forEach((a, i) => {
      const res = simulate(engine, i, TRUTH[i], { flip, rand });
      results.push(res);
      if (!res.solved || res.guesses > 1) failures[name].push(`${a.id}${res.solved ? `(${res.guesses}回目)` : '(×)'}`);
    });
  }
  const solved = results.filter((r) => r.solved);
  const avg = (xs) => (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2);
  rows[name] = {
    正解率: `${((solved.length / results.length) * 100).toFixed(1)}%`,
    '1回目で正解': `${((results.filter((r) => r.solved && r.guesses === 1).length / results.length) * 100).toFixed(1)}%`,
    平均質問数: avg(solved.map((r) => r.questions)),
    最大質問数: Math.max(...solved.map((r) => r.questions)),
  };
}
console.table(rows);
for (const [name, list] of Object.entries(failures)) console.log(`${name} で 1 回目に当たらなかった候補: ${[...new Set(list)].join(' ') || 'なし'}`);

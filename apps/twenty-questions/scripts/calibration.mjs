// Jev の確率行列を人手の正解表と突き合わせる。
//   - 信頼性ビン: Jev が p と言ったセルのうち、実際に yes だった割合（maybe のセルは除外）
//   - Brier スコアと、0.5 で切ったときの正解率
//   - 質問ごとの成績と、大きく外したセルの一覧（質問文の直しどころを探す用）
// 使い方: node scripts/calibration.mjs [--worst=25]
import { ANIMALS, QUESTIONS, TRUTH } from '../public/data.js';
import { resolveMatrix } from '../lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const { source, model, matrix } = await resolveMatrix();
console.log(`行列: ${source} (${model})`);

const cells = [];
ANIMALS.forEach((a, i) => QUESTIONS.forEach((q, j) => TRUTH[i][j] !== 0.5 && cells.push({ a: a.id, q: q.id, p: matrix[i][j], t: TRUTH[i][j] })));
const maybes = ANIMALS.flatMap((a, i) => QUESTIONS.map((q, j) => TRUTH[i][j] === 0.5 && matrix[i][j]).filter((p) => p !== false));

const bins = Array.from({ length: 10 }, (_, b) => ({ 範囲: `${(b / 10).toFixed(1)}–${((b + 1) / 10).toFixed(1)}`, セル数: 0, sumP: 0, sumT: 0 }));
for (const c of cells) {
  const b = bins[Math.min(9, Math.floor(c.p * 10))];
  b.セル数++;
  b.sumP += c.p;
  b.sumT += c.t;
}
console.table(bins.map(({ sumP, sumT, ...b }) => ({ ...b, 'Jev 平均 p': b.セル数 ? (sumP / b.セル数).toFixed(3) : '-', '実際の yes 率': b.セル数 ? (sumT / b.セル数).toFixed(3) : '-' })));

const brier = cells.reduce((s, c) => s + (c.p - c.t) ** 2, 0) / cells.length;
const acc = cells.filter((c) => c.p >= 0.5 === (c.t === 1)).length / cells.length;
const ece = bins.reduce((s, b) => s + (b.セル数 ? Math.abs(b.sumP - b.sumT) : 0), 0) / cells.length;
console.log(`yes/no が明確なセル ${cells.length} 個: 正解率 ${(acc * 100).toFixed(1)}% / Brier ${brier.toFixed(4)} / ECE ${ece.toFixed(4)}`);
console.log(`maybe のセル ${maybes.length} 個の Jev 平均 p = ${(maybes.reduce((s, p) => s + p, 0) / maybes.length).toFixed(3)}（0.2–0.8 に入った割合 ${((maybes.filter((p) => p > 0.2 && p < 0.8).length / maybes.length) * 100).toFixed(1)}%）`);

const perQ = QUESTIONS.map((q) => {
  const cs = cells.filter((c) => c.q === q.id);
  return { 質問: q.id, 正解率: `${((cs.filter((c) => c.p >= 0.5 === (c.t === 1)).length / cs.length) * 100).toFixed(0)}%`, Brier: (cs.reduce((s, c) => s + (c.p - c.t) ** 2, 0) / cs.length).toFixed(3) };
}).sort((x, y) => y.Brier - x.Brier);
console.log('\n質問ごと（Brier の悪い順）');
console.table(perQ.slice(0, 12));

console.log('\n大きく外したセル');
console.table(cells.sort((x, y) => Math.abs(y.p - y.t) - Math.abs(x.p - x.t)).slice(0, Number(args.worst ?? 25)).map((c) => ({ 候補: c.a, 質問: c.q, 'Jev p': c.p.toFixed(2), 正解表: c.t ? 'yes' : 'no' })));

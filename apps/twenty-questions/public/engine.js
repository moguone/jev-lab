// 20 の質問の推論エンジン。Jev は使わず、Jev が事前に出した確率行列をコードで合成するだけ。
// matrix[a][q] = 「候補 a について質問 q の答えが yes である確率」。
// ブラウザ (main.js) と Node スクリプト (scripts/*.mjs) の両方から使う。

export const ANSWERS = [
  { id: 'yes', ja: 'はい', value: 1 },
  { id: 'probably', ja: 'たぶんそう', value: 0.75 },
  { id: 'unknown', ja: 'わからない', value: 0.5 },
  { id: 'probably_not', ja: 'たぶん違う', value: 0.25 },
  { id: 'no', ja: 'いいえ', value: 0 },
];

export const DEFAULTS = {
  noise: 0.1, // プレイヤーの勘違いや行列の誤りを見込む割合。0 にすると 1 回の食い違いで候補が即死する
  clamp: 0.02, // 行列の確率を [clamp, 1-clamp] に収める
  guessAt: 0.8, // 事後確率がこれを超えたら回答する
  minGain: 0.01, // どの質問の期待情報利得もこれ未満なら、質問をやめて回答する
  maxQuestions: 25,
  maxGuesses: 3,
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 確率を 0/1 に丸めた行列。「確率をそのまま使う価値」を測る比較対象。
export const hardened = (matrix) => matrix.map((row) => row.map((p) => (p >= 0.5 ? 1 : 0)));

export function entropy(dist) {
  let h = 0;
  for (const p of dist) if (p > 0) h -= p * Math.log2(p);
  return h;
}

export class Engine {
  constructor(matrix, options = {}) {
    this.opt = { ...DEFAULTS, ...options };
    const c = this.opt.clamp;
    this.matrix = matrix.map((row) => row.map((p) => Math.min(1 - c, Math.max(c, p))));
    this.n = matrix.length;
    this.nq = matrix[0].length;
    this.reset();
  }

  reset() {
    this.posterior = new Array(this.n).fill(1 / this.n);
    this.asked = []; // { q, value, gain, entropyBefore, entropyAfter }
    this.rejected = []; // 回答して外した候補
  }

  // 候補 a が正解のとき、質問 q にプレイヤーが value (1=はい … 0=いいえ) と答える尤度
  likelihood(a, q, value) {
    const p = this.matrix[a][q];
    const clean = value * p + (1 - value) * (1 - p);
    return (1 - this.opt.noise) * clean + this.opt.noise * 0.5;
  }

  // 「はい / いいえ」の 2 択で答えが返るとした場合の期待情報利得 (bit)
  expectedGain(q) {
    const post = this.posterior;
    let pYes = 0;
    const ifYes = new Array(this.n);
    const ifNo = new Array(this.n);
    for (let a = 0; a < this.n; a++) {
      const ly = this.likelihood(a, q, 1);
      ifYes[a] = post[a] * ly;
      ifNo[a] = post[a] * (1 - ly);
      pYes += ifYes[a];
    }
    const pNo = 1 - pYes;
    if (pYes <= 0 || pNo <= 0) return { gain: 0, pYes };
    const hYes = entropy(ifYes.map((v) => v / pYes));
    const hNo = entropy(ifNo.map((v) => v / pNo));
    return { gain: entropy(post) - (pYes * hYes + pNo * hNo), pYes };
  }

  rankQuestions() {
    const done = new Set(this.asked.map((x) => x.q));
    const ranked = [];
    for (let q = 0; q < this.nq; q++) if (!done.has(q)) ranked.push({ q, ...this.expectedGain(q) });
    return ranked.sort((x, y) => y.gain - x.gain);
  }

  answer(q, value, meta = {}) {
    const before = entropy(this.posterior);
    const { gain } = this.expectedGain(q);
    let sum = 0;
    for (let a = 0; a < this.n; a++) {
      this.posterior[a] *= this.likelihood(a, q, value);
      sum += this.posterior[a];
    }
    for (let a = 0; a < this.n; a++) this.posterior[a] /= sum;
    this.asked.push({ q, value, gain, entropyBefore: before, entropyAfter: entropy(this.posterior), ...meta });
  }

  rejectGuess(a) {
    this.rejected.push(a);
    this.posterior[a] = 0;
    const sum = this.posterior.reduce((x, y) => x + y, 0);
    for (let i = 0; i < this.n; i++) this.posterior[i] /= sum;
  }

  ranking(limit = this.n) {
    return this.posterior
      .map((p, a) => ({ a, p }))
      .sort((x, y) => y.p - x.p)
      .slice(0, limit);
  }

  // 次の一手: { type: 'ask', q, gain, pYes } | { type: 'guess', a, p } | { type: 'giveup' }
  next() {
    if (this.rejected.length >= this.opt.maxGuesses || this.rejected.length >= this.n - 1) return { type: 'giveup' };
    const [top] = this.ranking(1);
    const [best] = this.rankQuestions();
    const outOfQuestions = !best || best.gain < this.opt.minGain || this.asked.length >= this.opt.maxQuestions;
    if (top.p >= this.opt.guessAt || outOfQuestions) return { type: 'guess', ...top };
    return { type: 'ask', ...best };
  }
}

// 正解表どおりに答えるプレイヤーで 1 ゲーム回す。truthRow[q] = 1 / 0.5 / 0。
// flip > 0 なら、その確率で yes/no を言い間違える。
export function simulate(engine, target, truthRow, { flip = 0, rand = Math.random } = {}) {
  engine.reset();
  for (;;) {
    const step = engine.next();
    if (step.type === 'giveup') return { solved: false, questions: engine.asked.length, guesses: engine.rejected.length };
    if (step.type === 'guess') {
      if (step.a === target) return { solved: true, questions: engine.asked.length, guesses: engine.rejected.length + 1 };
      engine.rejectGuess(step.a);
      continue;
    }
    let value = truthRow[step.q];
    if (value !== 0.5 && rand() < flip) value = 1 - value;
    engine.answer(step.q, value);
  }
}

// Jev 戦略をヘッドレス・同期進行で回して成績を比べる。起動中のサーバ (npm start) の /api/decide を経由する。
// 使い方: node scripts/bench.mjs [seeds=3] [ghosts=4] [strategies=jev-features,jev-composite,jev-ascii]
// 注意: TypeSafe の規約はサービスのベンチマーク・性能情報の公開を禁じている。結果は手元での検証にとどめること
import { Game } from '../public/game.js';
import { buildRequest, heuristicChoice, interpret } from '../public/agent.js';

const seeds = Number(process.argv[2] ?? 3);
const ghosts = Number(process.argv[3] ?? 4);
const strategies = (process.argv[4] ?? 'jev-features,jev-composite,jev-ascii').split(',');
const PRICE = Number(process.env.USD_PER_MTOK ?? 0); // 入力単価 ($/100万トークン)。指定したときだけコスト列を出す
const ENDPOINT = `http://localhost:${process.env.PORT ?? 8787}/api/decide`;

async function episode(strategy, seed) {
  const game = new Game({ seed, ghosts });
  const m = { latencies: [], tokens: 0, conf: 0, errors: 0, agree: 0, decisions: 0 };
  while (!game.over) {
    const req = buildRequest(strategy, game);
    const baseline = heuristicChoice(game, req.feats);
    let dir = baseline;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: req.state, questions: req.questions }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      const out = interpret(strategy, json.answers, game, req.feats);
      dir = out.dir;
      m.latencies.push(json.latencyMs);
      m.tokens += json.usage.input_tokens;
      m.conf += out.confidence;
      m.decisions++;
      if (dir === baseline) m.agree++;
    } catch (err) {
      if (++m.errors === 1) console.error(`[${strategy} seed=${seed}] ${err.message}`);
      if (m.errors > 20) throw new Error(`${strategy} seed=${seed}: API エラー多発のため中断`);
    }
    game.step(dir);
  }
  const sorted = [...m.latencies].sort((a, b) => a - b);
  const row = {
    strategy,
    seed,
    result: game.result,
    cleared: `${Math.round((1 - game.remaining() / game.totalPellets) * 100)}%`,
    score: game.score,
    ticks: game.tick,
    avgMs: Math.round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    tokens: m.tokens,
    ...(PRICE > 0 ? { usd: ((m.tokens * PRICE) / 1e6).toFixed(5) } : {}),
    avgConf: (m.conf / (m.decisions || 1)).toFixed(2),
    agreeHeur: `${Math.round((m.agree / (m.decisions || 1)) * 100)}%`,
    errors: m.errors,
  };
  console.error(`done: ${strategy} seed=${seed} → ${row.result} ${row.cleared} (${row.ticks} ticks)`);
  return row;
}

// 戦略ごとに並列、シードは順番に
const rows = (
  await Promise.all(
    strategies.map(async (s) => {
      const out = [];
      for (let seed = 1; seed <= seeds; seed++) out.push(await episode(s, seed));
      return out;
    }),
  )
).flat();
console.table(rows);

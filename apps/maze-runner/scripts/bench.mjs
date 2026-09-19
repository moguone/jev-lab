// 戦略をヘッドレス・同期進行で回して成績を比べる。Jev 戦略は起動中のサーバ (npm start) の /api/decide を経由する。
// 使い方: node scripts/bench.mjs [seeds=3] [ghosts=4] [strategies=カンマ区切り] [並列数=6]
// 注意: TypeSafe の規約はサービスのベンチマーク・性能情報の公開を禁じている。結果は手元での検証にとどめること
import { Game } from '../public/game.js';
import { STRATEGIES, buildRequest, heuristicChoice, interpret, tacticalHeuristic } from '../public/agent.js';

const seeds = Number(process.argv[2] ?? 3);
const ghosts = Number(process.argv[3] ?? 4);
const strategies = (process.argv[4] ?? 'jev-tactical-fanout,jev-tactical-choice,heuristic-tactical,heuristic').split(',');
const concurrency = Number(process.argv[5] ?? 6);
const PRICE = Number(process.env.USD_PER_MTOK ?? 0); // 入力単価 ($/100万トークン)。指定したときだけコスト列を出す
const ENDPOINT = `http://localhost:${process.env.PORT ?? 8787}/api/decide`;
const LOCAL = { heuristic: heuristicChoice, 'heuristic-tactical': tacticalHeuristic };

async function episode(strategy, seed) {
  const game = new Game({ seed, ghosts });
  const m = { latencies: [], tokens: 0, conf: 0, errors: 0, agree: 0, decisions: 0 };
  while (!game.over) {
    if (LOCAL[strategy]) {
      game.step(LOCAL[strategy](game));
      continue;
    }
    const req = buildRequest(strategy, game);
    let dir = req.fallbackDir;
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
      if (dir === req.fallbackDir) m.agree++;
    } catch (err) {
      if (++m.errors === 1) console.error(`[${strategy} seed=${seed}] ${err.message}`);
      if (m.errors > 20) throw new Error(`${strategy} seed=${seed}: API エラー多発のため中断`);
    }
    game.step(dir);
  }
  const sorted = [...m.latencies].sort((a, b) => a - b);
  console.error(`done: ${strategy} seed=${seed} → ${game.result} score=${game.score}`);
  return {
    strategy,
    seed,
    result: game.result,
    cleared: Math.round((1 - game.remaining() / game.totalPellets) * 100),
    score: game.score,
    eaten: game.ghostsEaten,
    ticks: game.tick,
    avgMs: Math.round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    tokens: m.tokens,
    ...(PRICE > 0 ? { usd: ((m.tokens * PRICE) / 1e6).toFixed(5) } : {}),
    agree: m.decisions ? Math.round((m.agree / m.decisions) * 100) : null,
    errors: m.errors,
  };
}

for (const s of strategies) if (!STRATEGIES[s]) throw new Error(`未知の戦略: ${s}`);
const jobs = strategies.flatMap((strategy) => Array.from({ length: seeds }, (_, i) => ({ strategy, seed: i + 1 })));
const rows = [];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let job; (job = jobs.shift()); ) rows.push(await episode(job.strategy, job.seed));
  }),
);
rows.sort((a, b) => strategies.indexOf(a.strategy) - strategies.indexOf(b.strategy) || a.seed - b.seed);
if (process.env.VERBOSE) console.table(rows);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.table(
  strategies.map((s) => {
    const r = rows.filter((x) => x.strategy === s);
    return {
      strategy: s,
      episodes: r.length,
      wins: r.filter((x) => x.result === 'win').length,
      avgScore: Math.round(mean(r.map((x) => x.score))),
      avgCleared: `${Math.round(mean(r.map((x) => x.cleared)))}%`,
      eatenPerEp: mean(r.map((x) => x.eaten)).toFixed(1),
      avgMs: Math.round(mean(r.map((x) => x.avgMs))) || '-',
      tokensPerEp: Math.round(mean(r.map((x) => x.tokens))) || '-',
      agreeFallback: r[0]?.agree === null ? '-' : `${Math.round(mean(r.map((x) => x.agree)))}%`,
      errors: r.reduce((a, x) => a + x.errors, 0),
    };
  }),
);

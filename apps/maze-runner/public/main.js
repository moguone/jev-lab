// 描画・実行ループ・計測。裁定そのものは agent.js、ゲームルールは game.js。

import { DIRS, Game, MAP, mulberry32 } from './game.js';
import { STRATEGIES, buildRequest, heuristicChoice, interpret } from './agent.js';

const TILE = 24;
const MAX_CONSECUTIVE_ERRORS = 3;

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

// タブが非表示になるとメインスレッドの setTimeout は 1 秒間隔に間引かれ、裏で回す連続検証が進まなくなる。
// Worker 内のタイマーは間引かれないので、待機は Worker 経由で行う
const timerWorker = new Worker(
  URL.createObjectURL(new Blob(['onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);'], { type: 'text/javascript' })),
);
const sleepers = new Map();
let sleepId = 0;
timerWorker.onmessage = (e) => {
  sleepers.get(e.data)?.();
  sleepers.delete(e.data);
};
const sleep = (ms) =>
  new Promise((resolve) => {
    sleepers.set(++sleepId, resolve);
    timerWorker.postMessage({ id: sleepId, ms });
  });

const ui = {
  strategy: $('strategy'), timing: $('timing'), tickMs: $('tickMs'), ghosts: $('ghosts'),
  seed: $('seed'), episodes: $('episodes'), gateOn: $('gateOn'), gate: $('gate'), price: $('price'),
};
for (const [id, s] of Object.entries(STRATEGIES)) ui.strategy.add(new Option(s.label, id));

let game;
let metrics;
let lastDecision = null;
let running = false;
let epoch = 0; // リセットや再スタートのたびに進め、古い非同期処理の結果を捨てる
let lastTickAt = 0;
let episodesLeft = 0;
let localRand = mulberry32(1);
const results = [];

const cfg = () => ({
  strategy: ui.strategy.value,
  timing: ui.timing.value,
  tickMs: Number(ui.tickMs.value),
  ghosts: Number(ui.ghosts.value),
  seed: Number(ui.seed.value) || 1,
  gateOn: ui.gateOn.checked,
  gate: Number(ui.gate.value),
});

function newMetrics() {
  return { decisions: 0, latencies: [], rtts: [], tokens: 0, confSum: 0, confN: 0, fallbacks: 0, stale: 0, errors: 0, illegal: 0, ageSum: 0 };
}

function newGame() {
  epoch++;
  const c = cfg();
  game = new Game({ seed: c.seed, ghosts: c.ghosts });
  localRand = mulberry32(c.seed * 7919);
  metrics = newMetrics();
  lastDecision = null;
  lastTickAt = performance.now();
  renderDecision();
  renderPanels();
}

// ---- 裁定 ---------------------------------------------------------------

async function decide() {
  const c = cfg();
  if (c.strategy === 'random') {
    const legal = game.legalDirs();
    return { dir: legal[Math.floor(localRand() * legal.length)], source: 'random' };
  }
  if (c.strategy === 'heuristic') return { dir: heuristicChoice(game), source: 'heuristic' };

  // ここまでは同期処理なので、request は「呼び出した瞬間の盤面」のスナップショットになる
  const request = buildRequest(c.strategy, game);
  const fallbackDir = heuristicChoice(game, request.feats);
  const started = performance.now();
  try {
    const res = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: request.state, questions: request.questions }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    const out = interpret(c.strategy, json.answers, game, request.feats);
    const gated = c.gateOn && out.confidence < c.gate;
    return {
      ...out,
      jevDir: out.dir,
      dir: gated ? fallbackDir : out.dir,
      source: gated ? 'fallback' : 'jev',
      latencyMs: json.latencyMs,
      rttMs: performance.now() - started,
      tokens: json.usage?.input_tokens ?? 0,
      answers: json.answers,
      request,
    };
  } catch (err) {
    return { dir: fallbackDir, source: 'error', error: String(err.message ?? err), request };
  }
}

function recordDecision(d) {
  lastDecision = d;
  if (d.source === 'random' || d.source === 'heuristic') return;
  metrics.decisions++;
  if (d.source === 'error') {
    metrics.errors++;
    metrics.consecutiveErrors = (metrics.consecutiveErrors ?? 0) + 1;
    showError(d.error);
    if (metrics.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) pause(`API エラーが ${MAX_CONSECUTIVE_ERRORS} 回続いたため停止しました`);
    return;
  }
  metrics.consecutiveErrors = 0;
  metrics.latencies.push(d.latencyMs);
  metrics.rtts.push(d.rttMs);
  metrics.tokens += d.tokens;
  metrics.confSum += d.confidence;
  metrics.confN++;
  if (d.source === 'fallback') metrics.fallbacks++;
  if (d.illegal) metrics.illegal++;
  renderDecision();
}

// ---- 実行ループ -----------------------------------------------------------

function advance(dir) {
  game.step(dir);
  lastTickAt = performance.now();
  renderPanels();
}

// 同期: 1 手ごとに Jev の回答を待つ。ゲーム速度 = レイテンシになる
async function runSync(myEpoch) {
  while (running && epoch === myEpoch && !game.over) {
    const started = performance.now();
    const d = await decide();
    if (!running || epoch !== myEpoch) return;
    recordDecision(d);
    if (!running) return;
    advance(d.dir);
    const wait = cfg().tickMs - (performance.now() - started);
    if (wait > 0) await sleep(wait);
  }
  if (epoch === myEpoch && game.over) onEpisodeEnd(myEpoch);
}

// リアルタイム: tick は待たない。回答が来るまでランナーは今の向きに直進し、
// 届いた手がその時点の盤面で打てなければ stale として捨てる
async function runRealtime(myEpoch) {
  let desired = null;
  let inflight = false;
  while (running && epoch === myEpoch && !game.over) {
    if (!inflight) {
      inflight = true;
      const askedAt = game.tick;
      decide().then((d) => {
        inflight = false;
        if (!running || epoch !== myEpoch) return;
        recordDecision(d);
        metrics.ageSum += game.tick - askedAt;
        if (game.legalDirs().includes(d.dir)) desired = d.dir;
        else metrics.stale++;
      });
    }
    advance(desired);
    await sleep(cfg().tickMs);
  }
  if (epoch === myEpoch && game.over) onEpisodeEnd(myEpoch);
}

function start() {
  if (game.over) newGame();
  if (episodesLeft === 0) episodesLeft = Math.max(1, Number(ui.episodes.value) || 1);
  running = true;
  showError(null);
  setControls();
  // API を使わないベースラインは回答が即時なので、常に同期ループで回す
  const c = cfg();
  (c.timing === 'sync' || !STRATEGIES[c.strategy].usesApi ? runSync : runRealtime)(epoch);
}

function pause(message) {
  running = false;
  setControls();
  if (message) showError(message);
}

async function onEpisodeEnd(myEpoch) {
  recordResult();
  episodesLeft--;
  if (episodesLeft > 0 && running) {
    await sleep(800);
    if (epoch !== myEpoch || !running) return;
    ui.seed.value = cfg().seed + 1;
    newGame();
    start();
    return;
  }
  episodesLeft = 0;
  running = false;
  setControls();
}

// ---- 表示 ---------------------------------------------------------------

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0);
const fmtMs = (v) => (v ? `${Math.round(v)} ms` : '–');
// 単価は利用者が入力したときだけ使う（リポジトリには価格情報を持たない）
const cost = (tokens) => (Number(ui.price.value) > 0 ? `$${((tokens * Number(ui.price.value)) / 1e6).toFixed(6)}` : '–');

function renderPanels() {
  $('hudScore').textContent = game.score;
  $('hudLives').textContent = game.lives;
  $('hudPellets').textContent = `${game.remaining()} / ${game.totalPellets}`;
  $('hudTick').textContent = game.tick;
  $('hudStatus').textContent = game.over
    ? { win: 'クリア！', lost: 'ゲームオーバー', timeout: '時間切れ' }[game.result]
    : running ? '実行中' : '待機中';

  const m = metrics;
  const items = [
    ['裁定数', m.decisions],
    ['Jev レイテンシ平均', fmtMs(avg(m.latencies))],
    ['Jev レイテンシ p95', fmtMs(p95(m.latencies))],
    ['ブラウザ往復 平均', fmtMs(avg(m.rtts))],
    ['入力トークン計', m.tokens.toLocaleString()],
    ['推定コスト', cost(m.tokens)],
    ['平均 confidence', m.confN ? (m.confSum / m.confN).toFixed(2) : '–'],
    ['フォールバック', m.fallbacks],
    ['stale で破棄', m.stale],
    ['回答までの平均 tick', m.decisions && cfg().timing === 'realtime' ? (m.ageSum / m.decisions).toFixed(1) : '–'],
    ['不正手 (型違反)', m.illegal],
    ['API エラー', m.errors],
  ];
  $('metrics').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function renderDecision() {
  const d = lastDecision;
  if (!d || !d.probabilities) {
    $('decision').innerHTML = '<p class="muted">まだ裁定がありません。</p>';
    $('requestDump').textContent = '';
    return;
  }
  const source = { jev: 'Jev', fallback: `フォールバック (Jev は ${d.jevDir})` }[d.source];
  const bars = Object.entries(d.probabilities)
    .filter(([dir]) => DIRS[dir])
    .sort((a, b) => b[1] - a[1])
    .map(([dir, p]) => `<div class="bar${dir === d.dir ? ' chosen' : ''}"><span>${dir}</span><i style="width:${(p * 100).toFixed(1)}%"></i><span>${(p * 100).toFixed(1)}%</span></div>`)
    .join('');
  $('decision').innerHTML =
    `<div class="head"><span>採用: <b>${d.dir}</b></span><span>決定者: <b>${source}</b></span>` +
    `<span>confidence: <b>${d.confidence.toFixed(2)}</b></span><span>Jev: <b>${fmtMs(d.latencyMs)}</b></span><span>tokens: <b>${d.tokens}</b></span></div>${bars}`;
  $('requestDump').textContent = JSON.stringify({ state: d.request.state, questions: d.request.questions, answers: d.answers }, null, 2);
}

function recordResult() {
  const c = cfg();
  const m = metrics;
  results.push({
    n: results.length + 1,
    strategy: c.strategy,
    timing: STRATEGIES[c.strategy].usesApi ? c.timing : '-',
    ghosts: c.ghosts,
    seed: c.seed,
    result: game.result,
    score: game.score,
    cleared: Math.round((1 - game.remaining() / game.totalPellets) * 100),
    ticks: game.tick,
    decisions: m.decisions,
    avgMs: Math.round(avg(m.latencies)),
    p95Ms: Math.round(p95(m.latencies)),
    tokens: m.tokens,
    usd: cost(m.tokens).replace('$', ''),
    fallbacks: m.fallbacks,
    stale: m.stale,
  });
  const r = results.at(-1);
  const row = $('results').tBodies[0].insertRow(0);
  row.innerHTML = Object.entries(r)
    .map(([k, v]) => `<td${k === 'result' ? ` class="${v}"` : ''}>${k === 'cleared' ? `${v}%` : v}</td>`)
    .join('');
}

function showError(message) {
  $('errorBox').hidden = !message;
  $('errorBox').textContent = message ?? '';
}

function setControls() {
  $('btnStart').disabled = running;
  $('btnPause').disabled = !running;
  for (const k of ['strategy', 'timing', 'ghosts', 'seed', 'episodes']) ui[k].disabled = running;
  renderPanels();
}

// ---- 描画 ---------------------------------------------------------------

function lerpPos(e, t) {
  return [(e.px + (e.x - e.px) * t + 0.5) * TILE, (e.py + (e.y - e.py) * t + 0.5) * TILE];
}

function draw(now) {
  const t = Math.min(1, (now - lastTickAt) / Math.min(cfg().tickMs, 200));
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < game.height; y++) {
    for (let x = 0; x < game.width; x++) {
      const c = MAP[y][x];
      if (c === '#') {
        ctx.fillStyle = '#1a1333';
        ctx.strokeStyle = '#6d4aff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(x * TILE + 1.5, y * TILE + 1.5, TILE - 3, TILE - 3);
        ctx.fill();
        ctx.stroke();
      } else if (c === '-') {
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(x * TILE, y * TILE + TILE / 2 - 1.5, TILE, 3);
      }
    }
  }

  ctx.fillStyle = '#c7d2fe';
  for (const k of game.pellets) {
    const [x, y] = k.split(',').map(Number);
    ctx.fillRect((x + 0.5) * TILE - 2, (y + 0.5) * TILE - 2, 4, 4);
  }
  const pulse = 5 + Math.sin(now / 150) * 1.5;
  ctx.strokeStyle = '#fde68a';
  ctx.lineWidth = 2.5;
  for (const k of game.powers) {
    const [x, y] = k.split(',').map(Number);
    ctx.beginPath();
    ctx.arc((x + 0.5) * TILE, (y + 0.5) * TILE, pulse, 0, Math.PI * 2);
    ctx.stroke();
  }

  const [pxl, pyl] = lerpPos(game.runner, t);
  drawProbabilities(pxl, pyl);
  drawRunner(pxl, pyl, now);
  for (const g of game.ghosts) drawGhost(g, t, now);

  if (game.over) {
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(0, canvas.height / 2 - 34, canvas.width, 68);
    ctx.fillStyle = game.result === 'win' ? '#4ade80' : '#ff6b6b';
    ctx.font = 'bold 28px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText({ win: 'CLEAR!', lost: 'GAME OVER', timeout: 'TIME UP' }[game.result], canvas.width / 2, canvas.height / 2);
  }
  requestAnimationFrame(draw);
}

// 直近の裁定の確率分布をランナーの周囲に矢印で重ねる（濃いほど高確率）
function drawProbabilities(cx, cy) {
  const probs = lastDecision?.probabilities;
  if (!probs) return;
  for (const [dir, p] of Object.entries(probs)) {
    if (!DIRS[dir] || p < 0.02) continue;
    const [dx, dy] = DIRS[dir];
    const bx = cx + dx * TILE * 0.95;
    const by = cy + dy * TILE * 0.95;
    ctx.fillStyle = `rgba(74, 222, 128, ${0.15 + p * 0.85})`;
    ctx.beginPath();
    ctx.moveTo(bx + dx * 8, by + dy * 8);
    ctx.lineTo(bx - dy * 6, by - dx * 6);
    ctx.lineTo(bx + dy * 6, by + dx * 6);
    ctx.fill();
  }
}

// ランナー: 進行方向を向く矢じり型
function drawRunner(cx, cy, now) {
  const angle = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[game.runner.dir];
  const r = TILE * 0.44;
  const flare = running ? 0.75 + Math.abs(Math.sin(now / 110)) * 0.15 : 0.8;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = '#5eead4';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(-r * 0.8, -r * flare);
  ctx.lineTo(-r * 0.35, 0);
  ctx.lineTo(-r * 0.8, r * flare);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ゴースト: 単眼のひし形。怯え中は輪郭だけになる
function drawGhost(g, t, now) {
  const [cx, cy] = lerpPos(g, t);
  const r = TILE * 0.44;
  const blink = g.frightened && game.frightTimer <= 10 && Math.floor(now / 160) % 2 === 0;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  if (g.frightened) {
    ctx.strokeStyle = blink ? '#f8fafc' : '#64748b';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  ctx.fillStyle = g.color;
  ctx.fill();
  const [dx, dy] = DIRS[g.dir] ?? [0, 0];
  ctx.fillStyle = '#0b0d1a';
  ctx.beginPath();
  ctx.arc(cx + dx * 2.5, cy + dy * 2.5, 3, 0, Math.PI * 2);
  ctx.fill();
}

// ---- 初期化 --------------------------------------------------------------

function syncOutputs() {
  $('tickMsOut').textContent = `${ui.tickMs.value} ms`;
  $('gateOut').textContent = Number(ui.gate.value).toFixed(2);
}

$('btnStart').addEventListener('click', start);
$('btnPause').addEventListener('click', () => pause());
$('btnReset').addEventListener('click', () => {
  running = false;
  episodesLeft = 0;
  showError(null);
  newGame();
  setControls();
});
$('btnCsv').addEventListener('click', async () => {
  if (!results.length) return;
  const csv = [Object.keys(results[0]).join(','), ...results.map((r) => Object.values(r).join(','))].join('\n');
  await navigator.clipboard.writeText(csv);
  $('btnCsv').textContent = 'コピーしました';
  setTimeout(() => ($('btnCsv').textContent = 'CSV コピー'), 1500);
});
for (const k of ['strategy', 'ghosts', 'seed']) ui[k].addEventListener('change', () => !running && newGame());
ui.tickMs.addEventListener('input', syncOutputs);
ui.gate.addEventListener('input', syncOutputs);
try {
  ui.price.value = localStorage.getItem('pricePerMTok') ?? '';
} catch {}
ui.price.addEventListener('input', () => {
  try {
    localStorage.setItem('pricePerMTok', ui.price.value);
  } catch {}
  renderPanels();
});

fetch('/api/status')
  .then((r) => r.json())
  .then((s) => {
    const badge = $('apiBadge');
    badge.textContent = s.mock ? 'MOCK: API キー未設定（回答はランダム）' : `LIVE: ${s.model}`;
    badge.className = `badge ${s.mock ? 'mock' : 'live'}`;
  })
  .catch(() => ($('apiBadge').textContent = 'サーバに接続できません'));

syncOutputs();
newGame();
setControls();
requestAnimationFrame(draw);

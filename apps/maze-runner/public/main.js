// 描画・実行ループ・計測・リプレイ。裁定そのものは agent.js、ゲームルールは game.js。

import { DIRS, Game, MAP, mulberry32 } from './game.js';
import { STRATEGIES, buildRequest, heuristicChoice, interpret, tacticalHeuristic } from './agent.js';

const TILE = 24;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_KEPT_REPLAYS = 20; // リクエスト本文ごと保持するので、古いものから捨てる

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
let rec; // 現在のエピソードの記録。シード + 各 tick の手があれば盤面は完全に再現できる
let lastDecision = null;
let consecutiveErrors = 0;
let running = false;
let epoch = 0; // リセットや再スタートのたびに進め、古い非同期処理の結果を捨てる
let lastTickAt = 0;
let episodesLeft = 0;
let localRand = mulberry32(1);
let replay = null; // { rec, pos, game, playing, events }
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

function newGame() {
  epoch++;
  const c = cfg();
  game = new Game({ seed: c.seed, ghosts: c.ghosts });
  rec = {
    version: 1,
    app: 'maze-runner',
    strategy: c.strategy,
    timing: STRATEGIES[c.strategy].usesApi ? c.timing : 'sync',
    ghosts: c.ghosts,
    seed: c.seed,
    steps: [],
    decisions: [],
    result: null,
    score: 0,
  };
  localRand = mulberry32(c.seed * 7919);
  consecutiveErrors = 0;
  lastDecision = null;
  lastTickAt = performance.now();
  renderAll();
}

// ---- 裁定 ---------------------------------------------------------------

async function decide() {
  const c = cfg();
  if (c.strategy === 'random') {
    const legal = game.legalDirs();
    return { dir: legal[Math.floor(localRand() * legal.length)], source: 'random' };
  }
  if (c.strategy === 'heuristic') return { dir: heuristicChoice(game), source: 'heuristic' };
  if (c.strategy === 'heuristic-tactical') return { dir: tacticalHeuristic(game), source: 'heuristic' };

  // ここまでは同期処理なので、request は「呼び出した瞬間の盤面」のスナップショットになる
  const askedTick = game.tick;
  const request = buildRequest(c.strategy, game);
  const { fallbackDir } = request;
  const wire = { state: request.state, questions: request.questions };
  const started = performance.now();
  try {
    const res = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wire) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    const out = interpret(c.strategy, json.answers, game, request.feats);
    const gated = c.gateOn && out.confidence < c.gate;
    return {
      ...out,
      askedTick,
      jevDir: out.dir,
      fallbackDir,
      dir: gated ? fallbackDir : out.dir,
      source: gated ? 'fallback' : 'jev',
      gate: c.gateOn ? c.gate : null,
      latencyMs: json.latencyMs,
      rttMs: performance.now() - started,
      usage: json.usage ?? {},
      retries: json.retries ?? 0,
      model: json.model,
      answers: json.answers,
      request: wire,
    };
  } catch (err) {
    return { askedTick, dir: fallbackDir, fallbackDir, source: 'error', error: String(err.message ?? err), rttMs: performance.now() - started, request: wire };
  }
}

// 裁定を記録に積む。forTick = この裁定が最初に効く tick
function recordDecision(d) {
  lastDecision = d;
  if (d.source === 'random' || d.source === 'heuristic') return d;
  d.forTick = game.tick + 1;
  rec.decisions.push(d);
  if (d.source === 'error') {
    showError(d.error);
    if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) pause(`API エラーが ${MAX_CONSECUTIVE_ERRORS} 回続いたため停止しました`);
  } else {
    consecutiveErrors = 0;
  }
  renderDecision();
  return d;
}

// ---- 実行ループ -----------------------------------------------------------

function advance(dir) {
  rec.steps.push(dir ?? null);
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
      decide().then((d) => {
        inflight = false;
        if (!running || epoch !== myEpoch) return;
        recordDecision(d);
        if (game.legalDirs().includes(d.dir)) desired = d.dir;
        else d.stale = true;
      });
    }
    advance(desired);
    await sleep(cfg().tickMs);
  }
  if (epoch === myEpoch && game.over) onEpisodeEnd(myEpoch);
}

function start() {
  if (replay) closeReplay();
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
  rec.result = game.result;
  rec.score = game.score;
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

// ---- リプレイ --------------------------------------------------------------
// pos = これまでに進めた手数。盤面は「pos+1 手目を打つ直前」で、インスペクタにはその手を決めた裁定を出す。

function simulate(r, upto) {
  const g = new Game({ seed: r.seed, ghosts: r.ghosts });
  for (let i = 0; i < upto && !g.over; i++) g.step(r.steps[i]);
  return g;
}

function computeEvents(r) {
  const deaths = [];
  const g = new Game({ seed: r.seed, ghosts: r.ghosts });
  for (let i = 0; i < r.steps.length && !g.over; i++) {
    const lives = g.lives;
    g.step(r.steps[i]);
    if (g.lives < lives) deaths.push(i);
  }
  const at = (test) => [...new Set(r.decisions.filter(test).map((d) => d.forTick - 1))];
  return {
    deaths,
    disagree: at((d) => d.source === 'jev' && d.dir !== d.fallbackDir),
    fallback: at((d) => d.source === 'fallback'),
    lowconf: at((d) => d.source !== 'error' && d.confidence < 0.5),
    slow: at((d) => d.latencyMs > 500),
    error: at((d) => d.source === 'error' || d.stale),
  };
}

function openReplay(r) {
  if (running) return;
  replay = { rec: r, pos: 0, playing: false, game: simulate(r, 0), events: computeEvents(r) };
  $('replayBar').hidden = false;
  $('rpSeek').max = r.steps.length;
  $('replayMeta').textContent = `${STRATEGIES[r.strategy]?.label ?? r.strategy} / seed ${r.seed} / ゴースト ${r.ghosts} / ${r.timing === 'sync' ? '同期' : 'リアルタイム'}` + (r.result ? ` / ${r.result} ${r.score}点` : ' / 途中');
  renderMarks();
  seek(0);
  setControls();
}

function closeReplay() {
  if (!replay) return;
  replay.playing = false;
  replay = null;
  $('replayBar').hidden = true;
  lastTickAt = 0;
  setControls();
  renderAll();
}

function seek(pos) {
  const max = replay.rec.steps.length;
  const next = Math.max(0, Math.min(max, pos));
  // 1 手だけ進むときは移動をアニメーションさせ、それ以外は即座に切り替える
  lastTickAt = next === replay.pos + 1 ? performance.now() : 0;
  replay.pos = next;
  replay.game = simulate(replay.rec, next);
  $('rpSeek').value = next;
  renderAll();
}

async function playReplay() {
  const mine = replay;
  mine.playing = true;
  setControls();
  while (replay === mine && mine.playing && mine.pos < mine.rec.steps.length) {
    seek(mine.pos + 1);
    await sleep(Number($('rpSpeed').value));
  }
  mine.playing = false;
  if (replay === mine) setControls();
}

function jump(direction) {
  const list = replay.events[$('rpJumpKind').value] ?? [];
  const target = direction > 0 ? list.find((p) => p > replay.pos) : [...list].reverse().find((p) => p < replay.pos);
  if (target !== undefined) {
    replay.playing = false;
    seek(target);
    setControls();
  }
}

// その手を決めた裁定 = forTick が pos+1 以下で最も新しいもの
function decisionAt(r, pos) {
  let found = null;
  for (const d of r.decisions) {
    if (d.forTick > pos + 1) break;
    found = d;
  }
  return found;
}

function renderMarks() {
  const { events, rec: r } = replay;
  const kind = $('rpJumpKind').value;
  const max = Math.max(1, r.steps.length);
  $('rpMarks').innerHTML = (events[kind] ?? []).map((p) => `<i style="left:${((p / max) * 100).toFixed(2)}%"></i>`).join('');
  $('rpJumpCount').textContent = `${(events[kind] ?? []).length} 件`;
}

function exportReplay() {
  const r = replay.rec;
  const blob = new Blob([JSON.stringify(r)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `replay-${r.strategy}-seed${r.seed}-g${r.ghosts}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importReplay(file) {
  try {
    const r = JSON.parse(await file.text());
    if (r.app !== 'maze-runner' || !Array.isArray(r.steps) || !Array.isArray(r.decisions)) throw new Error('Maze Runner のリプレイファイルではありません');
    showError(null);
    openReplay(r);
  } catch (err) {
    showError(`リプレイを読み込めません: ${err.message}`);
  }
}

// ---- 表示 ---------------------------------------------------------------

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0);
const fmtMs = (v) => (v ? `${Math.round(v)} ms` : '–');
const fmtNum = (v) => (v === null || v === undefined ? '–' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));
// 単価は利用者が入力したときだけ使う（リポジトリには価格情報を持たない）
const cost = (tokens) => (Number(ui.price.value) > 0 ? `$${((tokens * Number(ui.price.value)) / 1e6).toFixed(6)}` : '–');

// 記録から計測値を導く。リプレイ中は表示位置までの累計になる
function metricsOf(decisions) {
  const ok = decisions.filter((d) => d.source !== 'error');
  return {
    decisions: decisions.length,
    latencies: ok.map((d) => d.latencyMs),
    rtts: ok.map((d) => d.rttMs),
    tokens: ok.reduce((a, d) => a + (d.usage?.input_tokens ?? 0), 0),
    conf: avg(ok.map((d) => d.confidence)),
    fallbacks: ok.filter((d) => d.source === 'fallback').length,
    disagree: ok.filter((d) => d.source === 'jev' && d.dir !== d.fallbackDir).length,
    stale: decisions.filter((d) => d.stale).length,
    age: avg(decisions.map((d) => d.forTick - 1 - d.askedTick)),
    illegal: ok.filter((d) => d.illegal).length,
    errors: decisions.length - ok.length,
  };
}

function renderAll() {
  renderPanels();
  renderDecision();
}

function renderPanels() {
  const g = replay ? replay.game : game;
  const r = replay ? replay.rec : rec;
  $('hudScore').textContent = g.score;
  $('hudLives').textContent = g.lives;
  $('hudPellets').textContent = `${g.remaining()} / ${g.totalPellets}`;
  $('hudTick').textContent = replay ? `${replay.pos} / ${r.steps.length}` : g.tick;
  $('hudStatus').textContent = replay
    ? 'リプレイ'
    : g.over
      ? { win: 'クリア！', lost: 'ゲームオーバー', timeout: '時間切れ' }[g.result]
      : running ? '実行中' : '待機中';

  const m = metricsOf(replay ? r.decisions.filter((d) => d.forTick <= replay.pos + 1) : r.decisions);
  const items = [
    ['裁定数', m.decisions],
    ['Jev レイテンシ平均', fmtMs(avg(m.latencies))],
    ['Jev レイテンシ p95', fmtMs(p95(m.latencies))],
    ['ブラウザ往復 平均', fmtMs(avg(m.rtts))],
    ['入力トークン計', m.tokens.toLocaleString()],
    ['推定コスト', cost(m.tokens)],
    ['平均 confidence', m.decisions - m.errors ? m.conf.toFixed(2) : '–'],
    ['フォールバック', m.fallbacks],
    ['ヒューリスティックと不一致', m.disagree],
    ['stale で破棄', m.stale],
    ['回答までの平均 tick', m.decisions && r.timing === 'realtime' ? m.age.toFixed(1) : '–'],
    ['API エラー', m.errors],
  ];
  $('metrics').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('metricsScope').textContent = replay ? '（リプレイ位置までの累計）' : '（現在のエピソード）';
}

// 裁定インスペクタ: 何を渡し、Jev が何と答え、コードがどう合成して、その手になったか
function renderDecision() {
  const d = replay ? decisionAt(replay.rec, replay.pos) : lastDecision;
  const box = $('decision');
  if (!d || !d.request) {
    box.innerHTML = `<p class="muted">${replay ? 'この時点までに Jev の裁定はありません。' : 'まだ裁定がありません。'}</p>`;
    $('requestDump').textContent = '';
    $('responseDump').textContent = '';
    return;
  }
  const current = !replay || d.forTick === replay.pos + 1;
  const who = { jev: 'Jev', fallback: 'フォールバック（confidence がしきい値未満）', error: 'フォールバック（API エラー）' }[d.source];
  const agree = d.source === 'error' ? '' : d.jevDir === d.fallbackDir ? '<span class="tag ok">ヒューリスティックと一致</span>' : `<span class="tag warn">ヒューリスティックなら ${esc(d.fallbackDir)}</span>`;

  let html = `<div class="head">
    <span>tick <b>${esc(d.forTick)}</b> の手${current ? '' : ' <span class="tag">以降も継続中</span>'}</span>
    <span>採用: <b class="pick">${esc(d.dir)}</b></span>
    <span>決定者: <b>${who}</b></span>
    ${d.source === 'fallback' ? `<span>Jev の回答: <b>${esc(d.jevDir)}</b></span>` : ''}
    ${agree}${d.stale ? '<span class="tag bad">stale: 到着時には打てず破棄</span>' : ''}${d.illegal ? '<span class="tag bad">不正手</span>' : ''}
  </div>`;

  html += `<div class="head timing">
    <span>Jev レイテンシ: <b>${fmtMs(d.latencyMs)}</b></span>
    <span>ブラウザ往復: <b>${fmtMs(d.rttMs)}</b></span>
    <span>tokens: <b>${esc(d.usage?.input_tokens ?? '–')}</b> in / <b>${esc(d.usage?.output_tokens ?? '–')}</b> out</span>
    <span>リトライ: <b>${esc(d.retries ?? '–')}</b></span>
    <span>model: <b>${esc(d.model ?? '–')}</b></span>
    <span>質問時 tick <b>${esc(d.askedTick)}</b> → 反映 tick <b>${esc(d.forTick)}</b></span>
    ${d.source === 'error' ? '' : `<span>confidence: <b>${esc(fmtNum(d.confidence))}</b>${d.gate === null || d.gate === undefined ? '' : `（しきい値 ${esc(fmtNum(d.gate))}）`}</span>`}
  </div>`;
  if (d.error) html += `<p class="error">${esc(d.error)}</p>`;

  const state = d.request.state;
  const globals = Object.entries(state).filter(([k, v]) => k !== 'game' && typeof v !== 'object');
  if (globals.length) html += `<div class="chips">${globals.map(([k, v]) => `<span><i>${esc(k)}</i>${esc(v)}</span>`).join('')}</div>`;
  if (state.map_rows_top_to_bottom) html += `<h3>Jev に渡した盤面</h3><pre class="ascii">${esc(state.map_rows_top_to_bottom.join('\n'))}</pre>`;
  if (state.directions) html += `<h3>Jev に渡したラベル</h3>${table(state.directions, d.dir)}`;

  if (d.breakdown) {
    const rows = {};
    for (const [dir, b] of Object.entries(d.breakdown)) rows[dir] = { ...b, 'softmax %': `${((d.probabilities[dir] ?? 0) * 100).toFixed(1)}%` };
    html += `<h3>Jev の回答 → コードの合成 <small>*_level / *_noul が Jev の回答、それ以外はコードの計算。utility 最大の方向を採用</small></h3>${table(rows, d.jevDir, d.answers)}`;
  } else if (d.probabilities) {
    html += '<h3>Jev の回答（Choice の確率分布）</h3>';
    html += Object.entries(d.probabilities)
      .filter(([dir]) => DIRS[dir])
      .sort((a, b) => b[1] - a[1])
      .map(([dir, p]) => `<div class="bar${dir === d.jevDir ? ' chosen' : ''}"><span>${dir}</span><i style="width:${(p * 100).toFixed(1)}%"></i><span>${(p * 100).toFixed(1)}%</span></div>`)
      .join('');
  }
  box.innerHTML = html;
  $('requestDump').textContent = JSON.stringify(d.request, null, 2);
  $('responseDump').textContent = JSON.stringify({ model: d.model, answers: d.answers, usage: d.usage }, null, 2);
}

// 方向を行、項目を列にした表。*_level のセルには Jev が返した legend（その段階の説明文）をツールチップで付ける
function table(rows, chosen, answers) {
  const dirs = Object.keys(rows);
  const cols = Object.keys(rows[dirs[0]] ?? {});
  const cell = (dir, col) => {
    const v = rows[dir][col];
    const answer = answers?.[`${col.replace(/_(level|noul)$/, '')}_${dir}`];
    const legend = answer?.legend?.[Math.round(v)];
    const conf = answer?.confidence === undefined ? '' : ` <small>conf ${esc(fmtNum(answer.confidence))}</small>`;
    const cls = v === true || v === 'deadly' || v === 'high' ? ' class="hot"' : '';
    const fromJev = /_(level|noul)$/.test(col) ? ' data-jev' : '';
    return `<td${cls}${fromJev}${legend ? ` title="${esc(legend)}"` : ''}>${esc(fmtNum(v))}${answers && fromJev ? conf : ''}</td>`;
  };
  return `<div class="tableWrap"><table class="inspect"><thead><tr><th></th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${dirs
    .map((dir) => `<tr${dir === chosen ? ' class="chosen"' : ''}><th>${esc(dir)}</th>${cols.map((c) => cell(dir, c)).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function recordResult() {
  const c = cfg();
  const m = metricsOf(rec.decisions);
  const row = {
    n: results.length + 1,
    strategy: c.strategy,
    timing: STRATEGIES[c.strategy].usesApi ? rec.timing : '-',
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
  };
  const entry = { row, rec, button: Object.assign(document.createElement('button'), { className: 'small', textContent: '▶ リプレイ' }) };
  entry.button.addEventListener('click', () => entry.rec && openReplay(entry.rec));
  results.push(entry);
  const old = results[results.length - 1 - MAX_KEPT_REPLAYS];
  if (old) {
    old.rec = null;
    old.button.disabled = true;
    old.button.title = '古いリプレイは破棄されました';
  }
  const tr = $('results').tBodies[0].insertRow(0);
  tr.innerHTML =
    '<td></td>' +
    Object.entries(row)
      .map(([k, v]) => `<td${k === 'result' ? ` class="${esc(v)}"` : ''}>${k === 'cleared' ? `${v}%` : esc(v)}</td>`)
      .join('');
  tr.cells[0].append(entry.button);
}

function showError(message) {
  $('errorBox').hidden = !message;
  $('errorBox').textContent = message ?? '';
}

function setControls() {
  $('btnStart').disabled = running;
  $('btnPause').disabled = !running;
  $('btnReplay').disabled = running || rec.steps.length === 0 || replay?.rec === rec;
  for (const k of ['strategy', 'timing', 'ghosts', 'seed', 'episodes']) ui[k].disabled = running;
  for (const e of results) e.button.disabled = running || !e.rec;
  if (replay) $('rpPlay').textContent = replay.playing ? '⏸ 停止' : '▶ 再生';
  renderPanels();
}

// ---- 描画 ---------------------------------------------------------------

function lerpPos(e, t) {
  return [(e.px + (e.x - e.px) * t + 0.5) * TILE, (e.py + (e.y - e.py) * t + 0.5) * TILE];
}

function draw(now) {
  const g = replay ? replay.game : game;
  const animMs = replay ? Math.min(Number($('rpSpeed').value), 200) : Math.min(cfg().tickMs, 200);
  const t = Math.min(1, (now - lastTickAt) / animMs);
  const moving = replay ? replay.playing : running;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
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
  for (const k of g.pellets) {
    const [x, y] = k.split(',').map(Number);
    ctx.fillRect((x + 0.5) * TILE - 2, (y + 0.5) * TILE - 2, 4, 4);
  }
  const pulse = 5 + Math.sin(now / 150) * 1.5;
  ctx.strokeStyle = '#fde68a';
  ctx.lineWidth = 2.5;
  for (const k of g.powers) {
    const [x, y] = k.split(',').map(Number);
    ctx.beginPath();
    ctx.arc((x + 0.5) * TILE, (y + 0.5) * TILE, pulse, 0, Math.PI * 2);
    ctx.stroke();
  }

  const [rx, ry] = lerpPos(g.runner, t);
  const d = replay ? decisionAt(replay.rec, replay.pos) : lastDecision;
  drawProbabilities(rx, ry, d);
  drawRunner(g, rx, ry, now, moving);
  for (const ghost of g.ghosts) drawGhost(g, ghost, t, now);

  if (g.over) {
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(0, canvas.height / 2 - 34, canvas.width, 68);
    ctx.fillStyle = g.result === 'win' ? '#4ade80' : '#ff6b6b';
    ctx.font = 'bold 28px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText({ win: 'CLEAR!', lost: 'GAME OVER', timeout: 'TIME UP' }[g.result], canvas.width / 2, canvas.height / 2);
  }
  requestAnimationFrame(draw);
}

// 裁定の確率分布をランナーの周囲に矢印で重ねる（濃いほど高確率、リプレイ中は採用した手を白枠で示す）
function drawProbabilities(cx, cy, d) {
  const probs = d?.probabilities;
  if (!probs) return;
  for (const [dir, p] of Object.entries(probs)) {
    if (!DIRS[dir] || p < 0.02) continue;
    const [dx, dy] = DIRS[dir];
    const bx = cx + dx * TILE * 0.95;
    const by = cy + dy * TILE * 0.95;
    ctx.beginPath();
    ctx.moveTo(bx + dx * 8, by + dy * 8);
    ctx.lineTo(bx - dy * 6, by - dx * 6);
    ctx.lineTo(bx + dy * 6, by + dx * 6);
    ctx.closePath();
    ctx.fillStyle = `rgba(74, 222, 128, ${0.15 + p * 0.85})`;
    ctx.fill();
    if (replay && dir === d.dir) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ランナー: 進行方向を向く矢じり型
function drawRunner(g, cx, cy, now, moving) {
  const angle = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[g.runner.dir];
  const r = TILE * 0.44;
  const flare = moving ? 0.75 + Math.abs(Math.sin(now / 110)) * 0.15 : 0.8;
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
function drawGhost(g, ghost, t, now) {
  const [cx, cy] = lerpPos(ghost, t);
  const r = TILE * 0.44;
  const blink = ghost.frightened && g.frightTimer <= 10 && Math.floor(now / 160) % 2 === 0;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  if (ghost.frightened) {
    ctx.strokeStyle = blink ? '#f8fafc' : '#64748b';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  ctx.fillStyle = ghost.color;
  ctx.fill();
  const [dx, dy] = DIRS[ghost.dir] ?? [0, 0];
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
  if (replay) closeReplay();
  newGame();
  setControls();
});
$('btnReplay').addEventListener('click', () => openReplay(rec));
$('btnCsv').addEventListener('click', async () => {
  if (!results.length) return;
  const rows = results.map((e) => e.row);
  const csv = [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).join(','))].join('\n');
  await navigator.clipboard.writeText(csv);
  $('btnCsv').textContent = 'コピーしました';
  setTimeout(() => ($('btnCsv').textContent = 'CSV コピー'), 1500);
});

const stepTo = (pos) => {
  replay.playing = false;
  seek(pos);
  setControls();
};
$('rpSeek').addEventListener('input', (e) => stepTo(Number(e.target.value)));
$('rpFirst').addEventListener('click', () => stepTo(0));
$('rpPrev').addEventListener('click', () => stepTo(replay.pos - 1));
$('rpNext').addEventListener('click', () => stepTo(replay.pos + 1));
$('rpLast').addEventListener('click', () => stepTo(replay.rec.steps.length));
$('rpPlay').addEventListener('click', () => {
  if (replay.playing) {
    replay.playing = false;
    setControls();
  } else {
    if (replay.pos >= replay.rec.steps.length) seek(0);
    playReplay();
  }
});
$('rpJumpKind').addEventListener('change', renderMarks);
$('rpJumpPrev').addEventListener('click', () => jump(-1));
$('rpJumpNext').addEventListener('click', () => jump(1));
$('rpClose').addEventListener('click', closeReplay);
$('rpExport').addEventListener('click', exportReplay);
$('btnImport').addEventListener('click', () => $('rpImport').click());
$('rpImport').addEventListener('change', (e) => {
  if (e.target.files[0]) importReplay(e.target.files[0]);
  e.target.value = '';
});
document.addEventListener('keydown', (e) => {
  if (!replay || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') stepTo(replay.pos - (e.shiftKey ? 10 : 1));
  else if (e.key === 'ArrowRight') stepTo(replay.pos + (e.shiftKey ? 10 : 1));
  else if (e.key === ' ') $('rpPlay').click();
  else return;
  e.preventDefault();
});

for (const k of ['strategy', 'ghosts', 'seed']) ui[k].addEventListener('change', () => !running && !replay && newGame());
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

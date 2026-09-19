// 画面の進行。推論は engine.js、Jev を呼ぶのは自由回答の解釈と未知の候補の学習だけ（どちらもサーバ経由）。
import { ANIMALS, QUESTIONS } from './data.js';
import { ANSWERS, Engine, entropy, hardened } from './engine.js';

const $ = (id) => document.getElementById(id);
const pct = (p) => `${(p * 100).toFixed(p >= 0.0995 ? 0 : 1)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let animals = []; // 組み込みの候補 + Jev に覚えさせた候補
let softMatrix = [];
let engine = null;
let log = []; // 現在のゲームでの入力: { type: 'answer', q, value, meta } | { type: 'reject', a } | { type: 'correct', a }
let phase = 'idle'; // idle | playing | won | lost
let liveApi = false;

function applyServerState(state) {
  const learned = state.learned.map((x, i) => ({ id: `learned-${i}`, ja: x.name, en: x.name, learned: true }));
  animals = [...ANIMALS, ...learned];
  softMatrix = [...state.matrix, ...state.learned.map((x) => QUESTIONS.map((q) => x.row[q.id] ?? 0.5))];
}

const mode = () => document.querySelector('input[name=mode]:checked').value;

// 設定が変わっても同じ入力を流し直せば同じ局面に戻れる
function rebuildEngine() {
  engine = new Engine(mode() === 'hard' ? hardened(softMatrix) : softMatrix);
  for (const item of log) {
    if (item.type === 'answer') engine.answer(item.q, item.value, item.meta);
    else if (item.type === 'reject') engine.rejectGuess(item.a);
  }
}

function startGame() {
  log = [];
  phase = 'playing';
  $('review').hidden = true;
  rebuildEngine();
  render();
}

function submitAnswer(q, value, meta = {}) {
  log.push({ type: 'answer', q, value, meta });
  engine.answer(q, value, meta);
  render();
}

async function submitFreeText(q, input, note) {
  const reply = input.value.trim();
  if (!reply) return;
  note.className = 'note';
  note.textContent = 'Jev が回答を解釈中…';
  try {
    const res = await fetch('/api/interpret', { method: 'POST', body: JSON.stringify({ q, reply }) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    submitAnswer(q, json.value, { reply, confidence: json.confidence, latencyMs: json.latencyMs });
  } catch (err) {
    note.className = 'note error';
    note.textContent = `解釈に失敗: ${err.message}`;
  }
}

function renderCard() {
  const card = $('card');
  if (phase === 'idle') {
    card.innerHTML = `
      <p class="question">動物を 1 つ思い浮かべてください</p>
      <p class="sub">候補は ${animals.length} 種。質問にボタンか自由な文章で答えると、Jev が事前に出した確率をベイズ更新で合成して絞り込みます。</p>
      <button class="primary" id="startBtn">はじめる</button>
      <details class="note"><summary>候補の一覧</summary>${animals.map((a) => esc(a.ja)).join('、')}</details>`;
    $('startBtn').onclick = startGame;
    return;
  }
  if (phase === 'won' || phase === 'lost') {
    const last = log.at(-1);
    card.innerHTML = `
      <p class="question">${phase === 'won' ? `やった！ <span class="guess">${esc(animals[last.a].ja)}</span> でした` : '降参です…'}</p>
      <p class="sub">質問 ${engine.asked.length} 回、回答 ${engine.rejected.length + (phase === 'won' ? 1 : 0)} 回。下の「答え合わせ」で Jev の確率とあなたの回答を見比べられます。</p>
      <button class="primary" id="startBtn">もう一度</button>`;
    $('startBtn').onclick = startGame;
    return;
  }
  const step = engine.next();
  if (step.type === 'giveup') {
    phase = 'lost';
    return render();
  }
  if (step.type === 'guess') {
    card.innerHTML = `
      <div class="step">回答 ${engine.rejected.length + 1} / ${engine.opt.maxGuesses}（事後確率 ${pct(step.p)}）</div>
      <p class="question">思い浮かべたのは <span class="guess">${esc(animals[step.a].ja)}</span> ですか？</p>
      <p class="sub">&nbsp;</p>
      <div class="answers"><button id="guessYes">はい、正解</button><button id="guessNo">いいえ、違う</button></div>`;
    $('guessYes').onclick = () => {
      log.push({ type: 'correct', a: step.a });
      phase = 'won';
      render();
    };
    $('guessNo').onclick = () => {
      log.push({ type: 'reject', a: step.a });
      engine.rejectGuess(step.a);
      render();
    };
    return;
  }
  const q = QUESTIONS[step.q];
  card.innerHTML = `
    <div class="step">質問 ${engine.asked.length + 1}</div>
    <p class="question">${esc(q.ja)}</p>
    <p class="sub">期待情報利得 ${step.gain.toFixed(2)} bit ／ いまの候補だと「はい」になる見込み ${pct(step.pYes)}</p>
    <div class="answers">${ANSWERS.map((a) => `<button data-value="${a.value}">${a.ja}</button>`).join('')}</div>
    <form class="row" id="freeForm">
      <input id="freeInput" placeholder="自由に答える（例: 種類によるけど、だいたいそう）" maxlength="200" autocomplete="off">
      <button>Jev に解釈させる</button>
    </form>
    <p class="note" id="freeNote">${liveApi ? '' : 'API キーが無いので、自由回答の解釈はキーワードによるダミー。'}</p>`;
  for (const b of card.querySelectorAll('[data-value]')) b.onclick = () => submitAnswer(step.q, Number(b.dataset.value));
  $('freeForm').onsubmit = (e) => {
    e.preventDefault();
    submitFreeText(step.q, $('freeInput'), $('freeNote'));
  };
}

const answerLabel = (value) => ANSWERS.reduce((best, a) => (Math.abs(a.value - value) < Math.abs(best.value - value) ? a : best)).ja;
const pillClass = (value) => (value > 0.6 ? 'yes' : value < 0.4 ? 'no' : '');

function renderHistory() {
  $('historyNote').textContent = engine?.asked.length ? `エントロピー ${Math.log2(animals.length).toFixed(2)} → ${entropy(engine.posterior).toFixed(2)} bit` : '';
  $('history').innerHTML = (engine?.asked ?? [])
    .map(
      (x, i) => `<li>
        <span class="n">${i + 1}</span>
        <span>${esc(QUESTIONS[x.q].ja)}${x.reply ? `<span class="free">「${esc(x.reply)}」→ はい度 ${x.value.toFixed(2)}（confidence ${x.confidence.toFixed(2)}）</span>` : ''}</span>
        <span class="pill ${pillClass(x.value)}">${answerLabel(x.value)}</span>
        <span class="gain">−${(x.entropyBefore - x.entropyAfter).toFixed(2)} bit</span>
      </li>`,
    )
    .join('');
}

function renderSide() {
  if (!engine) rebuildEngine();
  $('entropyNote').textContent = `残りの不確かさ ${entropy(engine.posterior).toFixed(2)} bit`;
  const top = engine.ranking(12);
  const rejected = engine.rejected.map((a) => ({ a, p: 0, out: true }));
  $('ranking').innerHTML = [...top.filter((x) => x.p > 0), ...rejected]
    .map(
      (x) => `<div><span class="name ${x.out ? 'out' : ''}">${esc(animals[x.a].ja)}</span>
        <span class="track"><span class="fill" style="width:${x.p * 100}%; display:block"></span></span>
        <span class="pct">${x.out ? '×' : pct(x.p)}</span></div>`,
    )
    .join('');
  $('nextQuestions').innerHTML =
    '<tr><th>質問</th><th class="num">利得</th><th class="num">はいの見込み</th></tr>' +
    engine
      .rankQuestions()
      .slice(0, 6)
      .map((x) => `<tr><td>${esc(QUESTIONS[x.q].ja)}</td><td class="num">${x.gain.toFixed(2)}</td><td class="num">${pct(x.pYes)}</td></tr>`)
      .join('');
}

function renderReview() {
  const done = phase === 'won' || phase === 'lost';
  $('review').hidden = !done;
  if (!done) return;
  const select = $('truthSelect');
  const current = phase === 'won' ? String(log.at(-1).a) : select.value;
  select.innerHTML = '<option value="">思い浮かべた動物を選ぶ…</option>' + animals.map((a, i) => `<option value="${i}">${esc(a.ja)}${a.learned ? '（学習済み）' : ''}</option>`).join('');
  select.value = current;
  renderReviewTable();
}

function renderReviewTable() {
  const a = $('truthSelect').value;
  if (a === '') return void ($('reviewTable').innerHTML = '');
  const rows = engine.asked.map((x) => {
    const p = softMatrix[a][x.q];
    const clash = x.value !== 0.5 && Math.abs(x.value - p) > 0.6;
    return `<tr class="${clash ? 'clash' : ''}"><td>${esc(QUESTIONS[x.q].ja)}</td><td>${answerLabel(x.value)}</td><td class="num">${p.toFixed(2)}</td><td>${clash ? '食い違い' : ''}</td></tr>`;
  });
  const rank = engine.ranking().findIndex((x) => x.a === Number(a)) + 1;
  $('reviewTable').innerHTML =
    `<tr><th>質問</th><th>あなたの回答</th><th class="num">Jev の p(はい)</th><th></th></tr>${rows.join('')}` +
    `<tr><td colspan="4" class="note">最終順位 ${rank} 位 / ${animals.length}（事後確率 ${pct(engine.posterior[a])}）</td></tr>`;
}

function render() {
  renderCard();
  renderHistory();
  renderSide();
  renderReview();
}

async function learn() {
  const name = $('learnName').value.trim();
  if (!name) return;
  const note = $('learnNote');
  $('learnBtn').disabled = true;
  note.className = 'note';
  note.textContent = `Jev に「${name}」について ${QUESTIONS.length} 問を 1 リクエストで質問中…`;
  try {
    const res = await fetch('/api/learn', { method: 'POST', body: JSON.stringify({ name }) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    applyServerState({ matrix: softMatrix.slice(0, ANIMALS.length), learned: json.learned });
    rebuildEngine();
    render();
    $('truthSelect').value = String(animals.findIndex((x) => x.learned && x.ja === name));
    renderReviewTable();
    $('learnName').value = '';
    note.textContent = `「${name}」を候補に追加した。次のゲームから当てられる。`;
  } catch (err) {
    note.className = 'note error';
    note.textContent = `学習に失敗: ${err.message}`;
  } finally {
    $('learnBtn').disabled = false;
  }
}

async function init() {
  const state = await (await fetch('/api/state')).json();
  liveApi = state.liveApi;
  applyServerState(state);
  const mb = $('matrixBadge');
  mb.textContent = state.matrixSource === 'jev' ? `行列: ${state.matrixModel}` : '行列: MOCK';
  mb.classList.add(state.matrixSource === 'jev' ? 'live' : 'mock');
  const ab = $('apiBadge');
  ab.textContent = liveApi ? 'Jev API: LIVE' : 'Jev API: MOCK';
  ab.classList.add(liveApi ? 'live' : 'mock');
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.onchange = () => {
      rebuildEngine();
      render();
    };
  }
  $('truthSelect').onchange = renderReviewTable;
  $('learnBtn').onclick = learn;
  render();
}

init();

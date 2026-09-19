// 盤面 → Jev への state/questions 変換と、回答の解釈。
// Jev は計算・カウント・数値比較が苦手（公式 jaggedness）なので、距離計算は BFS でコード側が行い、
// Jev には定性的なラベルを渡して「どの方向に進むか」の裁定だけを任せる。

import { DIRS, OPPOSITE, key } from './game.js';

// id は保存済みリプレイやベンチの引数で使うので変えない。画面には label / short / desc を出す
export const STRATEGIES = {
  'jev-tactical-fanout': {
    group: 'Jev に判断させる',
    label: 'Jev【スコア重視】状況を段階評価 → コードが合成',
    short: 'Jev スコア重視',
    desc: 'ゴーストの向きや逃げ場の広さなどの戦術情報を渡し、方向ごとに「危険度」「得点の見込み」を Jev に段階評価させる。どの段階を何点と見るかはコードが決めるので、ゴーストを積極的に食べに行く高得点狙いの調整にしてある。',
    usesApi: true,
  },
  'jev-tactical-choice': {
    group: 'Jev に判断させる',
    label: 'Jev【おまかせ・省トークン】状況を見て Jev が 1 問で決める',
    short: 'Jev おまかせ',
    desc: '同じ戦術情報を渡し、優先順位を書いた 1 問で進む方向を Jev に選ばせる。危険と得点の天秤まで Jev 任せになる。トークンはスコア重視の約半分で済むが、ゴーストを追う場面が少なく得点は伸びにくい。生き残りやすさはスコア重視と同程度。',
    usesApi: true,
  },
  'jev-composite': {
    group: '比較用（旧方式・対照実験）',
    label: 'Jev【旧方式】距離だけ渡す → コードが合成',
    short: 'Jev 旧・合成',
    desc: '最寄りのペレットとゴーストまでの距離ラベルだけを渡す初期の方式。方向ごとに危険か・旨味があるかを聞き、コードで合成する。戦術情報を足す効果を見るための比較用。',
    usesApi: true,
  },
  'jev-features': {
    group: '比較用（旧方式・対照実験）',
    label: 'Jev【旧方式】距離だけ渡す → Jev が 1 問で決める',
    short: 'Jev 旧・1問',
    desc: '最寄りのペレットとゴーストまでの距離ラベルだけを渡し、1 問で方向を選ばせる初期の方式。比較用。',
    usesApi: true,
  },
  'jev-ascii': {
    group: '比較用（旧方式・対照実験）',
    label: 'Jev【対照実験】盤面の文字列を丸ごと渡す',
    short: 'Jev 盤面丸投げ',
    desc: '前処理をせず、盤面をテキストのまま渡す。Jev は距離の読み取りや数え上げが苦手なため、ほぼ進めない。コードで前処理する価値を確かめるための対照実験。',
    usesApi: true,
  },
  'heuristic-tactical': {
    group: 'Jev を使わない（コードだけ）',
    label: 'コードのみ【戦術版】Jev と同じ情報を数値のまま使う',
    short: 'コード 戦術版',
    desc: 'Jev のスコア重視・おまかせと同じ戦術情報を、ラベルにせず数値のまま点数化して進む。Jev 戦略の比較対象であり、confidence が低いときのフォールバック先でもある。API は呼ばない。',
    usesApi: false,
  },
  heuristic: {
    group: 'Jev を使わない（コードだけ）',
    label: 'コードのみ【基本版】距離だけで判断',
    short: 'コード 基本版',
    desc: '最寄りのペレットとゴーストまでの距離だけで点数化する単純なルール。旧方式の Jev 戦略の比較対象。API は呼ばない。',
    usesApi: false,
  },
  random: {
    group: 'Jev を使わない（コードだけ）',
    label: 'コードのみ【ランダム】',
    short: 'ランダム',
    desc: '進める方向から無作為に選ぶ。何も考えない場合の下限。',
    usesApi: false,
  },
};

// start から blocked を通らずに、isTarget を満たす最寄りマスまでの歩数。start 自身は 1 歩目。
function bfs(game, start, blocked, isTarget) {
  const seen = new Set([blocked, key(start[0], start[1])]);
  let frontier = [start];
  let dist = 1;
  while (frontier.length) {
    const next = [];
    for (const [x, y] of frontier) {
      if (isTarget(x, y)) return dist;
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = x + dx;
        const ny = y + dy;
        const k = key(nx, ny);
        if (seen.has(k) || !game.walkable(nx, ny)) continue;
        seen.add(k);
        next.push([nx, ny]);
      }
    }
    frontier = next;
    dist++;
  }
  return Infinity;
}

// 合法な各方向について「その方向へ踏み出した先」に何があるかを数値で求める
export function directionFeatures(game) {
  const { runner } = game;
  const here = key(runner.x, runner.y);
  const active = game.ghosts.filter((g) => !g.inHouse);
  const at = (list) => (x, y) => list.some((g) => g.x === x && g.y === y);
  const feats = {};
  for (const d of game.legalDirs()) {
    const start = [runner.x + DIRS[d][0], runner.y + DIRS[d][1]];
    feats[d] = {
      pelletDist: bfs(game, start, here, (x, y) => game.pellets.has(key(x, y)) || game.powers.has(key(x, y))),
      powerDist: bfs(game, start, here, (x, y) => game.powers.has(key(x, y))),
      ghostDist: bfs(game, start, here, at(active.filter((g) => !g.frightened))),
      edibleDist: bfs(game, start, here, at(active.filter((g) => g.frightened))),
      reverse: d === OPPOSITE[runner.dir],
    };
  }
  return feats;
}

export function heuristicChoice(game, feats = directionFeatures(game)) {
  const underThreat = Object.values(feats).some((f) => f.ghostDist <= 5);
  let bestDir = null;
  let best = -Infinity;
  for (const [d, f] of Object.entries(feats)) {
    let u = 0;
    if (f.ghostDist <= 2) u -= 100;
    else if (f.ghostDist <= 4) u -= 30;
    else if (f.ghostDist <= 7) u -= 8;
    if (f.edibleDist * 2 < game.frightTimer) u += 40 / f.edibleDist;
    if (f.pelletDist !== Infinity) u += 10 / f.pelletDist;
    if (underThreat && f.powerDist !== Infinity) u += 15 / f.powerDist;
    if (f.reverse) u -= 2;
    if (u > best) {
      best = u;
      bestDir = d;
    }
  }
  return bestDir;
}

// ---- 戦術特徴量 -----------------------------------------------------------
// 最寄り距離だけでは分からない文脈（ゴーストの向き、挟み撃ち、ペレット密度など）を求める。

const GHOST_SPEED = 0.75; // ゴーストは 4 tick 中 3 tick しか動かない

// from から blocked を通らずに到達できる全マスへの歩数（from 自身は 0）
function distanceMap(game, from, blocked) {
  const dist = new Map([[key(from[0], from[1]), 0]]);
  let frontier = [from];
  for (let d = 1; frontier.length; d++) {
    const next = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of Object.values(DIRS)) {
        const k = key(x + dx, y + dy);
        if (k === blocked || dist.has(k) || !game.walkable(x + dx, y + dy)) continue;
        dist.set(k, d);
        next.push([x + dx, y + dy]);
      }
    }
    frontier = next;
  }
  return dist;
}

// start から一本道をたどり、最初の分岐点（または行き止まり）とそこまでの歩数を返す
function nextJunction(game, from, start) {
  let prev = from;
  let cur = start;
  for (let steps = 1; ; steps++) {
    const exits = Object.values(DIRS)
      .map(([dx, dy]) => [cur[0] + dx, cur[1] + dy])
      .filter(([x, y]) => game.walkable(x, y) && !(x === prev[0] && y === prev[1]));
    if (exits.length !== 1) return { cell: cur, steps };
    prev = cur;
    cur = exits[0];
  }
}

const ESCAPE_CAP = 30;
const ESCAPE_MARGIN = 1; // ゴーストより何 tick 早く着けば安全とみなすか

// 各マスに危険なゴーストが最短で何 tick 後に来うるか。巣で待機中のものは出口から、
// 怯え中のものは怯えが解けてから動き出すとして織り込む
function ghostArrival(game) {
  const arrival = new Map();
  for (const g of game.ghosts) {
    const from = g.inHouse ? game.exit : [g.x, g.y];
    const delay = g.inHouse ? Math.max(0, g.releaseAt - game.tick) + 2 : g.frightened ? game.frightTimer : 0;
    for (const [k, dist] of distanceMap(game, from, null)) {
      const t = delay + dist / GHOST_SPEED;
      if (t < (arrival.get(k) ?? Infinity)) arrival.set(k, t);
    }
  }
  return arrival;
}

// start へ踏み出したあと、ゴーストより先に着けるマスだけを伝って行ける範囲の広さ。狭いほど袋小路
function escapeRoom(game, start, arrival, margin = ESCAPE_MARGIN) {
  const safe = (k, t) => t + margin < (arrival.get(k) ?? Infinity);
  if (!safe(key(start[0], start[1]), 1)) return 0;
  const seen = new Set([key(start[0], start[1])]);
  let frontier = [start];
  for (let t = 2; frontier.length && seen.size < ESCAPE_CAP; t++) {
    const next = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of Object.values(DIRS)) {
        const k = key(x + dx, y + dy);
        if (seen.has(k) || !game.walkable(x + dx, y + dy) || !safe(k, t)) continue;
        seen.add(k);
        next.push([x + dx, y + dy]);
      }
    }
    frontier = next;
  }
  return Math.min(ESCAPE_CAP, seen.size);
}

export function tacticalFeatures(game, feats = directionFeatures(game)) {
  const { runner } = game;
  const here = key(runner.x, runner.y);
  const dangerous = game.ghosts.filter((g) => !g.inHouse && !g.frightened);
  const arrival = ghostArrival(game);
  const out = {};
  for (const [d, f] of Object.entries(feats)) {
    const start = [runner.x + DIRS[d][0], runner.y + DIRS[d][1]];
    const map = distanceMap(game, start, here);

    // この方向で最寄りのゴーストが、こちら側へ近づく向きに進んでいるか
    let nearest = null;
    for (const g of dangerous) {
      const dist = map.get(key(g.x, g.y));
      if (dist !== undefined && (!nearest || dist < nearest.dist)) nearest = { g, dist };
    }
    let approaching = false;
    if (nearest) {
      const [gx, gy] = DIRS[nearest.g.dir];
      const ahead = map.get(key(nearest.g.x + gx, nearest.g.y + gy));
      approaching = nearest.dist === 0 || (ahead !== undefined && ahead < nearest.dist);
    }

    // 次の分岐点にゴーストが先回りできるなら、一本道で挟まれる
    const junction = nextJunction(game, [runner.x, runner.y], start);
    const fromJunction = distanceMap(game, junction.cell, here);
    const ghostToJunction = Math.min(Infinity, ...dangerous.map((g) => fromJunction.get(key(g.x, g.y)) ?? Infinity));
    const cutOff = ghostToJunction / GHOST_SPEED <= junction.steps + 1;

    let pelletCount = 0;
    for (const [k, dist] of map) if (dist < 10 && (game.pellets.has(k) || game.powers.has(k))) pelletCount++;

    out[d] = { ...f, approaching, cutOff, pelletCount, room: escapeRoom(game, start, arrival) };
  }
  const around = distanceMap(game, [runner.x, runner.y], null);
  const ghostsNearby = dangerous.filter((g) => (around.get(key(g.x, g.y)) ?? Infinity) <= 6).length;
  return { dirs: out, ghostsNearby };
}

// 100 シードのオフライン探索で決めた重み（scripts/sim.mjs で再確認できる）
export const TACTICAL_WEIGHTS = { chase: 130, chaseReach: 2, lure: 10, lureCount: 1, save: 30, saveRadius: 4, trapped: 120, tight: 40, narrow: 0 };

// 戦術特徴量を使うヒューリスティック。Jev に同じ情報を渡す前に、情報自体の価値を API なしで確かめるためのもの
export function tacticalHeuristic(game, tactical = tacticalFeatures(game), w = TACTICAL_WEIGHTS) {
  const { dirs, ghostsNearby } = tactical;
  const saving = game.frightTimer === 0 && ghostsNearby === 0 && game.pellets.size > 0;
  let bestDir = null;
  let best = -Infinity;
  for (const [d, f] of Object.entries(dirs)) {
    let u = 0;
    if (f.ghostDist <= 2) u -= f.approaching || f.ghostDist <= 1 ? 100 : 40;
    else if (f.ghostDist <= 4) u -= f.approaching ? 40 : 10;
    else if (f.ghostDist <= 7) u -= f.approaching ? 10 : 2;
    if (f.cutOff && f.ghostDist <= 12) u -= 35;
    u -= f.room < 4 ? w.trapped : f.room < 10 ? w.tight : f.room < 20 ? w.narrow : 0;
    if (f.edibleDist * w.chaseReach < game.frightTimer) u += w.chase / f.edibleDist;
    if (f.pelletDist !== Infinity) u += 10 / f.pelletDist + f.pelletCount * 0.3;
    if (f.powerDist !== Infinity) {
      if (ghostsNearby >= w.lureCount) u += (15 + w.lure * ghostsNearby) / f.powerDist;
      else if (saving && f.powerDist <= w.saveRadius) u -= w.save; // ゴーストを引きつけてから取るほうが高得点
    }
    if (f.reverse) u -= 2;
    if (u > best) {
      best = u;
      bestDir = d;
    }
  }
  return bestDir;
}

const threatLabel = (d) => (d <= 2 ? 'deadly' : d <= 4 ? 'high' : d <= 7 ? 'medium' : 'none');
const nearLabel = (d) => (d <= 1 ? 'adjacent' : d <= 3 ? 'near' : d <= 8 ? 'medium' : d === Infinity ? 'none' : 'far');

function featureState(game, feats) {
  const directions = {};
  for (const [d, f] of Object.entries(feats)) {
    directions[d] = {
      ghost_threat: threatLabel(f.ghostDist),
      nearest_pellet: nearLabel(f.pelletDist),
      power_pellet: nearLabel(f.powerDist),
      edible_ghost: game.frightTimer > 5 ? nearLabel(f.edibleDist) : 'none',
      reverses_current_heading: f.reverse,
    };
  }
  return {
    game: 'Maze chase game. The runner must collect every pellet without being caught by a ghost.',
    ghosts_are_edible_now: game.frightTimer > 5,
    directions,
  };
}

function asciiState(game) {
  const rows = [];
  for (let y = 0; y < game.height; y++) {
    let row = '';
    for (let x = 0; x < game.width; x++) {
      const k = key(x, y);
      const ghost = game.ghosts.find((g) => g.x === x && g.y === y);
      if (game.runner.x === x && game.runner.y === y) row += 'R';
      else if (ghost) row += ghost.frightened ? 'F' : 'G';
      else if (game.pellets.has(k)) row += '.';
      else if (game.powers.has(k)) row += 'o';
      else row += game.cell(x, y) === '#' || game.cell(x, y) === '-' ? '#' : ' ';
    }
    rows.push(row);
  }
  return {
    game: 'Maze chase game. The runner must collect every pellet without being caught by a ghost.',
    legend: {
      R: 'the runner (the player)',
      G: 'dangerous ghost',
      F: 'frightened ghost that can be eaten',
      '.': 'pellet',
      o: 'power pellet',
      '#': 'wall',
      ' ': 'empty corridor',
    },
    map_rows_top_to_bottom: rows,
    current_heading: game.runner.dir,
  };
}

const MOVE_INSTRUCTIONS = {
  task: 'Choose the direction the runner should move next.',
  priorities: [
    'Never choose a direction whose ghost_threat is deadly, and avoid high, unless ghosts are edible now.',
    'If ghosts are edible now, prefer the direction with the closest edible ghost.',
    'If any direction has a medium or worse ghost_threat, a close power pellet is valuable.',
    'Otherwise prefer the direction with the closest pellet.',
    'Between otherwise equal directions, avoid reversing the current heading.',
  ],
};

const VALUE_LEVELS = [
  'Nothing worth collecting this way: no pellet and no edible ghost',
  'Pellets exist this way but they are far',
  'A pellet is at medium distance this way',
  'A pellet is near or adjacent this way',
  'An edible ghost or a power pellet needed for safety is near or adjacent this way',
];

// ---- 戦術ラベル戦略 ---------------------------------------------------------

const roomLabel = (n) => (n < 4 ? 'trapped' : n < 10 ? 'tight' : 'open');
const countLabel = (n) => (n === 0 ? 'none' : n <= 3 ? 'few' : n <= 9 ? 'some' : 'many');

function tacticalState(game, { dirs, ghostsNearby }) {
  const directions = {};
  for (const [d, f] of Object.entries(dirs)) {
    const threat = threatLabel(f.ghostDist);
    directions[d] = {
      ghost_threat: threat,
      ghost_approaching: threat !== 'none' && f.approaching,
      cut_off_risk: f.cutOff && f.ghostDist <= 12,
      // ゴーストより先に着けるマスだけを伝って逃げられる範囲。trapped はほぼ袋小路
      escape_room: roomLabel(f.room),
      nearest_pellet: nearLabel(f.pelletDist),
      pellets_this_way: countLabel(f.pelletCount),
      power_pellet: nearLabel(f.powerDist),
      // 怯え時間内に追いつけるゴーストだけを載せる（時間の計算はコード側で済ませる）
      edible_ghost: f.edibleDist * TACTICAL_WEIGHTS.chaseReach < game.frightTimer ? nearLabel(f.edibleDist) : 'none',
      reverses_current_heading: f.reverse,
    };
  }
  return {
    game: 'Maze chase game. The runner scores by collecting pellets and, above all, by eating ghosts while they are edible. A dangerous ghost that catches the runner costs a life.',
    ghost_mode: game.ghostMode() === 'chase' ? 'hunting the runner' : 'scattering to the corners',
    dangerous_ghosts_nearby: ghostsNearby === 0 ? 'none' : ghostsNearby === 1 ? 'one' : 'several',
    edible_time_left: game.frightTimer > 20 ? 'plenty' : game.frightTimer > 0 ? 'short' : 'none',
    pellets_left: game.pellets.size > 20 ? 'many' : 'few',
    directions,
  };
}

const DANGER_LEVELS = [
  'No danger: ghost_threat is none and escape_room is open',
  'A ghost is this way but it is not approaching, and escape_room is open',
  'A ghost at medium ghost_threat is approaching, and escape_room is open',
  'escape_room is tight, or a ghost at high ghost_threat is approaching, or cut_off_risk is true',
  'escape_room is trapped, or ghost_threat is deadly: the runner will very likely be caught this way',
];
const DANGER_PENALTY = [0, 2, 10, 40, 120];

const REWARD_LEVELS = [
  'Nothing to collect this way: nearest_pellet is none and edible_ghost is none',
  'nearest_pellet is far',
  'nearest_pellet is medium',
  'nearest_pellet is near and pellets_this_way is few',
  'nearest_pellet is near and pellets_this_way is some or many',
  'nearest_pellet is adjacent',
  'power_pellet is adjacent or near while dangerous_ghosts_nearby is one or several',
  'edible_ghost is medium: a ghost can be eaten this way with some chasing',
  'edible_ghost is near: a ghost can be eaten this way soon',
  'edible_ghost is adjacent: a ghost can be eaten this way right now',
];
const REWARD_VALUE = [0, 1.5, 3, 5, 7, 10, 25, 25, 55, 120];
const WASTE_PENALTY = 30;

const TACTICAL_INSTRUCTIONS = {
  task: 'Choose the direction the runner should move next to reach the highest score without losing a life.',
  priorities: [
    'Never choose a direction whose ghost_threat is deadly or whose escape_room is trapped.',
    'Avoid a direction whose escape_room is tight when another direction is open.',
    'Avoid a direction whose cut_off_risk is true, or whose ghost_threat is high with ghost_approaching true.',
    'A ghost that is not approaching is much less dangerous than one that is approaching.',
    'If a direction has an edible_ghost that is not none, go that way: eating ghosts is worth the most.',
    'If dangerous_ghosts_nearby is one or several, a direction with power_pellet adjacent or near is very valuable.',
    'If dangerous_ghosts_nearby is none and pellets_left is many, do not take a power pellet yet; prefer other pellets.',
    'Otherwise prefer the direction with the closest pellet, and break ties by pellets_this_way.',
    'Between otherwise equal directions, avoid reversing the current heading.',
  ],
};

function tacticalRequest(strategy, game, feats) {
  const tactical = tacticalFeatures(game, feats);
  const state = tacticalState(game, tactical);
  const base = { feats, tactical, state, fallbackDir: tacticalHeuristic(game, tactical) };
  const dirs = Object.keys(feats);
  if (strategy === 'jev-tactical-choice') {
    const criteria = Object.fromEntries(dirs.map((d) => [d, `Move ${d}; described by \`directions.${d}\``]));
    return { ...base, questions: { move: { type: 'choice', instructions: TACTICAL_INSTRUCTIONS, criteria } } };
  }
  const questions = {};
  for (const d of dirs) {
    questions[`danger_${d}`] = {
      type: 'score',
      instructions: `How dangerous is moving ${d}? Judge only from ghost_threat, ghost_approaching, cut_off_risk and escape_room in \`directions.${d}\`.`,
      criteria: DANGER_LEVELS,
    };
    questions[`reward_${d}`] = {
      type: 'score',
      instructions: `How much score can the runner gain by moving ${d}? Judge from \`directions.${d}\` and \`dangerous_ghosts_nearby\`, ignoring danger.`,
      criteria: REWARD_LEVELS,
    };
    // パワーペレットが近い方向だけ、温存すべきかを追加で聞く（投機的 fan-out）
    if (feats[d].powerDist <= TACTICAL_WEIGHTS.saveRadius) {
      questions[`waste_${d}`] = {
        type: 'noul',
        instructions: `Would moving ${d} waste a power pellet that is better saved until ghosts come close?`,
        criteria: {
          true: 'dangerous_ghosts_nearby is none, edible_time_left is none, and pellets_left is many',
          false: 'dangerous_ghosts_nearby is one or several, or pellets_left is few, or edible_time_left is not none',
        },
      };
    }
  }
  return { ...base, questions };
}

// 連続値のスコア（例: 2.4）を、段階ごとの重みの線形補間に変換する
function interpolate(table, score) {
  const s = Math.max(0, Math.min(table.length - 1, score));
  const lo = Math.floor(s);
  const hi = Math.min(table.length - 1, lo + 1);
  return table[lo] + (table[hi] - table[lo]) * (s - lo);
}

function tacticalInterpret(answers, feats) {
  const utility = {};
  const breakdown = {};
  for (const d of Object.keys(feats)) {
    const danger = interpolate(DANGER_PENALTY, answers[`danger_${d}`]?.score ?? 2);
    const reward = interpolate(REWARD_VALUE, answers[`reward_${d}`]?.score ?? 0);
    const waste = WASTE_PENALTY * (answers[`waste_${d}`]?.noul ?? 0);
    // ラベル化で失われる距離の細かい差は、判断を覆さない程度の小さなタイブレークとしてコードが補う
    const tieBreak = (feats[d].pelletDist === Infinity ? 0 : 0.5 / feats[d].pelletDist) - (feats[d].reverse ? 1 : 0);
    utility[d] = reward - danger - waste + tieBreak;
    // リプレイで「Jev の回答 → コードの合成」を追えるように内訳を残す
    breakdown[d] = {
      danger_level: answers[`danger_${d}`]?.score ?? null,
      danger_penalty: -danger,
      reward_level: answers[`reward_${d}`]?.score ?? null,
      reward_value: reward,
      waste_noul: answers[`waste_${d}`]?.noul ?? null,
      waste_penalty: -waste,
      tie_break: tieBreak,
      utility: utility[d],
    };
  }
  return { utility, breakdown };
}

// 戦略ごとのリクエスト。選択肢には合法手しか入れないので、不正な手は型レベルで返ってこない。
export function buildRequest(strategy, game) {
  const feats = directionFeatures(game);
  const dirs = Object.keys(feats);
  if (strategy.startsWith('jev-tactical')) return tacticalRequest(strategy, game, feats);
  const fallbackDir = heuristicChoice(game, feats);
  if (strategy === 'jev-ascii') {
    const criteria = Object.fromEntries(dirs.map((d) => [d, `Move the runner one cell ${d} on the map`]));
    return {
      feats,
      fallbackDir,
      state: asciiState(game),
      questions: {
        move: {
          type: 'choice',
          instructions:
            'Read `map_rows_top_to_bottom`. Choose the direction the runner (R) should move next to collect pellets while staying away from dangerous ghosts (G). Frightened ghosts (F) are safe and worth chasing.',
          criteria,
        },
      },
    };
  }
  const state = featureState(game, feats);
  if (strategy === 'jev-composite') {
    const questions = {};
    for (const d of dirs) {
      questions[`danger_${d}`] = {
        type: 'noul',
        instructions: `Would moving ${d} put the runner at serious risk of being caught by a ghost? Judge from \`directions.${d}.ghost_threat\` and \`ghosts_are_edible_now\`.`,
        criteria: {
          true: 'ghost_threat is deadly or high while ghosts are not edible',
          false: 'ghost_threat is none or medium, or ghosts are edible now',
        },
      };
      questions[`value_${d}`] = {
        type: 'score',
        instructions: `How rewarding is moving ${d}? Judge only from \`directions.${d}\`, ignoring ghost_threat.`,
        criteria: VALUE_LEVELS,
      };
    }
    return { feats, fallbackDir, state, questions };
  }
  const criteria = Object.fromEntries(dirs.map((d) => [d, `Move ${d}; described by \`directions.${d}\``]));
  return { feats, fallbackDir, state, questions: { move: { type: 'choice', instructions: MOVE_INSTRUCTIONS, criteria } } };
}

// API 回答 → { dir, confidence, probabilities, illegal }
export function interpret(strategy, answers, game, feats) {
  const legal = Object.keys(feats);
  if (strategy === 'jev-tactical-fanout') {
    const { utility, breakdown } = tacticalInterpret(answers, feats);
    return rankByUtility(utility, 20, breakdown);
  }
  if (strategy === 'jev-composite') {
    const utility = {};
    const breakdown = {};
    for (const d of legal) {
      const danger = answers[`danger_${d}`]?.noul ?? 0.5;
      const value = (answers[`value_${d}`]?.score ?? 0) / (VALUE_LEVELS.length - 1);
      utility[d] = value - 1.5 * danger - (feats[d].reverse ? 0.05 : 0);
      breakdown[d] = { danger_noul: danger, danger_penalty: -1.5 * danger, value_level: answers[`value_${d}`]?.score ?? null, value, utility: utility[d] };
    }
    return rankByUtility(utility, 1, breakdown);
  }
  const a = answers.move;
  const illegal = !a || !legal.includes(a.choice);
  return {
    dir: illegal ? heuristicChoice(game, feats) : a.choice,
    confidence: a?.confidence ?? 0,
    probabilities: a?.probabilities ?? {},
    illegal,
  };
}

// 合成スコアには Jev の confidence が無いので、1位と2位の差（scale で 0〜1 に正規化）を確信度の代用にする
function rankByUtility(utility, scale, breakdown) {
  const ranked = Object.keys(utility).sort((a, b) => utility[b] - utility[a]);
  const margin = ranked.length > 1 ? (utility[ranked[0]] - utility[ranked[1]]) / scale : 1;
  return { dir: ranked[0], confidence: Math.max(0, Math.min(1, margin)), probabilities: softmax(utility, scale / 4), illegal: false, breakdown };
}

function softmax(utility, temperature = 0.25) {
  const entries = Object.entries(utility);
  const max = Math.max(...entries.map(([, u]) => u));
  const exps = entries.map(([d, u]) => [d, Math.exp((u - max) / temperature)]);
  const sum = exps.reduce((s, [, e]) => s + e, 0);
  return Object.fromEntries(exps.map(([d, e]) => [d, e / sum]));
}

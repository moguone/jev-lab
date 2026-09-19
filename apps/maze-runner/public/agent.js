// 盤面 → Jev への state/questions 変換と、回答の解釈。
// Jev は計算・カウント・数値比較が苦手（公式 jaggedness）なので、距離計算は BFS でコード側が行い、
// Jev には定性的なラベルを渡して「どの方向に進むか」の裁定だけを任せる。

import { DIRS, OPPOSITE, key } from './game.js';

export const STRATEGIES = {
  'jev-features': { label: 'Jev: Choice × 特徴量ラベル', usesApi: true },
  'jev-composite': { label: 'Jev: Noul+Score fan-out → コードで合成', usesApi: true },
  'jev-ascii': { label: 'Jev: Choice × ASCII 盤面そのまま', usesApi: true },
  heuristic: { label: 'ベースライン: ヒューリスティック (API なし)', usesApi: false },
  random: { label: 'ベースライン: ランダム (API なし)', usesApi: false },
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

// 戦略ごとのリクエスト。選択肢には合法手しか入れないので、不正な手は型レベルで返ってこない。
export function buildRequest(strategy, game) {
  const feats = directionFeatures(game);
  const dirs = Object.keys(feats);
  if (strategy === 'jev-ascii') {
    const criteria = Object.fromEntries(dirs.map((d) => [d, `Move the runner one cell ${d} on the map`]));
    return {
      feats,
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
    return { feats, state, questions };
  }
  const criteria = Object.fromEntries(dirs.map((d) => [d, `Move ${d}; described by \`directions.${d}\``]));
  return { feats, state, questions: { move: { type: 'choice', instructions: MOVE_INSTRUCTIONS, criteria } } };
}

// API 回答 → { dir, confidence, probabilities, illegal }
export function interpret(strategy, answers, game, feats) {
  const legal = Object.keys(feats);
  if (strategy === 'jev-composite') {
    const utility = {};
    for (const d of legal) {
      const danger = answers[`danger_${d}`]?.noul ?? 0.5;
      const value = (answers[`value_${d}`]?.score ?? 0) / (VALUE_LEVELS.length - 1);
      utility[d] = value - 1.5 * danger - (feats[d].reverse ? 0.05 : 0);
    }
    const ranked = [...legal].sort((a, b) => utility[b] - utility[a]);
    // 合成スコアには Jev の confidence が無いので、1位と2位の差を確信度の代用にする
    const margin = ranked.length > 1 ? utility[ranked[0]] - utility[ranked[1]] : 1;
    return { dir: ranked[0], confidence: Math.max(0, Math.min(1, margin)), probabilities: softmax(utility), illegal: false };
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

function softmax(utility, temperature = 0.25) {
  const entries = Object.entries(utility);
  const max = Math.max(...entries.map(([, u]) => u));
  const exps = entries.map(([d, u]) => [d, Math.exp((u - max) / temperature)]);
  const sum = exps.reduce((s, [, e]) => s + e, 0);
  return Object.fromEntries(exps.map(([d, e]) => [d, e / sum]));
}

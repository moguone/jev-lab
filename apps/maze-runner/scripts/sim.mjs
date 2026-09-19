// API を使わないベースライン戦略をヘッドレスで回し、エンジンの健全性と難易度を確認する。
// 使い方: node scripts/sim.mjs [episodes] [ghosts]
import { DIRS, Game, MAP, mulberry32 } from '../public/game.js';
import { directionFeatures, heuristicChoice } from '../public/agent.js';

const episodes = Number(process.argv[2] ?? 20);
const ghosts = Number(process.argv[3] ?? 4);

const widths = new Set(MAP.map((r) => r.length));
if (widths.size !== 1) throw new Error(`MAP の行幅が不揃い: ${[...widths]}`);

// 全ペレットがランナーの開始位置から到達可能か
{
  const g = new Game();
  const seen = new Set([g.runnerStart.join(',')]);
  let frontier = [g.runnerStart];
  while (frontier.length) {
    const next = [];
    for (const [x, y] of frontier) {
      for (const d of g.legalDirs(x, y)) {
        const [nx, ny] = [x + DIRS[d][0], y + DIRS[d][1]];
        if (seen.has(`${nx},${ny}`)) continue;
        seen.add(`${nx},${ny}`);
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  const unreachable = [...g.pellets, ...g.powers].filter((k) => !seen.has(k));
  if (unreachable.length) throw new Error(`到達不能なペレット: ${unreachable.join(' ')}`);
  console.log(`map ok: ${g.width}x${g.height}, pellets=${g.totalPellets}`);
}

for (const [name, pick] of [
  ['heuristic', (game) => heuristicChoice(game, directionFeatures(game))],
  ['random', (game, rand) => game.legalDirs()[Math.floor(rand() * game.legalDirs().length)]],
]) {
  const tally = { win: 0, lost: 0, timeout: 0 };
  let ticks = 0;
  let eaten = 0;
  for (let seed = 1; seed <= episodes; seed++) {
    const game = new Game({ seed, ghosts });
    const rand = mulberry32(seed * 7919);
    while (!game.over) game.step(pick(game, rand));
    tally[game.result]++;
    ticks += game.tick;
    eaten += 1 - game.remaining() / game.totalPellets;
  }
  console.log(
    `${name.padEnd(10)} win=${tally.win} lost=${tally.lost} timeout=${tally.timeout}` +
      ` avgTicks=${Math.round(ticks / episodes)} avgCleared=${Math.round((eaten / episodes) * 100)}%`,
  );
}

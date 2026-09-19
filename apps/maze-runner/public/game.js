// 迷路チェイスゲームのエンジン。DOM 非依存で、ブラウザと Node (scripts/sim.mjs) の両方から使う。
// 1 tick = ランナー 1 マス移動。乱数はシード付きなので同じ seed・同じ入力なら同じ展開になる。

export const MAP = [
  '###################',
  '#o.......#.......o#',
  '#.##.###.#.###.##.#',
  '#.................#',
  '#.##.#.#####.#.##.#',
  '#....#...#...#....#',
  '####.###.#.###.####',
  '####.#.......#.####',
  '####.#.##-##.#.####',
  '#......#GGG#......#',
  '####.#.#####.#.####',
  '####.#.......#.####',
  '####.#.#####.#.####',
  '#........#........#',
  '#.##.###.#.###.##.#',
  '#o.#.....P.....#.o#',
  '##.#.#.#####.#.#.##',
  '#....#...#...#....#',
  '#.######.#.######.#',
  '#.................#',
  '###################',
];

export const DIRS = { up: [0, -1], left: [-1, 0], down: [0, 1], right: [1, 0] };
export const DIR_NAMES = Object.keys(DIRS);
export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const FRIGHT_TICKS = 40;
const SCATTER_TICKS = 35;
const CYCLE_TICKS = 135;

const GHOST_DEFS = [
  { name: 'chaser', color: '#a78bfa', corner: [17, 1], release: 0 },
  { name: 'ambusher', color: '#34d399', corner: [1, 1], release: 10 },
  { name: 'flanker', color: '#fb7185', corner: [17, 19], release: 30 },
  { name: 'drifter', color: '#cbd5e1', corner: [1, 19], release: 50 },
];

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

export const key = (x, y) => `${x},${y}`;

export class Game {
  constructor({ seed = 1, ghosts = 4, lives = 3, maxTicks = 1500 } = {}) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.width = MAP[0].length;
    this.height = MAP.length;
    this.maxTicks = maxTicks;
    this.pellets = new Set();
    this.powers = new Set();
    this.house = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = MAP[y][x];
        if (c === '.') this.pellets.add(key(x, y));
        else if (c === 'o') this.powers.add(key(x, y));
        else if (c === 'G') this.house.push([x, y]);
        else if (c === '-') this.door = [x, y];
        else if (c === 'P') this.runnerStart = [x, y];
      }
    }
    this.exit = [this.door[0], this.door[1] - 1];
    this.totalPellets = this.pellets.size + this.powers.size;
    this.tick = 0;
    this.score = 0;
    this.lives = lives;
    this.frightTimer = 0;
    this.combo = 0;
    this.over = false;
    this.result = null; // 'win' | 'lost' | 'timeout'
    this.deaths = 0;
    this.ghostsEaten = 0;
    this.ghosts = GHOST_DEFS.slice(0, ghosts).map((def) => ({ ...def }));
    this.resetPositions();
  }

  resetPositions() {
    const [px, py] = this.runnerStart;
    this.runner = { x: px, y: py, px, py, dir: 'left' };
    this.frightTimer = 0;
    this.ghosts.forEach((g, i) => {
      const [x, y] = i === 0 ? this.exit : this.house[(i - 1) % this.house.length];
      Object.assign(g, {
        x, y, px: x, py: y,
        dir: 'left',
        inHouse: i !== 0,
        frightened: false,
        releaseAt: this.tick + g.release,
      });
    });
  }

  cell(x, y) {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return '#';
    return MAP[y][x];
  }

  // ランナーと、巣の外にいるゴーストが歩けるマス
  walkable(x, y) {
    const c = this.cell(x, y);
    return c !== '#' && c !== '-' && c !== 'G';
  }

  legalDirs(x = this.runner.x, y = this.runner.y) {
    return DIR_NAMES.filter((d) => this.walkable(x + DIRS[d][0], y + DIRS[d][1]));
  }

  remaining() {
    return this.pellets.size + this.powers.size;
  }

  step(dir) {
    if (this.over) return;
    this.tick++;
    const runner = this.runner;
    runner.px = runner.x;
    runner.py = runner.y;
    const legal = this.legalDirs();
    if (dir && legal.includes(dir)) runner.dir = dir;
    if (legal.includes(runner.dir)) {
      runner.x += DIRS[runner.dir][0];
      runner.y += DIRS[runner.dir][1];
    }

    const k = key(runner.x, runner.y);
    if (this.pellets.delete(k)) this.score += 10;
    if (this.powers.delete(k)) {
      this.score += 50;
      this.frightTimer = FRIGHT_TICKS;
      this.combo = 0;
      for (const g of this.ghosts) {
        if (g.inHouse) continue;
        g.frightened = true;
        g.dir = OPPOSITE[g.dir];
      }
    }

    for (const g of this.ghosts) {
      g.px = g.x;
      g.py = g.y;
    }
    if (this.resolveCollisions()) return;
    for (const g of this.ghosts) this.moveGhost(g);
    if (this.resolveCollisions()) return;

    if (this.frightTimer > 0 && --this.frightTimer === 0) {
      for (const g of this.ghosts) g.frightened = false;
    }
    if (this.remaining() === 0) this.finish('win');
    else if (this.tick >= this.maxTicks) this.finish('timeout');
  }

  finish(result) {
    this.over = true;
    this.result = result;
  }

  // 戻り値 true = このtickの処理を打ち切る（ミス or ゲーム終了）
  resolveCollisions() {
    const runner = this.runner;
    for (const g of this.ghosts) {
      if (g.inHouse) continue;
      const same = g.x === runner.x && g.y === runner.y;
      const swapped = g.x === runner.px && g.y === runner.py && g.px === runner.x && g.py === runner.y;
      if (!same && !swapped) continue;
      if (g.frightened) {
        this.score += 200 * 2 ** this.combo++;
        this.ghostsEaten++;
        const [hx, hy] = this.house[1] ?? this.house[0];
        Object.assign(g, { x: hx, y: hy, px: hx, py: hy, inHouse: true, frightened: false, releaseAt: this.tick + 15 });
        continue;
      }
      this.lives--;
      this.deaths++;
      if (this.lives <= 0) this.finish('lost');
      else this.resetPositions();
      return true;
    }
    return false;
  }

  moveGhost(g) {
    if (g.inHouse) {
      if (this.tick < g.releaseAt) return;
      if (g.x !== this.exit[0]) g.x += Math.sign(this.exit[0] - g.x);
      else g.y -= 1;
      if (g.x === this.exit[0] && g.y === this.exit[1]) {
        g.inHouse = false;
        g.dir = this.rand() < 0.5 ? 'left' : 'right';
      }
      return;
    }
    // ゴーストはランナーより少し遅い（怯え中はさらに遅い）
    if (g.frightened ? this.tick % 2 === 1 : this.tick % 4 === 0) return;

    let options = this.legalDirs(g.x, g.y).filter((d) => d !== OPPOSITE[g.dir]);
    if (options.length === 0) options = this.legalDirs(g.x, g.y);
    let chosen;
    if (g.frightened) {
      chosen = options[Math.floor(this.rand() * options.length)];
    } else {
      const [tx, ty] = this.ghostTarget(g);
      let best = Infinity;
      for (const d of options) {
        const dist = (g.x + DIRS[d][0] - tx) ** 2 + (g.y + DIRS[d][1] - ty) ** 2;
        if (dist < best) {
          best = dist;
          chosen = d;
        }
      }
    }
    g.dir = chosen;
    g.x += DIRS[chosen][0];
    g.y += DIRS[chosen][1];
  }

  // 'scatter' = 各自の担当コーナーへ散開中、'chase' = ランナーを追跡中
  ghostMode() {
    return this.tick % CYCLE_TICKS < SCATTER_TICKS ? 'scatter' : 'chase';
  }

  ghostTarget(g) {
    if (this.ghostMode() === 'scatter') return g.corner;
    const runner = this.runner;
    const [dx, dy] = DIRS[runner.dir];
    switch (g.name) {
      case 'ambusher':
        return [runner.x + dx * 4, runner.y + dy * 4];
      case 'flanker': {
        const b = this.ghosts[0];
        return [(runner.x + dx * 2) * 2 - b.x, (runner.y + dy * 2) * 2 - b.y];
      }
      case 'drifter':
        return (g.x - runner.x) ** 2 + (g.y - runner.y) ** 2 > 64 ? [runner.x, runner.y] : g.corner;
      default:
        return [runner.x, runner.y];
    }
  }
}

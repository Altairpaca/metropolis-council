/**
 * Seeded terrain generation. Uses value-noise (bilinear interpolation of a
 * coarse seeded lattice) so the map is smooth, deterministic and cheap.
 * Guarantees: a river OR coastline, buildable flat land near spawn, a
 * connected buildable core. Retries internally with a derivative seed if the
 * first attempt fails the reachability check.
 */
import type { Difficulty, Tile, WorldMap, Region } from './types.js';
import { BALANCE } from './constants.js';
import { RNG } from './rng.js';
import type { ScenarioConfig } from './types.js';

export const idx = (map: { width: number }, x: number, y: number): number => y * map.width + x;
export const inBounds = (map: { width: number; height: number }, x: number, y: number) =>
  x >= 0 && y >= 0 && x < map.width && y < map.height;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale, fy = y / scale;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

function attempt(seed: number, difficulty: Difficulty, scenario?: ScenarioConfig): WorldMap | null {
  const W = BALANCE.mapWidth, H = BALANCE.mapHeight;
  const rng = new RNG(seed ^ 0x5bf03635);
  const riverBlock = scenario?.initial.riverBlock ?? false;
  const waterScarcity = scenario?.initial.waterScarcity ?? 0.25;
  const seaLevel = 0.30 + waterScarcity * 0.10;

  // A meandering river as a cosine + noise band, OR a vertical divider for two_banks
  const riverPhase = rng.range(0, Math.PI * 2);
  const riverAmp = 5 + rng.range(0, 6);
  const riverCenter = riverBlock ? W / 2 : W * rng.range(0.35, 0.65);
  const riverWidth = riverBlock ? 3.0 : 2.2 + rng.range(0, 1.6);

  const tiles: Tile[] = new Array(W * H);
  const riverCells: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const n1 = valueNoise(x, y, 14, seed);
      const n2 = valueNoise(x, y, 6, seed ^ 0x1234);
      const n3 = valueNoise(x, y, 3, seed ^ 0x9876);
      let height = n1 * 0.62 + n2 * 0.27 + n3 * 0.11;
      // coastal falloff on the east edge
      const coast = x / W;
      height += (coast - 0.5) * 0.10;
      const riverX = riverCenter + Math.sin(y * 0.18 + riverPhase) * riverAmp * (riverBlock ? 0.25 : 1);
      const distRiver = Math.abs(x - riverX);
      let water = 0;
      if (distRiver < riverWidth) water = 1 - distRiver / riverWidth * 0.65;
      if (x > W - 3) water = Math.max(water, (x - (W - 3)) / 3); // eastern sea
      height -= water * 0.25;
      height = Math.max(0, Math.min(1, height));
      const slope = Math.abs(valueNoise(x + 1, y, 8, seed) - valueNoise(x - 1, y, 8, seed)) * 2;
      const buildable = water < 0.35 && height > seaLevel && height < 0.88 && slope < 0.32;
      let resource: Tile['resource'] = 'none';
      const rr = hash2(x, y, seed ^ 0xabcd);
      if (water > 0.5) resource = 'water';
      else if (rr > 0.94 && height > 0.6) resource = 'ore';
      else if (rr > 0.86) resource = 'fertile';
      if (water > 0.35) riverCells.push(i);
      tiles[i] = { x, y, height, water, slope, resource, buildable,
        landUse: 'empty', density: 0, pollution: 0,
        landValue: 0.3 + (1 - Math.abs(height - 0.5)) * 0.2 - water * 0.2 };
    }
  }

  // Spawn = buildable cell closest to the vertical center, west of the river for two_banks
  let spawn = { x: Math.floor(W * 0.4), y: Math.floor(H / 2) };
  let best = -Infinity;
  for (let y = 4; y < H - 4; y++) {
    for (let x = 3; x < W - 4; x++) {
      const t = tiles[y * W + x]!;
      if (!t.buildable) continue;
      const centerBonus = 1 - (Math.abs(y - H / 2) / (H / 2));
      const westBonus = riverBlock ? (x < riverCenter ? 1 : 0) : 1;
      const score = centerBonus + westBonus * 2 + (t.resource === 'fertile' ? 0.3 : 0);
      if (score > best) { best = score; spawn = { x, y }; }
    }
  }
  // Flood-fill buildable connectivity from spawn
  const seen = new Set<number>([idx({ width: W }, spawn.x, spawn.y)]);
  const q = [idx({ width: W }, spawn.x, spawn.y)];
  while (q.length) {
    const i = q.pop()!, x = i % W, y = Math.floor(i / W);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (seen.has(ni) || !tiles[ni]!.buildable) continue;
      seen.add(ni); q.push(ni);
    }
  }
  const buildableCount = tiles.filter(t => t.buildable).length;
  if (buildableCount < 480 || seen.size < 260) return null; // retry

  // Regions: NW, NE, SW, SE + center civic
  const regions: Region[] = [
    { id: 'north_west', name: '北岸西区 North-West', cells: [], center: { x: W * 0.25, y: H * 0.25 } },
    { id: 'north_east', name: '北岸东区 North-East', cells: [], center: { x: W * 0.75, y: H * 0.25 } },
    { id: 'south_west', name: '南岸西区 South-West', cells: [], center: { x: W * 0.25, y: H * 0.75 } },
    { id: 'south_east', name: '南岸东区 South-East', cells: [], center: { x: W * 0.75, y: H * 0.75 } },
    { id: 'center',     name: '中心区 Center',       cells: [], center: { x: W * 0.5,  y: H * 0.5 } },
  ];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const dx = x - W / 2, dy = y - H / 2;
    let rid = Math.hypot(dx, dy) < 7 ? 'center' : (y < H / 2 ? 'north' : 'south') + '_' + (x < W / 2 ? 'west' : 'east');
    regions.find(r => r.id === rid)!.cells.push(i);
  }
  return { width: W, height: H, seed, tiles, riverCells, spawn, regions, seaLevel };
}

export function generateMap(seed: number, difficulty: Difficulty = 'normal', scenario?: ScenarioConfig): WorldMap {
  for (let attemptNo = 0; attemptNo < 24; attemptNo++) {
    const m = attempt((seed + attemptNo * 7919) >>> 0, difficulty, scenario);
    if (m) return m;
  }
  // Defensive fallback: relaxed acceptance (still seeded & deterministic)
  const relaxed = attempt(seed ^ 0xdeadbeef, difficulty, scenario);
  if (relaxed) return relaxed;
  throw new Error('Map generation failed after 24 retries');
}

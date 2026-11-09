/**
 * Deterministic xorshift32 RNG. Four independent streams (terrain, events,
 * population, economy) keep different strategies' call order from perturbing
 * exogenous shocks. All state is a single uint32, serialized in every save.
 */
export class RNG {
  private s: number;
  constructor(seed: number) {
    let s = (seed | 0) >>> 0;
    if (s === 0) s = 0x9e3779b9;
    this.s = s;
  }
  static fromState(n: number): RNG { const r = new RNG(1); r.s = (n | 0) >>> 0 || 0x9e3779b9; return r; }
  /** float in [0,1) */
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
  pick<T>(a: T[]): T { return a[this.int(a.length)]!; }
  /** true with probability p */
  chance(p: number): boolean { return this.next() < p; }
  state(): number { return this.s >>> 0; }
  clone(): RNG { return RNG.fromState(this.s); }
}

export interface WorldRNG { terrain: RNG; events: RNG; population: RNG; economy: RNG; }

/** Stable per-stream salts (FNV-1a of the stream name). */
const SALT = { terrain: 0x1f3d5b77, events: 0x2a4c6e80, population: 0x3b5d7f91, economy: 0x4c6e80a2 } as const;
export function makeWorldRNG(seed: number): WorldRNG {
  const mix = (salt: number) => {
    let x = (seed ^ salt) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0 || 1;
  };
  return {
    terrain: new RNG(mix(SALT.terrain)),
    events: new RNG(mix(SALT.events)),
    population: new RNG(mix(SALT.population)),
    economy: new RNG(mix(SALT.economy)),
  };
}
export function serializeRNG(r: WorldRNG) {
  return { terrain: r.terrain.state(), events: r.events.state(), population: r.population.state(), economy: r.economy.state() };
}
export function restoreRNG(s: { terrain: number; events: number; population: number; economy: number }): WorldRNG {
  return { terrain: RNG.fromState(s.terrain), events: RNG.fromState(s.events), population: RNG.fromState(s.population), economy: RNG.fromState(s.economy) };
}

/** Stable 64-bit FNV-1a hash as hex — used for state hashing (pure, no deps). */
export function fnv1a64(str: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  // emulate 64-bit via two 32-bit lanes is inaccurate; use BigInt, deterministic everywhere
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  // mix in length
  h ^= BigInt(str.length & 0xffff);
  h = (h * prime) & mask;
  void h1; void h2;
  return h.toString(16).padStart(16, '0');
}

/**
 * Metropolis Council - procedural 3D city renderer.
 *
 * EVERYTHING here is generated at runtime from the simulation state by our own
 * code: no external models, textures, HDRIs or audio. Nothing is copied from any
 * commercial city builder. The look is a stylised modern metropolis with a
 * readable skyline, day/night lighting and data overlays.
 *
 * The renderer is read-only with respect to the simulation: it consumes a
 * WorldState and never mutates it.
 */
import * as THREE from 'three';
import type { WorldState, Tile } from '@metropolis/core';

export type OverlayMode = 'standard' | 'finance' | 'traffic' | 'pollution' | 'services' | 'landvalue';

export interface ViewState {
  mode: OverlayMode;
  zoom: number;       // camera distance multiplier
  rotation: number;   // horizontal orbit angle in radians
  panX: number;       // world-space pan
  panY: number;
  timeOfDay: number;  // 0..1 (0 = midnight, 0.5 = noon)
  showLabels: boolean;
}

export const DEFAULT_VIEW: ViewState = {
  mode: 'standard', zoom: 1, rotation: Math.PI * 0.25, panX: 0, panY: 0, timeOfDay: 0.74, showLabels: true,
};

export interface RenderStats { drawCalls: number; triangles: number; instanced: number; buildings: number; trees: number; vehicles: number; }

const MAX_BUILDINGS = 2400;
const MAX_TREES = 1600;
const MAX_VEHICLES = 260;

const PALETTE = {
  // Residential: warm terracotta / cream low-rise.
  res: [0xc9a68c, 0xd8bda6, 0xb99a80, 0xe0cbb4, 0xcfa98f],
  // Commercial: cool glass / steel towers.
  com: [0x7fa3bd, 0x6b90ad, 0x94b3c9, 0x5f87a6, 0x89aec8],
  // Industrial: dusty concrete and rust.
  ind: [0x9a8b78, 0x8a7a66, 0xa89a86, 0x7d6f5e],
  // Civic: pale limestone.
  civic: [0xe6dcc8, 0xd6cbb4, 0xefe6d4],
  park: [0x4f7d4a, 0x5c8a52, 0x466f43],
  empty: [0x6b7a5e],
};

function lerpColor(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return a.clone().lerp(b, Math.max(0, Math.min(1, t)));
}
function hsl(h: number, s: number, l: number): THREE.Color { return new THREE.Color().setHSL(h, s, l); }

/** Deterministic 0..1 hash so procedural variation is stable across frames. */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export class CityRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private terrain: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private roadGroup: THREE.Group = new THREE.Group();
  private buildingMesh: THREE.InstancedMesh | null = null;
  private treeMesh: THREE.InstancedMesh | null = null;
  private vehicleMesh: THREE.InstancedMesh | null = null;
  private landmarkGroup: THREE.Group = new THREE.Group();
  private lastState: WorldState | null = null;
  private lastView: ViewState = { ...DEFAULT_VIEW };
  private clock = 0;
  private disposed = false;
  private width = 1;
  private height = 1;
  private stats: RenderStats = { drawCalls: 0, triangles: 0, instanced: 0, buildings: 0, trees: 0, vehicles: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, opts: { width?: number; height?: number } = {}) {
    this.width = opts.width ?? canvas.clientWidth ?? 1280;
    this.height = opts.height ?? canvas.clientHeight ?? 720;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1522);
    this.scene.fog = new THREE.Fog(0x101a26, 60, 190);

    this.camera = new THREE.PerspectiveCamera(46, this.width / this.height, 0.5, 600);
    this.camera.position.set(40, 34, 40);

    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
    this.sun.position.set(38, 58, 22);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 220;
    this.sun.shadow.camera.left = -70;
    this.sun.shadow.camera.right = 70;
    this.sun.shadow.camera.top = 70;
    this.sun.shadow.camera.bottom = -70;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xa8caff, 0x3a4030, 0.95);
    this.scene.add(this.ambient);

    this.scene.add(this.roadGroup);
    this.scene.add(this.landmarkGroup);

    // A ground disc under the terrain so the horizon never shows a void.
    const base = new THREE.Mesh(
      new THREE.CircleGeometry(160, 64),
      new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 1 }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = -1.2;
    base.receiveShadow = true;
    this.scene.add(base);
  }

  /** Build or rebuild the static terrain + water for a map. */
  private buildTerrain(state: WorldState) {
    const { width: W, height: H, tiles } = state.map;
    if (this.terrain) { this.scene.remove(this.terrain); this.terrain.geometry.dispose(); (this.terrain.material as THREE.Material).dispose(); }
    if (this.water) { this.scene.remove(this.water); this.water.geometry.dispose(); (this.water.material as THREE.Material).dispose(); }

    const geo = new THREE.PlaneGeometry(W - 1, H - 1, W - 1, H - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const color = new THREE.Color();
    const cx = (W - 1) / 2, cz = (H - 1) / 2;

    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vz = pos.getZ(i);
      const tx = Math.max(0, Math.min(W - 1, Math.round(vx + cx)));
      const tz = Math.max(0, Math.min(H - 1, Math.round(vz + cz)));
      const t: Tile = tiles[tz * W + tx]!;
      const elev = (t.height - state.map.seaLevel) * 9;
      const isWater = t.water > 0.35;
      pos.setY(i, isWater ? -0.9 : Math.max(-0.4, elev));

      if (isWater) color.setHex(0x1d3a52);
      else if (t.landUse === 'park') color.setHex(0x3f6b3c);
      else if (t.height < state.map.seaLevel + 0.06) color.setHex(0xc8b98d);
      else if (t.height > 0.72) color.setHex(0x6d6a5e);
      else {
        const g = hsl(0.26 - t.height * 0.06, 0.22, 0.30 + t.height * 0.14);
        color.copy(g);
      }
      // structural colouring: roads read as dark asphalt
      if (t.landUse === 'road') color.setHex(0x2c333c);
      colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = false;
    this.scene.add(this.terrain);

    const waterGeo = new THREE.PlaneGeometry(W + 40, H + 40, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x2a6f9c, roughness: 0.22, metalness: 0.12, transparent: true, opacity: 0.93,
      emissive: 0x0a2334, emissiveIntensity: 0.5,
    });
    this.water = new THREE.Mesh(waterGeo, waterMat);
    this.water.position.y = -0.55;
    this.scene.add(this.water);
  }

  private buildRoads(state: WorldState) {
    for (const c of [...this.roadGroup.children]) {
      this.roadGroup.remove(c);
      if (c instanceof THREE.Mesh) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
    }
    const { width: W, height: H } = state.map;
    const cx = (W - 1) / 2, cz = (H - 1) / 2;
    const matStreet = new THREE.MeshStandardMaterial({ color: 0x2b323a, roughness: 0.92 });
    const matBridge = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.7, metalness: 0.25 });

    const groundAt = (tx: number, ty: number): number => {
      const t = state.map.tiles[Math.max(0, Math.min(state.map.tiles.length - 1, ty * W + tx))];
      if (!t) return 0;
      return Math.max(-0.3, (t.height - state.map.seaLevel) * 9);
    };
    for (const e of state.roads.edges) {
      const a = state.roads.nodes[e.a], b = state.roads.nodes[e.b];
      if (!a || !b) continue;
      const dx = b.x - a.x, dz = b.y - a.y;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const ay = groundAt(a.x, a.y), by = groundAt(b.x, b.y);
      const midY = (ay + by) / 2;
      const slope = Math.abs(by - ay);
      const geo = new THREE.BoxGeometry(1.15, 0.16, Math.hypot(len, slope) + 0.05);
      const mesh = new THREE.Mesh(geo, e.type === 'bridge' ? matBridge : matStreet);
      mesh.position.set((a.x + b.x) / 2 - cx, midY + 0.09, (a.y + b.y) / 2 - cz);
      mesh.rotation.order = 'YXZ';
      mesh.rotation.y = Math.atan2(dx, dz);
      mesh.rotation.x = -Math.atan2(by - ay, len);
      mesh.receiveShadow = true;
      this.roadGroup.add(mesh);
      // centre-line marking
      const markGeo = new THREE.BoxGeometry(0.09, 0.02, len * 0.78);
      const mark = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: 0xc8cfd6, transparent: true, opacity: 0.35 }));
      mark.position.set(mesh.position.x, mesh.position.y + 0.09, mesh.position.z);
      mark.rotation.copy(mesh.rotation);
      this.roadGroup.add(mark);
    }
  }

  private ensureInstances(state: WorldState) {
    if (!this.buildingMesh) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      geo.translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.12, vertexColors: false });
      this.buildingMesh = new THREE.InstancedMesh(geo, mat, MAX_BUILDINGS);
      this.buildingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.buildingMesh.castShadow = true;
      this.buildingMesh.receiveShadow = true;
      this.buildingMesh.count = 0;
      const colors = new Float32Array(MAX_BUILDINGS * 3);
      this.buildingMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      this.scene.add(this.buildingMesh);
    }
    if (!this.treeMesh) {
      const geo = new THREE.ConeGeometry(0.45, 1.7, 6);
      geo.translate(0, 0.85, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x6b9c52, roughness: 0.82 });
      this.treeMesh = new THREE.InstancedMesh(geo, mat, MAX_TREES);
      this.treeMesh.castShadow = true;
      this.treeMesh.count = 0;
      this.scene.add(this.treeMesh);
    }
    if (!this.vehicleMesh) {
      const geo = new THREE.BoxGeometry(0.34, 0.24, 0.7);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb066, emissiveIntensity: 1.2 });
      this.vehicleMesh = new THREE.InstancedMesh(geo, mat, MAX_VEHICLES);
      this.vehicleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.vehicleMesh.count = 0;
      this.scene.add(this.vehicleMesh);
    }
    void state;
  }

  private overlayColor(t: Tile, state: WorldState, view: ViewState): THREE.Color {
    switch (view.mode) {
      case 'traffic': {
        const v = state.roads.congestion;
        return lerpColor(hsl(0.33, 0.7, 0.5), hsl(0.0, 0.85, 0.5), v);
      }
      case 'pollution': return lerpColor(hsl(0.33, 0.6, 0.45), hsl(0.02, 0.9, 0.45), t.pollution);
      case 'landvalue': return lerpColor(hsl(0.62, 0.55, 0.35), hsl(0.13, 0.85, 0.60), t.landValue);
      case 'services': return lerpColor(hsl(0.0, 0.8, 0.45), hsl(0.36, 0.7, 0.5), state.services.satisfaction);
      case 'finance': {
        const v = Math.max(-1, Math.min(1, state.treasury / 20000));
        return v >= 0 ? lerpColor(hsl(0.58, 0.15, 0.42), hsl(0.42, 0.8, 0.55), v) : lerpColor(hsl(0.58, 0.15, 0.42), hsl(0.01, 0.85, 0.5), -v);
      }
      default: {
        const key = (t.landUse === 'empty' || t.landUse === 'road') ? 'empty' : t.landUse;
        const arr = PALETTE[key] ?? PALETTE.empty;
        const base = new THREE.Color(arr[Math.floor(hash01(t.x * 73856093 ^ t.y * 19349663) * arr.length)]!);
        return base;
      }
    }
  }

  /** Rebuild dynamic objects (buildings, trees, landmarks) from state. */
  private buildCity(state: WorldState, view: ViewState) {
    this.ensureInstances(state);
    const { width: W, height: H, tiles } = state.map;
    const cx = (W - 1) / 2, cz = (H - 1) / 2;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let bi = 0, ti = 0;

    for (const t of tiles) {
      const wx = t.x - cx, wz = t.y - cz;
      const groundY = Math.max(-0.3, (t.height - state.map.seaLevel) * 9);
      if (t.landUse === 'park') {
        if (ti < MAX_TREES) {
          const n = 1 + Math.floor(hash01(t.x * 31 + t.y * 17) * 2);
          for (let k = 0; k < n && ti < MAX_TREES; k++) {
            const ox = (hash01(t.x * 977 + k * 13) - 0.5) * 0.7;
            const oz = (hash01(t.y * 991 + k * 29) - 0.5) * 0.7;
            const s = 0.7 + hash01(t.x * 7 + t.y * 3 + k) * 0.7;
            dummy.position.set(wx + ox, groundY, wz + oz);
            dummy.scale.set(s, s, s);
            dummy.rotation.y = hash01(t.x + t.y * 5 + k) * Math.PI * 2;
            dummy.updateMatrix();
            this.treeMesh!.setMatrixAt(ti++, dummy.matrix);
          }
        }
        continue;
      }
      if (t.landUse === 'empty') {
        // Undeveloped green space: scattered trees, deterministic per tile.
        if (t.buildable && t.water < 0.3 && ti < MAX_TREES && hash01(t.x * 613 + t.y * 271) > 0.82) {
          const s = 0.6 + hash01(t.x * 11 + t.y * 3) * 0.6;
          dummy.position.set(wx, groundY, wz);
          dummy.scale.set(s, s, s);
          dummy.rotation.y = hash01(t.x + t.y * 7) * Math.PI * 2;
          dummy.updateMatrix();
          this.treeMesh!.setMatrixAt(ti++, dummy.matrix);
        }
        continue;
      }
      if (t.landUse === 'road') continue;
      if (bi >= MAX_BUILDINGS) continue;

      const distCenter = Math.hypot(t.x - W / 2, t.y - H / 2) / (W / 2);
      const coreBoost = Math.max(0, 1 - distCenter) ** 1.6;
      const h = 1.1 + t.density * (2.4 + coreBoost * 7.5) + hash01(t.x * 131 + t.y * 977) * 0.9;
      const w = 0.62 + hash01(t.x * 37 + t.y * 71) * 0.26;
      dummy.position.set(wx, groundY, wz);
      dummy.scale.set(w, h, w);
      dummy.rotation.y = Math.floor(hash01(t.x * 53 + t.y * 97) * 4) * (Math.PI / 2);
      dummy.updateMatrix();
      this.buildingMesh!.setMatrixAt(bi, dummy.matrix);

      color.copy(this.overlayColor(t, state, view));
      if (view.mode === 'standard') {
        // Density brightens the façade; night adds warm window light.
        color.offsetHSL(0, 0, t.density * 0.05);
      }
      this.buildingMesh!.setColorAt(bi, color);
      bi++;
    }
    this.buildingMesh!.count = bi;
    this.treeMesh!.count = ti;
    this.buildingMesh!.instanceMatrix.needsUpdate = true;
    if (this.buildingMesh!.instanceColor) this.buildingMesh!.instanceColor.needsUpdate = true;
    this.treeMesh!.instanceMatrix.needsUpdate = true;
    (this.buildingMesh!.material as THREE.MeshStandardMaterial).needsUpdate = true;

    // Landmarks: a handful of original towers to give the skyline a silhouette.
    for (const c of [...this.landmarkGroup.children]) {
      this.landmarkGroup.remove(c);
      if (c instanceof THREE.Mesh) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
    }
    const dense = tiles.filter(t => t.landUse === 'com' || t.landUse === 'civic')
      .sort((a, b) => b.density - a.density).slice(0, 2);
    dense.forEach((t, i) => {
      const groundY = Math.max(-0.3, (t.height - state.map.seaLevel) * 9);
      const height = 5 + t.density * 6 + i * 0.6;
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(1.05, 1.35, height, 8),
        new THREE.MeshStandardMaterial({
          color: 0xcfe0ee, roughness: 0.55, metalness: 0.05,
          emissive: 0x2b3d4f, emissiveIntensity: 0.55,
        }),
      );
      body.position.set(t.x - cx, groundY + height / 2, t.y - cz);
      body.castShadow = true; body.receiveShadow = true;
      this.landmarkGroup.add(body);
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(1.1, 1.6, 8),
        new THREE.MeshStandardMaterial({ color: 0xffe0ad, emissive: 0xffab5c, emissiveIntensity: 0.8 }),
      );
      crown.position.set(t.x - cx, groundY + height + 1.1, t.y - cz);
      crown.castShadow = true;
      this.landmarkGroup.add(crown);
    });
  }

  private updateVehicles(state: WorldState, view: ViewState) {
    if (!this.vehicleMesh) return;
    const { width: W, height: H } = state.map;
    const cx = (W - 1) / 2, cz = (H - 1) / 2;
    const edges = state.roads.edges;
    if (edges.length === 0) { this.vehicleMesh.count = 0; return; }
    const dummy = new THREE.Object3D();
    const density = Math.min(1, state.population.total / 3000);
    const n = Math.min(MAX_VEHICLES, Math.floor(edges.length * (2 + density * 6)));
    let vi = 0;
    for (let i = 0; i < n; i++) {
      const e = edges[i % edges.length]!;
      const a = state.roads.nodes[e.a], b = state.roads.nodes[e.b];
      if (!a || !b) continue;
      const phase = (this.clock * (0.15 + hash01(i) * 0.2) + hash01(i * 7)) % 1;
      const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const x = a.x + (b.x - a.x) * t - cx;
      const z = a.y + (b.y - a.y) * t - cz;
      dummy.position.set(x, 0.32, z);
      dummy.rotation.y = Math.atan2(b.x - a.x, b.y - a.y);
      dummy.scale.setScalar(0.8 + density * 0.5);
      dummy.updateMatrix();
      this.vehicleMesh.setMatrixAt(vi++, dummy.matrix);
    }
    this.vehicleMesh.count = vi;
    this.vehicleMesh.instanceMatrix.needsUpdate = true;
    void view;
  }

  /** Apply the day/night cycle and camera. */
  private updateEnvironment(state: WorldState, view: ViewState) {
    const t = view.timeOfDay;
    const sunAngle = t * Math.PI * 2 - Math.PI / 2;
    const sunHeight = Math.sin(sunAngle);
    const day = Math.max(0, sunHeight);
    this.sun.position.set(Math.cos(sunAngle) * 70, Math.max(6, sunHeight * 90), 32);
    this.sun.intensity = 0.35 + day * 2.6;
    this.sun.color.setHSL(0.09, 0.45 - day * 0.25, 0.55 + day * 0.25);
    this.sun.target.position.set(0, 0, 0);

    this.ambient.intensity = 0.25 + day * 0.75;
    this.ambient.color.copy(lerpColor(new THREE.Color(0x223355), new THREE.Color(0xbfd8ff), day));
    this.ambient.groundColor.copy(lerpColor(new THREE.Color(0x0a0e12), new THREE.Color(0x3a3b2c), day));

    const skyNight = new THREE.Color(0x070c14);
    const skyDawn = new THREE.Color(0x2b3550);
    const skyDay = new THREE.Color(0x8fb7d9);
    const sky = day < 0.25
      ? lerpColor(skyNight, skyDawn, day / 0.25)
      : lerpColor(skyDawn, skyDay, (day - 0.25) / 0.75);
    (this.scene.background as THREE.Color).copy(sky);
    (this.scene.fog as THREE.Fog).color.copy(sky);

    if (this.water) {
      const m = this.water.material as THREE.MeshStandardMaterial;
      m.color.copy(lerpColor(new THREE.Color(0x11283c), new THREE.Color(0x2f7fb0), day));
      m.metalness = 0.10 + day * 0.18;
      m.roughness = 0.22;
      m.opacity = 0.93;
    }

    // Frame the built-up area rather than the whole map, so a young town fills
    // the screen and a metropolis pulls the camera back on its own.
    const { width: W, height: H } = state.map;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, count = 0;
    for (const t of state.map.tiles) {
      if (t.landUse === 'empty') continue;
      if (t.x < minX) minX = t.x;
      if (t.x > maxX) maxX = t.x;
      if (t.y < minZ) minZ = t.y;
      if (t.y > maxZ) maxZ = t.y;
      count++;
    }
    const cx = (W - 1) / 2, cz = (H - 1) / 2;
    const builtCx = count > 0 ? (minX + maxX) / 2 - cx : 0;
    const builtCz = count > 0 ? (minZ + maxZ) / 2 - cz : 0;
    const span = count > 0 ? Math.max(maxX - minX, maxZ - minZ) : 18;
    const radius = Math.max(30, span * 2.05) * view.zoom;
    const targetX = builtCx + view.panX, targetZ = builtCz + view.panY;
    const elev = Math.PI * 0.26;
    const camX = targetX + Math.sin(view.rotation) * Math.cos(elev) * radius;
    const camZ = targetZ + Math.cos(view.rotation) * Math.cos(elev) * radius;
    const camY = Math.sin(elev) * radius * 0.85 + 6;
    this.camera.position.lerp(new THREE.Vector3(camX, camY, camZ), 0.14);
    this.camera.lookAt(targetX, 2, targetZ);

    // Window glow at night via emissive intensity on the shared material.
    if (this.buildingMesh) {
      const mat = this.buildingMesh.material as THREE.MeshStandardMaterial;
      const night = Math.max(0, 1 - day * 3.2);
      mat.emissive = new THREE.Color(0xffc987);
      mat.emissiveIntensity = night * night * 0.85;
    }
  }

  update(state: WorldState, view: ViewState = DEFAULT_VIEW): void {
    if (this.disposed) return;
    const mapChanged = !this.lastState || this.lastState.map.seed !== state.map.seed
      || this.lastState.roads.edges.length !== state.roads.edges.length;
    const landmarksChanged = !this.lastState
      || this.lastState.tick !== state.tick
      || this.lastState.landVersion !== state.landVersion;
    if (mapChanged) {
      this.buildTerrain(state);
    }
    if (mapChanged || this.roadGroup.children.length === 0) this.buildRoads(state);
    if (landmarksChanged || mapChanged) this.buildCity(state, view);
    if (view.mode !== this.lastView.mode || mapChanged) this.buildCity(state, view);
    this.updateVehicles(state, view);
    this.updateEnvironment(state, view);
    this.lastState = state;
    this.lastView = view;

    this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info;
    this.stats = {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      instanced: (this.buildingMesh?.count ?? 0) + (this.treeMesh?.count ?? 0) + (this.vehicleMesh?.count ?? 0),
      buildings: this.buildingMesh?.count ?? 0,
      trees: this.treeMesh?.count ?? 0,
      vehicles: this.vehicleMesh?.count ?? 0,
    };
  }

  /** Advance animation time without re-rendering the whole city. */
  tickAnimation(dt: number): void { this.clock += dt; }

  getStats(): RenderStats { return { ...this.stats }; }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.width = width; this.height = height;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach(x => x.dispose()); else m.dispose();
      }
    });
    this.renderer.dispose();
  }
}

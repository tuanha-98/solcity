import * as THREE from 'three'
import type { VarShape } from './model'

// One building style per kind of Solidity declaration. Every builder returns a group whose
// pivot is the bottom centre, made of parts created by `make` (so the scene can pick and dim them).

export type MeshOpts = {
  opacity?: number; wireframe?: boolean; emissive?: string; emissiveIntensity?: number; metalness?: number; roughness?: number
  map?: THREE.Texture; emissiveMap?: THREE.Texture
}
/** Outlines (glass frames) the scene should dim together with their building. */
export type Frame = (lines: THREE.LineSegments) => void
export type Make = (geo: THREE.BufferGeometry, color: string, o?: MeshOpts) => THREE.Mesh

const shared = <T extends THREE.BufferGeometry>(g: T) => {
  g.userData.shared = true // never disposed on rebuild
  return g
}

function prismGeometry() {
  // triangular prism: ridge along x, base spans z −0.5…0.5, height y 0…1
  const shape = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 1)])
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false })
  g.translate(0, 0, -0.5)
  g.rotateY(Math.PI / 2)
  return g
}

export const G = {
  box: shared(new THREE.BoxGeometry(1, 1, 1)),
  cyl: shared(new THREE.CylinderGeometry(1, 1, 1, 18)),
  cone: shared(new THREE.ConeGeometry(1, 1, 24)),
  prism: shared(prismGeometry()),
  sphere: shared(new THREE.SphereGeometry(1, 14, 10)),
  dome: shared(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2)),
}

function put(make: Make, parent: THREE.Object3D, geo: THREE.BufferGeometry, color: string, s: [number, number, number], p: [number, number, number], o?: MeshOpts) {
  const m = make(geo, color, o)
  m.scale.set(...s)
  m.position.set(...p)
  parent.add(m)
  return m
}

export const shade = (c: string, f: number) => `#${new THREE.Color(c).multiplyScalar(f).getHexString()}`

// ---------------------------------------------------------------------------
// State variable → warehouse with a gabled roof. The data type changes the building:
// value = single shed, mapping = wall of lit lockers (key → value), array = row of identical
// units, struct = two-storey warehouse, string/bytes = shop with a sign.

export function warehouse(make: Make, shape: VarShape, w: number, d: number, color: string): THREE.Group {
  const g = new THREE.Group()
  const roof = shade(color, 0.5)
  const unit = (x: number, uw: number, h: number, door = true) => {
    put(make, g, G.box, color, [uw, h, d], [x, h / 2, 0])
    put(make, g, G.prism, roof, [uw + 0.08, Math.min(0.42, uw * 0.3 + 0.12), d + 0.08], [x, h, 0])
    if (door && uw > 0.45) put(make, g, G.box, '#1a1e2c', [uw * 0.42, h * 0.58, 0.03], [x, (h * 0.58) / 2, d / 2 + 0.01])
    return h
  }
  switch (shape) {
    case 'value':
      unit(0, w, 0.7)
      break
    case 'array': {
      const n = 3, uw = w / n
      for (let i = 0; i < n; i++) unit((i - 1) * uw, uw - 0.14, 0.62)
      break
    }
    case 'mapping': {
      const h = unit(0, w, 0.9, false)
      const cols = 5, rows = 3
      const lw = (w * 0.82) / cols, lh = (h * 0.8) / rows
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const lit = (i * 7 + j * 3) % 4 !== 0
        put(make, g, G.box, lit ? '#fde68a' : '#3b2f14', [lw * 0.72, lh * 0.7, 0.03],
          [(i - (cols - 1) / 2) * lw, h * 0.1 + lh * (j + 0.5), d / 2 + 0.012], lit ? { emissive: '#f59e0b', emissiveIntensity: 0.9 } : {})
      }
      break
    }
    case 'struct': {
      const h = unit(0, w, 1.15)
      put(make, g, G.box, shade(color, 0.65), [w + 0.04, 0.08, d + 0.04], [0, h * 0.52, 0])
      for (let i = 0; i < 4; i++) put(make, g, G.box, '#e0e7ff', [w * 0.12, 0.16, 0.03], [(i - 1.5) * w * 0.22, h * 0.76, d / 2 + 0.012], { emissive: '#818cf8', emissiveIntensity: 0.6 })
      break
    }
    case 'bytes': {
      const h = unit(0, w, 0.62)
      put(make, g, G.box, '#2b3043', [0.05, 0.5, 0.05], [0, h + 0.35, 0])
      put(make, g, G.box, color, [w * 0.7, 0.3, 0.06], [0, h + 0.62, 0], { emissive: color, emissiveIntensity: 0.6 })
      break
    }
  }
  return g
}

// ---------------------------------------------------------------------------
// constant / immutable → Greek temple: set in stone. Marble for constant (compile time),
// sandstone for immutable (written once, in the constructor).

export function temple(make: Make, w: number, d: number, color: string): THREE.Group {
  const g = new THREE.Group()
  put(make, g, G.box, shade(color, 0.85), [w, 0.08, d], [0, 0.04, 0])
  put(make, g, G.box, shade(color, 0.92), [w - 0.14, 0.08, d - 0.14], [0, 0.12, 0])
  const base = 0.16, colH = 0.8
  put(make, g, G.box, shade(color, 0.7), [w - 0.6, colH, d - 0.7], [0, base + colH / 2, 0]) // inner chamber
  const nx = w > 1.2 ? 4 : 3
  for (const z of [d / 2 - 0.22, -(d / 2 - 0.22)]) for (let i = 0; i < nx; i++) {
    const x = -w / 2 + 0.22 + (i * (w - 0.44)) / (nx - 1)
    put(make, g, G.cyl, color, [0.07, colH, 0.07], [x, base + colH / 2, z])
  }
  put(make, g, G.box, color, [w - 0.1, 0.12, d - 0.1], [0, base + colH + 0.06, 0])
  const ped = put(make, g, G.prism, shade(color, 0.95), [d - 0.1, 0.32, w - 0.1], [0, base + colH + 0.12, 0])
  ped.rotation.y = Math.PI / 2 // gable faces the street
  return g
}

// ---------------------------------------------------------------------------
// modifier → castle keep: corner turrets, battlements and a flag on top of the statement floors.

export function castle(make: Make, parent: THREE.Object3D, half: number, bottom: number, top: number) {
  const stone = '#a8a29e', roof = '#9f1239'
  const h = top - bottom
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    put(make, parent, G.cyl, stone, [0.24, h + 0.25, 0.24], [sx * half, bottom + (h + 0.25) / 2, sz * half])
    put(make, parent, G.cone, roof, [0.32, 0.5, 0.32], [sx * half, top + 0.25 + 0.25, sz * half])
  }
  const n = 4, edge = half - 0.1
  for (let i = 0; i < n; i++) {
    const t = -edge + 0.35 + (i * (2 * edge - 0.7)) / (n - 1)
    for (const [x, z] of [[t, edge], [t, -edge], [edge, t], [-edge, t]] as const) {
      put(make, parent, G.box, stone, [0.2, 0.24, 0.2], [x, top + 0.12, z])
    }
  }
  put(make, parent, G.cyl, '#d6d3d1', [0.025, 1.0, 0.025], [0, top + 0.5, 0])
  put(make, parent, G.box, '#f43f5e', [0.5, 0.28, 0.02], [0.26, top + 0.82, 0], { emissive: '#9f1239', emissiveIntensity: 0.5 })
}

// ---------------------------------------------------------------------------
// event → radio mast that broadcasts (the scene adds expanding rings around the top).

export function mast(make: Make, color: string): { group: THREE.Group; top: number; light: THREE.Mesh } {
  const g = new THREE.Group()
  const h = 3.2
  put(make, g, G.box, '#2b3043', [0.95, 0.1, 0.95], [0, 0.05, 0])
  const lattice = make(new THREE.CylinderGeometry(0.06, 0.4, h, 4, 6, true), color, { wireframe: true, emissive: color, emissiveIntensity: 0.4 })
  lattice.position.y = 0.1 + h / 2
  lattice.rotation.y = Math.PI / 4
  g.add(lattice)
  put(make, g, G.cyl, shade(color, 0.6), [0.035, h, 0.035], [0, 0.1 + h / 2, 0])
  put(make, g, G.cyl, color, [0.24, 0.05, 0.24], [0, 0.1 + h * 0.42, 0])
  put(make, g, G.cyl, color, [0.15, 0.05, 0.15], [0, 0.1 + h * 0.72, 0])
  const light = put(make, g, G.sphere, '#ff4d6d', [0.11, 0.11, 0.11], [0, 0.1 + h + 0.08, 0], { emissive: '#ff1744', emissiveIntensity: 1.5 })
  return { group: g, top: 0.1 + h + 0.1, light }
}

// ---------------------------------------------------------------------------
// custom error → traffic cone: where execution stops.

export function trafficCone(make: Make): { group: THREE.Group; top: number } {
  const g = new THREE.Group()
  const r = 0.44, h = 1.3, y0 = 0.1
  put(make, g, G.box, '#7f1d1d', [1.0, 0.1, 1.0], [0, 0.05, 0])
  put(make, g, G.cone, '#f43f3f', [r, h, r], [0, y0 + h / 2, 0], { emissive: '#7f1d1d', emissiveIntensity: 0.4 })
  const band = (t0: number, t1: number) => {
    const rb = r * (1 - t0 / h) + 0.012, rt = r * (1 - t1 / h) + 0.012
    put(make, g, new THREE.CylinderGeometry(rt, rb, t1 - t0, 24, 1, true), '#f8fafc', [1, 1, 1], [0, y0 + (t0 + t1) / 2, 0], { emissive: '#94a3b8', emissiveIntensity: 0.3 })
  }
  band(0.42, 0.6)
  band(0.82, 0.98)
  return { group: g, top: y0 + h }
}

// ---------------------------------------------------------------------------
// high-rise floors: one storey per line of code

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  draw(canvas.getContext('2d')!)
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

const WIN = 5 // windows per facade
/** facade: light glass panes between darker mullions and a spandrel band (tinted by the material colour) */
const facade = canvasTexture(80, 32, (c) => {
  c.fillStyle = '#6b7388'
  c.fillRect(0, 0, 80, 32)
  c.fillStyle = '#ffffff'
  for (let i = 0; i < WIN; i++) c.fillRect(i * 16 + 2, 6, 12, 22)
})
/** which windows are lit: a few variants so the city does not look stamped */
const lights = [0, 1, 2, 3].map((v) => canvasTexture(80, 32, (c) => {
  c.fillStyle = '#000000'
  c.fillRect(0, 0, 80, 32)
  for (let i = 0; i < WIN; i++) {
    if ((i * 5 + v * 3) % 7 < 3) continue
    c.fillStyle = (i + v) % 3 === 0 ? '#9fd8ff' : '#ffd98a'
    c.fillRect(i * 16 + 2, 6, 12, 22)
  }
}))
/** castle wall: courses of stone with an arrow slit */
const stoneWall = canvasTexture(64, 32, (c) => {
  c.fillStyle = '#8f8a86'
  c.fillRect(0, 0, 64, 32)
  c.fillStyle = '#d9d4cf'
  for (let row = 0; row < 3; row++) for (let col = -1; col < 5; col++) {
    const x = col * 16 + (row % 2 ? 8 : 0)
    c.fillRect(x + 1, row * 11 + 1, 14, 9)
  }
  c.fillStyle = '#1f1d1c'
  c.fillRect(30, 8, 4, 16)
})
for (const t of [facade, stoneWall, ...lights]) t.userData.shared = true

const edgeBox = shared(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)))

/** One storey of a function tower: a concrete floor plate and a glass facade tinted by the statement kind. */
/**
 * One storey of a function tower: a floor plate as wide as the tower's tier (`slab`), and a glass
 * facade tinted by the statement kind (`size`). Lines inside a block get a facade set back from the
 * plate, like a balcony, so nesting shows without the tower ever getting wider higher up.
 */
export function storey(make: Make, slab: number, size: number, h: number, color: string, style: 'office' | 'castle', translucent: boolean, seed: number) {
  const g = new THREE.Group()
  put(make, g, G.box, style === 'castle' ? '#57534e' : '#2c3245', [slab + 0.08, 0.05, slab + 0.08], [0, 0.025, 0])
  const body = style === 'castle'
    ? put(make, g, G.box, color, [size, h - 0.05, size], [0, 0.05 + (h - 0.05) / 2, 0], { map: stoneWall, roughness: 0.9 })
    : put(make, g, G.box, color, [size, h - 0.05, size], [0, 0.05 + (h - 0.05) / 2, 0], {
      map: facade, emissive: '#ffffff', emissiveMap: lights[seed % lights.length], emissiveIntensity: 0.55,
      roughness: 0.3, metalness: 0.25, opacity: translucent ? 0.72 : 1,
    })
  return { group: g, body }
}

/** Glass storey: the `_;` of a modifier, where the wrapped function's body is inserted. */
export function glassStorey(make: Make, frame: Frame, size: number, h: number) {
  const g = new THREE.Group()
  const body = put(make, g, G.box, '#a5f3fc', [size, h - 0.03, size], [0, (h - 0.03) / 2 + 0.03, 0], {
    opacity: 0.2, roughness: 0.05, metalness: 0.1, emissive: '#22d3ee', emissiveIntensity: 0.25,
  })
  const edges = new THREE.LineSegments(edgeBox, new THREE.LineBasicMaterial({ color: '#cffafe', transparent: true, opacity: 0.95 }))
  edges.scale.copy(body.scale)
  edges.position.copy(body.position)
  g.add(edges)
  frame(edges)
  return { group: g, body }
}

/** Glass tower: a function with no body (interface / abstract): all facade, nothing inside. */
export function glassTower(make: Make, frame: Frame, size: number, floors: number, h: number) {
  const g = new THREE.Group()
  let y = 0
  let body: THREE.Mesh | undefined
  for (let i = 0; i < floors; i++) {
    const s = glassStorey(make, frame, size, h)
    s.group.position.y = y
    g.add(s.group)
    body ??= s.body
    y += h
  }
  // thin mullions up the corners
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(make, g, G.box, '#e0f2fe', [0.05, y, 0.05], [sx * size / 2, y / 2, sz * size / 2], { emissive: '#7dd3fc', emissiveIntensity: 0.4 })
  return { group: g, top: y, body: body! }
}

// ---------------------------------------------------------------------------
// roofs: what a function may do with state

export interface Roof {
  group: THREE.Group
  height: number
  /** blinking light, if any */
  light?: THREE.Mesh
}

/** Railing along the edge of a square roof. */
function railing(make: Make, g: THREE.Object3D, half: number, y: number, color: string) {
  for (const [x, z, w, d] of [[0, half, 2 * half, 0.04], [0, -half, 2 * half, 0.04], [half, 0, 0.04, 2 * half], [-half, 0, 0.04, 2 * half]] as const) {
    put(make, g, G.box, color, [w, 0.035, d], [x, y + 0.17, z])
  }
  const n = 4
  for (let i = 0; i <= n; i++) {
    const t = -half + (2 * half * i) / n
    for (const [x, z] of [[t, half], [t, -half], [half, t], [-half, t]] as const) put(make, g, G.box, color, [0.03, 0.17, 0.03], [x, y + 0.085, z])
  }
}

/** view: a glass observation deck. It looks out over the city and touches nothing. */
export function observationDeck(make: Make, frame: Frame, size: number): Roof {
  const g = new THREE.Group()
  const w = size * 0.72, h = 0.48
  put(make, g, G.box, '#cbd5e1', [size, 0.05, size], [0, 0.025, 0])
  railing(make, g, size / 2 - 0.04, 0.05, '#e2e8f0')
  const glass = put(make, g, G.box, '#a5f3fc', [w, h, w], [0, 0.05 + h / 2, 0], {
    opacity: 0.3, roughness: 0.05, metalness: 0.1, emissive: '#22d3ee', emissiveIntensity: 0.45,
  })
  const edges = new THREE.LineSegments(edgeBox, new THREE.LineBasicMaterial({ color: '#e0f2fe', transparent: true, opacity: 0.95 }))
  edges.scale.copy(glass.scale)
  edges.position.copy(glass.position)
  g.add(edges)
  frame(edges)
  // mullions in the middle of each glass wall
  for (const [x, z] of [[0, w / 2], [0, -w / 2], [w / 2, 0], [-w / 2, 0]] as const) put(make, g, G.box, '#e0f2fe', [0.03, h, 0.03], [x, 0.05 + h / 2, z])
  // cantilevered roof slab and a telescope on top
  put(make, g, G.box, '#e2e8f0', [w + 0.4, 0.06, w + 0.4], [0, 0.05 + h + 0.03, 0], { emissive: '#67e8f9', emissiveIntensity: 0.2 })
  const tube = put(make, g, G.cyl, '#94a3b8', [0.05, 0.42, 0.05], [0.12, 0.05 + h + 0.24, 0.05], { metalness: 0.6, roughness: 0.3 })
  tube.rotation.z = -0.75
  put(make, g, G.box, '#64748b', [0.06, 0.12, 0.06], [0.0, 0.05 + h + 0.12, 0.05])
  return { group: g, height: 0.05 + h + 0.06 }
}

/** pure: a roof garden. Nothing comes in and nothing goes out. */
export function roofGarden(make: Make, size: number, seed: number): Roof {
  const g = new THREE.Group()
  const half = size / 2 - 0.04
  // planter walls
  for (const [x, z, w, d] of [[0, half, 2 * half, 0.09], [0, -half, 2 * half, 0.09], [half, 0, 0.09, 2 * half], [-half, 0, 0.09, 2 * half]] as const) {
    put(make, g, G.box, '#a8a29e', [w, 0.16, d], [x, 0.08, z])
  }
  put(make, g, G.box, '#4d7c0f', [2 * half - 0.1, 0.1, 2 * half - 0.1], [0, 0.05, 0], { roughness: 1 })
  put(make, g, G.box, '#d6d3d1', [0.16, 0.015, 2 * half - 0.2], [0, 0.105, 0]) // stepping-stone path
  const spots: [number, number][] = [[-0.42, -0.38], [0.4, -0.3], [-0.36, 0.4], [0.42, 0.42], [-0.05, -0.05]]
  const k = size / 2.1
  spots.forEach(([x, z], i) => {
    if (i === 4 && seed % 2) return
    const r = 0.15 + ((seed * 7 + i * 5) % 5) * 0.025
    put(make, g, G.cyl, '#78350f', [0.035, 0.24, 0.035], [x * k, 0.1 + 0.12, z * k])
    put(make, g, G.sphere, i % 2 ? '#16a34a' : '#22c55e', [r, r * 1.15, r], [x * k, 0.1 + 0.24 + r * 0.8, z * k], { roughness: 0.9 })
  })
  return { group: g, height: 0.75 }
}

/** payable: a gilded dome on a colonnaded drum, like a bank or a city hall. */
export function goldDome(make: Make, size: number): Roof {
  const g = new THREE.Group()
  const gold = { metalness: 0.85, roughness: 0.22, emissive: '#6b4d00', emissiveIntensity: 0.35 }
  const r = size * 0.34
  put(make, g, G.box, '#d4a017', [size + 0.1, 0.08, size + 0.1], [0, 0.04, 0], { metalness: 0.6, roughness: 0.3, emissive: '#5c4300', emissiveIntensity: 0.3 })
  put(make, g, G.cyl, '#fef3c7', [r, 0.3, r], [0, 0.08 + 0.15, 0])
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    put(make, g, G.cyl, '#fffbeb', [0.03, 0.3, 0.03], [Math.cos(a) * (r + 0.04), 0.08 + 0.15, Math.sin(a) * (r + 0.04)])
  }
  put(make, g, G.cyl, '#fde68a', [r + 0.06, 0.05, r + 0.06], [0, 0.08 + 0.3 + 0.025, 0])
  put(make, g, G.dome, '#facc15', [r, r * 0.95, r], [0, 0.08 + 0.35, 0], gold)
  const top = 0.08 + 0.35 + r * 0.95
  put(make, g, G.cyl, '#fde68a', [0.06, 0.12, 0.06], [0, top + 0.06, 0], gold)
  put(make, g, G.cone, '#facc15', [0.05, 0.32, 0.05], [0, top + 0.12 + 0.16, 0], gold)
  return { group: g, height: top + 0.44 }
}

/** default (changes state, no ether): plant room and an antenna with a blinking light. */
export function plantRoom(make: Make, size: number): Roof {
  const g = new THREE.Group()
  put(make, g, G.box, '#3a4157', [size * 0.45, 0.3, size * 0.35], [-0.3 * (size / 2.1), 0.15, 0.2 * (size / 2.1)])
  put(make, g, new THREE.CylinderGeometry(0.02, 0.035, 1, 6), '#cbd5e1', [1, 1, 1], [0.45 * (size / 2.1), 0.5, -0.4 * (size / 2.1)])
  const light = put(make, g, G.sphere, '#ff4d6d', [0.06, 0.06, 0.06], [0.45 * (size / 2.1), 1.02, -0.4 * (size / 2.1)], { emissive: '#ff1744', emissiveIntensity: 1.2 })
  return { group: g, height: 0.3, light }
}

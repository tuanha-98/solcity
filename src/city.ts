import * as THREE from 'three'

// Street furniture and highways. Everything here is decoration: not pickable, never dimmed,
// except the highway asphalt which the scene registers for picking.

const box = new THREE.BoxGeometry(1, 1, 1)
box.userData.shared = true // reused across rebuilds
const mat = (color: string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...o })

function strip(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, width: number, height: number, material: THREE.Material, extend = 0) {
  const d = b.clone().sub(a)
  const len = d.length()
  const m = new THREE.Mesh(box, material)
  m.scale.set(len + extend * 2, height, width)
  m.position.copy(a).add(b).multiplyScalar(0.5)
  m.position.y += height / 2
  // orient along a→b (also on ramps) while keeping the width axis level
  const x = d.clone().normalize()
  const z = new THREE.Vector3(-x.z, 0, x.x).normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Dashes along a straight segment. */
function dashes(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, material: THREE.Material, w = 0.08, dash = 0.6, gap = 0.6, h = 0.012) {
  const d = b.clone().sub(a)
  const len = d.length()
  const dir = d.normalize()
  for (let s = gap / 2; s + dash <= len; s += dash + gap) {
    strip(parent, a.clone().addScaledVector(dir, s), a.clone().addScaledVector(dir, s + dash), w, h, material)
  }
}

// ---------------------------------------------------------------------------
// inside a city

export interface CityGrid {
  /** x of the vertical streets (local), z range they span */
  cols: number[]
  /** z of the horizontal streets (local): avenue behind the towers, between rows, front street */
  rows: number[]
  /** z of the street behind the storage row (no cross streets reach it) */
  back?: number
  x1: number
  x2: number
  y: number
}

export function streets(parent: THREE.Object3D, g: CityGrid) {
  const asphalt = mat('#0b0e17')
  const paint = mat('#3b4260', { emissive: '#1a1e2e' })
  const y = g.y + 0.002
  const zMin = Math.min(...g.rows), zMax = Math.max(...g.rows)
  for (const z of g.rows) {
    const a = new THREE.Vector3(g.x1 + 0.5, y, z), b = new THREE.Vector3(g.x2 - 0.5, y, z)
    strip(parent, a, b, 1.1, 0.01, asphalt)
    dashes(parent, a.clone().setY(y + 0.01), b.clone().setY(y + 0.01), paint, 0.06, 0.5, 0.5)
  }
  if (g.back !== undefined) {
    const a = new THREE.Vector3(g.x1 + 0.5, y, g.back), b = new THREE.Vector3(g.x2 - 0.5, y, g.back)
    strip(parent, a, b, 0.9, 0.01, asphalt)
    dashes(parent, a.clone().setY(y + 0.01), b.clone().setY(y + 0.01), paint, 0.06, 0.5, 0.5)
  }
  for (const x of g.cols) {
    const a = new THREE.Vector3(x, y, zMin), b = new THREE.Vector3(x, y, zMax)
    strip(parent, a, b, 0.8, 0.008, asphalt, 0.5)
  }
  // street lights at the crossings
  const pole = mat('#2b3043')
  const bulb = new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#ffd27a', emissiveIntensity: 1.6 })
  const poleGeo = new THREE.CylinderGeometry(0.04, 0.05, 1.3, 6)
  const bulbGeo = new THREE.SphereGeometry(0.11, 10, 8)
  for (const x of g.cols) for (const z of g.rows) {
    const p = new THREE.Mesh(poleGeo, pole)
    p.position.set(x + 0.55, g.y + 0.65, z + 0.6)
    p.castShadow = true
    const b = new THREE.Mesh(bulbGeo, bulb)
    b.position.set(x + 0.55, g.y + 1.33, z + 0.6)
    parent.add(p, b)
  }
}

/**
 * Where a highway meets a city: the city's own street runs on to the outer edge, where the highway
 * starts, so the highway itself never lies on the city's ground.
 */
export function cityGate(parent: THREE.Object3D, inner: THREE.Vector3, edge: THREE.Vector3) {
  const asphalt = mat('#0b0e17')
  const paint = mat('#3b4260', { emissive: '#1a1e2e' })
  const y = inner.y + 0.002
  // reach a little into the street it joins, but stop exactly at the edge: nothing hangs past the land
  const inward = inner.clone().sub(edge).setY(0).normalize()
  strip(parent, inner.clone().addScaledVector(inward, 0.55).setY(y), edge.clone().setY(y), 1.1, 0.01, asphalt)
  if (inner.distanceTo(edge) > 0.9) dashes(parent, inner.clone().setY(y + 0.01), edge.clone().setY(y + 0.01), paint, 0.06, 0.5, 0.5)
}

// ---------------------------------------------------------------------------
// highways between cities

export interface Car {
  obj: THREE.Object3D
  curve: THREE.CurvePath<THREE.Vector3>
  t: number
  /** fraction of the path per frame */
  speed: number
}

export interface Highway {
  group: THREE.Group
  asphalt: THREE.Mesh[]
  /** lane paint, recoloured when the road is in focus */
  paint: THREE.MeshStandardMaterial[]
  paintColor: THREE.Color
  cars: Car[]
  labelPos: THREE.Vector3
}

const CAR_COLORS = ['#f43f5e', '#f59e0b', '#22d3ee', '#a3e635', '#e879f9', '#f8fafc', '#60a5fa']

function curveOf(pts: THREE.Vector3[]) {
  const c = new THREE.CurvePath<THREE.Vector3>()
  for (let i = 0; i < pts.length - 1; i++) c.add(new THREE.LineCurve3(pts[i], pts[i + 1]))
  return c
}

function car(color: string) {
  const g = new THREE.Group()
  const body = new THREE.Mesh(box, mat(color, { roughness: 0.4, metalness: 0.3 }))
  body.scale.set(0.82, 0.28, 0.44)
  body.position.y = 0.2
  const cabin = new THREE.Mesh(box, mat('#1e293b', { roughness: 0.2, metalness: 0.5 }))
  cabin.scale.set(0.42, 0.2, 0.38)
  cabin.position.set(-0.05, 0.42, 0)
  const head = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff7d6', emissiveIntensity: 2 })
  const tail = new THREE.MeshStandardMaterial({ color: '#ff3b3b', emissive: '#ff1f1f', emissiveIntensity: 1.5 })
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(box, head)
    h.scale.set(0.04, 0.07, 0.1)
    h.position.set(0.42, 0.22, s * 0.14)
    const t = new THREE.Mesh(box, tail)
    t.scale.set(0.04, 0.07, 0.1)
    t.position.set(-0.42, 0.22, s * 0.14)
    g.add(h, t)
  }
  body.castShadow = cabin.castShadow = true
  g.add(body, cabin)
  return g
}

// ---------------------------------------------------------------------------
// smooth roads: the axis-aligned route becomes a dense list of samples with rounded corners
// and eased ramps; every road part (surface, paint, rails, lanes) is built from the same samples,
// so nothing gaps or overlaps at corners and slopes.

interface Sample {
  p: THREE.Vector3
  /** right-hand normal on the ground plane */
  n: THREE.Vector3
  /** distance travelled along the road */
  s: number
}

const ease = (t: number) => t * t * (3 - 2 * t)

function smoothRoad(route: THREE.Vector3[], radius: number, step = 0.18): Sample[] {
  const flat = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Vector3(b.x - a.x, 0, b.z - a.z)
  // elevation comes from every vertex of the route (ramps sit on straight legs) …
  const rd = [0]
  for (let i = 1; i < route.length; i++) rd.push(rd[i - 1] + flat(route[i - 1], route[i]).length())
  const yAt = (dist: number) => {
    let i = 0
    while (i < route.length - 2 && dist > rd[i + 1]) i++
    const L = rd[i + 1] - rd[i]
    const t = L > 0 ? Math.min(Math.max((dist - rd[i]) / L, 0), 1) : 0
    return route[i].y + (route[i + 1].y - route[i].y) * ease(t)
  }
  // … while the plan only keeps the real corners, so a corner's radius is limited by whole legs,
  // not by the short pieces a ramp splits a leg into
  const path = route.filter((p, i) => {
    if (i === 0 || i === route.length - 1) return true
    const u = flat(route[i - 1], p).normalize(), v = flat(p, route[i + 1]).normalize()
    return u.dot(v) < 0.999
  })
  const d = [0]
  for (let i = 1; i < path.length; i++) d.push(d[i - 1] + flat(path[i - 1], path[i]).length())
  const dir = (i: number) => flat(path[i], path[i + 1]).normalize()
  const r = path.map((_, i) => {
    if (i === 0 || i === path.length - 1) return 0
    if (dir(i - 1).dot(dir(i)) > 0.999) return 0
    return Math.min(radius, 0.45 * (d[i] - d[i - 1]), 0.45 * (d[i + 1] - d[i])) // = tangent length at 90°
  })
  const pts: { x: number; z: number; dist: number }[] = []
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], u = dir(i), L = d[i + 1] - d[i]
    const s0 = r[i], s1 = L - r[i + 1]
    const n = Math.max(1, Math.ceil((s1 - s0) / step))
    for (let k = 0; k <= n; k++) {
      if (k === 0 && pts.length) continue
      const s = s0 + ((s1 - s0) * k) / n
      pts.push({ x: a.x + u.x * s, z: a.z + u.z * s, dist: d[i] + s })
    }
    if (r[i + 1] > 0) {
      // rounded corner: a true circular arc, so every line offset from the centre (edges, lanes,
      // centre line) is a concentric arc and the inside and outside of the bend have the same shape
      const V = path[i + 1], v = dir(i + 1), rr = r[i + 1]
      const theta = Math.acos(Math.min(Math.max(u.dot(v), -1), 1))
      const T = rr * Math.tan(theta / 2) // tangent length from the corner to where the arc starts
      const inward = v.clone().addScaledVector(u, -v.dot(u)).normalize()
      const P0 = new THREE.Vector3(V.x - u.x * T, 0, V.z - u.z * T)
      const C = P0.clone().addScaledVector(inward, rr)
      const m = Math.max(8, Math.ceil((rr * theta) / step))
      for (let k = 1; k <= m; k++) {
        const phi = (theta * k) / m
        const x = C.x - inward.x * rr * Math.cos(phi) + u.x * rr * Math.sin(phi)
        const z = C.z - inward.z * rr * Math.cos(phi) + u.z * rr * Math.sin(phi)
        pts.push({ x, z, dist: d[i + 1] - T + (2 * T * k) / m })
      }
    }
  }
  let travelled = 0
  return pts.map((q, i) => {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)]
    const t = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z).normalize()
    const p = new THREE.Vector3(q.x, yAt(q.dist), q.z)
    if (i) travelled += Math.hypot(q.x - pts[i - 1].x, q.z - pts[i - 1].z)
    return { p, n: new THREE.Vector3(-t.z, 0, t.x), s: travelled }
  })
}

/**
 * A band following the samples, offset sideways by `off`, `w` wide, raised by `lift`.
 * `depth(i)` turns it into a slab with sides and a bottom; `keep(i)` drops pieces (dashes, rails).
 */
function band(parent: THREE.Object3D, S: Sample[], off: number, w: number, lift: number, material: THREE.Material,
  o: { depth?: (i: number) => number; keep?: (i: number) => boolean } = {}) {
  const pos: number[] = []
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z)
  const corners = (i: number) => {
    const { p, n } = S[i]
    const y = p.y + lift, dd = o.depth?.(i) ?? 0
    const l = p.clone().addScaledVector(n, off - w / 2).setY(y), r = p.clone().addScaledVector(n, off + w / 2).setY(y)
    return { l, r, lb: l.clone().setY(y - dd), rb: r.clone().setY(y - dd) }
  }
  for (let i = 0; i < S.length - 1; i++) {
    if (o.keep && !o.keep(i)) continue
    const A = corners(i), B = corners(i + 1)
    quad(A.l, B.l, B.r, A.r)
    if (o.depth) {
      quad(A.lb, B.lb, B.l, A.l)
      quad(A.r, B.r, B.rb, A.rb)
      quad(A.lb, A.rb, B.rb, B.lb)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  const m = new THREE.Mesh(g, material)
  m.receiveShadow = true
  parent.add(m)
  return m
}

/**
 * A road along an axis-aligned route.
 * one-way: single lane, chevrons and cars all heading from path start to end.
 * two-way: two lanes with a dashed centre line (yellow unless `line` is given), cars both ways.
 */
export function highway(path: THREE.Vector3[], kind: 'oneway' | 'twoway', traffic: number, accent: string, ground = 0.01, line?: string): Highway {
  const group = new THREE.Group()
  const width = kind === 'oneway' ? 1.6 : 2.7
  // inner edge of every bend keeps a radius of about 1: wider roads swing wider
  const S = smoothRoad(path, width / 2 + 1)
  const raised = (i: number) => S[i].p.y > ground + 0.25 && S[i + 1].p.y > ground + 0.25
  const DS = THREE.DoubleSide

  // surface: a slab that gets thicker (a bridge deck) as it rises
  const asphalt = [band(group, S, 0, width, 0.03, mat('#1b1f2e', { roughness: 0.95, side: DS }), {
    depth: (i) => Math.min(Math.max(S[i].p.y - ground + 0.03, 0.04), 0.32),
  })]

  const paintColor = new THREE.Color(accent)
  const paint: THREE.MeshStandardMaterial[] = []
  const edgeMat = mat(accent, { emissive: accent, emissiveIntensity: 0.25, side: DS })
  paint.push(edgeMat)
  for (const side of [-1, 1]) band(group, S, side * (width / 2 - 0.12), 0.07, 0.036, edgeMat)

  const cars: Car[] = []
  const lane = (off: number) => S.map(({ p, n }) => p.clone().addScaledVector(n, off).setY(p.y + 0.03))
  if (kind === 'twoway') {
    const centre = line ? mat(line, { emissive: line, emissiveIntensity: 0.4, side: DS }) : mat('#facc15', { emissive: '#a16207', emissiveIntensity: 0.5, side: DS })
    paint.push(centre)
    band(group, S, 0, 0.08, 0.036, centre, { keep: (i) => S[i].s % 1.0 < 0.55 })
    const lanes = [lane(0.62), lane(-0.62).reverse()]
    const n = Math.min(Math.max(traffic, 1) * 2, 10)
    for (let i = 0; i < n; i++) cars.push(spawn(group, lanes[i % 2], i, n))
  } else {
    // chevrons pointing the one allowed direction, only where the road is level
    const chev = mat('#e2e8f0', { emissive: accent, emissiveIntensity: 0.35, side: DS })
    paint.push(chev)
    const shape = new THREE.Shape([new THREE.Vector2(-0.25, -0.35), new THREE.Vector2(0.15, 0), new THREE.Vector2(-0.25, 0.35), new THREE.Vector2(-0.05, 0)])
    const geo = new THREE.ShapeGeometry(shape)
    geo.rotateX(-Math.PI / 2)
    let next = 1.6
    for (let i = 1; i < S.length - 1; i++) {
      if (S[i].s < next) continue
      const level = Math.abs(S[i + 1].p.y - S[i - 1].p.y) < 0.01
      const straight = S[i - 1].n.dot(S[i + 1].n) > 0.999
      if (!level || !straight) continue
      const m = new THREE.Mesh(geo, chev)
      m.position.copy(S[i].p).setY(S[i].p.y + 0.038)
      m.rotation.y = Math.atan2(S[i].n.x, S[i].n.z) // shape points +x; this turns +x onto the travel direction
      group.add(m)
      next = S[i].s + 2.6
    }
    const n = Math.min(Math.max(traffic, 3), 6)
    for (let i = 0; i < n; i++) cars.push(spawn(group, lane(0), i, n))
  }

  // overpass furniture: guard rails and their posts (the deck needs no pillars)
  const railMat = mat('#a3adc2', { metalness: 0.5, roughness: 0.35, side: DS })
  for (const side of [-1, 1]) band(group, S, side * (width / 2 + 0.06), 0.07, 0.3, railMat, { depth: () => 0.07, keep: raised })
  let nextPost = 0
  for (let i = 0; i < S.length - 1; i++) {
    const { p, n, s } = S[i]
    if (!raised(i) || s < nextPost) continue
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(box, railMat)
      post.scale.set(0.05, 0.26, 0.05)
      post.position.copy(p).addScaledVector(n, side * (width / 2 + 0.06)).setY(p.y + 0.16)
      group.add(post)
    }
    nextPost = s + 0.9
  }

  // label over the middle of the longest straight leg of the route
  let best = 0, labelPos = path[0].clone()
  for (let i = 0; i < path.length - 1; i++) {
    const len = path[i].distanceTo(path[i + 1])
    if (len > best) { best = len; labelPos = path[i].clone().add(path[i + 1]).multiplyScalar(0.5) }
  }
  labelPos.y = Math.max(labelPos.y, ground) + 0.4
  return { group, asphalt, paint, paintColor, cars, labelPos }
}

function spawn(group: THREE.Group, lane: THREE.Vector3[], i: number, n: number): Car {
  const curve = curveOf(lane)
  const c = car(CAR_COLORS[(i * 3 + lane.length) % CAR_COLORS.length])
  c.rotation.order = 'YZX' // yaw, then pitch on ramps
  group.add(c)
  const len = curve.getLength()
  return { obj: c, curve, t: (i / n + Math.random() * 0.05) % 1, speed: 0.07 / len }
}

/** Move a car along its lane and point it forward. */
export function driveCar(c: Car, boost: number) {
  c.t = (c.t + c.speed * boost) % 1
  const p = c.curve.getPointAt(c.t)
  const d = c.curve.getTangentAt(c.t)
  c.obj.position.copy(p)
  c.obj.rotation.y = Math.atan2(-d.z, d.x)
  c.obj.rotation.z = Math.atan2(d.y, Math.hypot(d.x, d.z))
}

// ---------------------------------------------------------------------------
// overpasses

const BRIDGE_H = 0.9
const RAMP = 2.4
/** straight, level road kept between a ramp and a corner, so the road lands before it turns */
/** level road kept between a ramp and a corner (≥ that road's corner radius, half width + 1) */
const cornerClear = (half: number) => half + 1.05

/** what a stretch of a road is: inside a city, the ramp off it, a gate's stub to its lane, or travel along a lane */
export type SegKind = 'city' | 'ramp' | 'stub' | 'v' | 'h'
/** who climbs over whom where two roads cross: gate stubs first, then north–south lanes, then east–west */
const LIFT_PRIORITY: Record<SegKind, number> = { stub: 3, v: 2, h: 1, ramp: 0, city: 0 }

/**
 * Where two roads cross at ground level, one of them climbs a ramp, crosses on a bridge and comes
 * back down: the one with the higher priority (ties: the north–south one). Crossings close together
 * share one bridge, and ramps stay clear of corners so a road is level again before it turns.
 */
export function withOverpasses(roads: { path: THREE.Vector3[]; kinds: SegKind[]; half: number }[], ground: number): THREE.Vector3[][] {
  const onGround = (p: THREE.Vector3) => Math.abs(p.y - ground) < 0.02
  const turns = (p: THREE.Vector3[], i: number) => {
    if (i <= 0 || i >= p.length - 1) return false
    const u = new THREE.Vector3(p[i].x - p[i - 1].x, 0, p[i].z - p[i - 1].z).normalize()
    const v = new THREE.Vector3(p[i + 1].x - p[i].x, 0, p[i + 1].z - p[i].z).normalize()
    return u.dot(v) < 0.999
  }
  type Seg = { road: number; k: number; a: THREE.Vector3; b: THREE.Vector3; ns: boolean; pri: number }
  const segs: Seg[] = []
  roads.forEach((r, i) => {
    for (let k = 0; k < r.path.length - 1; k++) {
      const a = r.path[k], b = r.path[k + 1]
      if (!onGround(a) || !onGround(b)) continue
      const ns = Math.abs(a.x - b.x) < 0.01 && Math.abs(a.z - b.z) > 0.01
      const ew = Math.abs(a.z - b.z) < 0.01 && Math.abs(a.x - b.x) > 0.01
      if (ns || ew) segs.push({ road: i, k, a, b, ns, pri: LIFT_PRIORITY[r.kinds[k]] ?? 0 })
    }
  })
  // crossings: which segment lifts, and where along it
  const lifts = new Map<string, { s: number; half: number }[]>()
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s1 = segs[i], s2 = segs[j]
    if (s1.road === s2.road || s1.ns === s2.ns) continue
    const ns = s1.ns ? s1 : s2, ew = s1.ns ? s2 : s1
    const inX = ns.a.x > Math.min(ew.a.x, ew.b.x) + 0.01 && ns.a.x < Math.max(ew.a.x, ew.b.x) - 0.01
    const inZ = ew.a.z > Math.min(ns.a.z, ns.b.z) + 0.01 && ew.a.z < Math.max(ns.a.z, ns.b.z) - 0.01
    if (!inX || !inZ) continue
    const up = ew.pri > ns.pri ? ew : ns
    const under = up === ns ? ew : ns
    const along = up.ns ? Math.abs(ew.a.z - up.a.z) : Math.abs(ns.a.x - up.a.x)
    const key = `${up.road}:${up.k}`
    lifts.set(key, [...(lifts.get(key) ?? []), { s: along, half: roads[under.road].half }])
  }
  return roads.map((r, i) => {
    const out = [r.path[0].clone()]
    for (let k = 0; k < r.path.length - 1; k++) {
      const a = r.path[k], b = r.path[k + 1]
      const hits = lifts.get(`${i}:${k}`)
      if (!hits) { out.push(b.clone()); continue }
      const startClear = turns(r.path, k) ? cornerClear(r.half) : 0.05
      const endClear = turns(r.path, k + 1) ? cornerClear(r.half) : 0.05
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize()
      const tops = hits.map((h) => [h.s - h.half - 0.35, h.s + h.half + 0.35]).sort((p, q) => p[0] - q[0])
      const merged: number[][] = []
      for (const t of tops) {
        const last = merged[merged.length - 1]
        if (last && t[0] - last[1] < RAMP * 2) last[1] = Math.max(last[1], t[1])
        else merged.push([...t])
      }
      const at = (s: number, y: number) => a.clone().addScaledVector(dir, s).setY(y)
      for (const [t0, t1] of merged) {
        const r0 = Math.max(startClear, t0 - RAMP), r1 = Math.min(len - endClear, t1 + RAMP)
        out.push(at(r0, ground), at(Math.max(t0, r0 + 0.3), ground + BRIDGE_H), at(Math.min(t1, r1 - 0.3), ground + BRIDGE_H), at(r1, ground))
      }
      out.push(b.clone())
    }
    return out
  })
}

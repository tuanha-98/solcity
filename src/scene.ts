import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Contract, Fn, Model, NamedItem, Span, StateVar, Stmt, StmtKind } from './model'
import { driveCar, highway, streets, withOverpasses, type Highway } from './city'
import { castle, glassStorey, glassTower, goldDome, mast, observationDeck, plantRoom, roofGarden, storey, temple, trafficCone, warehouse, type Frame, type Make, type Roof } from './architecture'

// ---------------------------------------------------------------------------
// Visual vocabulary

export const STMT_COLORS: Record<StmtKind, string> = {
  decl: '#2dd4bf',
  assign: '#a3e635',
  write: '#fb923c',
  call: '#60a5fa',
  guard: '#f87171',
  if: '#e879f9',
  loop: '#818cf8',
  return: '#4ade80',
  emit: '#f9a8d4',
  revert: '#dc2626',
  assembly: '#94a3b8',
  block: '#64748b',
  try: '#fbbf24',
  placeholder: '#ffffff',
  extcall: '#eab308',
  other: '#9ca3af',
}

export const STMT_LABEL: Record<StmtKind, string> = {
  decl: 'local variable', assign: 'assignment (local)', write: 'writes storage', call: 'call', guard: 'require / assert',
  if: 'if', loop: 'loop', return: 'return', emit: 'emit event', revert: 'revert', assembly: 'inline assembly',
  block: 'unchecked block', try: 'try / catch', placeholder: 'modifier body  _;', extcall: 'calls another contract', other: 'statement',
}

const VAR_COLORS = { value: '#38bdf8', mapping: '#f59e0b', array: '#34d399', struct: '#a78bfa', bytes: '#f472b6' }
const PLINTH_COLORS: Record<string, string> = {
  external: '#8b5cf6', public: '#3b82f6', internal: '#64748b', private: '#475569',
  modifier: '#e11d48', constructor: '#eab308', receive: '#14b8a6', fallback: '#14b8a6',
}
const LINK_COLORS = { read: '#22d3ee', write: '#fb923c', call: '#c084fc', emit: '#f9a8d4', modifier: '#fb7185', ext: '#facc15', revert: '#ef4444' }
const ROAD_ACCENT = { oneway: '#a78bfa', twoway: '#e2e8f0' }

// geometry constants (world units)
const CW = 2.2 // storage cell width
const CD = 2.2 // storage cell depth
const GAP = 0.25
const PLATE_Y = 0.2
const PLINTH_H = 0.3
const FOUND_H = 0.1 // foundation slab of storage / temple / mast / cone lots
const LOT = 2.85 // a tower's foundation: the full width of its lot
const MAX_LOT_CELLS = 3 // widest a storage lot is drawn, however many slots its variable spans
const FLOOR_H = 0.42
const TOWER_W = 2.1
const TOWER_PITCH_X = 3.9
const TOWER_PITCH_Z = 4.6

// ---------------------------------------------------------------------------

export type RefType = 'contract' | 'fn' | 'stmt' | 'var' | 'event' | 'error' | 'road'
export interface Ref {
  type: RefType
  key: string
  span: Span
  title: string
  detail: string
}

export interface Selection {
  contract?: Contract
  fn?: Fn
  stmt?: Stmt
  v?: StateVar
  ev?: NamedItem
  err?: NamedItem
  /** the editor line the cursor is on */
  line?: number
}

interface Particle {
  mesh: THREE.Mesh
  curve: THREE.Curve<THREE.Vector3>
  t: number
  speed: number
}

const unitBox = new THREE.BoxGeometry(1, 1, 1)
unitBox.userData.shared = true
const unitEdges = new THREE.EdgesGeometry(unitBox)
unitEdges.userData.shared = true

interface Rel {
  key: string
  from: string
  to: string
  kind: 'oneway' | 'twoway'
  count: number
  span: Span
  title: string
  detail: string
}

interface City {
  row: number
  col: number
  x1: number
  x2: number
  /** z of the city's front edge */
  edge: number
  frontStreet: number
  /** world x of the vertical streets: where highways may enter */
  cols: number[]
  contract: Contract
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer
  private labels: CSS2DRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private root = new THREE.Group()
  private links = new THREE.Group()
  private sun: THREE.DirectionalLight
  private ground: THREE.Mesh
  private grid: THREE.GridHelper
  private tooltip: HTMLDivElement

  private model?: Model
  private byName = new Map<string, Contract>()
  private fnOwner = new Map<string, string>() // fn id → contract name
  private pickables: THREE.Mesh[] = []
  private labelObjs: CSS2DObject[] = []
  /** fn id → statement index → its first storey; fn id → source line → storey */
  private stmtFloors = new Map<string, Map<number, THREE.Mesh>>()
  private lineFloors = new Map<string, Map<number, THREE.Mesh>>()
  /** glass frames, dimmed with their building */
  private frames: { obj: THREE.LineSegments; owners: string[] }[] = []
  private outline?: THREE.LineSegments
  private anchors = new Map<string, THREE.Vector3>() // var / event / fn-top anchors (world)
  private focusTargets = new Map<string, THREE.Vector3>()
  private particles: Particle[] = []
  private spinners: THREE.Object3D[] = []
  /** broadcast rings around event masts, and their blinking lights */
  private pulses: { mesh: THREE.Mesh; phase: number; owner: string }[] = []
  private beacons: THREE.Mesh[] = []
  private dimmed = (_owner: string) => false
  private roads = new Map<string, Highway & { label: HTMLElement; boost: number }>()
  /** final route of each road (debugging / inspection) */
  private roadPaths = new Map<string, THREE.Vector3[]>()
  private hovered?: THREE.Mesh
  private codeLabel?: CSS2DObject
  private built = false
  private tick = 0

  private tween?: { target: THREE.Vector3; pos: THREE.Vector3 }
  followCamera = true
  showAllLinks = false
  private selection: Selection = {}

  constructor(
    private container: HTMLElement,
    private handlers: { onPick: (r: Ref) => void; onHover: (r: Ref | null) => void },
  ) {
    const w = container.clientWidth, h = container.clientHeight
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.append(this.renderer.domElement)

    this.labels = new CSS2DRenderer()
    this.labels.setSize(w, h)
    // z-index 1 makes the label layer its own stacking context: the per-label depth z-indexes that
    // CSS2DRenderer sets stay inside it, so overlays (legend, tooltip) can sit above all labels
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1', overflow: 'hidden' })
    this.labels.domElement.className = 'labels'
    container.append(this.labels.domElement)

    this.tooltip = document.createElement('div')
    this.tooltip.className = 'tooltip'
    this.tooltip.hidden = true
    container.append(this.tooltip)

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000)
    this.camera.position.set(-14, 22, 34)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI * 0.49
    this.controls.addEventListener('start', () => (this.tween = undefined))

    const bg = new THREE.Color('#0a0c13')
    this.scene.background = bg
    this.scene.fog = new THREE.Fog(bg, 90, 220)
    this.scene.add(new THREE.HemisphereLight('#c7d2fe', '#1a1d2b', 1.1))
    this.sun = new THREE.DirectionalLight('#ffffff', 1.9)
    this.sun.position.set(25, 45, 30)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0005
    this.scene.add(this.sun, this.sun.target)

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#0d1019', roughness: 1 }))
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.grid = new THREE.GridHelper(1, 1, '#1b2030', '#141824')
    this.scene.add(this.ground, this.grid, this.root, this.links)

    new ResizeObserver(() => this.resize()).observe(container)
    this.bindPointer()
    this.renderer.setAnimationLoop(() => this.frame())
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight
    if (!w || !h) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.labels.setSize(w, h)
  }

  private clock = new THREE.Clock()

  private frame() {
    // animation is time-based (60 fps = 1 step), so a slow or throttled page still moves at the same speed
    const step = Math.min(this.clock.getDelta() * 60, 30)
    if (this.tween) {
      const a = 1 - Math.pow(1 - 0.09, step)
      this.controls.target.lerp(this.tween.target, a)
      this.camera.position.lerp(this.tween.pos, a)
      if (this.camera.position.distanceTo(this.tween.pos) < 0.05) this.tween = undefined
    }
    this.controls.update()
    // fog follows the zoom so distant cities fade, but whatever you are looking at never does
    const fog = this.scene.fog as THREE.Fog
    const d = this.camera.position.distanceTo(this.controls.target)
    fog.near = d * 1.2
    fog.far = d * 3 + 60
    for (const p of this.particles) {
      p.t = (p.t + p.speed * step) % 1
      p.mesh.position.copy(p.curve.getPointAt(p.t))
    }
    for (const s of this.spinners) s.rotation.y += 0.012 * step
    for (const p of this.pulses) {
      p.phase = (p.phase + 0.006 * step) % 1
      p.mesh.scale.setScalar(0.25 + p.phase * 1.6)
      ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - p.phase) * 0.7 * (this.dimmed(p.owner) ? 0.12 : 1)
    }
    const blink = (Math.sin(performance.now() / 260) + 1) / 2
    for (const b of this.beacons) (b.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + blink * 2
    if (++this.tick % 6 === 0) this.cullLabels()
    for (const r of this.roads.values()) for (const c of r.cars) driveCar(c, r.boost * step)
    this.renderer.render(this.scene, this.camera)
    this.labels.render(this.scene, this.camera)
  }

  /** Small labels disappear when far away; city names and road signs always stay. */
  private cullLabels() {
    const cam = this.camera.position
    const p = new THREE.Vector3()
    for (const l of this.labelObjs) {
      const cls = l.element.classList
      if (cls.contains('contract') || cls.contains('road')) continue
      l.getWorldPosition(p)
      const far = p.distanceTo(cam) > (cls.contains('fn') ? 60 : 42)
      cls.toggle('far', far)
    }
  }

  // -------------------------------------------------------------------------
  // building

  build(model: Model) {
    this.clear()
    this.model = model
    for (const c of model.contracts) {
      this.byName.set(c.name, c)
      for (const f of c.fns) this.fnOwner.set(f.id, c.name)
    }
    this.layoutCities(model)
    this.fitEnvironment()
    if (!this.built) this.frameAll(false)
    this.built = true
    this.focus(this.selection)
  }

  private clear() {
    for (const l of this.labelObjs) l.element.remove()
    this.labelObjs = []
    this.codeLabel?.element.remove()
    this.codeLabel = undefined
    const dispose = (o: THREE.Object3D) => {
      o.traverse((n) => {
        const m = n as THREE.Mesh
        if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose()
        const mat = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose()
      })
    }
    dispose(this.root)
    dispose(this.links)
    this.root.clear()
    this.links.clear()
    this.pickables = []
    this.stmtFloors.clear()
    this.lineFloors.clear()
    this.frames = []
    this.outline = undefined
    this.anchors.clear()
    this.focusTargets.clear()
    this.particles = []
    this.spinners = []
    this.pulses = []
    this.beacons = []
    this.roads.clear()
    this.roadPaths.clear()
    this.byName.clear()
    this.fnOwner.clear()
    this.hovered = undefined
  }

  /** One contract = one city. `left` is where the city's ground starts on the x axis. */
  private buildContract(c: Contract, left: number): { group: THREE.Group; width: number; back: number; edge: number; frontStreet: number; cols: number[] } {
    const ox = left + 1.4 // local x = -1.4 is the city's left edge
    const g = new THREE.Group()
    g.position.set(ox, 0, 0)
    this.root.add(g)

    // ---- storage row (z = 0) ----
    // Lots in slot order: one slot (packed variables share it) or one variable that spans several
    // slots. A variable spanning many slots (e.g. Observation[65535]) is drawn at most MAX_LOT_CELLS
    // cells wide and labelled with its slot range, so the row grows with variables, not with slots.
    const stored = c.vars.filter((v) => !v.constant && !v.immutable).sort((a, b) => a.slot - b.slot || a.offset - b.offset)
    const lots: { start: number; end: number; vars: StateVar[]; cells: number }[] = []
    for (const v of stored) {
      const span = v.shape === 'value' ? 1 : Math.max(v.slots, 1)
      const last = lots[lots.length - 1]
      if (v.shape === 'value' && last && last.start === v.slot && last.end === v.slot && last.vars[0].shape === 'value') {
        last.vars.push(v)
        continue
      }
      lots.push({ start: v.slot, end: v.slot + span - 1, vars: [v], cells: Math.min(span, MAX_LOT_CELLS) })
    }
    let maxX = 0
    let lx = 0
    for (const lot of lots) {
      const lw = lot.cells * CW + (lot.cells - 1) * GAP
      const owners = lot.vars.map((v) => v.id)
      this.foundation(g, this.maker(this.varRef(lot.vars[0]), owners), owners, lx + lw / 2, 0, lw, CD, '#252a3a')
      const pre = c.slotsUnknownBase ? '+' : ''
      const slotText = lot.start === lot.end ? `${pre}slot ${lot.start}` : `${pre}slots ${lot.start}–${lot.end}`
      this.label(g, slotText, 'lbl slot', new THREE.Vector3(lx + lw / 2, PLATE_Y, CD / 2 + 0.3))
      for (const v of lot.vars) {
        const x0 = lx + (v.shape === 'value' ? (v.offset / 32) * CW : 0)
        const w = v.shape === 'value' ? Math.max((v.bytes / 32) * CW, 0.22) : lw
        const obj = this.varObject(v, w, false)
        obj.position.set(x0 + w / 2, PLATE_Y + FOUND_H, 0)
        g.add(obj)
        maxX = Math.max(maxX, x0 + w)
        const top = this.topOf(obj)
        this.label(g, v.name, 'lbl var', new THREE.Vector3(x0 + w / 2, top + 0.25, 0), v.id)
        this.anchors.set(v.id, new THREE.Vector3(ox + x0 + w / 2, top, 0))
        this.focusTargets.set(v.id, new THREE.Vector3(ox + x0 + w / 2, top, 0))
      }
      lx += lw + GAP
    }
    // constants / immutables live in bytecode, not storage: glass blocks after the row
    let cx = stored.length ? maxX + 1.2 : 0
    for (const v of c.vars.filter((v) => v.constant || v.immutable)) {
      const w = CW * 0.75
      this.foundation(g, this.maker(this.varRef(v), [v.id]), [v.id], cx + w / 2, 0, w + 0.3, CD, '#3a3530')
      const obj = this.varObject(v, w, true)
      obj.position.set(cx + w / 2, PLATE_Y + FOUND_H, 0)
      g.add(obj)
      const top = this.topOf(obj)
      this.label(g, `${v.name}`, 'lbl var ghost', new THREE.Vector3(cx + w / 2, top + 0.25, 0), v.id)
      this.label(g, v.constant ? 'constant' : 'immutable', 'lbl slot', new THREE.Vector3(cx + w / 2, PLATE_Y, CD / 2 + 0.3))
      this.anchors.set(v.id, new THREE.Vector3(ox + cx + w / 2, top, 0))
      this.focusTargets.set(v.id, new THREE.Vector3(ox + cx + w / 2, top, 0))
      cx += w + 0.6
      maxX = Math.max(maxX, cx)
    }

    // ---- function towers ----
    const fns = c.fns
    const perRow = Math.max(3, Math.min(7, Math.ceil(Math.sqrt(fns.length) * 1.5)))
    const z0 = CD / 2 + 4.0
    let maxZ = CD / 2
    fns.forEach((f, i) => {
      const x = (i % perRow) * TOWER_PITCH_X + 1.1
      const z = z0 + Math.floor(i / perRow) * TOWER_PITCH_Z
      const top = this.tower(g, ox, f, x, z)
      maxX = Math.max(maxX, x + 1.4)
      maxZ = Math.max(maxZ, z + 1.4)
      this.anchors.set(f.id, new THREE.Vector3(ox + x, top, z))
      this.focusTargets.set(f.id, new THREE.Vector3(ox + x, Math.max(top * 0.6, 1.5), z))
    })

    // ---- street grid: an avenue behind the buildings, one street per row gap, and vertical streets ----
    const rowsN = Math.max(1, Math.ceil(fns.length / perRow))
    const colsN = Math.max(1, Math.min(perRow, fns.length))
    const rowStreets = [CD / 2 + 1.85]
    for (let r = 0; r < rowsN; r++) rowStreets.push(z0 + r * TOWER_PITCH_Z + TOWER_PITCH_Z / 2)
    const colStreets: number[] = []
    for (let k = -1; k < colsN; k++) colStreets.push(1.1 + (k + 0.5) * TOWER_PITCH_X)
    const frontStreet = rowStreets[rowStreets.length - 1]
    maxX = Math.max(maxX, colStreets[colStreets.length - 1] + 0.6)
    maxZ = Math.max(maxZ, frontStreet + 0.6)

    // ---- events (floating octahedrons) and custom errors ----
    const ex = maxX + 1.8
    let ez = 0
    for (const e of c.events) {
      const ref: Ref = { type: 'event', key: e.id, span: e.span, title: `event ${e.name}`, detail: e.detail }
      const b = mast(this.maker(ref, [e.id]), '#f9a8d4')
      this.foundation(g, this.maker(ref, [e.id]), [e.id], ex, ez, 1.6, 1.6, '#2b2236')
      b.group.position.set(ex, PLATE_Y + FOUND_H, ez)
      g.add(b.group)
      this.beacons.push(b.light)
      for (let k = 0; k < 2; k++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 6, 48), new THREE.MeshBasicMaterial({ color: '#f9a8d4', transparent: true, depthWrite: false }))
        ring.rotation.x = Math.PI / 2
        ring.position.set(ex, PLATE_Y + b.top - 0.15, ez)
        g.add(ring)
        this.pulses.push({ mesh: ring, phase: k / 2, owner: e.id })
      }
      this.label(g, e.name, 'lbl event', new THREE.Vector3(ex, PLATE_Y + b.top + 0.35, ez), e.id)
      this.anchors.set(e.id, new THREE.Vector3(ox + ex, PLATE_Y + b.top, ez))
      this.focusTargets.set(e.id, new THREE.Vector3(ox + ex, PLATE_Y + b.top * 0.6, ez))
      ez += 2.4
    }
    for (const e of c.errors) {
      const ref: Ref = { type: 'error', key: e.id, span: e.span, title: `error ${e.name}`, detail: e.detail }
      const b = trafficCone(this.maker(ref, [e.id]))
      this.foundation(g, this.maker(ref, [e.id]), [e.id], ex, ez, 1.5, 1.5, '#331c22')
      b.group.position.set(ex, PLATE_Y + FOUND_H, ez)
      g.add(b.group)
      this.label(g, e.name, 'lbl error', new THREE.Vector3(ex, PLATE_Y + b.top + 0.3, ez), e.id)
      this.anchors.set(e.id, new THREE.Vector3(ox + ex, PLATE_Y + b.top, ez))
      this.focusTargets.set(e.id, new THREE.Vector3(ox + ex, PLATE_Y + b.top * 0.6, ez))
      ez += 2.2
    }
    if (c.events.length || c.errors.length) {
      maxX = ex + 1
      maxZ = Math.max(maxZ, ez)
    }

    // ---- plate ----
    const x1 = -1.4, x2 = Math.max(maxX, 6) + 1.4
    const zA = -CD / 2 - 1.3, zB = maxZ + 1.0
    streets(g, { cols: colStreets, rows: rowStreets, x1, x2, y: PLATE_Y })
    const kindColor = c.kind === 'interface' ? '#141a2b' : c.kind === 'library' ? '#10221c' : c.kind === 'abstract' ? '#1a1630' : '#141827'
    const plate = this.mesh(unitBox, kindColor, { roughness: 0.9 })
    plate.scale.set(x2 - x1, PLATE_Y, zB - zA)
    plate.position.set((x1 + x2) / 2, PLATE_Y / 2, (zA + zB) / 2)
    plate.castShadow = false
    g.add(plate)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(x2 - x1, PLATE_Y, zB - zA)),
      new THREE.LineBasicMaterial({ color: c.kind === 'interface' ? '#5b6cff' : '#2a3150' }),
    )
    edges.position.copy(plate.position)
    g.add(edges)
    this.pick(plate, { type: 'contract', key: c.id, span: c.span, title: `${c.kind} ${c.name}`, detail: c.bases.length ? `is ${c.bases.join(', ')}` : '' }, [c.id])
    const kindTag = c.kind === 'contract' ? '' : `<span class="tag">${c.kind}</span>`
    this.label(g, `${c.name}${kindTag}`, 'lbl contract', new THREE.Vector3(x1 + 0.3, PLATE_Y, zA), c.id, true, [0, 1])
    this.focusTargets.set(c.id, new THREE.Vector3(ox + (x1 + x2) / 2, 0, (zA + zB) / 2))
    return { group: g, width: x2 - x1, back: zA, edge: zB, frontStreet, cols: colStreets.map((cx) => ox + cx) }
  }

  /**
   * Roads between cities. Inheritance = one-way road from the derived city to its base (the derived
   * contract can use the base's code, not the other way round). Calls = two-way road (call out, value back).
   */
  private relations(model: Model): Rel[] {
    const rels: Rel[] = []
    const has = (n: string) => this.byName.has(n)
    const inherits = (a: string, b: string) => !!this.byName.get(a)?.bases.includes(b)
    for (const c of model.contracts) for (const b of c.bases) {
      if (!has(b)) continue
      rels.push({
        key: `inh:${c.name}>${b}`, from: c.name, to: b, kind: 'oneway', count: 3,
        span: { ...c.span, endLine: c.span.startLine },
        title: `${c.name} is ${b}`, detail: `One-way: ${c.name} can use ${b}'s code, ${b} cannot reach ${c.name}`,
      })
    }
    const pairs = new Map<string, Rel & { ab: number; ba: number }>()
    for (const c of model.contracts) for (const o of c.callsOut) {
      if (!has(o.target) || inherits(c.name, o.target) || inherits(o.target, c.name)) continue
      const [a, b] = [c.name, o.target].sort()
      const key = `call:${a}|${b}`
      const cur = pairs.get(key) ?? { key, from: a, to: b, kind: 'twoway' as const, count: 0, span: o.first, title: `${a} ⇄ ${b}`, detail: '', ab: 0, ba: 0 }
      cur.count += o.count
      if (c.name === a) cur.ab += o.count
      else cur.ba += o.count
      if (o.first.startLine < cur.span.startLine) cur.span = o.first
      pairs.set(key, cur)
    }
    for (const p of pairs.values()) {
      p.detail = [p.ab ? `${p.from} → ${p.to}: ${p.ab} call site${p.ab > 1 ? 's' : ''}` : '', p.ba ? `${p.to} → ${p.from}: ${p.ba} call site${p.ba > 1 ? 's' : ''}` : '']
        .filter(Boolean).join(' · ')
      rels.push(p)
    }
    return rels
  }

  /**
   * Cities on a 2D grid with corridors between them, like blocks of a bigger city.
   * Every city's gate faces south, onto the horizontal corridor below its row. A road leaves through
   * that corridor, turns into a vertical corridor if the other city is in another row, and enters the
   * other city from the corridor below it. Each road gets its own lane in every corridor it uses, and
   * corridors are as wide as their lanes need.
   */
  private layoutCities(model: Model) {
    const order = this.cityOrder(model)
    const n = order.length
    if (!n) return
    const aspect = Math.max(this.camera.aspect, 0.35)
    const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * aspect * 1.6))))
    const rows = Math.ceil(n / cols)

    // build every city at the origin first, to know its size
    const built = order.map((c, i) => {
      const row = Math.floor(i / cols)
      const col = row % 2 === 0 ? i % cols : cols - 1 - (i % cols) // snake: neighbours in `order` stay adjacent
      return { c, row, col, b: this.buildContract(c, 0) }
    })
    const cell = new Map(built.map((x) => [x.c.name, x]))

    // pass 1: which corridors each road uses, and its lane in each
    // lane pitch: a road crossing the next lane needs half a road + a ramp + a straight run before
    // its corner, so it is back on the ground before it turns
    const TRACK = 6.5
    const LANE0 = 5.6 // first lane this far below a row: room for a ramp up to the first overpass
    const hLanes = new Array(rows + 1).fill(0), vLanes = new Array(cols + 1).fill(0)
    const rels = this.relations(model)
      .map((r) => {
        const A = cell.get(r.from)!, B = cell.get(r.to)!
        return { r, A, B, dist: Math.abs(A.row - B.row) + Math.abs(A.col - B.col) }
      })
      .sort((a, b) => a.dist - b.dist)
    const routes = rels.map(({ r, A, B }) => {
      const hA = A.row + 1, laneA = hLanes[hA]++
      if (A.row === B.row) return { r, A, B, hA, laneA }
      // vertical corridor that keeps the detour shortest
      const cand = [A.col, A.col + 1, B.col, B.col + 1]
      const v = cand.reduce((best, k) => {
        const cost = (k: number) => Math.abs(k - (A.col + 0.5)) + Math.abs(k - (B.col + 0.5))
        return cost(k) < cost(best) ? k : best
      })
      const laneV = vLanes[v]++
      const hB = B.row + 1, laneB = hLanes[hB]++
      return { r, A, B, hA, laneA, v, laneV, hB, laneB }
    })

    // pass 2: corridor and cell sizes → positions
    const hW = hLanes.map((k, i) => (i === 0 ? 3 : Math.max(8.5, LANE0 + Math.max(k - 1, 0) * TRACK + 3.2)))
    const vW = vLanes.map((k) => Math.max(6, 4.4 + Math.max(k - 1, 0) * TRACK))
    const colW = new Array(cols).fill(0), rowD = new Array(rows).fill(0)
    for (const x of built) {
      colW[x.col] = Math.max(colW[x.col], x.b.width)
      rowD[x.row] = Math.max(rowD[x.row], x.b.edge - x.b.back)
    }
    const vLeft: number[] = [], colLeft: number[] = []
    let xc = 0
    for (let j = 0; j <= cols; j++) {
      vLeft[j] = xc
      xc += vW[j]
      if (j < cols) { colLeft[j] = xc; xc += colW[j] }
    }
    const hTop: number[] = [], rowTop: number[] = []
    let zc = 0
    for (let i = 0; i <= rows; i++) {
      hTop[i] = zc
      zc += hW[i]
      if (i < rows) { rowTop[i] = zc; zc += rowD[i] }
    }

    // move each city into its cell (centred in its column, front edge on the corridor)
    const cities = new Map<string, City>()
    const owner = (id: string) => id.split(':')[1]
    for (const x of built) {
      const dx = colLeft[x.col] + (colW[x.col] - x.b.width) / 2
      const dz = rowTop[x.row] + rowD[x.row] - x.b.edge
      x.b.group.position.x += dx
      x.b.group.position.z += dz
      for (const m of [this.anchors, this.focusTargets]) for (const [id, p] of m) if (owner(id) === x.c.name) { p.x += dx; p.z += dz }
      cities.set(x.c.name, {
        row: x.row, col: x.col, x1: dx, x2: dx + x.b.width, edge: x.b.edge + dz, frontStreet: x.b.frontStreet + dz,
        cols: x.b.cols.map((c) => c + dx), contract: x.c,
      })
    }

    // pass 3: geometry. Gates are slots along the city's front edge, kept well inside its rim
    // (a two-way road is 2.7 wide); each road takes the free slot nearest the side it heads to.
    const free = new Map([...cities].map(([k, C]) => {
      const lo = C.x1 + 2.2, hi = C.x2 - 2.2
      const n = hi > lo ? Math.floor((hi - lo) / 3.4) + 1 : 1
      const slots = n === 1 ? [(C.x1 + C.x2) / 2] : Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1))
      return [k, slots]
    }))
    const gate = (city: string, towardX: number) => {
      const C = cities.get(city)!
      const slots = free.get(city)!
      if (!slots.length) return (C.x1 + C.x2) / 2
      const right = towardX > (C.x1 + C.x2) / 2
      return (right ? slots.pop() : slots.shift())!
    }
    const laneZ = (h: number, lane: number) => hTop[h] + LANE0 + lane * TRACK
    const laneX = (v: number, lane: number) => vLeft[v] + 2.2 + lane * TRACK
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const y0 = 0.01, yc = PLATE_Y
    const plans: { r: Rel; path: THREE.Vector3[]; half: number }[] = []
    for (const rt of routes) {
      const A = cities.get(rt.r.from)!, B = cities.get(rt.r.to)!
      const xv = rt.v !== undefined ? laneX(rt.v, rt.laneV!) : undefined
      const xa = gate(rt.r.from, xv ?? (B.x1 + B.x2) / 2)
      const xb = gate(rt.r.to, xv ?? (A.x1 + A.x2) / 2)
      const za = laneZ(rt.hA, rt.laneA)
      const path = [V(xa, yc, A.frontStreet), V(xa, yc, A.edge), V(xa, y0, A.edge + 1.2), V(xa, y0, za)]
      if (xv === undefined) path.push(V(xb, y0, za))
      else {
        const zb = laneZ(rt.hB!, rt.laneB!)
        path.push(V(xv, y0, za), V(xv, y0, zb), V(xb, y0, zb))
      }
      path.push(V(xb, y0, B.edge + 1.2), V(xb, yc, B.edge), V(xb, yc, B.frontStreet))
      plans.push({ r: rt.r, path: path.filter((p, i) => i === 0 || p.distanceTo(path[i - 1]) > 0.01), half: rt.r.kind === 'oneway' ? 0.8 : 1.35 })
    }
    // where roads cross, the north–south one becomes an overpass
    withOverpasses(plans, y0).forEach((path, i) => {
      this.roadPaths.set(plans[i].r.key, path)
      this.addHighway(plans[i].r, path)
    })
  }

  private addHighway(r: Rel, path: THREE.Vector3[]) {
    const hw = highway(path, r.kind, r.count, ROAD_ACCENT[r.kind])
    this.root.add(hw.group)
    const ref: Ref = { type: 'road', key: r.key, span: r.span, title: r.kind === 'oneway' ? `${r.title}  (inheritance)` : `${r.title}  (calls)`, detail: r.detail }
    for (const m of hw.asphalt) {
      m.userData.baseOpacity = 1
      m.userData.baseEmissive = (m.material as THREE.MeshStandardMaterial).emissive.clone()
      this.pick(m, ref, [r.key])
    }
    const text = r.kind === 'oneway'
      ? `${r.from} <span class="arrow">➜</span> ${r.to}<span class="tag">inherits · one-way</span>`
      : `${r.from} <span class="arrow">⇄</span> ${r.to}<span class="tag">${r.count} call${r.count > 1 ? 's' : ''} · two-way</span>`
    const label = this.label(this.root, text, `lbl road ${r.kind}`, hw.labelPos, undefined, true, [0.5, 1])
    for (const m of hw.paint) m.userData.base = m.emissiveIntensity
    this.roads.set(r.key, { ...hw, label: label.element, boost: 1 })
  }

  /** Put connected cities next to each other: the busiest in the middle, neighbours on the side they connect to most. */
  private cityOrder(model: Model): Contract[] {
    const w = new Map<string, number>()
    const key = (a: string, b: string) => [a, b].sort().join('|')
    const bump = (a: string, b: string, n: number) => { if (a !== b) w.set(key(a, b), (w.get(key(a, b)) ?? 0) + n) }
    for (const c of model.contracts) {
      for (const b of c.bases) bump(c.name, b, 3)
      for (const o of c.callsOut) bump(c.name, o.target, o.count)
    }
    const weight = (a: string, b: string) => w.get(key(a, b)) ?? 0
    const degree = (a: string) => model.contracts.reduce((n, c) => n + weight(a, c.name), 0)
    const rest = [...model.contracts]
    rest.sort((a, b) => degree(b.name) - degree(a.name))
    if (!rest.length || degree(rest[0].name) === 0) return model.contracts
    const line: Contract[] = [rest.shift()!]
    while (rest.length) {
      let best = 0, score = -1
      rest.forEach((c, i) => {
        const sc = line.reduce((n, p) => n + weight(c.name, p.name), 0)
        if (sc > score) { score = sc; best = i }
      })
      const c = rest.splice(best, 1)[0]
      if (score <= 0) { line.push(c); continue }
      // attach to the end it is closer to (in connections)
      const toLeft = line.reduce((n, p, i) => n + weight(c.name, p.name) * (line.length - i), 0)
      const toRight = line.reduce((n, p, i) => n + weight(c.name, p.name) * (i + 1), 0)
      if (toLeft > toRight) line.unshift(c)
      else line.push(c)
    }
    return line
  }

  private roadBetween(a: string, b: string) {
    const [x, y] = [a, b].sort()
    return this.roads.get(`inh:${a}>${b}`) ?? this.roads.get(`inh:${b}>${a}`) ?? this.roads.get(`call:${x}|${y}`)
  }

  /** A storage variable as a warehouse (its data type shapes the building); constants and immutables as temples. */
  private varObject(v: StateVar, w: number, ghost: boolean): THREE.Group {
    const color = VAR_COLORS[v.shape]
    const d = CD * 0.86
    const make = this.maker(this.varRef(v), [v.id])
    if (ghost) return temple(make, w, d, v.constant ? '#e7e5e4' : '#d6b77a')
    return warehouse(make, v.shape, w, d, color)
  }

  /** A function as a high-rise: plinth = visibility, one storey per line of code, rings = modifiers. Returns top y. */
  private tower(parent: THREE.Group, ox: number, f: Fn, x: number, z: number): number {
    const g = new THREE.Group()
    g.position.set(x, PLATE_Y, z)
    parent.add(g)
    const fnRef: Ref = {
      type: 'fn', key: f.id, span: f.span, title: f.kind === 'function' ? `${f.name}()` : f.kind === 'modifier' ? `modifier ${f.name}` : f.name,
      detail: [f.kind === 'modifier' ? '' : f.visibility, f.mutability === 'modifier' ? '' : f.mutability, f.modifiers.length ? `modifiers: ${f.modifiers.join(', ')}` : '']
        .filter(Boolean).join(' · '),
    }
    const plinthColor = PLINTH_COLORS[f.kind === 'function' ? f.visibility : f.kind] ?? '#64748b'
    const plinth = this.mesh(unitBox, plinthColor)
    plinth.scale.set(LOT, PLINTH_H, LOT)
    plinth.position.y = PLINTH_H / 2
    const curb = new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: '#c7d2fe', transparent: true, opacity: 0.35 }))
    curb.scale.copy(plinth.scale)
    curb.position.copy(plinth.position)
    g.add(curb)
    this.framer([f.id])(curb)
    g.add(plinth)
    this.pick(plinth, fnRef, [f.id])

    // one storey per line of code: office floors, stone for a modifier's keep, glass for `_;`
    const readOnly = f.mutability === 'view' || f.mutability === 'pure'
    const byStmt = new Map<number, THREE.Mesh>()
    const byLine = new Map<number, THREE.Mesh>()
    let top = PLINTH_H
    let topSize = TOWER_W
    for (const l of f.lines) {
      const st = f.statements[l.stmt]
      const kind = st?.kind ?? 'other'
      const size = Math.max(TOWER_W - (st?.depth ?? 0) * 0.42, 0.55)
      topSize = size
      const ref: Ref = {
        type: 'stmt', key: `${f.id}#L${l.line}`, title: STMT_LABEL[kind], detail: l.code.trim(),
        span: { startLine: l.line, endLine: l.line, start: l.start, end: l.end },
      }
      const make = this.maker(ref, [f.id])
      const floor = kind === 'placeholder'
        ? glassStorey(make, this.framer([f.id]), size, FLOOR_H)
        : storey(make, size, FLOOR_H, STMT_COLORS[kind], f.kind === 'modifier' ? 'castle' : 'office', readOnly, l.line)
      floor.group.position.y = top
      g.add(floor.group)
      floor.body.userData.floor = true
      byLine.set(l.line, floor.body)
      if (st && !byStmt.has(l.stmt)) byStmt.set(l.stmt, floor.body)
      top += FLOOR_H
    }
    this.stmtFloors.set(f.id, byStmt)
    this.lineFloors.set(f.id, byLine)

    if (!f.hasBody) {
      // declared only (interface / abstract): a glass tower, all facade and nothing inside
      const t = glassTower(this.maker(fnRef, [f.id]), this.framer([f.id]), TOWER_W - 0.2, 4, FLOOR_H)
      t.group.position.y = PLINTH_H
      g.add(t.group)
      top = PLINTH_H + t.top
      topSize = TOWER_W - 0.2
    }
    // the roof says what the function may do with state
    if (f.kind !== 'modifier') {
      const make = this.maker(fnRef, [f.id])
      let roof: Roof | undefined
      if (f.mutability === 'payable') roof = goldDome(make, topSize)
      else if (f.mutability === 'view') roof = observationDeck(make, this.framer([f.id]), topSize)
      else if (f.mutability === 'pure') roof = roofGarden(make, topSize, f.span.startLine)
      else if (f.hasBody) roof = plantRoom(make, topSize)
      if (roof) {
        roof.group.position.y = top
        g.add(roof.group)
        if (roof.light) this.beacons.push(roof.light)
        top += roof.height
      }
    }
    // modifiers: rings around the plinth, one per modifier
    // each modifier is a guard fence around the base, inside the foundation
    const fence = TOWER_W / 2 + 0.22
    f.modifiers.forEach((_, k) => {
      const y = PLINTH_H + 0.07 + k * 0.17
      for (const [sx, sz, w, d] of [[0, fence, 2 * fence, 0.07], [0, -fence, 2 * fence, 0.07], [fence, 0, 0.07, 2 * fence], [-fence, 0, 0.07, 2 * fence]] as const) {
        const bar = this.mesh(unitBox, '#fb7185', { emissive: '#9f1239', emissiveIntensity: 0.5 })
        bar.scale.set(w, 0.11, d)
        bar.position.set(sx, y, sz)
        g.add(bar)
        this.pick(bar, fnRef, [f.id])
      }
    })
    if (f.kind === 'modifier') {
      castle(this.maker(fnRef, [f.id]), g, TOWER_W / 2 + 0.05, PLINTH_H, top)
      top += 1.1
    }
    const tag = f.kind === 'modifier' ? 'modifier' : f.kind !== 'function' ? f.kind : `${f.visibility}${f.mutability !== 'nonpayable' ? ` · ${f.mutability}` : ''}`
    this.label(g, `${f.kind === 'function' ? `${f.name}()` : f.name}<span class="tag">${tag}</span>`, 'lbl fn', new THREE.Vector3(0, top + 0.35, 0), f.id, true)
    return PLATE_Y + top
  }

  // -------------------------------------------------------------------------
  // helpers

  /** A foundation slab filling a building's lot, with a curb outline. */
  private foundation(parent: THREE.Object3D, make: Make, owners: string[], x: number, z: number, w: number, d: number, color: string) {
    const m = make(unitBox, color, { roughness: 0.85 })
    m.scale.set(w, FOUND_H, d)
    m.position.set(x, PLATE_Y + FOUND_H / 2, z)
    parent.add(m)
    const curb = new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: '#5b6485', transparent: true, opacity: 0.8 }))
    curb.scale.copy(m.scale)
    curb.position.copy(m.position)
    parent.add(curb)
    this.framer(owners)(curb)
  }

  private varRef(v: StateVar): Ref {
    return {
      type: 'var', key: v.id, span: v.span, title: `${v.name}`,
      detail: `${v.type}${v.constant ? ' · constant (no slot)' : v.immutable ? ' · immutable (no slot)' : ` · slot ${v.slot}${v.offset ? ` offset ${v.offset}` : ''} · ${v.shape === 'value' ? `${v.bytes} bytes` : `${v.slots} slot${v.slots > 1 ? 's' : ''}`}`}`,
    }
  }

  /** Registers glass frames so they fade with their building. */
  private framer(owners: string[]): Frame {
    return (obj) => {
      obj.userData.baseOpacity = (obj.material as THREE.LineBasicMaterial).opacity
      this.frames.push({ obj, owners })
    }
  }

  /** Factory for building parts that are pickable as `ref` and dim with `owners`. */
  private maker(ref: Ref, owners: string[]): Make {
    return (geo, color, o) => {
      const m = this.mesh(geo, color, o)
      this.pick(m, ref, owners)
      return m
    }
  }

  private mesh(geo: THREE.BufferGeometry, color: string, o: Parameters<Make>[2] = {}) {
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: o.roughness ?? 0.55,
      metalness: o.metalness ?? 0.08,
      transparent: true,
      opacity: o.opacity ?? 1,
      wireframe: !!o.wireframe,
      emissive: o.emissive ?? '#000000',
      emissiveIntensity: o.emissiveIntensity ?? 1,
      map: o.map ?? null,
      emissiveMap: o.emissiveMap ?? null,
    })
    const m = new THREE.Mesh(geo, mat)
    m.castShadow = (o.opacity ?? 1) > 0.5
    m.receiveShadow = true
    m.userData.baseOpacity = mat.opacity
    m.userData.baseEmissive = mat.emissive.clone()
    m.userData.baseEI = mat.emissiveIntensity
    return m
  }

  private pick(m: THREE.Mesh, ref: Ref, owners: string[]) {
    m.userData.ref = ref
    m.userData.owners = owners
    this.pickables.push(m)
  }

  private label(parent: THREE.Object3D, html: string, cls: string, pos: THREE.Vector3, owner?: string, isHtml = false, center: [number, number] = [0.5, 1]) {
    const div = document.createElement('div')
    div.className = cls
    if (isHtml) div.innerHTML = html
    else div.textContent = html
    if (owner) div.dataset.owner = owner
    const o = new CSS2DObject(div)
    o.position.copy(pos)
    o.center.set(center[0], center[1])
    parent.add(o)
    this.labelObjs.push(o)
    return o
  }

  private topOf(o: THREE.Object3D) {
    o.updateMatrixWorld(true)
    return new THREE.Box3().setFromObject(o).max.y
  }

  /** Curved link with a particle flowing from `a` to `b`. */
  private arc(a: THREE.Vector3, b: THREE.Vector3, color: string, radius: number, into: THREE.Group, opacity = 0.9, kind = '') {
    const dist = a.distanceTo(b)
    const mid = a.clone().add(b).multiplyScalar(0.5)
    mid.y = Math.max(a.y, b.y) + dist * 0.28 + 1.2
    const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone())
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 40, radius, 6, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    )
    tube.userData.kind = kind
    into.add(tube)
    const dot = new THREE.Mesh(new THREE.SphereGeometry(radius * 2.6, 10, 10), new THREE.MeshBasicMaterial({ color: '#ffffff' }))
    into.add(dot)
    this.particles.push({ mesh: dot, curve, t: Math.random(), speed: 0.006 + 0.3 / Math.max(dist * 40, 60) })
  }

  private fitEnvironment() {
    const bb = new THREE.Box3().setFromObject(this.root)
    if (bb.isEmpty()) bb.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 1, 10))
    const c = bb.getCenter(new THREE.Vector3())
    const size = bb.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z) + 60
    this.ground.scale.set(span * 2, span * 2, 1)
    this.ground.position.set(c.x, -0.01, c.z)
    this.scene.remove(this.grid)
    this.grid.dispose()
    this.grid = new THREE.GridHelper(span * 2, Math.round(span), '#1b2030', '#121620')
    this.grid.position.set(c.x, 0, c.z)
    this.scene.add(this.grid)
    const half = Math.max(size.x, size.z) / 2 + 10
    const cam = this.sun.shadow.camera
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half; cam.near = 1; cam.far = 200
    cam.updateProjectionMatrix()
    this.sun.position.set(c.x + 25, 45, c.z + 30)
    this.sun.target.position.copy(c)
  }

  /** all: every label · cities: only city names and road signs · off: none */
  setLabelMode(mode: 'all' | 'cities' | 'off') {
    this.labels.domElement.dataset.mode = mode
  }

  frameAll(animate = true) {
    const bb = new THREE.Box3().setFromObject(this.root)
    if (bb.isEmpty()) return
    const c = bb.getCenter(new THREE.Vector3())
    // a steep, map-like view of the grid of cities
    const dir = new THREE.Vector3(-0.25, 0.85, 0.55).normalize()
    // fit by projecting the box corners: grow/shrink the distance until the map fills ~90% of the pane
    const cam = this.camera.clone()
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(
      i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z))
    let dist = bb.getSize(new THREE.Vector3()).length()
    const right = new THREE.Vector3(), up = new THREE.Vector3()
    for (let k = 0; k < 8; k++) {
      cam.position.copy(c).addScaledVector(dir, dist)
      cam.lookAt(c)
      cam.updateMatrixWorld()
      const q = corners.map((p) => p.clone().project(cam))
      const [x0, x1] = [Math.min(...q.map((v) => v.x)), Math.max(...q.map((v) => v.x))]
      const [y0, y1] = [Math.min(...q.map((v) => v.y)), Math.max(...q.map((v) => v.y))]
      // recentre: slide the target so the map's on-screen box is centred, then rescale the distance
      const halfH = dist * Math.tan((cam.fov * Math.PI) / 360)
      right.setFromMatrixColumn(cam.matrixWorld, 0)
      up.setFromMatrixColumn(cam.matrixWorld, 1)
      c.addScaledVector(right, ((x0 + x1) / 2) * halfH * cam.aspect).addScaledVector(up, ((y0 + y1) / 2) * halfH)
      dist *= Math.max((x1 - x0) / 2, (y1 - y0) / 2) / 0.9
    }
    const pos = c.clone().addScaledVector(dir, dist)
    if (animate) this.tween = { target: c, pos }
    else {
      this.controls.target.copy(c)
      this.camera.position.copy(pos)
    }
  }

  /** Half of the narrower field of view: a tall, narrow pane is limited by its width. */
  private halfFov() {
    const v = (this.camera.fov * Math.PI) / 360
    return Math.min(v, Math.atan(Math.tan(v) * this.camera.aspect))
  }

  /** Frame a set of points (e.g. a variable plus every tower that touches it). */
  private flyToFit(points: THREE.Vector3[]) {
    const bb = new THREE.Box3().setFromPoints(points)
    const c = bb.getCenter(new THREE.Vector3())
    const r = Math.max(bb.getSize(new THREE.Vector3()).length() / 2, 6)
    this.flyTo(c, Math.max((r / Math.sin(this.halfFov())) * 1.15, 16), true)
  }

  private flyTo(p: THREE.Vector3, distance: number, exact = false) {
    const offset = this.camera.position.clone().sub(this.controls.target)
    // keep a city-map view: never flatter than ~38° above the ground
    const flat = Math.hypot(offset.x, offset.z)
    if (Math.atan2(offset.y, flat) < 0.66) offset.y = flat * Math.tan(0.66)
    const len = exact ? distance : THREE.MathUtils.clamp(offset.length(), distance * 0.7, distance * 1.4)
    offset.setLength(len)
    this.tween = { target: p.clone(), pos: p.clone().add(offset) }
  }

  // -------------------------------------------------------------------------
  // name resolution (own contract first, then in-file bases)

  private find<T>(contract: string, pick: (c: Contract) => T | undefined, seen = new Set<string>()): T | undefined {
    const c = this.byName.get(contract)
    if (!c || seen.has(c.name)) return undefined
    seen.add(c.name)
    const r = pick(c)
    if (r !== undefined) return r
    for (const b of c.bases) {
      const x = this.find(b, pick, seen)
      if (x !== undefined) return x
    }
    return undefined
  }
  private varId = (c: string, n: string) => this.find(c, (k) => k.vars.find((v) => v.name === n)?.id)
  private fnId = (c: string, n: string) => this.find(c, (k) => k.fns.find((f) => f.name === n)?.id)
  private eventId = (c: string, n: string) => this.find(c, (k) => k.events.find((e) => e.name === n)?.id)
  private errorId = (c: string, n: string) => this.find(c, (k) => k.errors.find((e) => e.name === n)?.id)

  private floorTop(fnId: string, i: number) {
    const m = this.stmtFloors.get(fnId)?.get(i)
    if (!m) return this.anchors.get(fnId)!
    const p = m.getWorldPosition(new THREE.Vector3())
    p.y += FLOOR_H / 2
    return p
  }

  // -------------------------------------------------------------------------
  // focus: what the editor cursor is on

  focus(sel: Selection) {
    this.selection = sel
    // reset
    for (const l of this.links.children.slice()) {
      const m = l as THREE.Mesh
      m.geometry?.dispose()
      ;(m.material as THREE.Material)?.dispose()
    }
    this.links.clear()
    this.particles = this.particles.filter((p) => p.mesh.parent === this.root)
    this.codeLabel?.element.remove()
    this.codeLabel?.removeFromParent()
    this.codeLabel = undefined
    if (this.outline) {
      this.outline.removeFromParent()
      ;(this.outline.material as THREE.Material).dispose()
      this.outline = undefined
    }
    if (!this.model) return

    const active = new Set<string>()
    const add = (id?: string) => id && active.add(id)
    type L = { from: THREE.Vector3; to: THREE.Vector3; color: string; strong: boolean }
    const links: L[] = []
    let highlight: THREE.Mesh | undefined
    let target: THREE.Vector3 | undefined
    let distance = 22
    let fitIds: string[] | undefined

    const stmtLinks = (f: Fn, i: number, s: Stmt, strong: boolean, only?: (kind: string, id: string) => boolean) => {
      const c = this.fnOwner.get(f.id)!
      const floor = this.floorTop(f.id, i)
      const ok = (k: string, id?: string): id is string => !!id && (!only || only(k, id))
      for (const n of s.reads) { const id = this.varId(c, n); if (ok('read', id)) { add(id); links.push({ from: this.anchors.get(id)!, to: floor, color: LINK_COLORS.read, strong }) } }
      for (const n of s.writes) { const id = this.varId(c, n); if (ok('write', id)) { add(id); links.push({ from: floor, to: this.anchors.get(id)!, color: LINK_COLORS.write, strong }) } }
      for (const n of s.calls) { const id = this.fnId(c, n); if (ok('call', id)) { add(id); links.push({ from: floor, to: this.anchors.get(id)!, color: LINK_COLORS.call, strong }) } }
      for (const n of s.emits) { const id = this.eventId(c, n); if (ok('emit', id)) { add(id); links.push({ from: floor, to: this.anchors.get(id)!, color: LINK_COLORS.emit, strong }) } }
      for (const n of s.reverts) { const id = this.errorId(c, n); if (ok('revert', id)) { add(id); links.push({ from: floor, to: this.anchors.get(id)!, color: LINK_COLORS.revert, strong }) } }
      // calls into another city: link to the callee's tower (or its city for `new`)
      for (const x of s.ext) {
        const id = x.fn === 'constructor' ? this.byName.get(x.contract)?.id : this.fnId(x.contract, x.fn)
        const to = id && (this.anchors.get(id) ?? this.focusTargets.get(id))
        if (ok('ext', id) && to) { add(id); links.push({ from: floor, to, color: LINK_COLORS.ext, strong }) }
      }
    }

    if (sel.fn) {
      const f = sel.fn
      add(f.id)
      const stmtIdx = sel.stmt ? f.statements.indexOf(sel.stmt) : -1
      f.statements.forEach((s, i) => stmtLinks(f, i, s, i === stmtIdx))
      // modifiers wrap the function: link plinth → modifier tower
      const c = this.fnOwner.get(f.id)!
      const base = this.anchors.get(f.id)!.clone()
      base.y = PLATE_Y + PLINTH_H
      for (const m of f.modifiers) {
        const id = this.fnId(c, m)
        if (!id) continue
        add(id)
        links.push({ from: this.anchors.get(id)!, to: base, color: LINK_COLORS.modifier, strong: stmtIdx < 0 })
      }
      // functions/modifiers that use this modifier
      if (f.kind === 'modifier') {
        for (const k of this.model.contracts) for (const g of k.fns) {
          if (g.modifiers.includes(f.name) && this.fnId(k.name, f.name) === f.id) {
            add(g.id)
            const b = this.anchors.get(g.id)!.clone(); b.y = PLATE_Y + PLINTH_H
            links.push({ from: this.anchors.get(f.id)!, to: b, color: LINK_COLORS.modifier, strong: true })
          }
        }
      }
      const lineFloor = sel.line ? this.lineFloors.get(f.id)?.get(sel.line) : undefined
      if (stmtIdx >= 0 || lineFloor) {
        // the storey of the exact line under the cursor
        highlight = lineFloor ?? this.stmtFloors.get(f.id)?.get(stmtIdx)
        target = highlight ? highlight.getWorldPosition(new THREE.Vector3()) : this.floorTop(f.id, stmtIdx)
        distance = 16
        // a call into another city: frame both ends so the road between them is visible
        const ext = (sel.stmt?.ext ?? [])
          .map((x) => (x.fn === 'constructor' ? this.byName.get(x.contract)?.id : this.fnId(x.contract, x.fn)))
          .filter((x): x is string => !!x)
        if (ext.length) fitIds = [f.id, ...ext]
      } else {
        target = this.focusTargets.get(f.id)
        distance = 20
      }
    } else if (sel.v || sel.ev || sel.err) {
      const key = (sel.v ?? sel.ev ?? sel.err)!.id
      add(key)
      // every statement anywhere that touches this variable / emits this event
      for (const k of this.model.contracts) for (const f of k.fns) f.statements.forEach((s, i) => {
        const before = links.length
        stmtLinks(f, i, s, true, (_, id) => id === key)
        if (links.length > before) add(f.id)
      })
      target = this.focusTargets.get(key)
      distance = 24
      fitIds = [...active]
    } else if (sel.contract && this.showAllLinks) {
      // overview: function-level links for the whole contract
      for (const f of sel.contract.fns) f.statements.forEach((s, i) => stmtLinks(f, i, s, false))
    }

    if (!sel.fn && !sel.v && !sel.ev && !sel.err && sel.contract) {
      target = this.focusTargets.get(sel.contract.id)
      distance = 34
    }

    // dim whatever is not involved
    const dim = active.size > 0
    this.dimmed = (owner) => dim && !active.has(owner)
    for (const m of this.pickables) {
      const mat = m.material as THREE.MeshStandardMaterial
      const owners = m.userData.owners as string[]
      const isPlate = ['contract', 'road'].includes((m.userData.ref as Ref).type)
      const on = !dim || isPlate || owners.some((o) => active.has(o))
      mat.opacity = (m.userData.baseOpacity as number) * (on ? 1 : 0.13)
      mat.depthWrite = on
      mat.emissive.copy(m.userData.baseEmissive as THREE.Color)
      mat.emissiveIntensity = (m.userData.baseEI as number) ?? 1
      m.scale.copy(m.userData.baseScale ?? m.scale)
    }
    for (const fr of this.frames) {
      const on = !dim || fr.owners.some((o) => active.has(o))
      ;(fr.obj.material as THREE.LineBasicMaterial).opacity = (fr.obj.userData.baseOpacity as number) * (on ? 1 : 0.12)
    }
    for (const l of this.labelObjs) {
      const o = l.element.dataset.owner
      const isContractName = !!o && /^c:[^:]+$/.test(o)
      l.element.classList.toggle('dim', dim && !!o && !isContractName && !active.has(o))
    }

    // roads light up (and traffic speeds up) when the focus crosses from one city to another
    const home = sel.fn ? this.fnOwner.get(sel.fn.id) : (sel.v ?? sel.ev ?? sel.err)?.id.split(':')[1]
    const busy = new Set<Highway>()
    if (home) for (const id of active) {
      const other = id.split(':')[1]
      const r = other && other !== home ? this.roadBetween(home, other) : undefined
      if (r) busy.add(r)
    }
    for (const r of this.roads.values()) {
      const on = busy.has(r)
      r.boost = on ? 2.6 : 1
      for (const m of r.paint) m.emissiveIntensity = (m.userData.base as number) * (on ? 4 : 1)
      r.label.classList.toggle('active', on)
    }

    for (const l of links) {
      if (!l.from || !l.to) continue
      this.arc(l.from, l.to, l.color, l.strong ? 0.075 : 0.045, this.links, l.strong ? 0.95 : 0.65)
    }

    if (highlight) {
      const mat = highlight.material as THREE.MeshStandardMaterial
      mat.emissive.set('#ffffff')
      mat.emissiveIntensity = mat.emissiveMap ? 1.4 : 0.45
      mat.opacity = Math.max(mat.opacity, 0.85)
      if (!highlight.userData.baseScale) highlight.userData.baseScale = highlight.scale.clone()
      highlight.scale.copy((highlight.userData.baseScale as THREE.Vector3).clone().multiply(new THREE.Vector3(1.12, 1.06, 1.12)))
      // bright frame around the storey
      this.outline = new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: '#ffffff' }))
      this.outline.scale.setScalar(1.03)
      highlight.add(this.outline)
      const ref = highlight.userData.ref as Ref
      const div = document.createElement('div')
      div.className = 'lbl code'
      div.textContent = ref.detail
      this.codeLabel = new CSS2DObject(div)
      this.codeLabel.center.set(0, 0.5)
      this.codeLabel.position.set(highlight.scale.x / 2 + 0.4, 0, 0)
      this.codeLabel.position.divide(highlight.scale) // child of a scaled mesh
      highlight.add(this.codeLabel)
    }

    if (this.followCamera) {
      const pts = fitIds?.map((id) => this.anchors.get(id)).filter((p): p is THREE.Vector3 => !!p)
      if (pts && pts.length > 1) this.flyToFit(pts)
      else if (target) this.flyTo(target, distance)
    }
  }

  // -------------------------------------------------------------------------
  // pointer: hover tooltip + click to jump to code

  private bindPointer() {
    const el = this.renderer.domElement
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const hit = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, this.camera)
      const hits = ray.intersectObjects(this.pickables, false)
      // prefer things that are not faded out, and anything over the plate
      const visible = hits.filter((h) => ((h.object as THREE.Mesh).material as THREE.Material).opacity > 0.2)
      const best = visible.find((h) => (h.object.userData.ref as Ref).type !== 'contract') ?? visible[0]
      return best?.object as THREE.Mesh | undefined
    }
    el.addEventListener('pointermove', (e) => {
      const m = hit(e)
      if (m !== this.hovered) {
        this.hovered = m
        this.handlers.onHover(m ? (m.userData.ref as Ref) : null)
        el.style.cursor = m ? 'pointer' : 'default'
      }
      if (m) {
        const ref = m.userData.ref as Ref
        this.tooltip.innerHTML = `<b>${esc(ref.title)}</b>${ref.detail ? `<div>${esc(ref.detail)}</div>` : ''}<span class="ln">line ${ref.span.startLine}${ref.span.endLine > ref.span.startLine ? `–${ref.span.endLine}` : ''}</span>`
        const r = this.container.getBoundingClientRect()
        this.tooltip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 300)}px`
        this.tooltip.style.top = `${e.clientY - r.top + 14}px`
        this.tooltip.hidden = false
      } else this.tooltip.hidden = true
    })
    el.addEventListener('pointerleave', () => {
      this.tooltip.hidden = true
      this.hovered = undefined
      this.handlers.onHover(null)
    })
    let down: { x: number; y: number } | undefined
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }))
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
      const m = hit(e)
      if (m) this.handlers.onPick(m.userData.ref as Ref)
    })
  }
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

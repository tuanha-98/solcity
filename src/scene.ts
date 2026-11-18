import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Contract, Fn, Model, NamedItem, Span, StateVar, Stmt, StmtKind } from './model'
import { cityGate, driveCar, highway, streets, withOverpasses, type Highway, type SegKind } from './city'
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
/** roads read from the chain: an address a contract holds (also its centre line), a proxy's implementation */
const CHAIN_ACCENT = { ref: '#34d399', proxy: '#38bdf8' }

// geometry constants (world units)
const CW = 2.2 // storage cell width
const CD = 2.2 // storage cell depth
const GAP = 0.25
const PLATE_Y = 0.2
const PLINTH_H = 0.3
const FOUND_H = 0.1 // foundation slab of storage / temple / mast / cone lots
const LOT = 2.85 // a tower's foundation: the full width of its lot
const MAX_LOT_CELLS = 3 // widest a storage lot is drawn, however many slots its variable spans
/** gates along a city's front edge: kept this far from the corners, and this far apart (a two-way road is 2.7 wide) */
const GATE_MARGIN = 2.2
const GATE_PITCH = 4
/** how far a storey's facade is set back per level of nesting (if / for / unchecked …) */
const NEST_RECESS = 0.12

/**
 * Outline width of storey `i` of an `n`-storey tower. Short towers are one straight block; long
 * ones step back in up to five tiers as they rise, like a setback skyscraper, so a storey is never
 * wider than the one below it.
 */
function tierWidth(i: number, n: number) {
  if (n <= 8) return TOWER_W
  const tiers = Math.min(5, Math.max(2, Math.round(n / 10)))
  const perTier = Math.ceil(n / tiers)
  return TOWER_W * (1 - 0.12 * Math.floor(i / perTier))
}
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
  /** read from the chain: an address a contract holds, or a proxy's implementation */
  chain?: 'ref' | 'proxy'
  /** the road sign's small print, when not the default */
  tag?: string
}

interface City {
  row: number
  col: number
  x1: number
  x2: number
  /** z of the city's back (north) and front (south) edges */
  back: number
  edge: number
  /** the street behind the storage row, and the streets across the city (avenue … front street) */
  backStreet: number
  rowStreets: number[]
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
    this.focus(this.carry(this.selection))
  }

  /** The selection was made in the code before this build: the same items in the new code, or nothing. */
  private carry(sel: Selection): Selection {
    const contract = sel.contract && this.byName.get(sel.contract.name)
    if (!contract) return { line: sel.line }
    const fn = sel.fn && contract.fns.find((f) => f.id === sel.fn!.id)
    return {
      contract,
      fn,
      stmt: fn && sel.fn && sel.stmt ? fn.statements[sel.fn.statements.indexOf(sel.stmt)] : undefined,
      v: sel.v && contract.vars.find((x) => x.id === sel.v!.id),
      ev: sel.ev && contract.events.find((x) => x.id === sel.ev!.id),
      err: sel.err && contract.errors.find((x) => x.id === sel.err!.id),
      line: sel.line,
    }
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
  private buildContract(c: Contract, left: number, minWidth = 0): {
    group: THREE.Group; width: number; back: number; edge: number; frontStreet: number; backStreet: number; rowStreets: number[]; cols: number[]
  } {
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
    // the front edge is widened when needed so that every road gets a gate of its own
    const x1 = -1.4, x2 = Math.max(Math.max(maxX, 6) + 1.4, x1 + minWidth)
    const zA = -CD / 2 - 1.3, zB = maxZ + 1.0
    const backStreet = -CD / 2 - 0.6 // behind the storage row, for gates on the north edge
    streets(g, { cols: colStreets, rows: rowStreets, back: backStreet, x1, x2, y: PLATE_Y })
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
    const kindTag = (c.kind === 'contract' ? '' : `<span class="tag">${c.kind}</span>`)
      + (c.address ? `<span class="tag addr" title="${c.address}">${c.address.slice(0, 6)}…${c.address.slice(-4)}${c.unverified ? ' · not verified' : ''}</span>` : '')
    this.label(g, `${c.name}${kindTag}`, 'lbl contract', new THREE.Vector3(x1 + 0.3, PLATE_Y, zA), c.id, true, [0, 1])
    this.focusTargets.set(c.id, new THREE.Vector3(ox + (x1 + x2) / 2, 0, (zA + zB) / 2))
    return { group: g, width: x2 - x1, back: zA, edge: zB, frontStreet, backStreet, rowStreets, cols: colStreets.map((cx) => ox + cx) }
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
    // read from the chain (address imports): a proxy runs its implementation's code; a contract holds
    // the address of another one. When code already calls between the two, that road says so instead.
    const held = new Map<string, Rel & { vias: string[] }>()
    const onCall = new Map<string, string[]>()
    for (const l of model.links) {
      if (!has(l.from) || !has(l.to) || l.from === l.to) continue
      const at = this.byName.get(l.to)?.address
      if (l.kind === 'proxy') {
        rels.push({
          key: `proxy:${l.from}>${l.to}`, from: l.from, to: l.to, kind: 'oneway', count: 3, span: l.span, chain: 'proxy', tag: 'proxy · delegatecall',
          title: `${l.from} runs ${l.to}`, detail: `Proxy: every call to ${l.from} runs ${l.to}'s code (delegatecall) on ${l.from}'s storage${at ? ` · ${at}` : ''}`,
        })
        continue
      }
      const [a, b] = [l.from, l.to].sort()
      const what = `${l.from}.${l.via} = ${l.to}${at ? ` (${at})` : ''}`
      if (pairs.has(`call:${a}|${b}`)) {
        onCall.set(`call:${a}|${b}`, [...(onCall.get(`call:${a}|${b}`) ?? []), what])
        continue
      }
      const key = `chain:${a}|${b}`
      const cur = held.get(key)
      if (cur) {
        cur.vias.push(l.via)
        cur.detail += ` · ${what}`
        cur.tag = `${cur.vias.join(', ')} · on-chain`
        continue
      }
      const r = { key, from: l.from, to: l.to, kind: 'twoway' as const, count: 1, span: l.span, chain: 'ref' as const, vias: [l.via], tag: `${l.via} · on-chain`, title: `${l.from} ⇄ ${l.to}`, detail: `On-chain: ${what}` }
      held.set(key, r)
      rels.push(r)
    }
    for (const p of pairs.values()) {
      p.detail = [p.ab ? `${p.from} → ${p.to}: ${p.ab} call site${p.ab > 1 ? 's' : ''}` : '', p.ba ? `${p.to} → ${p.from}: ${p.ba} call site${p.ba > 1 ? 's' : ''}` : '', ...(onCall.get(p.key) ?? []).map((w) => `on-chain: ${w}`)]
        .filter(Boolean).join(' · ')
      rels.push(p)
    }
    return rels
  }

  /**
   * Cities on a 2D grid with corridors between them, like blocks of a bigger city.
   * Each city has gates on all four sides; a road leaves by the side facing the other city, takes its
   * own lane in each corridor it travels (an L or a Z), and enters the other city the same way.
   * Corridors are as wide as their lanes need.
   */
  private layoutCities(model: Model) {
    const order = this.cityOrder(model)
    const n = order.length
    if (!n) return
    const aspect = Math.max(this.camera.aspect, 0.35)
    const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * aspect * 1.6))))
    const rows = Math.ceil(n / cols)

    const rels0 = this.relations(model)

    // Gates sit on all four sides: north and south edges (on the back street and the front street)
    // and east and west ends of the streets across the city. A city's front and back edges are wide
    // enough that, between them, every road can have its own gate.
    const roadEnds = new Map<string, number>()
    for (const r of rels0) for (const x of [r.from, r.to]) roadEnds.set(x, (roadEnds.get(x) ?? 0) + 1)
    const gateSpan = (k: number) => (k > 1 ? 2 * GATE_MARGIN + (k - 1) * GATE_PITCH : 0)

    // build every city at the origin first, to know its size
    const built = order.map((c, i) => {
      const row = Math.floor(i / cols)
      const col = row % 2 === 0 ? i % cols : cols - 1 - (i % cols) // snake: neighbours in `order` stay adjacent
      // north and south edges alone can give every road a gate; east/west gates are extra room, so a
      // road end that finds no clean gate on its side always has somewhere else to go
      return { c, row, col, b: this.buildContract(c, 0, gateSpan(Math.ceil((roadEnds.get(c.name) ?? 0) / 2))) }
    })
    type Built = (typeof built)[number]
    const cell = new Map(built.map((x) => [x.c.name, x]))

    type Side = 'S' | 'N' | 'E' | 'W'
    type Corr = { axis: 'H' | 'V'; index: number }
    // The layout is computed, checked, and only then applied. When a road end cannot get a clean gate
    // on the side it was planned for (every gate there would put its stub alongside another road's),
    // that side is ruled out for that road end and the roads are planned again.
    const attempt = (forbid: Set<string>) => {
    const conflicts: string[] = []
    // ---- pass 1: for each road, the side it leaves and enters by, and the corridors it travels ----
    const slotCount = (width: number) => {
      const span = width - 2 * GATE_MARGIN
      return span > 0 ? Math.floor(span / GATE_PITCH + 1e-6) + 1 : 1
    }
    // east/west gates sit on the streets across the city; the back street is too close to the north edge
    // for a road's width (half of a two-way road is 1.35, the back street is 0.7 inside the edge)
    const capacity = (x: Built, side: Side) => (side === 'S' || side === 'N' ? slotCount(x.b.width) : x.b.rowStreets.length)
    const used = new Map<string, Record<Side, number>>()
    const usedOf = (name: string) => {
      let u = used.get(name)
      if (!u) used.set(name, (u = { S: 0, N: 0, E: 0, W: 0 }))
      return u
    }
    // S → corridor below the row, N → above it, E → right of the column, W → left of it
    const corridorOf = (x: Built, side: Side): Corr =>
      side === 'S' ? { axis: 'H', index: x.row + 1 } : side === 'N' ? { axis: 'H', index: x.row }
        : side === 'E' ? { axis: 'V', index: x.col + 1 } : { axis: 'V', index: x.col }
    const between = (a: number, b: number) => [a, a + 1, b, b + 1].reduce((best, k) => {
      const cost = (k: number) => Math.abs(k - (a + 0.5)) + Math.abs(k - (b + 0.5))
      return cost(k) < cost(best) ? k : best
    })
    const lanes = { H: new Array<number>(rows + 1).fill(0), V: new Array<number>(cols + 1).fill(0) }
    const plansIn = rels0
      .map((r) => ({ r, A: cell.get(r.from)!, B: cell.get(r.to)! }))
      .sort((p, q) => (Math.abs(p.A.row - p.B.row) + Math.abs(p.A.col - p.B.col)) - (Math.abs(q.A.row - q.B.row) + Math.abs(q.A.col - q.B.col)))
      .map(({ r, A, B }) => {
        const dx = B.col - A.col, dy = B.row - A.row
        // sides of A that face B, and sides of B that face A
        const aV: Side[] = dy > 0 ? ['S'] : dy < 0 ? ['N'] : ['S', 'N']
        const aH: Side[] = dx > 0 ? ['E'] : dx < 0 ? ['W'] : ['E', 'W']
        const bV: Side[] = dy > 0 ? ['N'] : dy < 0 ? ['S'] : ['S', 'N']
        const bH: Side[] = dx > 0 ? ['W'] : dx < 0 ? ['E'] : ['E', 'W']
        const pairs: [Side, Side][] = []
        const add = (as: Side[], bs: Side[]) => { for (const a of as) for (const b of bs) pairs.push([a, b]) }
        if (Math.abs(dx) >= Math.abs(dy)) { add(aH, bH); add(aV, bH); add(aH, bV); add(aV, bV) }
        else { add(aV, bV); add(aH, bV); add(aV, bH); add(aH, bH) }
        const legsFor = (sa: Side, sb: Side): Corr[] => {
          const ca = corridorOf(A, sa), cb = corridorOf(B, sb)
          if (ca.axis !== cb.axis) return [ca, cb] // an L: along one corridor, then the crossing one
          if (ca.index === cb.index) return [ca] // both gates open onto the same corridor
          const mid: Corr = ca.axis === 'H' ? { axis: 'V', index: between(A.col, B.col) } : { axis: 'H', index: between(A.row, B.row) }
          return [ca, mid, cb]
        }
        // fewest turns wins, among sides that still have a free gate
        let best: { sa: Side; sb: Side; legs: Corr[]; score: number } | undefined
        pairs.forEach(([sa, sb], i) => {
          const legs = legsFor(sa, sb)
          const fits = usedOf(r.from)[sa] < capacity(A, sa) && usedOf(r.to)[sb] < capacity(B, sb)
          const banned = forbid.has(`${r.key}:A:${sa}`) || forbid.has(`${r.key}:B:${sb}`)
          const score = (banned ? 1e5 : 0) + (fits ? 0 : 1000) + legs.length * 10 + i * 0.01
          if (!best || score < best.score) best = { sa, sb, legs, score }
        })
        usedOf(r.from)[best!.sa]++
        usedOf(r.to)[best!.sb]++
        return { r, A, B, sa: best!.sa, sb: best!.sb, legs: best!.legs.map((l) => ({ ...l, lane: lanes[l.axis][l.index]++ })) }
      })

    // Lane order inside each corridor: a road whose gate stub comes in from the west (or north) side
    // takes a lane on that side, one coming in from the east (or south) a lane on the far side, and
    // roads that only pass through (or have stubs on both sides) the lanes in between. Stubs then reach
    // their lanes without running across, and alongside, each other.
    const users = new Map<string, { plan: number; leg: number }[]>()
    plansIn.forEach((p, i) => p.legs.forEach((l, j) => {
      const k = `${l.axis}${l.index}`
      users.set(k, [...(users.get(k) ?? []), { plan: i, leg: j }])
    }))
    const fromSide = (ref: { plan: number; leg: number }) => {
      const p = plansIn[ref.plan], l = p.legs[ref.leg]
      let low = false, high = false
      const note = (side: Side) => {
        if (l.axis === 'V') { if (side === 'E') low = true; else if (side === 'W') high = true }
        else { if (side === 'S') low = true; else if (side === 'N') high = true }
      }
      if (ref.leg === 0) note(p.sa) // A's stub comes into this corridor
      if (ref.leg === p.legs.length - 1) note(p.sb) // B's stub leaves from it
      return low && !high ? 0 : high && !low ? 2 : 1
    }
    for (const refs of users.values()) {
      refs.sort((a, b) => fromSide(a) - fromSide(b) || a.plan - b.plan)
      refs.forEach((ref, idx) => { plansIn[ref.plan].legs[ref.leg].lane = idx })
    }

    // ---- pass 2: corridor and cell sizes → positions ----
    // lane pitch: a road crossing the next lane needs half a road + a ramp + a straight run before
    // its corner, so it is back on the ground before it turns; the margin leaves room for a ramp
    // between a city's gate and the first lane, on either side of a corridor
    const TRACK = 6.5
    const MARGIN = 5.6
    const corridorWidth = (k: number, outer: boolean) => (k > 0 ? 2 * MARGIN + (k - 1) * TRACK : outer ? 3 : 6)
    const hW = lanes.H.map((k, i) => corridorWidth(k, i === 0 || i === rows))
    const vW = lanes.V.map((k, j) => corridorWidth(k, j === 0 || j === cols))
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

    // where each city goes (centred in its column, front edge on the corridor); applied once settled
    const cities = new Map<string, City>()
    const offsets = new Map<string, { dx: number; dz: number }>()
    for (const x of built) {
      const dx = colLeft[x.col] + (colW[x.col] - x.b.width) / 2
      const dz = rowTop[x.row] + rowD[x.row] - x.b.edge
      offsets.set(x.c.name, { dx, dz })
      const info: City = {
        row: x.row, col: x.col, x1: dx, x2: dx + x.b.width, back: x.b.back + dz, edge: x.b.edge + dz,
        backStreet: x.b.backStreet + dz, rowStreets: x.b.rowStreets.map((z) => z + dz), frontStreet: x.b.frontStreet + dz,
        cols: x.b.cols.map((c) => c + dx), contract: x.c,
      }
      cities.set(x.c.name, info)
    }

    // ---- pass 3: gates and routes ----
    // north/south gates: evenly spaced along the edge, kept clear of the corners;
    // east/west gates: at the ends of the streets across the city (avenue, between rows, front street)
    const slots = new Map([...cities].map(([k, C]) => {
      const lo = C.x1 + GATE_MARGIN, hi = C.x2 - GATE_MARGIN
      const n = slotCount(C.x2 - C.x1)
      const xs = n === 1 ? [(C.x1 + C.x2) / 2] : Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1))
      const zs = [...C.rowStreets]
      return [k, { S: [...xs], N: [...xs], E: [...zs], W: [...zs] } as Record<Side, number[]>]
    }))
    // stubs already laid in each corridor (from gates on either side of it), so that a new stub never
    // runs alongside another one too closely: gates of the cities above and below a corridor (or left
    // and right of it) are chosen independently and could otherwise line up
    const stubs = new Map<string, { at: number; lo: number; hi: number; half: number }[]>()
    /** the free gate on a side nearest to where the road heads next, whose stub keeps clear of others */
    // gates in use on each side, and how many each side still has to give (planned in pass 1)
    const taken = new Map<string, number[]>()
    const left = new Map([...used].map(([k, u]) => [k, { ...u }]))
    const isNS = (side: Side) => side === 'S' || side === 'N'
    /** can a gate go at `v` on this side: on the edge (north/south) or a street end (east/west), spaced
     *  from the side's other gates, its stub clear of other stubs, and leaving enough gates for later roads */
    const fits = (city: string, side: Side, v: number, corridor: string, span: [number, number], half: number) => {
      const C = cities.get(city)!
      const list = slots.get(city)![side]
      const inUse = taken.get(`${city}:${side}`) ?? []
      if (isNS(side)) {
        if (v < C.x1 + GATE_MARGIN - 1e-6 || v > C.x2 - GATE_MARGIN + 1e-6) return false
        if (inUse.some((u) => Math.abs(u - v) < GATE_PITCH - 1e-6)) return false
        const blocked = list.filter((x) => Math.abs(x - v) < GATE_PITCH - 1e-6).length
        const onSlot = list.some((x) => Math.abs(x - v) < 0.05)
        if (!onSlot && list.length - blocked < (left.get(city)?.[side] ?? 1) - 1) return false
      } else {
        if (!list.some((z) => Math.abs(z - v) < 0.05)) return false
        // the road's mouth must lie wholly on the city's side, clear of its corners
        if (v - C.back < half + 0.2 || C.edge - v < half + 0.2) return false
      }
      const lo = Math.min(...span), hi = Math.max(...span)
      return (stubs.get(corridor) ?? []).every((o) => Math.abs(o.at - v) >= o.half + half + 1 || Math.min(o.hi, hi) - Math.max(o.lo, lo) <= 0.1)
    }
    const commit = (city: string, side: Side, v: number, corridor: string, span: [number, number], half: number) => {
      const list = slots.get(city)![side]
      const gap = isNS(side) ? GATE_PITCH - 1e-6 : 0.05
      for (let i = list.length - 1; i >= 0; i--) if (Math.abs(list[i] - v) < gap) list.splice(i, 1)
      taken.set(`${city}:${side}`, [...(taken.get(`${city}:${side}`) ?? []), v])
      const l = left.get(city)
      if (l) l[side] = Math.max(0, l[side] - 1)
      stubs.set(corridor, [...(stubs.get(corridor) ?? []), { at: v, lo: Math.min(...span), hi: Math.max(...span), half }])
      return v
    }
    /**
     * Pick a gate on one side: the free slot nearest to where the road heads (`toward`). On north and
     * south edges the gate may also sit exactly opposite `toward`. With `jogs`, a sideways jog shorter
     * than two bends (which reads as a kink) is avoided: the jog is either zero or at least `minJog`.
     */
    const take = (city: string, side: Side, toward: number, corridor: string, span: [number, number], half: number, jogs: boolean, tag: string) => {
      const C = cities.get(city)!
      const list = slots.get(city)![side]
      const minJog = 2 * (half + 1) + 0.5
      const cands = [...list]
      if (isNS(side)) cands.push(toward)
      const ok = cands.filter((v) => fits(city, side, v, corridor, span, half))
      if (!ok.length) conflicts.push(tag) // no clean gate on this side: plan this road end differently
      const pool = ok.length ? ok : list
      if (!pool.length) return isNS(side) ? (C.x1 + C.x2) / 2 : C.frontStreet
      const score = (v: number) => {
        const d = Math.abs(v - toward)
        return d < 0.05 ? 0 : jogs && d < minJog ? 1000 + d : d
      }
      const best = pool.reduce((b, v) => (score(v) < score(b) ? v : b))
      return commit(city, side, Math.abs(best - toward) < 0.05 ? toward : best, corridor, span, half)
    }
    /** For a road that only crosses one corridor: one position that suits both gates, so it runs straight. */
    const shared = (p: (typeof plansIn)[number], half: number, corridor: string, spanA: [number, number], spanB: [number, number]) => {
      const A = cities.get(p.r.from)!, B = cities.get(p.r.to)!
      let cands: number[]
      if (isNS(p.sa)) {
        const lo = Math.max(A.x1, B.x1) + GATE_MARGIN, hi = Math.min(A.x2, B.x2) - GATE_MARGIN
        if (hi < lo - 1e-6) return undefined
        const mid = (lo + hi) / 2
        cands = []
        for (let d = 0; d <= (hi - lo) / 2 + 1e-6; d += 0.5) cands.push(mid - d, mid + d)
        cands = cands.filter((v) => v >= lo - 1e-6 && v <= hi + 1e-6)
      } else {
        // east/west gates sit on street ends: only streets both cities have at the same height
        cands = slots.get(p.r.from)![p.sa].filter((z) => slots.get(p.r.to)![p.sb].some((w) => Math.abs(w - z) < 0.05))
        cands.sort((a, b) => b - a) // front streets first: they line up across a row
      }
      return cands.find((v) => fits(p.r.from, p.sa, v, corridor, spanA, half) && fits(p.r.to, p.sb, v, corridor, spanB, half))
    }
    /** where a gate's stub starts: just past the ramp off the city, on the corridor side */
    const outAt = (C: City, side: Side) => (side === 'S' ? C.edge + 1.2 : side === 'N' ? C.back - 1.2 : side === 'E' ? C.x2 + 1.2 : C.x1 - 1.2)
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const y0 = 0.01, yc = PLATE_Y
    /** inside the city on its street, on the edge, and out on the ground past the ramp */
    const gatePoints = (C: City, side: Side, at: number) =>
      side === 'S' ? [V(at, yc, C.frontStreet), V(at, yc, C.edge), V(at, y0, C.edge + 1.2)]
        : side === 'N' ? [V(at, yc, C.backStreet), V(at, yc, C.back), V(at, y0, C.back - 1.2)]
          : side === 'E' ? [V(C.x2 - 0.6, yc, at), V(C.x2, yc, at), V(C.x2 + 1.2, y0, at)]
            : [V(C.x1 + 0.6, yc, at), V(C.x1, yc, at), V(C.x1 - 1.2, y0, at)]
    const laneAt = (l: Corr & { lane: number }) => (l.axis === 'H' ? hTop[l.index] : vLeft[l.index]) + MARGIN + l.lane * TRACK
    const centre = (C: City, axis: 'x' | 'z') => (axis === 'x' ? (C.x1 + C.x2) / 2 : C.frontStreet)

    const plans: { r: Rel; path: THREE.Vector3[]; kinds: SegKind[]; half: number; gates: [THREE.Vector3[], THREE.Vector3[]] }[] = []
    for (const p of plansIn) {
      const A = cities.get(p.r.from)!, B = cities.get(p.r.to)!
      const last = p.legs[p.legs.length - 1]
      const half = p.r.kind === 'oneway' ? 0.8 : 1.35
      const key = (l: Corr) => `${l.axis}${l.index}`
      // A's gate: nearest to where the first corridor leg turns (or to B when there is one leg)
      const aToward = p.legs.length > 1 ? laneAt(p.legs[1]) : centre(B, isNS(p.sa) ? 'x' : 'z')
      const spanA: [number, number] = [outAt(A, p.sa), laneAt(p.legs[0])]
      const spanB: [number, number] = [laneAt(last), outAt(B, p.sb)]
      // a road that only crosses one corridor gets gates facing each other when there is room for it
      const straight = p.legs.length === 1 ? shared(p, half, key(last), spanA, spanB) : undefined
      let aAt: number, bAt: number
      if (straight !== undefined) {
        aAt = commit(p.r.from, p.sa, straight, key(p.legs[0]), spanA, half)
        bAt = commit(p.r.to, p.sb, straight, key(last), spanB, half)
      } else {
        aAt = take(p.r.from, p.sa, aToward, key(p.legs[0]), spanA, half, p.legs.length > 1, `${p.r.key}:A:${p.sa}`)
        // B's gate: nearest to where the last leg arrives from
        const bToward = p.legs.length > 1 ? laneAt(p.legs[p.legs.length - 2]) : aAt
        bAt = take(p.r.to, p.sb, bToward, key(last), spanB, half, true, `${p.r.key}:B:${p.sb}`)
      }
      const ga = gatePoints(A, p.sa, aAt), gb = gatePoints(B, p.sb, bAt)

      const path: THREE.Vector3[] = []
      const kinds: SegKind[] = []
      const push = (pt: THREE.Vector3, kind?: SegKind) => {
        if (path.length && pt.distanceTo(path[path.length - 1]) < 0.01) return
        if (path.length) kinds.push(kind!)
        path.push(pt)
      }
      // the highway meets each city at its outer edge (the city's street carries on inside)
      push(ga[1]); push(ga[2], 'ramp')
      let cur = ga[2]
      p.legs.forEach((l, i) => {
        // onto this leg's lane: the gate's stub for the first leg, travel along the previous one after
        const c = laneAt(l)
        cur = l.axis === 'H' ? V(cur.x, y0, c) : V(c, y0, cur.z)
        push(cur, i === 0 ? 'stub' : p.legs[i - 1].axis === 'H' ? 'h' : 'v')
      })
      // along the last lane to B's gate, then in
      cur = last.axis === 'H' ? V(gb[2].x, y0, cur.z) : V(cur.x, y0, gb[2].z)
      push(cur, last.axis === 'H' ? 'h' : 'v')
      push(gb[2], 'stub'); push(gb[1], 'ramp')
      plans.push({ r: p.r, path, kinds, half, gates: [ga, gb] })
    }
    return { cities, offsets, plans, conflicts, y0 }
    }

    // plan, check, and re-plan the road ends that found no clean gate (a few rounds at most)
    const forbid = new Set<string>()
    let layout = attempt(forbid)
    for (let round = 0; round < 8 && layout.conflicts.length; round++) {
      const before = forbid.size
      layout.conflicts.forEach((c) => forbid.add(c))
      if (forbid.size === before) break // nothing new to rule out
      layout = attempt(forbid)
    }

    // apply: move the cities into place, then lay the roads
    const owner = (id: string) => id.split(':')[1]
    for (const x of built) {
      const { dx, dz } = layout.offsets.get(x.c.name)!
      x.b.group.position.x += dx
      x.b.group.position.z += dz
      for (const m of [this.anchors, this.focusTargets]) for (const [id, p] of m) if (owner(id) === x.c.name) { p.x += dx; p.z += dz }
    }
    for (const p of layout.plans) {
      const [ga, gb] = p.gates
      cityGate(this.root, ga[0], ga[1])
      cityGate(this.root, gb[0], gb[1])
    }
    // where roads cross, one becomes an overpass (gate stubs over through lanes, north–south over east–west)
    withOverpasses(layout.plans, layout.y0).forEach((path, i) => {
      this.roadPaths.set(layout.plans[i].r.key, path)
      this.addHighway(layout.plans[i].r, path)
    })
  }

  private addHighway(r: Rel, path: THREE.Vector3[]) {
    const hw = highway(path, r.kind, r.count, r.chain ? CHAIN_ACCENT[r.chain] : ROAD_ACCENT[r.kind], undefined, r.chain === 'ref' ? CHAIN_ACCENT.ref : undefined)
    this.root.add(hw.group)
    const what = r.chain === 'proxy' ? 'proxy' : r.chain === 'ref' ? 'on-chain' : r.kind === 'oneway' ? 'inheritance' : 'calls'
    const ref: Ref = { type: 'road', key: r.key, span: r.span, title: `${r.title}  (${what})`, detail: r.detail }
    for (const m of hw.asphalt) {
      m.userData.baseOpacity = 1
      m.userData.baseEmissive = (m.material as THREE.MeshStandardMaterial).emissive.clone()
      this.pick(m, ref, [r.key])
    }
    const tag = r.tag ?? (r.kind === 'oneway' ? 'inherits · one-way' : `${r.count} call${r.count > 1 ? 's' : ''} · two-way`)
    const text = `${r.from} <span class="arrow">${r.kind === 'oneway' ? '➜' : '⇄'}</span> ${r.to}<span class="tag">${esc(tag)}</span>`
    const cls = `lbl road ${r.kind}${r.chain === 'ref' ? ' chain' : r.chain === 'proxy' ? ' proxy' : ''}`
    const label = this.label(this.root, text, cls, hw.labelPos, undefined, true, [0.5, 1])
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
    for (const l of model.links) bump(l.from, l.to, 3)
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
    f.lines.forEach((l, i) => {
      const st = f.statements[l.stmt]
      const kind = st?.kind ?? 'other'
      // the tier sets the outline (never wider going up); nesting only sets the facade back
      const tier = f.kind === 'modifier' ? TOWER_W : tierWidth(i, f.lines.length)
      const size = Math.max(tier - 2 * NEST_RECESS * Math.min(st?.depth ?? 0, 3), tier * 0.55)
      topSize = tier
      const ref: Ref = {
        type: 'stmt', key: `${f.id}#L${l.line}`, title: STMT_LABEL[kind], detail: l.code.trim(),
        span: { startLine: l.line, endLine: l.endLine, start: l.start, end: l.end },
      }
      const make = this.maker(ref, [f.id])
      const floor = kind === 'placeholder'
        ? glassStorey(make, this.framer([f.id]), size, FLOOR_H)
        : storey(make, tier, size, FLOOR_H, STMT_COLORS[kind], f.kind === 'modifier' ? 'castle' : 'office', readOnly, l.line)
      floor.group.position.y = top
      g.add(floor.group)
      floor.body.userData.floor = true
      for (let ln = l.line; ln <= l.endLine; ln++) byLine.set(ln, floor.body) // every line of a wrapped statement
      if (st && !byStmt.has(l.stmt)) byStmt.set(l.stmt, floor.body)
      top += FLOOR_H
    })
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

import * as THREE from 'three'

// A big city is tens of thousands of meshes, and every mesh is a draw call. Once a city is built, the
// scene draws its static parts through batches instead: one InstancedMesh for each kind of part (same
// shape, same material look) in a tile of the map, with each part's colour, opacity and glow set per
// instance. The parts themselves stay behind as invisible proxies, for picking, positions and focus.

/** Same shape, same key: shared geometries by identity, geometries made per part (a lamp post, a
 * cone's band) by their vertices. */
const geoKeys = new WeakMap<THREE.BufferGeometry, string>()
export function geoKey(g: THREE.BufferGeometry): string {
  let k = geoKeys.get(g)
  if (k !== undefined) return k
  if (g.userData.shared) k = g.uuid
  else {
    let h = 2166136261
    const pos = g.attributes.position?.array ?? []
    for (let i = 0; i < pos.length; i++) h = Math.imul(h ^ Math.round(pos[i] * 1e4), 16777619)
    const idx = g.index?.array ?? []
    for (let i = 0; i < idx.length; i++) h = Math.imul(h ^ idx[i], 16777619)
    k = `${g.type}:${pos.length}:${idx.length}:${h >>> 0}`
  }
  geoKeys.set(g, k)
  return k
}

/** The key of a material's look, apart from what each instance carries (colour, opacity, glow). */
export const lookKey = (m: THREE.MeshStandardMaterial) =>
  `${m.map?.uuid ?? ''}|${m.emissiveMap?.uuid ?? ''}|${m.wireframe ? 'w' : ''}|${m.roughness}|${m.metalness}|${m.side}`

// Pass 1 draws the opaque instances (no blending, depth written, sorted by the GPU's depth test);
// pass 2 the faded and glass ones (blended, no depth written). Each instance belongs to one pass: the
// other moves its vertices behind the far plane, where they are clipped.
const patch = (shader: { vertexShader: string; fragmentShader: string }) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute float instAlpha;
attribute vec3 instGlow;
varying float vInstAlpha;
varying vec3 vInstGlow;`)
    .replace('#include <fog_vertex>', `#include <fog_vertex>
	vInstAlpha = instAlpha;
	vInstGlow = instGlow;
	#if SOLCITY_PASS == 1
	if ( instAlpha < 0.999 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
	#else
	if ( instAlpha >= 0.999 || instAlpha <= 0.001 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
	#endif`)
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying float vInstAlpha;
varying vec3 vInstGlow;`)
    .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vInstGlow;')
    .replace('#include <color_fragment>', `#include <color_fragment>
	diffuseColor.a *= vInstAlpha;`)
}

function passMaterial(src: THREE.MeshStandardMaterial, pass: 1 | 2) {
  const m = new THREE.MeshStandardMaterial({
    // colour and glow come per instance; `emissiveIntensity` stays free to make a whole batch blink
    color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 1,
    roughness: src.roughness, metalness: src.metalness, map: src.map, emissiveMap: src.emissiveMap,
    wireframe: src.wireframe, side: src.side,
    transparent: pass === 2, depthWrite: pass === 1,
  })
  m.defines = { ...m.defines, SOLCITY_PASS: pass }
  m.onBeforeCompile = patch
  m.customProgramCacheKey = () => `solcity-batch-${pass}`
  return m
}

export class MeshBatch {
  readonly solid: THREE.InstancedMesh
  readonly glass: THREE.InstancedMesh
  private alpha: THREE.InstancedBufferAttribute
  private dirty = true

  /**
   * `members` share a geometry (or an identical one) and a look. `blink`: the glow is the colour alone,
   * and the batch's `emissiveIntensity` sets its strength (beacons). `moving`: placed again every frame.
   */
  constructor(readonly members: THREE.Mesh[], o: { castShadow: boolean; receiveShadow: boolean; blink?: boolean; moving?: boolean }) {
    const n = members.length
    // a copy of the geometry to carry the per-instance attributes (never the shared original: disposing
    // a geometry frees its buffers for every mesh that uses them)
    const geo = members[0].geometry.clone()
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1)
    const glow = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    geo.setAttribute('instAlpha', this.alpha)
    geo.setAttribute('instGlow', glow)
    const src = members[0].material as THREE.MeshStandardMaterial
    this.solid = new THREE.InstancedMesh(geo, passMaterial(src, 1), n)
    this.glass = new THREE.InstancedMesh(geo, passMaterial(src, 2), n)
    const c = new THREE.Color()
    members.forEach((m, i) => {
      const mat = m.material as THREE.MeshStandardMaterial
      this.solid.setMatrixAt(i, m.matrixWorld)
      this.solid.setColorAt(i, mat.color)
      const a = (m.userData.baseOpacity as number | undefined) ?? mat.opacity
      this.alpha.array[i] = a
      c.copy(mat.emissive).multiplyScalar(o.blink ? 1 : mat.emissiveIntensity)
      glow.setXYZ(i, c.r, c.g, c.b)
      m.userData.batch = this
      m.userData.slot = i
      m.userData.opacity = a
    })
    this.glass.instanceMatrix = this.solid.instanceMatrix
    this.glass.instanceColor = this.solid.instanceColor
    this.solid.castShadow = o.castShadow
    this.solid.receiveShadow = this.glass.receiveShadow = o.receiveShadow
    // moving parts outrun the bounds measured where they started
    if (o.moving) this.solid.frustumCulled = this.glass.frustumCulled = false
    this.commit()
  }

  /** opacity of one instance: 1 opaque, below that faded or glass, 0 not drawn */
  set(slot: number, a: number) {
    if (this.alpha.array[slot] === a) return
    this.alpha.array[slot] = a
    this.dirty = true
  }

  /** send the changed opacities, and skip a pass that has nothing to draw */
  commit() {
    if (!this.dirty) return
    this.dirty = false
    const a = this.alpha.array as Float32Array
    let solid = false, glass = false
    for (let i = 0; i < a.length && !(solid && glass); i++) {
      if (a[i] >= 0.999) solid = true
      else if (a[i] > 0.001) glass = true
    }
    this.solid.visible = solid
    this.glass.visible = glass
    this.alpha.needsUpdate = true
  }

  get materials() {
    return [this.solid.material, this.glass.material] as THREE.MeshStandardMaterial[]
  }

  dispose() {
    this.solid.geometry.dispose()
    for (const m of this.materials) m.dispose()
    this.solid.dispose()
    this.glass.dispose()
  }
}

/** Outlines (glass frames, curbs, plate edges) merged into one LineSegments, opacity per vertex. */
export class LineBatch {
  readonly lines: THREE.LineSegments
  private colors: THREE.BufferAttribute
  private dirty = false

  constructor(members: THREE.LineSegments[]) {
    let total = 0
    for (const l of members) total += l.geometry.index?.count ?? l.geometry.attributes.position.count
    const pos = new Float32Array(total * 3)
    const col = new Float32Array(total * 4)
    const v = new THREE.Vector3()
    let at = 0
    for (const l of members) {
      const g = l.geometry, p = g.attributes.position, idx = g.index
      const mat = l.material as THREE.LineBasicMaterial
      const a = (l.userData.baseOpacity as number | undefined) ?? mat.opacity
      const count = idx?.count ?? p.count
      l.userData.lineBatch = this
      l.userData.lineStart = at
      l.userData.lineCount = count
      for (let k = 0; k < count; k++, at++) {
        v.fromBufferAttribute(p, idx ? idx.getX(k) : k).applyMatrix4(l.matrixWorld)
        pos[at * 3] = v.x; pos[at * 3 + 1] = v.y; pos[at * 3 + 2] = v.z
        col[at * 4] = mat.color.r; col[at * 4 + 1] = mat.color.g; col[at * 4 + 2] = mat.color.b; col[at * 4 + 3] = a
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.colors = new THREE.BufferAttribute(col, 4)
    geo.setAttribute('color', this.colors)
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }))
  }

  /** opacity of one of the merged outlines */
  set(l: THREE.LineSegments, a: number) {
    const c = this.colors.array as Float32Array
    const start = l.userData.lineStart as number, end = start + (l.userData.lineCount as number)
    if (c[start * 4 + 3] === a) return
    for (let k = start; k < end; k++) c[k * 4 + 3] = a
    this.dirty = true
  }

  commit() {
    if (!this.dirty) return
    this.dirty = false
    this.colors.needsUpdate = true
  }

  dispose() {
    this.lines.geometry.dispose()
    ;(this.lines.material as THREE.Material).dispose()
  }
}

import './style.css'
import { createEditor, monaco } from './editor'
import { analyze, itemsAtLine, type Model, type Span } from './model'
import { Scene3D, STMT_COLORS, STMT_LABEL, type Ref } from './scene'
import { SAMPLE, OLD_SAMPLE_HASHES, hashText } from './sample'
import { defaultBranch, fetchRaw, flatten, listSolidity, parseGitHubUrl, type RepoRef } from './github'
import { CHAINS, addExplorer, importFromChain, parseTarget, probeExplorer, type Chain, type Explorer, type Target } from './onchain'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* storage unavailable */ } },
}

// a stored copy of an older built-in sample is replaced by the current one; real edits are kept
const stored = store.get('sol-blocks:code')
const editor = createEditor($('code'), stored && !OLD_SAMPLE_HASHES.includes(hashText(stored)) ? stored : SAMPLE)
const text = editor.getModel()!
let model: Model | undefined

const scene = new Scene3D($('view'), { onPick: jumpTo, onHover: hoverCode })

// ---------- parse → 3D ----------
let lastEditLine = 1
let drawError = ''
/** after loading new code, frame the whole map on the next build */
let fitNext = false
let sourceLabel = ''
function update() {
  const { model: m, errors: raw } = analyze(editor.getValue())
  // when the parser cannot locate the error, the line just edited is the best guess
  const errors = raw.map((e) => (e.line ? e : { ...e, line: lastEditLine, message: e.message === 'Syntax error' ? `${e.message} near here` : e.message }))
  monaco.editor.setModelMarkers(text, 'solidity', errors.map((e) => ({
    severity: monaco.MarkerSeverity.Error,
    message: e.message,
    startLineNumber: e.line, startColumn: e.column + 1,
    endLineNumber: e.line, endColumn: e.column ? e.column + 2 : 200,
  })))
  const status = $('status')
  if (m && (m.contracts.length || !errors.length)) {
    drawError = ''
    try {
      model = m
      scene.build(m)
      syncCursor()
      if (fitNext) { scene.frameAll(); fitNext = false }
    } catch (err) {
      // a bug in drawing must not take the page down: say so and keep the editor usable
      console.error(err)
      drawError = `Could not draw this code: ${(err as Error).message}`
    }
  }
  if (drawError) {
    status.className = 'status err'
    status.textContent = drawError
  } else if (errors.length) {
    status.className = 'status err'
    status.textContent = `Line ${errors[0].line}: ${errors[0].message}${model ? ' · showing last valid version' : ''}`
  } else if (model) {
    const fns = model.contracts.reduce((n, c) => n + c.fns.length, 0)
    const stmts = model.contracts.reduce((n, c) => n + c.fns.reduce((k, f) => k + f.statements.length, 0), 0)
    status.className = 'status'
    status.textContent = `${sourceLabel ? `${sourceLabel} · ` : ''}${model.contracts.length} contract${model.contracts.length === 1 ? '' : 's'} · ${fns} functions · ${stmts} statements`
    status.title = status.textContent
  }
}

let timer: number | undefined
editor.onDidChangeModelContent((e) => {
  lastEditLine = e.changes[0]?.range.startLineNumber ?? lastEditLine
  clearTimeout(timer)
  timer = window.setTimeout(() => {
    update()
    store.set('sol-blocks:code', editor.getValue())
  }, 300)
})

// ---------- editor cursor → 3D focus ----------
function syncCursor() {
  if (!model) return
  const line = editor.getPosition()?.lineNumber ?? 1
  scene.focus(itemsAtLine(model, line))
}
editor.onDidChangeCursorPosition(() => syncCursor())

// ---------- 3D → editor ----------
let flash: monaco.editor.IEditorDecorationsCollection | undefined
let flashTimer: number | undefined
function jumpTo(ref: Ref) {
  const start = text.getPositionAt(ref.span.start)
  editor.setPosition(start)
  editor.revealLineInCenterIfOutsideViewport(start.lineNumber, monaco.editor.ScrollType.Smooth)
  editor.focus()
  flash?.clear()
  flash = editor.createDecorationsCollection([{ range: lineRange(ref.span), options: { isWholeLine: true, className: 'flash-range' } }])
  clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => flash?.clear(), 1400)
}

const hover = editor.createDecorationsCollection()
function hoverCode(ref: Ref | null) {
  // a whole contract would paint the entire file: mark just its header line
  const span = ref?.type === 'contract' ? { ...ref.span, endLine: ref.span.startLine } : ref?.span
  hover.set(ref && span ? [{ range: lineRange(span), options: { isWholeLine: true, className: 'hover-range', linesDecorationsClassName: 'hover-gutter' } }] : [])
}

function lineRange(s: Span) {
  return new monaco.Range(s.startLine, 1, s.endLine, 1)
}

// ---------- toolbar ----------
const fileInput = $<HTMLInputElement>('file')
$('open').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]
  if (f) loadCode(await f.text(), f.name)
  fileInput.value = ''
})
$('sample').addEventListener('click', () => loadCode(SAMPLE, ''))

/** Replace the editor content with code from elsewhere and frame the new map. */
function loadCode(code: string, label: string) {
  sourceLabel = label
  fitNext = true
  editor.setValue(code)
  editor.setPosition({ lineNumber: 1, column: 1 })
  editor.revealLine(1)
}

// ---------- GitHub import ----------
const gh = {
  dlg: $<HTMLDialogElement>('gh'),
  form: $<HTMLFormElement>('gh-form'),
  url: $<HTMLInputElement>('gh-url'),
  go: $<HTMLButtonElement>('gh-go'),
  flatten: $<HTMLInputElement>('gh-flatten'),
  status: $('gh-status'),
  filter: $<HTMLInputElement>('gh-filter'),
  list: $<HTMLUListElement>('gh-files'),
}
let ghFiles: { repo: RepoRef & { ref: string }; files: string[] } | undefined
const ghSay = (msg: string, err = false) => { gh.status.textContent = msg; gh.status.className = `gh-status${err ? ' err' : ''}` }

$('github').addEventListener('click', () => {
  if (!gh.url.value) gh.url.value = store.get('sol-blocks:gh') ?? ''
  gh.dlg.showModal()
  gh.url.focus()
  gh.url.select()
})
$('gh-close').addEventListener('click', () => gh.dlg.close())
gh.form.addEventListener('submit', async (e) => {
  e.preventDefault()
  gh.go.disabled = true
  try {
    await ghOpen(gh.url.value)
  } catch (err) {
    ghSay((err as Error).message, true)
  } finally {
    gh.go.disabled = false
  }
})

async function ghOpen(link: string) {
  const r = parseGitHubUrl(link)
  store.set('sol-blocks:gh', link.trim())
  ghSay('Reading repository…')
  const ref = r.ref ?? (await defaultBranch(r.owner, r.repo))
  const repo = { ...r, ref }
  if (r.kind === 'file') return ghLoadFile(repo)
  const { files, truncated } = await listSolidity(r.owner, r.repo, ref)
  const under = files.filter((f) => !r.path || f.startsWith(`${r.path}/`))
  if (!under.length) throw new Error(`No .sol files under ${r.path || 'the repository root'}`)
  // likely sources first; tests, scripts and vendored libraries last
  const rank = (f: string) => (/(^|\/)(lib|node_modules)\//.test(f) ? 2 : /(^|\/)(test|tests|script|scripts|mocks?)\/|\.(t|s)\.sol$/.test(f) ? 1 : 0)
  under.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  ghFiles = { repo, files: under }
  gh.filter.hidden = false
  gh.filter.value = ''
  renderGhFiles()
  ghSay(`${under.length} Solidity file${under.length > 1 ? 's' : ''} in ${r.owner}/${r.repo}@${ref}${truncated ? ' (GitHub truncated the listing)' : ''}. Pick one:`)
  gh.filter.focus()
}

function renderGhFiles() {
  if (!ghFiles) return
  const q = gh.filter.value.trim().toLowerCase()
  const shown = ghFiles.files.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 400)
  gh.list.replaceChildren(...shown.map((f) => {
    const li = document.createElement('li')
    const cut = f.lastIndexOf('/') + 1
    const kind = /(^|\/)(lib|node_modules)\//.test(f) ? 'library' : /(^|\/)(test|tests)\/|\.t\.sol$/.test(f) ? 'test' : /(^|\/)(script|scripts)\/|\.s\.sol$/.test(f) ? 'script' : ''
    li.innerHTML = `<span class="dir">${f.slice(0, cut)}</span><b>${f.slice(cut)}</b>${kind ? `<span class="tag">${kind}</span>` : ''}`
    li.addEventListener('click', () => ghLoadFile({ ...ghFiles!.repo, path: f, kind: 'file' }).catch((err) => ghSay((err as Error).message, true)))
    return li
  }))
}
gh.filter.addEventListener('input', renderGhFiles)

async function ghLoadFile(r: RepoRef & { ref: string }) {
  ghSay(`Loading ${r.path}…`)
  const out = gh.flatten.checked
    ? await flatten(r, { onProgress: (m) => ghSay(m) })
    : { source: await fetchRaw(r.owner, r.repo, r.ref, r.path), files: [r.path], missing: [] as string[] }
  const extra = out.files.length - 1
  loadCode(out.source, `${r.owner}/${r.repo} · ${r.path.split('/').pop()}${extra ? ` +${extra} imported` : ''}`)
  if (out.missing.length) {
    ghSay(`Loaded ${out.files.length} file${out.files.length > 1 ? 's' : ''}. Could not find: ${out.missing.join(', ')}`, true)
  } else {
    gh.dlg.close()
  }
}
// ---------- import from an EVM address ----------
const ad = {
  dlg: $<HTMLDialogElement>('addr'),
  form: $<HTMLFormElement>('addr-form'),
  chain: $<HTMLSelectElement>('addr-chain'),
  input: $<HTMLInputElement>('addr-input'),
  go: $<HTMLButtonElement>('addr-go'),
  depth: $<HTMLSelectElement>('addr-depth'),
  full: $<HTMLInputElement>('addr-full'),
  key: $<HTMLInputElement>('addr-key'),
  rpc: $<HTMLInputElement>('addr-rpc'),
  status: $('addr-status'),
  log: $<HTMLUListElement>('addr-log'),
}
// Blockscout explorers of chains found from pasted links, kept in this browser
const explorers: Explorer[] = (() => {
  try {
    const list = JSON.parse(store.get('solcity:explorers') ?? '[]') as Partial<Explorer>[]
    return list.filter((e): e is Explorer => typeof e?.origin === 'string' && /^https?:\/\/[^/]+$/.test(e.origin)
      && Number.isSafeInteger(e.chainId) && e.chainId! > 0 && typeof e.name === 'string')
  } catch {
    return []
  }
})()
explorers.forEach(addExplorer)
/** the chain list: the built-in chains, then the ones found from explorer links */
const fillChains = () => {
  const was = ad.chain.value
  const opt = (c: Chain) => new Option(c.name, String(c.id))
  const found = document.createElement('optgroup')
  found.label = 'From explorer links'
  found.append(...CHAINS.filter((c) => c.custom).map(opt))
  ad.chain.replaceChildren(...CHAINS.filter((c) => !c.custom).map(opt), ...(found.childElementCount ? [found] : []))
  if (was) ad.chain.value = was
}
fillChains()
ad.chain.value = store.get('solcity:chain') ?? '1'
if (!ad.chain.value) ad.chain.value = '1'
ad.depth.value = store.get('solcity:depth') ?? '1'
const adSay = (msg: string, err = false) => { ad.status.textContent = msg; ad.status.className = `gh-status${err ? ' err' : ''}` }
const adLog = (line: string, kind?: 'ok' | 'warn') => {
  const li = document.createElement('li')
  li.textContent = line
  if (kind) li.className = kind
  ad.log.append(li)
  li.scrollIntoView({ block: 'nearest' })
}
const rpcKey = () => `solcity:rpc:${ad.chain.value}`

$('address').addEventListener('click', () => {
  if (!ad.input.value) ad.input.value = store.get('solcity:addr') ?? ''
  ad.key.value = store.get('solcity:etherscan-key') ?? ''
  ad.rpc.value = store.get(rpcKey()) ?? ''
  ad.dlg.showModal()
  ad.input.focus()
  ad.input.select()
})
$('addr-close').addEventListener('click', () => ad.dlg.close())
ad.chain.addEventListener('change', () => (ad.rpc.value = store.get(rpcKey()) ?? ''))
/** select a chain, with the RPC node kept for it */
const pickChain = (id: number) => {
  if (ad.chain.value === String(id)) return
  ad.chain.value = String(id)
  ad.rpc.value = store.get(rpcKey()) ?? ''
}

const probes = new Map<string, Promise<Chain>>()
/** the chain an explorer solcity does not know shows: asked once, then kept in this browser */
function explorerChain(origin: string): Promise<Chain> {
  let p = probes.get(origin)
  if (!p) {
    p = probeExplorer(origin).then((e) => {
      const chain = addExplorer(e)
      if (!explorers.some((x) => x.origin === e.origin)) {
        explorers.push(e)
        store.set('solcity:explorers', JSON.stringify(explorers))
      }
      fillChains()
      return chain
    })
    p.catch(() => probes.delete(origin)) // asked again next time
    probes.set(origin, p)
  }
  return p
}
const asking = (origin: string) => adSay(`Asking ${new URL(origin).host} which chain it shows…`)

// an explorer link names its chain: pick it as soon as one is pasted
ad.input.addEventListener('input', () => {
  let t: Target
  try {
    t = parseTarget(ad.input.value, Number(ad.chain.value))
  } catch {
    return // not a whole address yet
  }
  adSay('')
  if (t.chainFromLink && CHAINS.some((c) => c.id === t.chainId)) pickChain(t.chainId)
  const origin = t.explorer
  if (!origin) return
  const host = new URL(origin).host
  const still = () => ad.input.value.toLowerCase().includes(host) // the answer is for what is in the box
  asking(origin)
  explorerChain(origin).then(
    (c) => {
      if (!still()) return
      pickChain(c.id)
      adSay(`${host}: Blockscout explorer of ${c.name} (chain ${c.id})`)
    },
    (err: Error) => { if (still()) adSay(err.message, true) },
  )
})
ad.form.addEventListener('submit', async (e) => {
  e.preventDefault()
  ad.go.disabled = true
  ad.log.replaceChildren()
  try {
    const t = parseTarget(ad.input.value, Number(ad.chain.value))
    if (t.explorer) asking(t.explorer)
    const chain = t.explorer ? await explorerChain(t.explorer) : CHAINS.find((c) => c.id === t.chainId)
    if (!chain) throw new Error(`Chain ${t.chainId} is not one solcity knows; pick a chain from the list and paste the bare address`)
    pickChain(chain.id)
    store.set('solcity:addr', ad.input.value.trim())
    store.set('solcity:chain', String(chain.id))
    store.set('solcity:depth', ad.depth.value)
    store.set('solcity:etherscan-key', ad.key.value.trim())
    store.set(rpcKey(), ad.rpc.value.trim())
    const depth = Number(ad.depth.value)
    adSay(`Reading ${chain.name}…`)
    const out = await importFromChain({
      chain, address: t.address, depth, max: depth > 1 ? 20 : 12, fullRelated: ad.full.checked,
      etherscanKey: ad.key.value.trim() || undefined, rpc: ad.rpc.value.trim() || undefined, onProgress: adLog,
    })
    loadCode(out.source, out.label)
    if (out.warnings.length) adSay(`Loaded ${out.contracts} contract${out.contracts > 1 ? 's' : ''}; ${out.warnings.length} could not be read fully (above).`, true)
    else ad.dlg.close()
  } catch (err) {
    adSay((err as Error).message, true)
  } finally {
    ad.go.disabled = false
  }
})

$('fit').addEventListener('click', () => scene.frameAll())
const follow = $<HTMLInputElement>('follow')
follow.addEventListener('change', () => (scene.followCamera = follow.checked))
const all = $<HTMLInputElement>('all')
all.addEventListener('change', () => {
  scene.showAllLinks = all.checked
  syncCursor()
})

// label visibility, remembered per browser
const labelsMode = $<HTMLSelectElement>('labels-mode')
const applyLabels = () => scene.setLabelMode(labelsMode.value as 'all' | 'cities' | 'off')
labelsMode.value = store.get('solcity:labels') ?? 'all'
applyLabels()
labelsMode.addEventListener('change', () => {
  store.set('solcity:labels', labelsMode.value)
  applyLabels()
})

// drop a .sol file anywhere on the code pane
const codePane = $('code-pane')
codePane.addEventListener('dragover', (e) => { e.preventDefault(); codePane.classList.add('drop') })
codePane.addEventListener('dragleave', () => codePane.classList.remove('drop'))
codePane.addEventListener('drop', async (e) => {
  e.preventDefault()
  codePane.classList.remove('drop')
  const f = e.dataTransfer?.files[0]
  if (f) loadCode(await f.text(), f.name)
})

// resizable split
const divider = $('divider')
divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const pct = Math.min(75, Math.max(25, (ev.clientX / window.innerWidth) * 100))
    document.body.style.setProperty('--split', `${pct}%`)
  }
  const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up) }
  divider.addEventListener('pointermove', move)
  divider.addEventListener('pointerup', up)
})

// legend
$('legend').innerHTML = `
  <div class="lg-title">Storeys = lines of code (glass colour = statement kind)</div>
  ${(['decl', 'assign', 'write', 'call', 'extcall', 'guard', 'if', 'loop', 'return', 'emit', 'revert'] as const)
    .map((k) => `<span><i style="--c:${STMT_COLORS[k]}"></i>${STMT_LABEL[k]}</span>`).join('')}
  <div class="lg-title">Buildings</div>
  <span class="row"><b>function</b> high-rise, one storey per line, lit windows; long ones step back in tiers</span>
  <span class="row"><b>inside if / for</b> storey set back like a balcony</span>
  <span class="row"><b>modifier</b> castle keep: stone storeys, turrets, flag</span>
  <span class="row"><b>interface / no body</b> glass tower · <b>_;</b> glass storey</span>
  <span class="row"><b>state variable</b> warehouse with a pitched roof</span>
  <span class="row"><b>constant</b> marble temple · <b>immutable</b> sandstone temple</span>
  <span class="row"><b>event</b> radio mast sending rings</span>
  <span class="row"><b>error</b> red and white traffic cone</span>
  <div class="lg-title">Warehouse = data type</div>
  <span><i class="sq" style="--c:#38bdf8"></i>value: shed</span><span><i class="sq" style="--c:#f59e0b"></i>mapping: lockers</span>
  <span><i class="sq" style="--c:#34d399"></i>array: row of units</span><span><i class="sq" style="--c:#a78bfa"></i>struct: 2 storeys</span>
  <span><i class="sq" style="--c:#f472b6"></i>string / bytes: sign</span>
  <div class="lg-title">Links</div>
  <span><i class="ln" style="--c:#22d3ee"></i>reads</span><span><i class="ln" style="--c:#fb923c"></i>writes</span>
  <span><i class="ln" style="--c:#c084fc"></i>calls</span><span><i class="ln" style="--c:#f9a8d4"></i>emits</span>
  <span><i class="ln" style="--c:#fb7185"></i>modifier</span><span><i class="ln" style="--c:#facc15"></i>calls other contract</span><span><i class="ln" style="--c:#ef4444"></i>reverts with error</span>
  <div class="lg-title">Roads between cities (contracts)</div>
  <span><i class="ln" style="--c:#a78bfa"></i>one-way: inheritance</span><span><i class="ln dash" style="--c:#facc15"></i>two-way: calls</span>
  <span><i class="ln dash" style="--c:#34d399"></i>on-chain: holds its address</span><span><i class="ln" style="--c:#38bdf8"></i>proxy: runs this code</span>
  <span class="row">where roads cross, the north–south road takes an overpass</span>
  <div class="lg-title">Towers</div>
  <span><i class="sq" style="--c:#8b5cf6"></i>external</span><span><i class="sq" style="--c:#3b82f6"></i>public</span>
  <span><i class="sq" style="--c:#64748b"></i>internal / private</span><span><i class="sq" style="--c:#fb7185"></i>modifier fence</span>
  <div class="lg-title">Roofs = what it does with state</div>
  <span class="row"><b>payable</b> gilded dome</span>
  <span class="row"><b>view</b> glass observation deck</span>
  <span class="row"><b>pure</b> roof garden</span>
  <span class="row"><b>changes state</b> plant room and antenna</span>
`
$('legend-toggle').addEventListener('click', () => $('legend').classList.toggle('open'))

update()
// start on a line that calls another contract, so the first view shows a road in use
const start = text.findMatches('asset.transferFrom', false, false, true, null, false)[0]?.range.startLineNumber ?? 1
editor.setPosition({ lineNumber: start, column: 9 })
editor.revealLineInCenter(start)

if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __editor: editor, __model: () => model })

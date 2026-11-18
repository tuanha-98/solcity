// Load verified contracts from an EVM address: the code deployed there, the implementation behind a
// proxy, and the contracts it points to (the addresses its getters return, read from the chain), each
// followed the same way up to a chosen number of hops. Source code comes from Sourcify or Blockscout
// (open, no key) or from Etherscan (with the user's own API key); chain state from a public JSON-RPC node.
//
// Everything ends up in one Solidity text: the sections of each address one after the other, with a
// header of `// @contract`, `// @proxy` and `// @link` lines that the model turns into on-chain roads.

import { parse } from '@solidity-parser/parser'
import { IMPORT_RE, dirOf, join } from './github'
import { checksum, keccakText, selector } from './keccak'

export interface Chain {
  id: number
  name: string
  rpc: string
  /** a Blockscout explorer of this chain that answers browsers (CORS) */
  blockscout?: string
  /** explorer hosts whose links point at this chain */
  hosts: string[]
}

export const CHAINS: Chain[] = [
  { id: 1, name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', blockscout: 'https://eth.blockscout.com', hosts: ['etherscan.io', 'eth.blockscout.com'] },
  { id: 8453, name: 'Base', rpc: 'https://base-rpc.publicnode.com', blockscout: 'https://base.blockscout.com', hosts: ['basescan.org', 'base.blockscout.com'] },
  { id: 42161, name: 'Arbitrum One', rpc: 'https://arbitrum-one-rpc.publicnode.com', blockscout: 'https://arbitrum.blockscout.com', hosts: ['arbiscan.io', 'arbitrum.blockscout.com'] },
  { id: 10, name: 'OP Mainnet', rpc: 'https://optimism-rpc.publicnode.com', blockscout: 'https://explorer.optimism.io', hosts: ['optimistic.etherscan.io', 'explorer.optimism.io', 'optimism.blockscout.com'] },
  { id: 137, name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', blockscout: 'https://polygon.blockscout.com', hosts: ['polygonscan.com', 'polygon.blockscout.com'] },
  { id: 56, name: 'BNB Smart Chain', rpc: 'https://bsc-dataseed.bnbchain.org', hosts: ['bscscan.com'] },
  { id: 43114, name: 'Avalanche C-Chain', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', hosts: ['snowtrace.io', 'snowscan.xyz'] },
  { id: 100, name: 'Gnosis', rpc: 'https://gnosis-rpc.publicnode.com', hosts: ['gnosisscan.io', 'gnosis.blockscout.com'] },
  { id: 59144, name: 'Linea', rpc: 'https://linea-rpc.publicnode.com', hosts: ['lineascan.build'] },
  { id: 534352, name: 'Scroll', rpc: 'https://scroll-rpc.publicnode.com', hosts: ['scrollscan.com'] },
  { id: 130, name: 'Unichain', rpc: 'https://unichain-rpc.publicnode.com', blockscout: 'https://unichain.blockscout.com', hosts: ['uniscan.xyz', 'unichain.blockscout.com'] },
  { id: 11155111, name: 'Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', blockscout: 'https://eth-sepolia.blockscout.com', hosts: ['sepolia.etherscan.io', 'eth-sepolia.blockscout.com'] },
  { id: 84532, name: 'Base Sepolia', rpc: 'https://base-sepolia-rpc.publicnode.com', blockscout: 'https://base-sepolia.blockscout.com', hosts: ['sepolia.basescan.org', 'base-sepolia.blockscout.com'] },
]

export const shortAddress = (a: string) => {
  const c = checksum(a)
  return `${c.slice(0, 6)}…${c.slice(-4)}`
}

/** An address (on `fallbackChain`), an explorer link (etherscan.io/address/0x…, basescan.org/token/0x…), or eip155:<chain>:<address>. */
export function parseTarget(input: string, fallbackChain: number): { chainId: number; address: string; chainFromLink: boolean } {
  const s = input.trim()
  const caip = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/i.exec(s)
  if (caip) return { chainId: Number(caip[1]), address: caip[2].toLowerCase(), chainFromLink: true }
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { chainId: fallbackChain, address: s.toLowerCase(), chainFromLink: false }
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    throw new Error('Paste a contract address (0x… and 40 hex digits) or an explorer link')
  }
  const m = /0x[0-9a-fA-F]{40}/.exec(url.pathname + url.hash)
  if (!m) throw new Error('No contract address in this link')
  const host = url.hostname.replace(/^www\./, '')
  const chain = CHAINS.find((c) => c.hosts.includes(host))
  // Sourcify links name the chain by its id: repo.sourcify.dev/1/0x…
  const sourcify = /(^|\.)sourcify\.dev$/.test(host) ? /\/(\d+)\/0x[0-9a-fA-F]{40}/.exec(url.pathname + url.hash) : null
  const chainId = chain?.id ?? (sourcify ? Number(sourcify[1]) : fallbackChain)
  return { chainId, address: m[0].toLowerCase(), chainFromLink: !!chain || !!sourcify }
}

// ---------------------------------------------------------------------------
// verified source

interface AbiParam { type: string; name?: string }
interface AbiItem { type: string; name?: string; inputs?: AbiParam[]; outputs?: AbiParam[]; stateMutability?: string; constant?: boolean }

export interface Verified {
  address: string
  /** the contract compiled for this address */
  name: string
  /** the file that defines it */
  main: string
  files: Map<string, string>
  abi: AbiItem[]
  remappings: string[]
  compiler: string
  language: string
  provider: 'Sourcify' | 'Blockscout' | 'Etherscan'
  /** implementations the provider reports when the address is a proxy */
  implementations: string[]
}

async function getJson<T>(url: string): Promise<{ status: number; body?: T }> {
  let r: Response
  try {
    r = await fetch(url)
  } catch {
    throw new Error('network error')
  }
  if (r.status === 429) throw new Error('rate limited, try again in a minute')
  if (r.status >= 500) throw new Error(`server error ${r.status}`)
  try {
    return { status: r.status, body: (await r.json()) as T }
  } catch {
    return { status: r.status }
  }
}

const isAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const definesRe = (name: string) => new RegExp(`\\b(contract|library|interface)\\s+${name}\\b`)

/** the file that defines `name`: preferably one named after it */
function findMain(files: Map<string, string>, name: string) {
  const re = definesRe(name)
  const paths = [...files.keys()]
  return paths.find((p) => p.split('/').pop() === `${name}.sol` && re.test(files.get(p)!)) ?? paths.find((p) => re.test(files.get(p)!)) ?? paths[0]
}

async function fromSourcify(chain: Chain, address: string): Promise<Verified | undefined> {
  type R = {
    compilation?: { name: string; fullyQualifiedName?: string; compilerVersion?: string; language?: string; compilerSettings?: { remappings?: string[] } }
    sources?: Record<string, { content: string }>
    abi?: AbiItem[]
    proxyResolution?: { implementations?: { address?: string }[] }
  }
  const { status, body } = await getJson<R>(`https://sourcify.dev/server/v2/contract/${chain.id}/${address}?fields=sources,compilation,abi,proxyResolution`)
  const c = body?.compilation
  if (status !== 200 || !c || !body?.sources) return undefined
  const files = new Map(Object.entries(body.sources).map(([p, s]) => [p, s.content]))
  const fqn = c.fullyQualifiedName ?? ''
  const main = fqn.includes(':') && files.has(fqn.slice(0, fqn.lastIndexOf(':'))) ? fqn.slice(0, fqn.lastIndexOf(':')) : findMain(files, c.name)
  return {
    address, name: c.name, main, files, abi: body.abi ?? [], remappings: c.compilerSettings?.remappings ?? [],
    compiler: c.compilerVersion ?? '', language: c.language ?? 'Solidity', provider: 'Sourcify',
    implementations: (body.proxyResolution?.implementations ?? []).map((i) => i.address).filter(isAddress).map((a) => a.toLowerCase()),
  }
}

async function fromBlockscout(chain: Chain, address: string): Promise<Verified | undefined> {
  if (!chain.blockscout) return undefined
  type R = {
    name?: string; file_path?: string; source_code?: string; language?: string; compiler_version?: string
    additional_sources?: { file_path: string; source_code: string }[]
    abi?: AbiItem[]
    compiler_settings?: { remappings?: string[] }
    implementations?: { address_hash?: string; address?: string }[]
  }
  const { status, body } = await getJson<R>(`${chain.blockscout}/api/v2/smart-contracts/${address}`)
  if (status !== 200 || !body?.source_code || !body.name) return undefined
  const files = new Map<string, string>([[body.file_path || `${body.name}.sol`, body.source_code]])
  for (const s of body.additional_sources ?? []) files.set(s.file_path, s.source_code)
  return {
    address, name: body.name, main: body.file_path || findMain(files, body.name), files, abi: body.abi ?? [],
    remappings: body.compiler_settings?.remappings ?? [], compiler: body.compiler_version ?? '', language: body.language ?? 'solidity',
    provider: 'Blockscout',
    implementations: (body.implementations ?? []).map((i) => i.address_hash ?? i.address).filter(isAddress).map((a) => a.toLowerCase()),
  }
}

async function fromEtherscan(chain: Chain, address: string, key: string): Promise<Verified | undefined> {
  type R = { status: string; result: string | { SourceCode: string; ABI: string; ContractName: string; CompilerVersion: string; Proxy: string; Implementation: string }[] }
  const { body } = await getJson<R>(`https://api.etherscan.io/v2/api?chainid=${chain.id}&module=contract&action=getsourcecode&address=${address}&apikey=${encodeURIComponent(key)}`)
  if (!body) throw new Error('unreadable answer')
  if (body.status !== '1' || typeof body.result === 'string') throw new Error(typeof body.result === 'string' ? body.result : 'not found')
  const r = body.result[0]
  if (!r?.SourceCode || !r.ContractName) return undefined
  const files = new Map<string, string>()
  let remappings: string[] = []
  let raw = r.SourceCode.trim()
  if (raw.startsWith('{')) {
    // multi-file: {{ standard JSON input }} or { "path": { "content": … } }
    if (raw.startsWith('{{')) raw = raw.slice(1, -1)
    const j = JSON.parse(raw) as { sources?: Record<string, { content: string }>; settings?: { remappings?: string[] } } & Record<string, { content: string }>
    for (const [p, s] of Object.entries(j.sources ?? j)) if (typeof s?.content === 'string') files.set(p, s.content)
    remappings = j.settings?.remappings ?? []
  } else files.set(`${r.ContractName}.sol`, raw)
  let abi: AbiItem[] = []
  try { abi = JSON.parse(r.ABI) as AbiItem[] } catch { /* "Contract source code not verified" */ }
  return {
    address, name: r.ContractName, main: findMain(files, r.ContractName), files, abi, remappings,
    compiler: r.CompilerVersion ?? '', language: /vyper/i.test(r.CompilerVersion ?? '') ? 'Vyper' : 'Solidity', provider: 'Etherscan',
    implementations: r.Proxy === '1' && isAddress(r.Implementation) ? [r.Implementation.toLowerCase()] : [],
  }
}

/** Verified source of an address: Sourcify first, then Blockscout, then Etherscan when there is a key. */
async function fetchVerified(chain: Chain, address: string, etherscanKey?: string): Promise<{ v?: Verified; tried: string[] }> {
  const tried: string[] = []
  const sources: [string, () => Promise<Verified | undefined>][] = [['Sourcify', () => fromSourcify(chain, address)]]
  if (chain.blockscout) sources.push(['Blockscout', () => fromBlockscout(chain, address)])
  if (etherscanKey) sources.push(['Etherscan', () => fromEtherscan(chain, address, etherscanKey)])
  for (const [name, f] of sources) {
    try {
      const v = await f()
      if (v) return { v, tried }
      tried.push(`${name}: not verified`)
    } catch (e) {
      tried.push(`${name}: ${(e as Error).message}`)
    }
  }
  return { tried }
}

// ---------------------------------------------------------------------------
// reading the chain

type Call = { method: string; params: unknown[] }

/** JSON-RPC calls in batches; a call that fails gives undefined. */
async function rpc(url: string, calls: Call[]): Promise<(string | undefined)[]> {
  const out: (string | undefined)[] = []
  for (let i = 0; i < calls.length; i += 20) {
    const chunk = calls.slice(i, i + 20)
    let r: Response
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk.map((c, k) => ({ jsonrpc: '2.0', id: k, ...c }))),
      })
    } catch {
      throw new Error('could not reach the RPC node')
    }
    if (!r.ok) throw new Error(`RPC node answered ${r.status}${r.status === 429 ? ' (rate limited)' : ''}`)
    const j = (await r.json()) as { id: number; result?: unknown } | { id: number; result?: unknown }[]
    const res: (string | undefined)[] = chunk.map(() => undefined)
    for (const x of Array.isArray(j) ? j : [j]) if (typeof x.id === 'number' && typeof x.result === 'string') res[x.id] = x.result
    out.push(...res)
  }
  return out
}

const ZERO = `0x${'0'.repeat(40)}`
/** an address stored in a 32-byte word (the upper 12 bytes zero), unless it is zero */
function wordAddress(word?: string): string | undefined {
  if (!word || word.length < 66) return undefined
  const w = word.slice(2, 66).toLowerCase()
  if (!/^0{24}[0-9a-f]{40}$/.test(w)) return undefined
  const a = `0x${w.slice(24)}`
  return a === ZERO ? undefined : a
}
/** the addresses of an ABI-encoded address[] (first 10) */
function arrayAddresses(data?: string): string[] {
  if (!data || data.length < 130) return []
  const hex = data.slice(2)
  const word = (i: number) => hex.slice(i * 64, i * 64 + 64)
  const off = parseInt(word(0), 16) / 32
  if (!Number.isInteger(off) || off < 1 || (off + 1) * 64 > hex.length) return []
  const n = Math.min(parseInt(word(off), 16) || 0, 10)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const a = wordAddress(`0x${word(off + 1 + i)}`)
    if (a) out.push(a)
  }
  return out
}

// where proxies keep their implementation (EIP-1967, EIP-1822, ZeppelinOS) and admin
let slots: { impl: string[]; beacon: string; admin: string[] } | undefined
const SLOTS = () => {
  const s1967 = (label: string) => `0x${(BigInt(`0x${keccakText(label)}`) - 1n).toString(16).padStart(64, '0')}`
  return (slots ??= {
    impl: [s1967('eip1967.proxy.implementation'), `0x${keccakText('PROXIABLE')}`, `0x${keccakText('org.zeppelinos.proxy.implementation')}`],
    beacon: s1967('eip1967.proxy.beacon'),
    admin: [s1967('eip1967.proxy.admin'), `0x${keccakText('org.zeppelinos.proxy.admin')}`],
  })
}
/** EIP-1167 minimal proxy: the implementation is in the bytecode */
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i

/** view functions without arguments that return an address (or a list of them) */
const addressGetters = (abi: AbiItem[]) => abi
  .filter((f) => f.type === 'function' && !!f.name && !f.inputs?.length && f.outputs?.length === 1
    && (f.stateMutability === 'view' || f.stateMutability === 'pure' || f.constant === true)
    && (f.outputs[0].type === 'address' || f.outputs[0].type === 'address[]'))
  .slice(0, 48)

/** addresses written in the code (comments left out), with the constant they are assigned to */
function literalAddresses(text: string): { via: string; address: string }[] {
  const out = new Map<string, string>()
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  for (const m of code.matchAll(/(?:\b(\w+)\s*=\s*(?:\w+\s*\(\s*)*)?\b(0x[0-9a-fA-F]{40})\b/g)) {
    const a = m[2].toLowerCase()
    if (!out.has(a)) out.set(a, m[1] && !/^(address|payable)$/.test(m[1]) ? m[1] : 'literal')
  }
  return [...out].map(([address, via]) => ({ address, via }))
}

const isContractCode = (code?: string) => !!code && code !== '0x' && !/^0xef0100/i.test(code) // EIP-7702 accounts are not contracts

// ---------------------------------------------------------------------------
// one Solidity text

type Top = { type: string; name?: string; kind?: string; range?: [number, number]; baseContracts?: { baseName: { namePath: string } }[] }
const parsedCache = new Map<string, Top[] | null>()
function topLevel(text: string): Top[] | undefined {
  if (!parsedCache.has(text)) {
    let nodes: Top[] | null = null
    try {
      nodes = (parse(text, { range: true, tolerant: true }) as unknown as { children: Top[] }).children
    } catch { /* left as it is */ }
    parsedCache.set(text, nodes)
  }
  return parsedCache.get(text) ?? undefined
}

/** The files a contract is built from, in reading order: its own file, then its imports, depth first. */
function readingOrder(v: Verified): { order: string[]; missing: string[] } {
  const keys = [...v.files.keys()]
  const remaps = v.remappings
    .map((r) => (r.includes(':') ? r.slice(r.indexOf(':') + 1) : r).split('='))
    .filter((r): r is [string, string] => r.length === 2 && !!r[0])
  const resolve = (from: string, spec: string) => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const p = join(dirOf(from), spec)
      if (v.files.has(p)) return p
    }
    if (v.files.has(spec)) return spec
    for (const [prefix, target] of remaps) {
      if (!spec.startsWith(prefix)) continue
      const p = join('', target + spec.slice(prefix.length))
      if (v.files.has(p)) return p
    }
    const tail = keys.filter((k) => k.endsWith(`/${spec.replace(/^(\.\.?\/)+/, '')}`)).sort((a, b) => a.length - b.length)
    if (tail.length) return tail[0]
    const base = spec.split('/').pop()
    const same = keys.filter((k) => k.split('/').pop() === base)
    return same.length === 1 ? same[0] : undefined
  }
  const order: string[] = []
  const missing: string[] = []
  const walk = (p: string) => {
    if (order.includes(p)) return
    order.push(p)
    for (const m of v.files.get(p)!.matchAll(IMPORT_RE)) {
      const dep = resolve(p, m[1])
      if (dep) walk(dep)
      else if (!missing.includes(m[1])) missing.push(m[1])
    }
  }
  if (v.files.has(v.main)) walk(v.main)
  return { order, missing }
}

/** the contract and every contract it inherits from, by name, as defined in these files */
function lineage(files: { nodes?: Top[] }[], name: string): Set<string> {
  const bases = new Map<string, string[]>()
  for (const f of files) for (const n of f.nodes ?? []) {
    if (n.type === 'ContractDefinition' && n.name && !bases.has(n.name)) bases.set(n.name, (n.baseContracts ?? []).map((b) => b.baseName.namePath.split('.').pop()!))
  }
  const out = new Set<string>()
  const visit = (n: string) => {
    if (out.has(n) || !bases.has(n)) return
    out.add(n)
    bases.get(n)!.forEach(visit)
  }
  visit(name)
  return out
}

interface Section {
  address: string
  v?: Verified
  /** 'full': every file it is compiled from; 'own': the contract itself and what it inherits */
  mode: 'full' | 'own'
  /** how the import got here: 'token0 of UniswapV3Pool' */
  note: string
  /** the city's name (set when assembled; the contract name, renamed if another address has it) */
  name: string
}

export interface Link {
  /** address whose code holds the reference (for a proxy's implementation: the implementation) */
  from: string
  to: string
  via: string
  kind: 'ref' | 'proxy'
}

const FILE_LEVEL = new Set(['StructDefinition', 'EnumDefinition', 'CustomErrorDefinition', 'TypeDefinition', 'FunctionDefinition', 'FileLevelConstant', 'EventDefinition'])
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

function assemble(chain: Chain, sections: Section[], links: Link[], notes: string[]): string {
  // every name written so far (each Solidity name may be defined once), and the address a contract stands for
  const written = new Map<string, { text: string; address?: string }>()
  const fileLevel = new Set<string>()
  const unique = (base: string) => {
    let n = base
    for (let i = 2; written.has(n); i++) n = `${base}_${i}`
    return n
  }
  const body: string[] = []
  for (const sec of sections) {
    const v = sec.v
    if (!v) {
      sec.name = unique(`Unverified_${sec.address.slice(2, 8)}`)
      written.set(sec.name, { text: '', address: sec.address })
      body.push(`// ===== ${sec.name} · ${checksum(sec.address)} · ${sec.note} · no verified source =====\ncontract ${sec.name} {}\n`)
      continue
    }
    const files = readingOrder(v).order.map((path) => ({ path, text: v.files.get(path)!, nodes: topLevel(v.files.get(path)!) }))
    const keep = sec.mode === 'own' ? lineage(files, v.name) : undefined
    // the city of this address keeps the contract's name; when that name is taken: the same code is the
    // same city, other code is renamed
    const mainNode = files.flatMap((f) => (f.nodes ?? []).filter((n) => n.type === 'ContractDefinition' && n.name === v.name && n.range).map((n) => ({ f, n })))[0]
    const mainText = mainNode ? mainNode.f.text.slice(mainNode.n.range![0], mainNode.n.range![1] + 1) : ''
    const prev = written.get(v.name)
    let rename: string | undefined
    if (!prev) sec.name = v.name
    else if (!prev.address && squash(prev.text) === squash(mainText)) {
      prev.address = sec.address
      sec.name = v.name
    } else sec.name = rename = unique(`${v.name}_${sec.address.slice(2, 6)}`)

    const parts: string[] = []
    for (const f of files) {
      let text = f.text
      if (!f.nodes) {
        // could not be parsed: kept as it is when everything is wanted, else left out
        if (sec.mode === 'own' && f.path !== v.main) continue
        parts.push(`// ----- ${f.path} -----\n${text.replace(IMPORT_RE, (line) => `// ${line.trim()}  (flattened)`)}`)
        continue
      }
      const edits: { at: number; end: number; text: string }[] = []
      let kept = 0
      for (const n of f.nodes) {
        if (!n.range) continue
        const at = n.range[0], end = n.range[1] + 1
        if (n.type === 'ImportDirective') {
          edits.push({ at, end, text: `// ${squash(text.slice(at, end))}  (flattened)` })
        } else if (n.type === 'ContractDefinition' && n.name) {
          if (n.name === v.name && rename) {
            const head = /^(?:abstract\s+)?(?:contract|library|interface)\s+/.exec(text.slice(at, end))
            if (head) edits.push({ at: at + head[0].length, end: at + head[0].length + v.name.length, text: rename })
            written.set(rename, { text: text.slice(at, end), address: sec.address })
            kept++
          } else if (keep && !keep.has(n.name)) {
            edits.push({ at, end, text: '' })
          } else if (written.has(n.name)) {
            edits.push({ at, end, text: `// ${n.kind ?? 'contract'} ${n.name}: see above` })
          } else {
            written.set(n.name, { text: text.slice(at, end), address: n.name === v.name ? sec.address : undefined })
            kept++
          }
        } else if (FILE_LEVEL.has(n.type) && n.name) {
          const key = `${n.type}:${n.name}`
          if (fileLevel.has(key)) edits.push({ at, end, text: '' })
          else {
            fileLevel.add(key)
            kept++
          }
        }
      }
      if (!kept && sec.mode === 'own') continue
      for (const e of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.text + text.slice(e.end)
      parts.push(`// ----- ${f.path} -----\n${text.replace(/\n{4,}/g, '\n\n\n').trim()}\n`)
    }
    const how = `${sec.note} · verified on ${v.provider}${v.compiler ? ` · ${v.compiler.replace(/^v/, '').replace(/\+commit.*$/, '')}` : ''}`
    body.push(`// ===== ${sec.name} · ${checksum(sec.address)} · ${how} =====\n\n${parts.join('\n')}`)
  }

  const nameOf = new Map(sections.map((s) => [s.address, s.name]))
  const head = [
    `// solcity: contracts read from ${chain.name} (chain ${chain.id}) on ${new Date().toISOString().slice(0, 10)}.`,
    '// Each @contract line is the verified code at an address; @proxy joins a proxy to the code it runs;',
    '// @link is an address one contract holds (read from the chain), drawn as an on-chain road.',
    `// @chain ${chain.id} ${chain.name}`,
    ...sections.map((s) => `// @contract ${s.name} ${checksum(s.address)}${s.v ? '' : ' unverified'}`),
    ...links.filter((l) => nameOf.has(l.from) && nameOf.has(l.to)).map((l) => (l.kind === 'proxy'
      ? `// @proxy ${nameOf.get(l.from)} -> ${nameOf.get(l.to)}`
      : `// @link ${nameOf.get(l.from)}.${l.via} -> ${nameOf.get(l.to)}`)),
    ...notes.map((n) => `// ${n}`),
  ]
  return `${head.join('\n')}\n\n${body.join('\n\n')}`
}

// ---------------------------------------------------------------------------

export interface ImportOptions {
  chain: Chain
  address: string
  /** how many hops to follow from the address (0: only it, and its implementation if it is a proxy) */
  depth: number
  /** most addresses to load */
  max: number
  /** load related contracts with their libraries and interfaces (otherwise: the contract and its bases) */
  fullRelated: boolean
  etherscanKey?: string
  /** a JSON-RPC URL to use instead of the chain's public node */
  rpc?: string
  onProgress?: (line: string, kind?: 'ok' | 'warn') => void
}

export interface ImportResult {
  source: string
  /** short description for the status bar */
  label: string
  /** things that could not be loaded */
  warnings: string[]
  contracts: number
}

async function inParallel<T>(items: T[], limit: number, f: (x: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await f(items[next++])
  }))
}

export async function importFromChain(o: ImportOptions): Promise<ImportResult> {
  const say = o.onProgress ?? (() => {})
  const rpcUrl = o.rpc?.trim() || o.chain.rpc
  type Node = Section & { depth: number; state: string; impl: boolean; proxy: boolean; tried: string[] }
  const nodes = new Map<string, Node>()
  const links: Link[] = []
  const notes: string[] = []
  const warnings: string[] = []
  const codes = new Map<string, string | undefined>()
  let queue: Node[] = []
  let capped = false
  const add = (address: string, depth: number, note: string, mode: Section['mode'], state = address, impl = false) => {
    const have = nodes.get(address)
    if (have) return have
    if (nodes.size >= o.max) {
      capped = true
      return undefined
    }
    const n: Node = { address, mode, note, name: '', depth, state, impl, proxy: false, tried: [] }
    nodes.set(address, n)
    queue.push(n)
    return n
  }
  const warn = (msg: string) => {
    warnings.push(msg)
    say(msg, 'warn')
  }
  const label = (n: Node) => n.v?.name ?? shortAddress(n.address)
  const codeOf = async (addresses: string[]) => {
    const unknown = [...new Set(addresses.filter((a) => !codes.has(a)))]
    const res = await rpc(rpcUrl, unknown.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })))
    unknown.forEach((a, i) => codes.set(a, res[i]))
  }

  /** what a contract points to: its implementation if it is a proxy, and the addresses it holds */
  const follow = async (n: Node) => {
    const refs: { via: string; address: string }[] = []
    const hops = n.depth < o.depth
    if (!n.impl) {
      await codeOf([n.address])
      if (!isContractCode(codes.get(n.address))) {
        warn(`${shortAddress(n.address)} has no contract code on ${o.chain.name}`)
        return
      }
      const S = SLOTS()
      const words = await rpc(rpcUrl, [...S.impl, S.beacon, ...S.admin].map((s) => ({ method: 'eth_getStorageAt', params: [n.address, s, 'latest'] })))
      const impls = new Set(n.v?.implementations ?? [])
      const minimal = MINIMAL_PROXY.exec(codes.get(n.address) ?? '')
      if (minimal) impls.add(`0x${minimal[1].toLowerCase()}`)
      for (const w of words.slice(0, S.impl.length)) { const a = wordAddress(w); if (a) impls.add(a) }
      const beacon = wordAddress(words[S.impl.length])
      if (beacon) {
        const [r] = await rpc(rpcUrl, [{ method: 'eth_call', params: [{ to: beacon, data: selector('implementation()') }, 'latest'] }])
        const a = wordAddress(r)
        if (a) impls.add(a)
        if (hops) refs.push({ via: 'beacon', address: beacon })
      }
      for (const w of words.slice(S.impl.length + 1)) { const a = wordAddress(w); if (a && hops) refs.push({ via: 'admin', address: a }) }
      impls.delete(n.address)
      for (const a of impls) {
        n.proxy = true
        // the implementation's code runs on the proxy's storage: one stop, at the same depth
        const m = add(a, n.depth, `implementation of ${label(n)}`, n.mode, n.address, true)
        if (m) links.push({ kind: 'proxy', from: n.address, to: a, via: 'implementation' })
        say(`${label(n)} is a proxy for ${shortAddress(a)}`)
      }
    }
    // the addresses it holds: its getters (a proxy's are asked through its implementation) and the
    // addresses written in its code
    if (hops && n.v && !n.proxy) {
      const getters = addressGetters(n.v.abi)
      const res = await rpc(rpcUrl, getters.map((g) => ({ method: 'eth_call', params: [{ to: n.state, data: selector(`${g.name}()`) }, 'latest'] })))
      getters.forEach((g, i) => {
        const found = g.outputs![0].type === 'address' ? [wordAddress(res[i])].filter((a): a is string => !!a) : arrayAddresses(res[i])
        found.forEach((a, k) => refs.push({ via: found.length > 1 ? `${g.name}[${k}]` : g.name!, address: a }))
      })
      for (const r of literalAddresses(n.v.files.get(n.v.main) ?? '')) refs.push(r)
    }
    if (!refs.length) return
    await codeOf(refs.map((r) => r.address))
    const seen = new Set<string>()
    for (const r of refs) {
      if (r.address === n.address || r.address === n.state || seen.has(`${r.via}>${r.address}`)) continue
      seen.add(`${r.via}>${r.address}`)
      if (!isContractCode(codes.get(r.address))) {
        if (r.via !== 'literal' && codes.get(r.address) !== undefined) notes.push(`${r.via} of ${label(n)} is ${checksum(r.address)}, an account (not a contract)`)
        continue
      }
      const m = add(r.address, n.depth + 1, `${r.via} of ${label(n)}`, o.fullRelated ? 'full' : 'own')
      if (!m) continue
      links.push({ kind: 'ref', from: n.address, to: r.address, via: r.via })
      say(`${label(n)}.${r.via} → ${shortAddress(r.address)}`)
    }
  }

  add(o.address, 0, 'requested', 'full')
  while (queue.length) {
    const round = queue
    queue = []
    await inParallel(round, 4, async (n) => {
      say(`Reading ${shortAddress(n.address)}…`)
      const { v, tried } = await fetchVerified(o.chain, n.address, o.etherscanKey)
      n.tried = tried
      if (v && !/solidity/i.test(v.language)) warn(`${v.name} at ${shortAddress(n.address)} is written in ${v.language}; solcity reads Solidity only`)
      else if (v) {
        n.v = v
        say(`${v.name} at ${shortAddress(n.address)} (${v.provider})`, 'ok')
      } else if (n.depth > 0 || n.impl) warn(`${shortAddress(n.address)} (${n.note}): no verified source`)
    })
    await inParallel(round, 3, async (n) => {
      try {
        await follow(n)
      } catch (e) {
        warn(`${label(n)}: could not read the chain (${(e as Error).message})`)
      }
    })
  }
  if (capped) warn(`Stopped at ${o.max} contracts; follow fewer hops to see the rest`)

  const root = nodes.get(o.address)!
  const all = [...nodes.values()]
  if (!all.some((n) => n.v)) {
    const how = root.tried.join('; ')
    throw new Error(`No verified Solidity source for ${shortAddress(o.address)} on ${o.chain.name}${how ? ` (${how})` : ''}.${o.etherscanKey ? '' : ' With an Etherscan API key, Etherscan is tried too.'}`)
  }
  for (const n of all) {
    if (!n.v) continue
    const { missing } = readingOrder(n.v)
    if (missing.length) warn(`${n.v.name}: could not place ${missing.length} import${missing.length > 1 ? 's' : ''} (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''})`)
  }
  const source = assemble(o.chain, all, links, notes)
  const rootName = root.v?.name ?? nodes.get(links.find((l) => l.kind === 'proxy' && l.from === root.address)?.to ?? '')?.v?.name ?? shortAddress(o.address)
  const more = all.length - 1
  return {
    source,
    label: `${o.chain.name} ${shortAddress(o.address)} · ${rootName}${more ? ` +${more} linked` : ''}`,
    warnings,
    contracts: all.length,
  }
}

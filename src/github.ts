// Load Solidity from public GitHub repositories.
// Files come from raw.githubusercontent.com (no rate limit); listing a repo uses the GitHub REST API
// (unauthenticated: about 60 requests per hour). Package imports (@openzeppelin/…, forge-std/…) are
// fetched from unpkg when the repo itself does not contain them.

export interface RepoRef {
  owner: string
  repo: string
  /** branch, tag or commit; resolved to the default branch when missing */
  ref?: string
  /** file or folder inside the repo ('' = root) */
  path: string
  kind: 'file' | 'tree'
}

/** github.com/o/r, …/tree/ref/dir, …/blob/ref/file.sol, raw.githubusercontent.com/o/r/ref/file.sol */
export function parseGitHubUrl(input: string): RepoRef {
  const url = new URL(input.trim().replace(/^(?!https?:\/\/)/, 'https://'))
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...rest] = parts
    if (!owner || !repo || !ref || !rest.length) throw new Error('Unrecognised raw GitHub URL')
    return { owner, repo, ref, path: rest.join('/'), kind: 'file' }
  }
  if (!/(^|\.)github\.com$/.test(url.hostname)) throw new Error('Not a GitHub URL')
  const [owner, repoRaw, mode, ref, ...rest] = parts
  if (!owner || !repoRaw) throw new Error('URL needs at least github.com/owner/repo')
  const repo = repoRaw.replace(/\.git$/, '')
  if (!mode) return { owner, repo, path: '', kind: 'tree' }
  if (mode === 'blob' && ref) return { owner, repo, ref, path: rest.join('/'), kind: 'file' }
  if (mode === 'tree' && ref) return { owner, repo, ref, path: rest.join('/'), kind: 'tree' }
  throw new Error('Use a link to a repo, a folder (/tree/…) or a file (/blob/…)')
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (r.status === 403 || r.status === 429) throw new Error('GitHub API rate limit reached (about 60 requests per hour without sign-in). Try again later, or paste a link to a single file.')
  if (r.status === 404) throw new Error('Not found. Is the repository public and the link correct?')
  if (!r.ok) throw new Error(`GitHub API: ${r.status} ${r.statusText}`)
  return r.json() as Promise<T>
}

export async function defaultBranch(owner: string, repo: string) {
  return (await json<{ default_branch: string }>(`https://api.github.com/repos/${owner}/${repo}`)).default_branch
}

/** All .sol files of a repo at a ref (one API call). */
export async function listSolidity(owner: string, repo: string, ref: string): Promise<{ files: string[]; truncated: boolean }> {
  const t = await json<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  )
  return { files: t.tree.filter((e) => e.type === 'blob' && e.path.endsWith('.sol')).map((e) => e.path).sort(), truncated: t.truncated }
}

export async function fetchRaw(owner: string, repo: string, ref: string, path: string) {
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`)
  if (!r.ok) throw new Error(`${path}: ${r.status === 404 ? 'not found' : r.statusText}`)
  return r.text()
}

// ---------------------------------------------------------------------------
// flattening: the chosen file first, then every file it imports (recursively), imports commented out

const IMPORT_RE = /^[ \t]*import\s+(?:[^;]*?\bfrom\s+)?["']([^"']+)["'][^;]*;/gm

function join(dir: string, rel: string) {
  const out = dir ? dir.split('/') : []
  for (const seg of rel.split('/')) {
    if (seg === '..') out.pop()
    else if (seg !== '.' && seg !== '') out.push(seg)
  }
  return out.join('/')
}
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')

type Source = { kind: 'repo'; path: string } | { kind: 'npm'; path: string }

export interface Flattened {
  source: string
  /** files included, in order (repo paths, or npm:… for packages) */
  files: string[]
  /** imports that could not be found */
  missing: string[]
}

export async function flatten(r: RepoRef & { ref: string }, opts: { maxFiles?: number; onProgress?: (msg: string) => void } = {}): Promise<Flattened> {
  const max = opts.maxFiles ?? 60
  let tree: Set<string> | undefined
  const repoFiles = async () => {
    tree ??= new Set((await listSolidity(r.owner, r.repo, r.ref)).files)
    return tree
  }
  const seen = new Map<string, string>() // key → text
  const order: string[] = []
  const missing: string[] = []

  const load = async (src: Source): Promise<string> =>
    src.kind === 'repo'
      ? fetchRaw(r.owner, r.repo, r.ref, src.path)
      : fetch(`https://unpkg.com/${src.path}`).then((res) => {
        if (!res.ok) throw new Error(`${src.path}: ${res.status}`)
        return res.text()
      })

  /** Resolve an import written in `from` to a repo file or an npm package file. */
  const resolve = async (from: Source, spec: string): Promise<Source | undefined> => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return { kind: from.kind, path: join(dirOf(from.path), spec) } as Source
    }
    if (from.kind === 'npm') return { kind: 'npm', path: spec }
    const files = await repoFiles().catch(() => new Set<string>())
    // the import as a repo path, under common source roots, or in a vendored lib/ folder (foundry)
    const seg = spec.split('/')
    const scoped = seg[0].startsWith('@')
    const name = scoped ? `${seg[0].slice(1)}-${seg[1]}` : seg[0]
    const rest = seg.slice(scoped ? 2 : 1).join('/')
    const candidates = [
      spec, `src/${spec}`, `contracts/${spec}`, `node_modules/${spec}`,
      `lib/${name}/${rest}`, `lib/${name}/src/${rest}`, `lib/${name}/contracts/${rest}`,
    ]
    if (spec.startsWith('@openzeppelin/contracts/')) candidates.push(`lib/openzeppelin-contracts/contracts/${rest}`)
    if (spec.startsWith('@openzeppelin/contracts-upgradeable/')) candidates.push(`lib/openzeppelin-contracts-upgradeable/contracts/${rest}`)
    const hit = candidates.find((c) => files.has(c))
    if (hit) return { kind: 'repo', path: hit }
    // otherwise a package: unpkg serves npm files, e.g. @openzeppelin/contracts/access/Ownable.sol
    if (/^(@[^/]+\/)?[a-z0-9._-]+\//i.test(spec)) return { kind: 'npm', path: spec }
    return undefined
  }

  const visit = async (src: Source) => {
    const key = `${src.kind}:${src.path}`
    if (seen.has(key) || order.length >= max) return
    opts.onProgress?.(`Loading ${src.path}…`)
    let text: string
    try {
      text = await load(src)
    } catch {
      missing.push(src.path)
      return
    }
    seen.set(key, text)
    order.push(key)
    for (const m of text.matchAll(IMPORT_RE)) {
      const dep = await resolve(src, m[1])
      if (dep) await visit(dep)
      else if (!missing.includes(m[1])) missing.push(m[1])
    }
  }

  await visit({ kind: 'repo', path: r.path })
  if (!order.length) throw new Error(`Could not load ${r.path}`)

  const label = (key: string) => (key.startsWith('npm:') ? key.slice(4) : key.slice(5))
  const parts = order.map((key, i) => {
    const body = seen.get(key)!.replace(IMPORT_RE, (line) => `// ${line.trim()}  (flattened)`)
    return i === 0 ? body : `\n// ===== imported: ${label(key)} =====\n${body}`
  })
  return { source: parts.join('\n'), files: order.map(label), missing }
}

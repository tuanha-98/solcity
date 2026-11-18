import { parse, visit } from '@solidity-parser/parser'
import type * as AST from '@solidity-parser/parser/dist/src/ast-types'

/** 1-based inclusive line range plus character offsets (end exclusive) for editor selection. */
export interface Span {
  startLine: number
  endLine: number
  start: number
  end: number
}

export type StmtKind =
  | 'decl' | 'assign' | 'write' | 'call' | 'guard' | 'if' | 'loop' | 'return'
  | 'emit' | 'revert' | 'assembly' | 'block' | 'try' | 'placeholder' | 'extcall' | 'other'

/** a call into another contract of this file: `token.transfer()`, `IERC20(x).approve()`, `new Foo()` */
export interface ExtCall {
  contract: string
  fn: string
}

export interface Stmt {
  kind: StmtKind
  depth: number
  span: Span
  /** first source line of the statement, trimmed — used for tooltips */
  text: string
  reads: string[]
  writes: string[]
  calls: string[]
  emits: string[]
  ext: ExtCall[]
  /** custom errors this statement reverts with */
  reverts: string[]
}

export interface FnLine {
  line: number
  /** offsets of the line in the source */
  start: number
  end: number
  /** the line without comments */
  code: string
  /** index into `statements` of the innermost statement on this line, or -1 */
  stmt: number
}

export type FnKind = 'function' | 'constructor' | 'fallback' | 'receive' | 'modifier'

export interface Fn {
  id: string
  name: string
  kind: FnKind
  visibility: string
  mutability: string
  modifiers: string[]
  hasBody: boolean
  span: Span
  statements: Stmt[]
  /** every code line of the body (no blank / comment / brace-only lines): one building floor each */
  lines: FnLine[]
  reads: string[]
  writes: string[]
  calls: string[]
  emits: string[]
  ext: ExtCall[]
}

export type VarShape = 'value' | 'mapping' | 'array' | 'struct' | 'bytes'

export interface StateVar {
  id: string
  name: string
  type: string
  shape: VarShape
  /** bytes used inside its slot (value types) or 32 * slots */
  bytes: number
  slots: number
  slot: number
  offset: number
  constant: boolean
  immutable: boolean
  visibility: string
  span: Span
}

export interface NamedItem {
  id: string
  name: string
  span: Span
  detail: string
}

export interface Contract {
  id: string
  name: string
  kind: string
  bases: string[]
  /** some bases are not defined in this file, so slot numbers are relative */
  slotsUnknownBase: boolean
  span: Span
  vars: StateVar[]
  fns: Fn[]
  events: NamedItem[]
  errors: NamedItem[]
  structs: NamedItem[]
  enums: NamedItem[]
  /** other contracts of this file that this one calls, with the number of call sites */
  callsOut: { target: string; count: number; first: Span }[]
}

export interface Model {
  contracts: Contract[]
}

export interface ParseResult {
  model?: Model
  errors: { line: number; column: number; message: string }[]
}

// ---------------------------------------------------------------------------

export function analyze(source: string): ParseResult {
  let ast: AST.SourceUnit & { errors?: { message: string; line: number; column: number }[] }
  try {
    ast = parse(source, { loc: true, range: true, tolerant: true }) as typeof ast
  } catch (e) {
    const err = e as { errors?: { message: string; line: number; column: number }[]; message: string }
    // some syntax errors crash the AST builder without a position: line 0 = unknown
    return { errors: err.errors?.length ? err.errors : [{ line: 0, column: 0, message: 'Syntax error' }] }
  }
  const errors = (ast.errors ?? []).map((e) => ({ line: e.line, column: e.column, message: e.message }))
  const lines = source.split('\n')
  const ctx = new Ctx(lines, ast, source)
  const contracts = ast.children
    .filter((c): c is AST.ContractDefinition => c.type === 'ContractDefinition')
    .map((c) => ctx.contract(c))
  return { model: { contracts }, errors }
}

const ELEMENTARY_BYTES: Record<string, number> = { bool: 1, address: 20, byte: 1 }

class Ctx {
  private structDefs = new Map<string, AST.StructDefinition>()
  private enumNames = new Set<string>()
  private contractDefs = new Map<string, AST.ContractDefinition>()
  /** variable name → contract type name, for parameters / returns of each function */
  private scopes = new WeakMap<Fn, Map<string, string>>()
  private layoutCache = new Map<string, { end: number; offset: number; unknown: boolean }>()

  private lines: string[]
  private src: string

  constructor(lines: string[], ast: AST.SourceUnit, src: string) {
    this.lines = lines
    this.src = src
    const collect = (n: AST.BaseASTNode) => {
      if (n.type === 'StructDefinition') this.structDefs.set((n as AST.StructDefinition).name, n as AST.StructDefinition)
      if (n.type === 'EnumDefinition') this.enumNames.add((n as AST.EnumDefinition).name)
    }
    for (const c of ast.children) {
      collect(c)
      if (c.type === 'ContractDefinition') {
        this.contractDefs.set(c.name, c)
        c.subNodes.forEach(collect)
      }
    }
  }

  span(n: AST.BaseASTNode): Span {
    const r = n.range ?? [0, 0]
    return {
      startLine: n.loc?.start.line ?? 1,
      endLine: n.loc?.end.line ?? 1,
      start: r[0],
      end: r[1] + 1,
    }
  }

  firstLine(n: AST.BaseASTNode) {
    const l = this.lines[(n.loc?.start.line ?? 1) - 1] ?? ''
    return l.trim()
  }

  // ---------- contracts ----------

  contract(c: AST.ContractDefinition): Contract {
    const id = `c:${c.name}`
    const vars: StateVar[] = []
    const fns: Fn[] = []
    const events: NamedItem[] = []
    const errors: NamedItem[] = []
    const structs: NamedItem[] = []
    const enums: NamedItem[] = []

    for (const n of c.subNodes as AST.ASTNode[]) {
      switch (n.type) {
        case 'StateVariableDeclaration':
          for (const v of n.variables) vars.push(this.stateVar(c.name, v as AST.StateVariableDeclarationVariable, n))
          break
        case 'FunctionDefinition':
          fns.push(this.fn(c.name, n))
          break
        case 'ModifierDefinition':
          fns.push(this.modifier(c.name, n))
          break
        case 'EventDefinition':
          events.push({ id: `${id}:ev:${n.name}`, name: n.name, span: this.span(n), detail: this.firstLine(n) })
          break
        case 'CustomErrorDefinition':
          errors.push({ id: `${id}:err:${n.name}`, name: n.name, span: this.span(n), detail: this.firstLine(n) })
          break
        case 'StructDefinition':
          structs.push({ id: `${id}:st:${n.name}`, name: n.name, span: this.span(n), detail: `${n.members.length} fields` })
          break
        case 'EnumDefinition':
          enums.push({ id: `${id}:en:${n.name}`, name: n.name, span: this.span(n), detail: n.members.map((m) => m.name).join(', ') })
          break
      }
    }

    // storage layout: continue after the linearized bases (when they are in this file)
    const base = this.baseLayout(c)
    let slot = base.end
    let offset = base.offset
    for (const v of vars) {
      if (v.constant || v.immutable) continue
      const packable = v.shape === 'value' && v.bytes < 32
      if (!packable || offset + v.bytes > 32) {
        if (offset > 0) slot++
        offset = 0
      }
      v.slot = slot
      v.offset = offset
      if (packable) {
        offset += v.bytes
      } else {
        slot += v.slots
        offset = 0
      }
    }

    // names visible in this contract: its own plus everything inherited from bases defined in this file
    const stateNames = new Set(vars.map((v) => v.name))
    const fnNames = new Set(fns.map((f) => f.name))
    const eventNames = new Set(events.map((e) => e.name))
    const errorNames = new Set(errors.map((e) => e.name))
    const stateTypes = new Map<string, string>()
    for (const k of [c, ...this.ancestors(c)]) {
      for (const n of k.subNodes as AST.ASTNode[]) {
        if (n.type === 'StateVariableDeclaration') this.typedNames(n.variables as AST.VariableDeclaration[], stateTypes)
      }
    }
    for (const b of this.ancestors(c)) {
      for (const n of b.subNodes as AST.ASTNode[]) {
        if (n.type === 'StateVariableDeclaration') n.variables.forEach((v) => v.name && stateNames.add(v.name))
        if (n.type === 'FunctionDefinition' && n.name) fnNames.add(n.name)
        if (n.type === 'ModifierDefinition') fnNames.add(n.name)
        if (n.type === 'EventDefinition') eventNames.add(n.name)
        if (n.type === 'CustomErrorDefinition') errorNames.add(n.name)
      }
    }
    for (const f of fns) this.resolveRefs(f, stateNames, fnNames, eventNames, c.name, stateTypes, errorNames)

    // outgoing calls to other contracts in this file, counted per call site
    const out = new Map<string, { target: string; count: number; first: Span }>()
    for (const f of fns) for (const st of f.statements) for (const x of new Set(st.ext.map((e) => e.contract))) {
      const cur = out.get(x) ?? { target: x, count: 0, first: st.span }
      cur.count++
      out.set(x, cur)
    }

    return {
      id,
      name: c.name,
      kind: c.kind,
      bases: c.baseContracts.map((b) => b.baseName.namePath),
      slotsUnknownBase: base.unknown,
      span: this.span(c),
      vars,
      fns,
      events,
      errors,
      structs,
      enums,
      callsOut: [...out.values()],
    }
  }

  private ancestors(c: AST.ContractDefinition, seen = new Set<string>()): AST.ContractDefinition[] {
    const out: AST.ContractDefinition[] = []
    for (const b of c.baseContracts) {
      const def = this.contractDefs.get(b.baseName.namePath)
      if (!def || seen.has(def.name)) continue
      seen.add(def.name)
      out.push(def, ...this.ancestors(def, seen))
    }
    return out
  }

  /** Where this contract's own storage starts: after all inherited (in-file) state, packed. */
  private baseLayout(c: AST.ContractDefinition, seen = new Set<string>()): { end: number; offset: number; unknown: boolean } {
    const order: AST.ContractDefinition[] = []
    let unknown = false
    const walk = (d: AST.ContractDefinition) => {
      for (const b of d.baseContracts) {
        const def = this.contractDefs.get(b.baseName.namePath)
        if (!def) { unknown = true; continue }
        if (seen.has(def.name)) continue
        seen.add(def.name)
        walk(def)
        order.push(def)
      }
    }
    walk(c)
    let slot = 0
    let offset = 0
    for (const d of order) {
      for (const n of d.subNodes as AST.ASTNode[]) {
        if (n.type !== 'StateVariableDeclaration') continue
        for (const raw of n.variables) {
          const v = raw as AST.StateVariableDeclarationVariable
          if (v.isDeclaredConst || v.isImmutable || !v.typeName) continue
          const t = this.typeInfo(v.typeName)
          const packable = t.shape === 'value' && t.bytes < 32
          if (!packable || offset + t.bytes > 32) {
            if (offset > 0) slot++
            offset = 0
          }
          if (packable) offset += t.bytes
          else slot += t.slots
        }
      }
    }
    return { end: slot, offset, unknown }
  }

  private stateVar(contract: string, v: AST.StateVariableDeclarationVariable, decl: AST.BaseASTNode): StateVar {
    const t = v.typeName ? this.typeInfo(v.typeName) : { shape: 'value' as const, bytes: 32, slots: 1, label: '?' }
    return {
      id: `c:${contract}:var:${v.name}`,
      name: v.name ?? '?',
      type: t.label,
      shape: t.shape,
      bytes: t.bytes,
      slots: t.slots,
      slot: -1,
      offset: 0,
      constant: !!v.isDeclaredConst,
      immutable: !!v.isImmutable,
      visibility: v.visibility ?? 'internal',
      span: this.span(decl),
    }
  }

  /** Storage size of a type, following the Solidity layout rules (approximation for user-defined value types). */
  typeInfo(t: AST.TypeName): { shape: VarShape; bytes: number; slots: number; label: string } {
    switch (t.type) {
      case 'ElementaryTypeName': {
        const n = t.name
        if (n === 'string' || n === 'bytes') return { shape: 'bytes', bytes: 32, slots: 1, label: n }
        let bytes = ELEMENTARY_BYTES[n]
        if (bytes === undefined) {
          const m = /^(u?int|bytes)(\d+)?$/.exec(n)
          if (m) bytes = m[1] === 'bytes' ? Number(m[2] ?? 32) : Number(m[2] ?? 256) / 8
          else bytes = 32
        }
        return { shape: 'value', bytes, slots: 1, label: n + (t.stateMutability ? ` ${t.stateMutability}` : '') }
      }
      case 'Mapping': {
        const k = this.typeInfo(t.keyType).label
        const v = this.typeInfo(t.valueType).label
        return { shape: 'mapping', bytes: 32, slots: 1, label: `mapping(${k} => ${v})` }
      }
      case 'ArrayTypeName': {
        const el = this.typeInfo(t.baseTypeName)
        const len = t.length && t.length.type === 'NumberLiteral' ? Number(t.length.number) : undefined
        if (len === undefined) return { shape: 'array', bytes: 32, slots: 1, label: `${el.label}[]` }
        const perSlot = el.shape === 'value' && el.bytes < 32 ? Math.floor(32 / el.bytes) : 0
        const slots = perSlot ? Math.ceil(len / perSlot) : len * el.slots
        return { shape: 'array', bytes: 32, slots: Math.max(slots, 1), label: `${el.label}[${len}]` }
      }
      case 'UserDefinedTypeName': {
        const name = t.namePath.split('.').pop()!
        const s = this.structDefs.get(name)
        if (s) return { shape: 'struct', bytes: 32, slots: this.structSlots(s), label: t.namePath }
        if (this.enumNames.has(name)) return { shape: 'value', bytes: 1, slots: 1, label: t.namePath }
        if (this.contractDefs.has(name) || /^I[A-Z]/.test(name)) return { shape: 'value', bytes: 20, slots: 1, label: t.namePath }
        return { shape: 'value', bytes: 32, slots: 1, label: t.namePath }
      }
      case 'FunctionTypeName':
        return { shape: 'value', bytes: 24, slots: 1, label: 'function' }
      default:
        return { shape: 'value', bytes: 32, slots: 1, label: '?' }
    }
  }

  private structSlots(s: AST.StructDefinition, depth = 0): number {
    if (depth > 8) return 1
    let slot = 0
    let offset = 0
    for (const m of s.members) {
      if (!m.typeName) continue
      const t = this.typeInfo(m.typeName)
      const packable = t.shape === 'value' && t.bytes < 32
      if (!packable || offset + t.bytes > 32) {
        if (offset > 0) slot++
        offset = 0
      }
      if (packable) offset += t.bytes
      else slot += t.slots
    }
    return Math.max(slot + (offset > 0 ? 1 : 0), 1)
  }

  // ---------- functions ----------

  private typedNames(params: (AST.VariableDeclaration | null)[] | null | undefined, into = new Map<string, string>()) {
    for (const p of params ?? []) {
      if (p?.name && p.typeName?.type === 'UserDefinedTypeName') into.set(p.name, p.typeName.namePath)
    }
    return into
  }

  private fn(contract: string, f: AST.FunctionDefinition): Fn {
    const kind: FnKind = f.isConstructor ? 'constructor' : f.isReceiveEther ? 'receive' : f.isFallback ? 'fallback' : 'function'
    const name = f.name || kind
    const params = f.parameters.map((p) => p.typeName ? this.typeInfo(p.typeName).label : '?').join(',')
    const out: Fn = {
      id: `c:${contract}:fn:${name}(${params})`,
      name,
      kind,
      visibility: f.visibility === 'default' ? 'public' : f.visibility,
      mutability: f.stateMutability ?? 'nonpayable',
      modifiers: f.modifiers.map((m) => m.name),
      hasBody: !!f.body,
      span: this.span(f),
      statements: f.body ? this.stmts(f.body.statements as AST.Statement[], 0) : [],
      lines: [],
      reads: [], writes: [], calls: [], emits: [], ext: [],
    }
    this.scopes.set(out, this.typedNames([...f.parameters, ...(f.returnParameters ?? [])]))
    if (f.body) out.lines = this.bodyLines(f.body, out.statements)
    return out
  }

  private modifier(contract: string, m: AST.ModifierDefinition): Fn {
    const out: Fn = {
      id: `c:${contract}:mod:${m.name}`,
      name: m.name,
      kind: 'modifier',
      visibility: 'internal',
      mutability: 'modifier',
      modifiers: [],
      hasBody: !!m.body,
      span: this.span(m),
      statements: m.body ? this.stmts(m.body.statements as AST.Statement[], 0) : [],
      lines: [],
      reads: [], writes: [], calls: [], emits: [], ext: [],
    }
    this.scopes.set(out, this.typedNames(m.parameters ?? []))
    if (m.body) out.lines = this.bodyLines(m.body, out.statements)
    return out
  }

  /** The code lines between a body's braces, each tied to the innermost statement on it. */
  private bodyLines(body: AST.Block, stmts: Stmt[]): FnLine[] {
    const [open, close] = body.range ?? [0, 0]
    return codeLines(this.src, open + 1, close, body.loc?.start.line ?? 1).map((l) => {
      let stmt = -1
      stmts.forEach((s, i) => {
        if (s.span.startLine <= l.line && l.line <= s.span.endLine && (stmt < 0 || s.depth >= stmts[stmt].depth)) stmt = i
      })
      return { ...l, stmt }
    })
  }

  /** Flatten statements depth-first. Containers (if/for/…) become one floor, children follow one level deeper. */
  private stmts(list: AST.Statement[], depth: number): Stmt[] {
    const out: Stmt[] = []
    for (const s of list) this.stmt(s, depth, out)
    return out
  }

  private stmt(s: AST.Statement | AST.BaseASTNode, depth: number, out: Stmt[]) {
    const push = (kind: StmtKind, own: (AST.BaseASTNode | null | undefined)[]) => {
      const st: Stmt = { kind, depth, span: this.span(s), text: this.firstLine(s), reads: [], writes: [], calls: [], emits: [], ext: [], reverts: [] }
      // stash the AST parts that belong to this floor (not its children) for later name resolution
      ;(st as Stmt & { _own: unknown[] })._own = own.filter(Boolean)
      out.push(st)
      return st
    }
    const body = (b: AST.BaseASTNode | null | undefined) => {
      if (!b) return
      if (b.type === 'Block') for (const c of (b as AST.Block).statements) this.stmt(c, depth + 1, out)
      else this.stmt(b, depth + 1, out)
    }
    switch (s.type) {
      case 'IfStatement': {
        const n = s as AST.IfStatement
        push('if', [n.condition])
        body(n.trueBody)
        if (n.falseBody) {
          // `else if` chains stay at the same depth
          if (n.falseBody.type === 'IfStatement') this.stmt(n.falseBody, depth, out)
          else body(n.falseBody)
        }
        return
      }
      case 'ForStatement': {
        const n = s as AST.ForStatement
        push('loop', [n.initExpression, n.conditionExpression, n.loopExpression])
        body(n.body)
        return
      }
      case 'WhileStatement':
      case 'DoWhileStatement': {
        const n = s as AST.WhileStatement
        push('loop', [n.condition])
        body(n.body)
        return
      }
      case 'UncheckedStatement':
        push('block', [])
        body((s as AST.UncheckedStatement).block)
        return
      case 'Block':
        for (const c of (s as AST.Block).statements) this.stmt(c, depth, out)
        return
      case 'TryStatement': {
        const n = s as AST.TryStatement
        push('try', [n.expression])
        body(n.body)
        for (const c of n.catchClauses) body(c.body)
        return
      }
      case 'VariableDeclarationStatement':
        push('decl', [s])
        return
      case 'ReturnStatement':
        push('return', [s])
        return
      case 'EmitStatement':
        push('emit', [s])
        return
      case 'RevertStatement':
        push('revert', [s])
        return
      case 'InlineAssemblyStatement':
        push('assembly', [])
        return
      case 'ExpressionStatement': {
        const e = (s as AST.ExpressionStatement).expression
        if (e?.type === 'Identifier' && e.name === '_') return void push('placeholder', [])
        if (e?.type === 'FunctionCall' && e.expression.type === 'Identifier' && ['require', 'assert'].includes(e.expression.name))
          return void push('guard', [s])
        if (e?.type === 'FunctionCall' && e.expression.type === 'Identifier' && e.expression.name === 'revert')
          return void push('revert', [s])
        if (e?.type === 'BinaryOperation' && /^(=|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|<<=|>>=)$/.test(e.operator)) return void push('assign', [s])
        if (e?.type === 'UnaryOperation' && /^(\+\+|--|delete)$/.test(e.operator)) return void push('assign', [s])
        if (e?.type === 'FunctionCall') return void push('call', [s])
        push('other', [s])
        return
      }
      default:
        push('other', [s])
    }
  }

  /** Fill reads/writes/calls/emits per statement and per function. */
  resolveRefs(f: Fn, state: Set<string>, fns: Set<string>, events: Set<string>, self: string, stateTypes: Map<string, string>, errors: Set<string>) {
    const all = { reads: new Set<string>(), writes: new Set<string>(), calls: new Set<string>(), emits: new Set<string>() }
    const allExt = new Map<string, ExtCall>()
    // contract-typed names visible here: locals (filled as we go) → params → state
    const locals = new Map<string, string>()
    const params = this.scopes.get(f) ?? new Map<string, string>()
    const typeOf = (name: string) => locals.get(name) ?? params.get(name) ?? stateTypes.get(name)
    const isContract = (t?: string) => !!t && this.contractDefs.has(t.split('.').pop()!)
    // `Position storage p = positions[x]` makes p an alias of positions
    const alias = new Map<string, string>()
    const stateOf = (name: string) => (state.has(name) ? name : alias.get(name))
    for (const st of f.statements) {
      const own = (st as Stmt & { _own: AST.BaseASTNode[] })._own ?? []
      delete (st as Partial<Stmt & { _own: unknown }>)._own
      const r = new Set<string>(), w = new Set<string>(), c = new Set<string>(), e = new Set<string>()
      const ext = new Map<string, ExtCall>()
      const rv = new Set<string>()
      const addExt = (contract: string, fn: string) => {
        contract = contract.split('.').pop()!
        if (contract !== self) ext.set(`${contract}.${fn}`, { contract, fn })
      }
      const writeRoots = new Set<AST.BaseASTNode>()
      // `x = …` writes x without reading it; `x += …` both reads and writes
      const pureWrites = new Set<AST.BaseASTNode>()
      for (const node of own) {
        visit(node, {
          BinaryOperation: (b) => {
            if (/^(=|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|<<=|>>=)$/.test(b.operator)) {
              for (const t of b.left.type === 'TupleExpression' ? b.left.components : [b.left]) {
                const root = rootIdent(t as AST.BaseASTNode | null)
                if (!root) continue
                writeRoots.add(root)
                if (b.operator === '=' && root === t) pureWrites.add(root)
              }
            }
          },
          UnaryOperation: (u) => {
            if (/^(\+\+|--|delete)$/.test(u.operator)) {
              const root = rootIdent(u.subExpression)
              if (root) writeRoots.add(root)
            }
          },
          FunctionCall: (fc) => {
            const callee = fc.expression
            if (callee.type === 'Identifier' && fns.has(callee.name)) c.add(callee.name)
            if (callee.type === 'MemberAccess' && callee.expression.type === 'Identifier' && callee.expression.name === 'this' && fns.has(callee.memberName)) c.add(callee.memberName)
            // calls into another contract: x.fn(), Type(addr).fn(), Library.fn()
            if (callee.type === 'MemberAccess') {
              const base = callee.expression
              let target: string | undefined
              if (base.type === 'FunctionCall' && base.expression.type === 'Identifier' && isContract(base.expression.name)) target = base.expression.name
              else if (base.type === 'Identifier') target = isContract(base.name) ? base.name : isContract(typeOf(base.name)) ? typeOf(base.name) : undefined
              if (target) addExt(target, callee.memberName)
            }
            // array.push(...) / pop() mutate storage
            if (callee.type === 'MemberAccess' && /^(push|pop)$/.test(callee.memberName)) {
              const root = rootIdent(callee.expression)
              if (root) writeRoots.add(root)
            }
          },
          NewExpression: (n) => {
            if (n.typeName.type === 'UserDefinedTypeName' && isContract(n.typeName.namePath)) addExt(n.typeName.namePath, 'constructor')
          },
          VariableDeclarationStatement: (d) => {
            this.typedNames(d.variables as AST.VariableDeclaration[], locals)
            const v = d.variables[0] as AST.VariableDeclaration | null
            const root = rootIdent(d.initialValue)
            const target = root && stateOf((root as AST.Identifier).name)
            if (v?.name && v.storageLocation === 'storage' && target) alias.set(v.name, target)
          },
          RevertStatement: (rs) => {
            const callee = rs.revertCall.expression
            if (callee.type === 'Identifier' && errors.has(callee.name)) rv.add(callee.name)
          },
          EmitStatement: (em) => {
            const ev = em.eventCall.expression
            if (ev.type === 'Identifier' && events.has(ev.name)) e.add(ev.name)
          },
          Identifier: (id) => {
            const target = stateOf(id.name)
            if (target && !pureWrites.has(id)) r.add(target)
          },
        })
      }
      for (const root of writeRoots) {
        const target = stateOf((root as AST.Identifier).name)
        if (target) w.add(target)
      }
      st.reads = [...r]; st.writes = [...w]; st.calls = [...c]; st.emits = [...e]; st.ext = [...ext.values()]; st.reverts = [...rv]
      if (st.ext.length && st.kind === 'call') st.kind = 'extcall'
      ext.forEach((x, k) => allExt.set(k, x))
      if (w.size && st.kind === 'assign') st.kind = 'write'
      if (w.size && st.kind === 'call') st.kind = 'write'
      r.forEach((x) => all.reads.add(x)); w.forEach((x) => all.writes.add(x))
      c.forEach((x) => all.calls.add(x)); e.forEach((x) => all.emits.add(x))
    }
    f.reads = [...all.reads]; f.writes = [...all.writes]; f.calls = [...all.calls]; f.emits = [...all.emits]; f.ext = [...allExt.values()]
  }
}

/** Split src[from, to) into lines with comments removed; keep only lines with real code. */
function codeLines(src: string, from: number, to: number, firstLine: number) {
  const out: { line: number; start: number; end: number; code: string }[] = []
  let line = firstLine, lineStart = from, code = ''
  let inLine = false, inBlock = false, quote = ''
  for (let i = from; i <= to; i++) {
    const ch = i < to ? src[i] : '\n'
    if (ch === '\n') {
      out.push({ line, start: lineStart, end: i, code })
      line++; lineStart = i + 1; code = ''; inLine = false
      continue
    }
    if (inLine) continue
    if (inBlock) { if (ch === '*' && src[i + 1] === '/') { inBlock = false; i++ } continue }
    if (quote) {
      code += ch
      if (ch === '\\') { code += src[i + 1] ?? ''; i++ } else if (ch === quote) quote = ''
      continue
    }
    if (ch === '/' && src[i + 1] === '/') { inLine = true; continue }
    if (ch === '/' && src[i + 1] === '*') { inBlock = true; i++; continue }
    if (ch === '"' || ch === "'") quote = ch
    code += ch
  }
  // drop blank, comment-only and brace-only lines
  return out.filter((l) => /[^\s{};]/.test(l.code))
}

/** a[b].c.d → Identifier a */
function rootIdent(n: AST.BaseASTNode | null | undefined): AST.BaseASTNode | undefined {
  while (n) {
    if (n.type === 'Identifier') return n
    if (n.type === 'IndexAccess') n = (n as AST.IndexAccess).base
    else if (n.type === 'MemberAccess') n = (n as AST.MemberAccess).expression
    else if (n.type === 'IndexRangeAccess') n = (n as AST.IndexRangeAccess).base
    else return undefined
  }
  return undefined
}

/** Find the most specific item whose span contains a line. */
export function itemsAtLine(m: Model, line: number) {
  const contract = m.contracts.find((c) => c.span.startLine <= line && line <= c.span.endLine)
  if (!contract) return {}
  const inSpan = (s: Span) => s.startLine <= line && line <= s.endLine
  const fn = contract.fns.find((f) => inSpan(f.span))
  let stmt: Stmt | undefined
  if (fn) {
    // deepest statement wins (children come after their container in the flat list)
    for (const s of fn.statements) if (inSpan(s.span) && (!stmt || s.depth >= stmt.depth)) stmt = s
  }
  const v = contract.vars.find((x) => inSpan(x.span))
  const ev = contract.events.find((x) => inSpan(x.span))
  const err = contract.errors.find((x) => inSpan(x.span))
  return { contract, fn, stmt, v, ev, err, line }
}

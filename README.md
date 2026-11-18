# solcity

Write Solidity on the left and see it as 3D blocks on the right. The cursor and the scene stay in sync.

```bash
npm install
npm run dev
```

## What maps to what

Each contract is a **city**. Inside it, every kind of declaration has its own architecture:

| Code | Building |
|---|---|
| `contract` / `interface` / `library` | a city: ground plate, street grid, street lights |
| function | high-rise: plinth colour = visibility, **one storey per line of code** (blank, comment and brace-only lines skipped); glass colour = statement kind; long functions step back in tiers as they rise (never wider higher up); lines inside `if` / `for` / `unchecked` blocks have their facade set back like balconies; rooftop by mutability |
| roof (by mutability) | `payable` gilded dome · `view` glass observation deck · `pure` roof garden · state-changing plant room and antenna; read-only towers are translucent |
| modifier | castle keep: stone storeys, corner turrets, battlements, flag; rose guard fences around the base of the towers that use it |
| function without a body (interface, abstract) | glass tower: all facade, nothing inside |
| `_;` in a modifier | a glass storey: where the wrapped function's body goes |
| state variable | warehouse with a pitched roof, placed by **storage slot** (packed variables share a lot) |
| ↳ value / mapping / array / struct / string | shed / wall of lit lockers / row of units / two storeys / shop sign |
| `constant` / `immutable` | marble temple / sandstone temple (no storage slot) |
| event | radio mast sending rings |
| custom error | red and white traffic cone |

Cities are joined by **highways**:

- **one-way road** (violet, chevrons) = inheritance, driving from the derived city to its base:
  the derived contract can use the base's code, not the other way round.
- **two-way road** (yellow centre line) = calls between contracts (`token.transfer()`,
  `IERC20(x).approve()`, `new Foo()`); more call sites = more traffic.
- **on-chain road** (green centre line) = one contract holds the other's address on the chain (an
  [address import](#import-from-an-address): `token0()`, `factory()`, a constant…).
- **proxy road** (blue, chevrons) = a proxy runs the implementation's code (delegatecall) on its own storage.

Cities sit on a 2D grid (columns chosen from the pane's shape, snake order so connected cities stay
neighbours), with corridors between them. Gates are on all four sides of a city: north and south edges
(on the back street behind the storage row and on the front street) and east and west ends of the
avenue, the streets between rows and the front street (never the back street, which runs too close to
the north edge for a road's width). Each road leaves by the side facing the other city, with the fewest
turns, and gets its own gate and its own lane in every corridor. A city's north and south edges are
always wide enough to give every road a gate between them, so when a road end finds no clean gate on
the side it was planned for, the roads are planned again with that side ruled out. A highway meets a
city exactly at its outer edge, and the city's street carries on inside; no part of a road lies
outside the land it serves. Where two roads cross, one climbs onto an overpass (deck and guard rails,
no pillars): gate stubs over through lanes, north–south over east–west. Every building stands on a
foundation that fills its whole lot. A road lights up and its traffic speeds up when the code under
the cursor crosses into the other city.

Links (shown for whatever the cursor is on): **cyan** = reads storage, **orange** = writes storage,
**violet** = internal call, **yellow** = call into another contract, **pink** = emit, **red** = revert
with a custom error, **rose** = modifier. Writes through storage pointers
(`Position storage p = positions[x]; p.shares += 1`) count as writes to `positions`.

- Cursor on a line → exactly that storey gets a white frame and shows the line, with the statement's links.
- Cursor on a state variable, event or error → every statement in the file that touches it is linked.
- Click any block → the editor jumps to its line. Hovering a block highlights its lines.
- Edit the code: the scene rebuilds after a short pause. On a syntax error, the last valid scene stays.
- **Labels** in the toolbar: all labels, only city names and road signs, or none.

## Import from GitHub

**GitHub** in the toolbar takes a link to a public repo, a folder (`/tree/…`) or a file (`/blob/…`, or a
raw link). A repo or folder lists its `.sol` files (sources first, then tests, scripts and vendored
libraries) with a filter; pick one to load it.

With **Include imported files** on, the file's imports are fetched and appended below it (import lines are
commented out), so base contracts, interfaces and libraries from other files become cities with roads:

- relative imports (`./`, `../`) from the same repo;
- absolute paths that exist in the repo (also under `src/`, `contracts/`, `lib/<pkg>/…`);
- package imports such as `@openzeppelin/contracts/…` from unpkg (latest published version).

Files come from `raw.githubusercontent.com`; listing a repo uses the GitHub API, which allows about
60 requests per hour without sign-in. Private repos are not supported.

## Import from an address

**Address** in the toolbar takes a contract address and a chain, or an explorer link that names the chain
(`etherscan.io/address/0x…`, `basescan.org/token/0x…`, a Blockscout link, or `eip155:<chain>:0x…`).
Ethereum, Base, Arbitrum, OP, Polygon, BNB Chain, Avalanche, Gnosis, Linea, Scroll, Unichain, Sepolia and
Base Sepolia are listed.

1. The verified source of the address comes from Sourcify, then Blockscout (neither needs a key), then
   Etherscan if you add your own API key. Its files are joined into one, imports commented out.
2. If it is a proxy (EIP-1967, EIP-1822, ZeppelinOS, beacon, EIP-1167 clone, or what the explorer
   reports), its implementation is loaded too and joined by a proxy road.
3. **Follow** reads what it points to from the chain: every view function without arguments that
   returns an address (`factory()`, `token0()`, `owner()`…, called on the proxy for an implementation),
   the EIP-1967 admin and beacon, and addresses written in its code. Each one that is a contract joins
   as a city with an on-chain road, to one or two hops. Accounts that are not contracts are noted in the
   header.

Related contracts come with the contracts they inherit from; tick **with their libraries and interfaces**
for everything they compile with. Libraries, interfaces and bases shared by several addresses are kept
once (the first copy); a deployed contract whose name is taken by different code is renamed `Name_1a2b`.
A contract with no verified source is an empty city marked *not verified*.

The text starts with what was read, in lines the city is drawn from (edit or delete them freely):

```solidity
// @chain 1 Ethereum
// @contract UniswapV3Pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640
// @contract FiatTokenProxy 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
// @link UniswapV3Pool.token0 -> FiatTokenProxy
// @proxy FiatTokenProxy -> FiatTokenV2_2
```

Chain state comes from public PublicNode endpoints (BNB Chain: `bsc-dataseed.bnbchain.org`); another
JSON-RPC URL can be set per chain. The key and RPC URL are kept in the browser's local storage.
Vyper contracts are skipped.

## Files

- `src/model.ts`: parse (`@solidity-parser/parser`) → contracts, storage layout, statements, reads/writes
- `src/scene.ts`: three.js scene, city layout, highway routing, links, focus, picking
- `src/architecture.ts`: building styles; `src/city.ts`: streets, lights, highways, cars
- `src/github.ts`: GitHub links, repo listing, import flattening
- `src/onchain.ts`: import from an address (verified source, proxies, related contracts, chain reads);
  `src/keccak.ts`: Keccak-256 for selectors, storage slots and checksums
- `src/editor.ts`: Monaco setup; `src/main.ts`: wiring

Storage slots include inherited variables when the base contracts are in the same file. If a base is
imported from elsewhere, slot numbers are shown as `+slot n` (relative).

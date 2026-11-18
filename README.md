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

## Files

- `src/model.ts`: parse (`@solidity-parser/parser`) → contracts, storage layout, statements, reads/writes
- `src/scene.ts`: three.js scene, city layout, highway routing, links, focus, picking
- `src/architecture.ts`: building styles; `src/city.ts`: streets, lights, highways, cars
- `src/github.ts`: GitHub links, repo listing, import flattening
- `src/editor.ts`: Monaco setup; `src/main.ts`: wiring

Storage slots include inherited variables when the base contracts are in the same file. If a base is
imported from elsewhere, slot numbers are shown as `+slot n` (relative).

# CLAUDE.md

## Project overview

FilmShell is a zero-dependency CLI (beyond two Halo API client libraries) that downloads Halo Infinite theater film data, extracts per-player movement from the raw binary chunks, fetches map metadata (MVAR), and renders SVG path visualizations.

## Build and run

```sh
npm install        # install dependencies
npm run build      # compile TypeScript (tsc)
npm run dev        # build + run in one step
npm start          # run pre-built dist/cli/index.js
```

There are no tests yet. The build (`npm run build`) is the primary verification — it must compile with zero errors under strict mode.

## Project structure

```
src/
  cli/                   # CLI tool — the main FilmShell pipeline
    index.ts             # Entry point — orchestrates the 5-stage pipeline
    ui.ts                # Centralized TUI: colors, gradient spinner, box drawing, structured output
    auth.ts              # Xbox Live / Halo API authentication with encrypted token storage
    film-downloader.ts   # Match history fetch, film chunk download and zlib decompression
    map-metadata.ts      # MVAR asset fetch from Halo UGC API
    bond-parser.ts       # Bond Compact Binary v2 parser (MVAR file format)
    object-extractor.ts  # Extract map objects (spawns, weapons, flags) from parsed MVAR
    motion-extractor.ts  # Binary frame scanning and position extraction from film chunks
    svg-generator.ts     # Scale motion to world coords and render SVG
    types.ts             # Shared type definitions
    objects.json         # Object ID → name mapping (numeric IDs to human-readable names)
films/                   # Reference films for offline testing (checked into source control)
```

## Architecture

The pipeline has 5 stages, each driven from `src/cli/index.ts`:

1. **Authentication** (`auth.ts`) — OAuth → Xbox Live → Spartan token chain
2. **Download** (`film-downloader.ts`) — fetch match history, download/decompress film chunks
3. **Map Analysis** (`map-metadata.ts` → `bond-parser.ts` → `object-extractor.ts`) — fetch MVAR, parse Bond binary, extract objects
4. **Motion Extraction** (`motion-extractor.ts`) — scan film chunks for frame markers (`A0 7B 42`), auto-detect encoding variant, accumulate coordinate deltas
5. **SVG Generation** (`svg-generator.ts`) — scale to world coordinates, render paths with map object overlays

## Key conventions

- **ESM-only** — the project uses `"type": "module"` with NodeNext module resolution. All local imports use `.js` extensions.
- **Zero runtime dependencies** beyond `@dendotdev/conch` (Xbox auth) and `@dendotdev/grunt` (Halo API client). The TUI uses raw ANSI escape codes, no chalk/ora/ink.
- **`onStatus` callback pattern** — modules accept an optional `onStatus?: (msg: string) => void` parameter. Internal progress messages route through this callback so `index.ts` can pipe them to spinners. When no callback is provided, modules fall back to `console.log(dim(...))`.
- **Strict TypeScript** — `strict: true` in tsconfig. The build must produce zero errors.
- **Film binary format** — not publicly documented. Motion extraction relies on reverse-engineered heuristics. Multiple encoding variants exist across different maps (base-0x09 standard, b3-variant, 40088064 fallback).

## Coordinate encoding and scaling

Motion data uses two coordinates with different bit widths:
- **coord1 (Y axis):** 16-bit encoding (0–65535). Cumulative deltas with ±32768 wraparound.
- **coord2 (X axis):** 12-bit encoding (0–4095). Cumulative deltas with ±2048 wraparound.

The 16:1 bit-width ratio (`ENCODING_RATIO = 65536/4096`) means one raw coord2 unit covers 16× more world distance than one raw coord1 unit, adjusted for map aspect ratio.

**Scaling approach** (`svg-generator.ts`):
- **Axis mapping:** cumCoord1 → world Y, cumCoord2 → world X (negated). Do NOT swap these axes — the path shape is correct with this mapping.
- **Spawn anchoring:** The path's first frame is anchored to the nearest Initial Spawn (`findBestSpawnAnchor` tries each candidate and picks the one that keeps the most path points within map bounds).
- **Constraint-based scaling (with anchor):** Instead of an arbitrary fill percentage, scaleY is computed as the tightest fit that keeps the entire path within map bounds from the anchor point. Both Y constraints (north/south from anchor) and X constraints (east/west, converted via encoding ratio) are checked. The tightest constraint wins.
- **Fallback scaling (no anchor):** When no spawn anchor is available, falls back to `MAP_FILL_FACTOR` (85%) of map height for Y, with X derived from Y.
- **X derived from Y:** `scaleX = scaleY / (ENCODING_RATIO × mapWidth / mapHeight)`. Never calibrate X independently — doing so overstretches the horizontal axis.

## Reference films

Eight pre-downloaded films in `films/` can be re-processed without API access. The first six are played on Aquarius with the human player making a full loop of the map. The seventh is a solo combat test on Aquarius with AR fire at the south spawn and Sidekick fire at the north spawn. The eighth is a PvE match on Aquarius where the human engages a bot in combat:

```sh
npm start -- --match-id 53a98da9-718d-4374-b739-b0ee2e7033ba
```

Types: 2 PvP (2 humans), 3 PvE (human + bot), 2 Solo (1 human).

## Weapon fire events

Weapon fire events are encoded in the film chunk bit stream at a **4-bit offset** (not byte-aligned). Discovery and initial decoding by [Andy Curtis](https://github.com/acurtis166) ([source](https://github.com/dend/blog-comments/issues/5#issuecomment-3875288507)).

**Fire event structure** (all fields bit-packed at 4-bit shift):

```
0d  26  00  40  [ctr]  [slot]  [----weapon ID (8 bytes)----]  [oct]  [u16]  [aim...]
 |   |   |   |    |      |                                      |      |
lead |  0x00 |  fire    slot                                  octant  aim vector
byte |      mostly counter  1=primary                         (0-7)   uint16
     |      0x40   (+4/shot) 3=secondary
   0x26    (low 2 bits vary)
```

- **Lead byte:** `0x0d` for fire events.
- **Player index:** Bit-packed into byte at offset 1 (`0x26` for player index 0).
- **Fire counter:** Increments by 4 per shot, wraps at 256.
- **Weapon slot:** `0x01` = primary, `0x03` = secondary.
- **Weapon ID:** 8-byte identifier. Last 4 bytes are usually `42 c9 67 9f` (common namespace).
- **Aim vector:** Octahedral 3D-to-2D encoding — octant byte (0-7) selects a face, uint16 encodes position within the face. See Andy's [analysis](https://github.com/dend/blog-comments/issues/5#issuecomment-3875288507) for sphere projection details.

**Searching for weapon IDs:** Because of the 4-bit shift, weapon IDs don't appear as raw byte sequences. To search, compute shifted patterns: `pattern[k] = ((id[k] << 4) | (id[k+1] >> 4)) & 0xFF` for k=0..6 (7-byte pattern).

**Known weapon IDs** (from Andy Curtis, [updated list](https://github.com/dend/blog-comments/issues/5#issuecomment-3882279646)):

| Weapon | ID |
|---|---|
| MA40 AR | `48 c1 9d 2d 42 c9 67 9f` |
| Mk51 Sidekick | `f4 08 19 0f 42 c9 67 9f` |
| BR75 | `2b 18 24 d5 42 c9 67 9f` |
| M392 Bandit | `2f b2 1c 87 42 c9 67 9f` |
| VK78 Commando | `fd 98 55 4c 42 c9 67 9f` |
| S7 Sniper | `0a 19 92 bc 42 c9 67 9f` |
| CQS48 Bulldog | `b6 19 d8 4a 42 c9 67 9f` |
| M41 SPNKr | `71 ab 0a 2c 42 c9 67 9f` |
| Needler | `b5 33 95 7e 42 c9 67 9f` |

See full list in the [comment thread](https://github.com/dend/blog-comments/issues/5#issuecomment-3882279646) (25 weapons documented).

**Validated in film `b49f075b`:** 124 AR fire events (slot 1) in chunks 1-2, 47 Sidekick fire events (slot 3) in chunks 3-4, matching the test scenario (AR at south spawn, Sidekick at north spawn).

## PvE (human + bot) film encoding

When a bot is present, the frame encoding changes fundamentally. **Each bot frame carries BOTH entity positions:**

- **Bot position**: byte-aligned at pos+11..14 (one-byte-shifted layout, `b9=0x35`, `b7=0x40`)
- **Human position**: embedded sub-record at ~pos+34, **4-bit-shifted** (one nibble offset from byte alignment)

The human's position is NOT in its own top-level frames. The byte-aligned `b8=0x4d b9=0x56` stream at pi=0 is a derived quantity (not human position) and must be ignored.

### Embedded human sub-record

```
pos+0:  A0 7B 42                    ← standard marker
pos+5:  40 09 40 05 35              ← bot frame header (b9=0x35)
pos+10: 59 05 XX XX XX ...          ← bot coords (byte-aligned, current bot extractor)
...
pos+34: 10 0a 30                    ← SUB-RECORD MARKER (constant)
pos+37: 15 64 YY ZZ WW ...          ← 4-bit-shifted human coords
        │
        └─ nibble decode: (0x15 & 0xF)<<4 | (0x64>>4) = 0x56  ← shifted "b9"
                          (0x64 & 0xF)<<4 | (YY>>4) = 0x4?    ← shifted "d0"
```

**Decode formula**: `shiftByte(k) = ((chunk[base+k] & 0xF) << 4) | (chunk[base+k+1] >> 4)` where `base = pos + offset_of_10_0a_30 + 3`. Then `c1 = shiftByte(1)*256 + shiftByte(2)` and `c2 = ((shiftByte(3) & 0xF) << 8) | shiftByte(4)`, identical to standard encoding but on nibble-shifted bytes.

**Presence**: Only ~25-30% of bot frames carry the human sub-record (those with `10 0a 30`). Others have `10 0a 20` or `10 0a 40` — different sub-record types without human coords. The byte at marker+3 must have low nibble = 5 (e.g. `0x15`) for shifted-b9 to decode as `0x56`.

**Rare normal frames**: A handful (~7-15) of `pi=1 b7=0x00 b8=0x05 b9=0x56` standard-layout frames appear at the very start (before the bot spawns). These are merged into the human stream.

**Validated in films `4bfdd8b9` and `b632adeb`**: human does a full loop. Embedded extraction gives cumRange c1≈275, c2≈2070, final≈(0,160) — matches solo loop shape with near-perfect closure.

### Bot stream layout (unchanged)

| Field | Standard (human, b7=0x00) | Bot (b7=0x40) |
|---|---|---|
| Layout marker | `p9 & 1 == 0` | `p9 & 1 == 1` |
| High-nibble check | `(pos+10 >> 4) == 4` | `(pos+11 >> 4) == 0` |
| coord1 (16-bit) | pos+10, pos+11 | pos+11, pos+12 |
| coord2 (12-bit) | pos+12, pos+13 | pos+13, pos+14 |

Extraction uses `extractPvEHumanEmbedded` for the human stream (nibble-shifted sub-records) and `extractBase09BotShifted` for the bot stream (byte-aligned pos+11..14).

## Things to know

- `config.json` and `tokens.bin` are gitignored and contain secrets — never commit them.
- The `objects.json` ID mapping is incomplete. New object IDs are discovered by creating Forge maps with known placements and correlating MVAR dumps.
- The version number displayed in the CLI banner is read from `package.json` at runtime.

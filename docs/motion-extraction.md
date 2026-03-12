# Motion Extraction from Halo Infinite Theater Films

## What we're trying to do

Halo Infinite records every match as a "theater film" — a binary blob that the game can replay. Somewhere inside that blob is a log of where every player was standing, many times per second. We want to fish those positions out so we can draw a map of where everyone walked.

Halo's film format is **not documented publicly**. Everything here was figured out by staring at hex dumps and comparing films where we knew what the player did (e.g., "walked one loop around the map clockwise").

---

## The big picture

A film is made of **frames**. Think of a frame as "here's what changed since the last frame" — new positions, shots fired, grenades thrown, etc. Each frame is packed into the binary stream one after another.

Every frame starts with a **magic number**: the three bytes `A0 7B 42`. When we see those three bytes in a row, we know a frame begins there. Think of it as a bookmark.

```
... random data ... A0 7B 42 [frame 1 contents] ... A0 7B 42 [frame 2 contents] ...
                    ^^^^^^^^                         ^^^^^^^^
                    "frame starts here"              "frame starts here"
```

**Step 1 of extraction is always**: scan the entire film for every `A0 7B 42` and write down where each one is.

---

## Anatomy of a position frame

Not every frame is a position frame. Some are weapon fire, some are game events, some are things we haven't figured out. A **position frame** tells us "this player is now at coordinates (X, Y)".

Here's what the first 14 bytes of a position frame look like in a **solo or PvP match** (we'll do PvE/bot matches separately because they're weird):

```
byte offset →  0  1  2  3  4  5  6  7  8  9  10 11 12 13
value       → A0 7B 42 ?? ?? 40 09 00 ?? 56 40 8C 69 D4
                        └──── header ─────┘ └─ data ─┘
```

Let's walk through each byte:

| Offset | Name | What it means | Example |
|---|---|---|---|
| 0–2 | Marker | Always `A0 7B 42`. "A frame starts here." | `A0 7B 42` |
| 3–4 | (unknown) | We skip these. Probably timestamps or sequence numbers. | varies |
| 5 | Type prefix | `0x40` for position-type frames. | `40` |
| 6 | Type + player | Low 5 bits = **base type** (`0x09` for standard position). Top 3 bits = **player index** (0–7). | `09` = type 0x09, player 0 <br> `29` = type 0x09, player 1 (0x20 added) |
| 7 | Stream selector | `0x00` = human's main position. `0x40` = bot's position. `0x05` = camera/spectator (ignore). | `00` |
| 8 | Subtype | Varies by map/mode. `0x05` is common. We mostly ignore it. | `05` |
| 9 | Marker byte | `0x56` for human streams. `0x35` for bot streams. (This is a big clue for telling them apart.) | `56` |
| 10 | d0 — Y high | High byte of the Y coordinate. **Must have high nibble = 4** for position frames (so d0 is `0x40`–`0x4F`). | `40` |
| 11 | d1 — Y low | Low byte of Y. | `8C` |
| 12 | d2 — X high nibble | **Low nibble** of this byte is the top 4 bits of X. High nibble is something else (ignored). | `69` → X high = `9` |
| 13 | d3 — X low | Low byte of X. | `D4` |

### Building coordinates from the data bytes

From bytes 10–13 we compute two numbers:

```
Y_raw = d0 × 256 + d1         → 16-bit number, but since d0 is always 0x40-0x4F,
                                Y_raw is really in [16384, 20479] — a 12-bit range
                                shifted up by 0x4000

X_raw = (d2 & 0x0F) × 256 + d3 → 12-bit number in [0, 4095]
```

**Example** with the bytes above (`40 8C 69 D4`):
- `Y_raw = 0x40 × 256 + 0x8C = 16384 + 140 = 16524`
- `X_raw = (0x69 & 0x0F) × 256 + 0xD4 = 9 × 256 + 212 = 2516`

These are **not** world coordinates (meters or whatever). They're raw encoding values. We convert them to real-world positions later (see the "Scaling" section).

---

## Cumulative deltas: the key trick

Here's the thing: a single `(Y_raw, X_raw)` pair isn't enough. The encoding **wraps around**. X_raw is a 12-bit number (max 4095). When the player walks far enough that X_raw would be 4096, it rolls over to 0 — like an odometer.

So we can't just read the raw values. We have to track **how much they change** from frame to frame and add up those changes:

```
frame 1: X_raw = 4090
frame 2: X_raw = 4095  → change = +5     → total X so far: +5
frame 3: X_raw = 3     → change = -4092  ← this looks huge! but it's really a wrap:
                         actual change = -4092 + 4096 = +4  → total: +9
frame 4: X_raw = 8     → change = +5     → total: +14
```

We call the running total `cumCoord` (cumulative coordinate). The logic is:

1. Compute the raw delta: `delta = current_raw - previous_raw`
2. If `|delta|` is bigger than half the encoding range, it's a wraparound — add or subtract the full range to correct it.
3. Add the corrected delta to the running total.

**Wraparound thresholds:**
- Y (16-bit-ish): if delta > 32768, subtract 65536. If delta < -32768, add 65536.
- X (12-bit): if delta > 2048, subtract 4096. If delta < -2048, add 4096.

There's also a **discontinuity filter**: if a corrected delta is still huge (>4000), it's probably a death/respawn teleport, not real movement. We zero those out so the path doesn't shoot across the map.

---

## Why PvE films are different (the hard part)

Now for the mess. In **PvE films** — a human playing against one bot — the encoding changes fundamentally.

### What we expected to find

You'd think: "Player 0 is the human, player 1 is the bot. Each gets their own position frames. Easy."

That is **not** what happens.

### What actually happens

When a bot is present, the film **packs both entities into the same frames**. Specifically:

1. The bot gets its own top-level position frames. These look *almost* like human frames but with a few key differences (covered below).
2. The human's position is **embedded INSIDE the bot's frames** as a sub-record, ~34 bytes in, at a **4-bit offset from byte alignment**. (Yes, really. The human data is shifted over by half a byte.)
3. There's also a *fake* human stream at byte offset 10 (the normal spot) that looks right but **tracks the wrong thing** — possibly the bot's aim target or a camera. This is a trap.

Let's diagram a bot frame:

```
 ┌──────────────────── one bot frame (~60 bytes long) ─────────────────────┐
 │                                                                          │
 │  A0 7B 42  ...  40 09 40 05 35  59 05 E2 66 21  ...  10 0A 30  15 64 ...│
 │  └marker┘       └─ header ─┘    └─ BOT pos ─┘        └marker┘  └HUMAN┘  │
 │                                                                          │
 │                 (b7=0x40,       (shifted 1 byte     (sub-record) (shifted│
 │                  b9=0x35        right: bytes        constant     4 BITS  │
 │                  = bot stream)   11-14 not 10-13)   '10 0a 30')  right!) │
 └──────────────────────────────────────────────────────────────────────────┘
```

---

## Bot position encoding (byte-aligned, one byte later)

The bot's own position lives in the frame header region, but **shifted one byte to the right** compared to a human frame.

| Field | Human frame (solo/PvP) | Bot frame (PvE) |
|---|---|---|
| Stream selector (offset 7) | `0x00` | `0x40` |
| Marker byte (offset 9) | `0x56` | `0x35` (odd → signals shifted layout) |
| Y high (d0) | offset **10**, high nibble = 4 | offset **11**, high nibble = **0** |
| Y low (d1) | offset 11 | offset 12 |
| X high nibble (d2) | offset 12 | offset 13 |
| X low (d3) | offset 13 | offset 14 |

Everything else — the 16-bit/12-bit formulas, the wraparound math — works the same. The data is just sitting one byte later, and the d0 high-nibble check is 0 instead of 4.

**How we tell it's a bot frame:**
- `chunk[pos+7] == 0x40`
- `chunk[pos+9] & 0x01 == 1` (byte 9 is odd, e.g. `0x35`)
- `chunk[pos+11] >> 4 == 0` (d0 high nibble is zero)

---

## Embedded human sub-record (the weird part)

Here's where it gets strange. The human's position in PvE films is **not in the frame header**. It's ~34 bytes into the bot's frame, after a sub-record marker, and the bytes are **nibble-shifted** — shifted over by 4 bits (half a byte).

### What "4-bit shifted" means

Normal byte data:
```
byte 0: HHHH LLLL  ← high nibble, low nibble
byte 1: HHHH LLLL
byte 2: HHHH LLLL
```

4-bit-shifted data — the real boundaries straddle the byte boundaries:
```
byte 0: .... HHHH  ← bottom half of byte 0 is the top half of shifted-byte 0
byte 1: LLLL HHHH  ← top half of byte 1 is the bottom half of shifted-byte 0
byte 2: LLLL HHHH     bottom half of byte 1 is the top half of shifted-byte 1
byte 3: LLLL ....
```

To read shifted-byte `k` starting at some base position:
```
shifted_byte[k] = (raw[base+k] & 0x0F) << 4  |  (raw[base+k+1] >> 4)
                  └─ low nibble of this ─┘      └─ high nibble of next ─┘
                     becomes high nibble           becomes low nibble
```

### Finding the human sub-record

About 34 bytes into each bot frame there's a **sub-record marker**: three specific bytes `10 0A 30`. When we see those, the human data follows right after — but nibble-shifted.

Not every bot frame has it. Only about 25–30% of bot frames carry the human sub-record. The rest have `10 0A 20` or `10 0A 40` at that spot instead — those are different sub-record types that don't contain human position. So we check for `10 0A 30` specifically.

### Decoding the human from nibble-shifted bytes

Once we find `10 0A 30` at offset `off` (somewhere around pos+34), we set `base = pos + off + 3` and decode:

```
raw bytes at base:  [15] [64] [YY] [ZZ] [WW] [VV] ...
                                      ↓ nibble-shift decode ↓
shifted_byte[0] = (0x15 & 0xF) << 4 | (0x64 >> 4) = 0x50 | 0x6 = 0x56  ← human marker! (same as b9 in normal frames)
shifted_byte[1] = (0x64 & 0xF) << 4 | (YY   >> 4) = 0x40 | ...  = 0x4?  ← d0 (high nibble = 4, position channel!)
shifted_byte[2] = ...                                                    ← d1 (Y low byte)
shifted_byte[3] = ...                                                    ← d2
shifted_byte[4] = ...                                                    ← d3 (X low byte)
```

Look at that: `shifted_byte[0]` is `0x56` — the exact same marker value as byte 9 in a normal human frame. And `shifted_byte[1]` has high nibble 4 — exactly the d0 check for a position frame. The human data has the **same structure** as a normal frame, just shoved over by half a byte inside the bot's frame.

From there it's the same math:
- `Y_raw = shifted_byte[1] × 256 + shifted_byte[2]`
- `X_raw = (shifted_byte[3] & 0x0F) × 256 + shifted_byte[4]`

And then cumulative deltas as before.

### Sanity check

In our test films the human walked one loop around the map. Solo films gave us a path with these properties:
- X range ≈ 2000–2400 raw units
- Y range ≈ 270–300 raw units
- Start and end points nearly identical (loop closes)

The embedded-human decode in PvE films gives us the **same thing**:
- X range ≈ 2060–2090
- Y range ≈ 272–276
- Loop closes within ~160 units

Meanwhile the *fake* human stream (byte-aligned at offset 10 in PvE films, with `b8=0x4d`) gives X range ≈ 1260 and never visits the north half of the map. Wrong.

---

## Side-by-side: Solo/PvP vs PvE

| | Solo / PvP | PvE (human + bot) |
|---|---|---|
| **Human position location** | Byte-aligned at offset 10–13 in the human's own frames | **Nibble-shifted** at offset ~37–42 **inside bot frames**, after `10 0A 30` marker |
| **Bot position location** | n/a | Byte-aligned at offset 11–14 (one byte later than normal) in bot frames |
| **Human frame header** | `b7=0x00`, `b9=0x56`, d0 high nibble = 4 | Same — but only ~7–15 such frames exist, all at match start before bot spawns |
| **Bot frame header** | n/a | `b7=0x40`, `b9=0x35`, d0 (at offset 11) high nibble = 0 |
| **How to detect** | No `b9=0x35` frames → standard mode | `b9=0x35` frames present AND embedded `10 0A 30` sub-records with shifted-b9=`0x56` |
| **Trap to avoid** | — | Byte-aligned `b8=0x4d b9=0x56` stream at offset 10 looks like the human but **isn't** — it tracks something else (bot's target?) |

---

## Why does PvE do this?

We don't know for sure — this is reverse engineering, not a spec. Best guess:

When the bot is the "primary" entity generating frames, the game's frame writer treats the human as an **attached piece of state** inside the bot's perspective rather than a peer entity. This is a common pattern in game netcode: "here's what the AI sees, including where the opponent is." The nibble shift is probably a bit-packing artifact — some preceding field has an odd number of nibbles, and the human sub-record gets packed right after it without padding to a byte boundary.

---

## Bot coordinate scale (unresolved)

We've noticed the bot's cumulative-coordinate range is consistently ~2.5–4× larger than the human's, even though both are on the same map. The bot's deltas are smooth (no wraparound errors), so the accumulation is correct. Hypotheses:

1. **Different encoding resolution** — the bot stream might use more raw units per world-meter than the human stream.
2. **Bot just moves more** — the bot wanders for the full match while the human does one quick loop; over ~7× more frames, cumRange naturally grows.

Currently we render the bot at an independent scale (fitted to map bounds) rather than trying to register it against the human. This gives a visually coherent bot path at the cost of exact position correspondence.

---

## Glossary

| Term | Meaning |
|---|---|
| **Frame** | One "tick" of recorded game state, marked by `A0 7B 42` |
| **Marker** | The three-byte `A0 7B 42` sequence that starts every frame |
| **Base type** | The low 5 bits of byte 6. `0x09` is the standard position type for most maps |
| **Stream selector** | Byte 7. Picks which entity's data this frame carries (`0x00` human, `0x40` bot) |
| **d0–d3** | The four "data bytes" holding coordinate info. Normally at offsets 10–13 |
| **cumCoord** | Cumulative coordinate — running total of corrected deltas |
| **Wraparound** | When a raw coordinate rolls over (like an odometer). We detect and correct these by checking for implausibly large deltas |
| **Nibble** | Half a byte (4 bits). One hex digit. |
| **Nibble-shifted** | Data where the real byte boundaries are offset by 4 bits from the file's byte boundaries |
| **Sub-record** | A mini-frame packed inside a bigger frame, with its own marker (`10 0A 30` for the human in PvE) |

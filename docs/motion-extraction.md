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

---

# How We Figured This Out (Reverse-Engineering Methodology)

None of the above was documented. Here's the process we used to discover it, written so someone else can do the same on a different format.

## Step 0: Control the experiment

The single most important thing: **record films where you know exactly what happened**.

- Walk a precise path (one clockwise loop, start and end at the same spot).
- Change exactly one variable per film (solo vs PvP vs PvE, same map, same route).
- Do something distinctive in each phase (e.g., "walked straight north for 10 seconds, then turned east") so you can spot those phases in the data.

A film of "I ran around randomly for 2 minutes" is almost useless. A film of "I walked from spawn A to spawn B in a straight line, then stood still for 5 seconds" is gold — you know the X should increase monotonically then go flat.

## Step 1: Find the frame markers

Position data repeats many times per second. If the film is a 60-second match and there are 60+ frames per second, there should be some 3-or-4-byte sequence that appears **thousands of times** — once per frame.

**Technique**: Slide a window over the file and count every distinct 3-byte sequence. The one that appears way more than any other is your frame marker.

```
for i in 0..len-3:
    triplet = bytes[i:i+3]
    count[triplet] += 1
sort counts descending → 'A0 7B 42' appears 5000+ times, next runner-up appears <100 times
```

Sanity check: if you found the right marker, the gaps between consecutive markers should be roughly consistent (tens to hundreds of bytes, not 1 byte or 50,000 bytes). Irregular gaps are normal (different frame types have different sizes), but you shouldn't see markers 2 bytes apart.

## Step 2: Classify frames by header bytes

Once you know where frames start, look at the first ~10 bytes after each marker. Make a histogram of each byte position:

| offset | unique values seen | most common |
|---|---|---|
| +5 | 1 | `40` (always) ← structural constant |
| +6 | 4 | `09`, `08`, `29`, `28` ← low variety = type field |
| +7 | 3 | `00`, `40`, `05` ← also a type selector |
| +9 | 8 | `56`, `35`, ... ← more variety, but still discrete |
| +10 | 256 | full range ← this is data, not header |

**Rule of thumb**: bytes with few distinct values are **structure** (type fields, flags). Bytes with many distinct values are **data** (positions, angles).

Offset +10 having the full range tells you "data starts here." Offsets +5 through +9 having low variety tells you "these are frame-type bytes."

## Step 3: Find the position channel

Position data has a **signature**: it changes smoothly. A player walking moves a tiny amount between consecutive frames. If you plot byte values frame-to-frame, position data looks like a gentle ramp, while random data looks like noise.

**Technique**: For each candidate byte offset (10, 11, 12, ...), compute the **average absolute delta** between consecutive frames:

```
for each offset k in 10..20:
    deltas = [abs(frame[i+1][k] - frame[i][k]) for each consecutive pair]
    print(k, mean(deltas), stddev(deltas))
```

| offset | mean |δ| | stddev | interpretation |
|---|---|---|---|
| 10 | 0.8 | 3.2 | smooth ← position byte! |
| 11 | 12.4 | 45.1 | changes a lot per frame ← low byte of position (more sensitive) |
| 12 | 1.1 | 4.8 | smooth ← also position |
| 13 | 18.9 | 52.3 | low byte of the other coord |
| 14 | 127.3 | 88.0 | random-looking ← NOT position (probably angle, state, or unrelated) |

Offsets 10-13 are smooth. Offsets 10 and 12 are *very* smooth (high bytes — they only change when the low byte overflows). Offsets 11 and 13 change more but still correlate frame-to-frame. **That's your position block.**

## Step 4: Figure out the bit widths and byte pairing

You found 4 bytes of position data. But how do they combine? Is it two 16-bit numbers? One 32-bit number? Two 12-bit numbers packed funny?

**Technique A — check high-nibble constancy**: If a byte's high nibble is always the same value (e.g., always 4), that nibble is probably a **marker**, not data. So `d0 = 0x4X` means the real data is only 12 bits (low nibble of d0 + full d1), and the `4` is a channel tag.

**Technique B — plot the raw values**: Combine candidate byte pairs into numbers and plot them over time for a film where you walked a straight line.

- If `(d0*256 + d1)` goes up smoothly and `(d2*256 + d3)` stays flat → you walked along the d0/d1 axis.
- If both change, you walked diagonally. Try a film where you walked purely north.

**Technique C — look for wraparound**: If `d1` jumps from 255 to 0 while `d0` increments by 1 at the same moment, they're a paired 16-bit number. If `d1` wraps but `d0` *doesn't* change, d0 is a separate field.

In our case: `d2`'s high nibble varies but only takes values like {2,3,6,7,10,11,14,15} in bot streams — that's **not** random, it's structured. The low nibble of `d2` is the real data. So `X = (d2 & 0x0F) << 8 | d3` = 12-bit X.

## Step 5: Verify with the loop-closure test

**This is the most powerful test in the whole toolkit.** If the player walked a loop and ended where they started, the correct decode should give a cumulative position that **returns to nearly zero**.

```
decode all frames → compute cumulative deltas → last cumCoord ≈ (0, 0)?
```

- Got (2, -15)? Good enough — small drift is normal.
- Got (4500, -128)? Something's wrong. Maybe you're including a wraparound that isn't one, or filtering out frames that matter, or your bit width is off by one.

This test catches **almost every decode error** because errors compound. A single bad wraparound adds ±4096 to the cumulative — very visible.

## Step 6: How we found the nibble shift (PvE)

When we hit PvE films, the byte-aligned decode produced a path that didn't form a loop. Steps to diagnose:

### 6a. Rule out the obvious

First: is it a **filtering** problem? Maybe we're including frames from the wrong entity.

- Split frames by every header byte and decode each subset separately.
- If one subset gives a clean loop, that's your filter.
- **Result**: No subset of byte-aligned frames gave a loop. So the data itself is wrong, not the filter.

### 6b. Diff against the working case

Take a Solo film (works) and a PvE film (broken) where the human did the **same thing**. Compare:

| | Solo | PvE | Suspicious? |
|---|---|---|---|
| Human frames/sec | ~20 | ~5 | PvE has way fewer! Where did they go? |
| Bot frames/sec | 0 | ~30 | Bot has tons of frames |
| Human X range (raw) | 1300–3400 | 2400–3600 | Half the range missing! |

The human appears to have **far fewer frames** in PvE, and the range is truncated. Meanwhile the bot has a suspiciously high frame count. **Hypothesis**: the bot's frames are carrying the human's data somewhere.

### 6c. Search inside the bot frames

The bot's frames are ~60 bytes long but we only read bytes 11-14. What's in the rest?

**Technique**: Dump the full bot frame bytes for 10 consecutive frames and look for **smoothly-changing regions** (same trick as Step 3, but per-offset inside the bot frame):

```
for offset in 10..55:
    mean_delta = mean(|frame[i+1][offset] - frame[i][offset]| for i in consecutive pairs)
```

We found **two** smooth regions:
- Offsets 11-14 (the bot's own position — already known)
- Offsets ~38-42 — another smooth region!

### 6d. Recognize the structure in the second region

Dumped bytes around offset 38 for a handful of frames:

```
34  35  36  37  38  39  40
10  0a  30  15  64  08  c6  ← frame 1
10  0a  30  15  64  08  d2  ← frame 2  (only byte 40 changes slightly)
10  0a  30  15  64  08  e0  ← frame 3
```

`10 0A 30` is constant — **that's a marker**. `15 64` is mostly constant — smells like a header. The changing bytes are further in.

### 6e. Discover the nibble shift

The key observation: byte 37 is always `0x15` and byte 38 is always `0x64`. Those specific values look boring. But:

```
(0x15 & 0x0F) = 5,  (0x64 >> 4) = 6  → combine: 5<<4 | 6 = 0x56
```

`0x56` is the **exact marker byte** (b9) for human frames in solo films! And:

```
(0x64 & 0x0F) = 4,  (next byte >> 4) = ?  → combine: 4<<4 | ? = 0x4?
```

`0x4?` is the d0 pattern for human position frames (high nibble = 4)!

**The human frame header is there, just offset by half a byte.** Once you see it, you can't unsee it. Apply the nibble-shift decode and suddenly the loop-closure test passes.

### 6f. Why look for a nibble shift at all?

We didn't immediately guess "nibble shift." We first tried:

- Every byte offset (38, 39, 40, ...) as the start of human data → none gave a loop
- XORing with various constants → no luck
- Big-endian vs little-endian → no luck

The breakthrough was noticing the **constant bytes** (`15`, `64`) and asking "what if I recombine them differently?" When `(15 & 0xF)<<4 | (64>>4) = 0x56` matched a known marker, that was the eureka moment. General principle: **constant bytes next to data are often markers — if the byte values don't match a known marker, try nibble-recombining them.**

## Step 7: Falsifying the wrong hypotheses

Reverse engineering produces a lot of "maybe it's this?" moments. Kill bad hypotheses fast:

**The byte-aligned `b8=0x4d` stream looked like the human but wasn't.** How we proved it:

1. **Range test**: Its X values never went below 2413, but the Solo human's X hits ~1300 during the north leg. A correct decode should cover the same range as Solo. FAIL.

2. **Correlation test**: If stream A and stream B are the same entity, `A[t] - B[t]` should be roughly constant. We compared b8=4d frames to embedded-sub-record frames at the same timestamps — the offset **drifted** (from +237 to +80 over the match). Two entities moving independently give a drifting offset. SAME-ENTITY HYPOTHESIS FAIL.

3. **Loop-closure test**: Solo closes the loop at (-11, -73). Embedded sub-record closes at (0, 163). b8=4d doesn't close at all (ends 600+ units away from start). FAIL.

Three independent failures = that stream is definitively not the human.

## General heuristics cheat sheet

| If you see… | It probably means… |
|---|---|
| A byte that's always the same value | Structural constant / marker |
| A byte with 2-8 distinct values | Type selector / flags |
| A byte that uses the full 0-255 range | Data (position, angle, timestamp) |
| Two bytes where one wraps 255→0 as the other increments | They're a paired 16-bit number |
| A byte whose high nibble is constant but low nibble varies | 4-bit marker + 4-bit data, or the low nibble is the real high nibble of a 12-bit field |
| Smooth frame-to-frame deltas (mean δ < 10) | Continuous physical quantity (position, look angle) |
| Noisy deltas (mean δ > 50) | Unrelated field, or the low byte of a fast-changing quantity |
| Constant bytes that don't match any known marker | Try nibble-recombining with neighbors — might be bit-shifted |
| Your known-loop path doesn't close | Wrong bit width, wrong wraparound threshold, or mixing multiple entity streams |
| Fewer frames than expected for one entity, more for another | Data may be packed into the other entity's frames |

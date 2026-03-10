/**
 * Motion path extraction from film chunks
 * Ported from test-new-film.cjs and docs/motion-extraction.md
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { MotionPoint, PlayerPath } from './types.js';
import { dim } from './ui.js';

/**
 * Player index is encoded in bits 7-5 of the second byte of the frame type.
 * e.g., 40090005 = player 0, 40290005 = player 1 (0x09 vs 0x29, diff = 0x20)
 * Base frame type = second byte & 0x1f
 */
function getPlayerIndex(frameTypeByte1: number): number {
  return (frameTypeByte1 >> 5) & 0x07;
}

function getBaseType(frameTypeByte1: number): number {
  return frameTypeByte1 & 0x1f;
}

/**
 * Build the 4-byte frame type hex string for a given base type and player index.
 * Base type is the original hex string (e.g. '40090005'), player index 0-7.
 */
function buildFrameTypeHex(baseHex: string, playerIndex: number): string {
  const bytes = Buffer.from(baseHex, 'hex');
  bytes[1] = (bytes[1] & 0x1f) | ((playerIndex & 0x07) << 5);
  return bytes.toString('hex');
}

/**
 * Detect all entity streams present in the film by scanning frame types.
 *
 * An entity stream is a (playerIndex, isBot) pair. In bot/PvE films the
 * same playerIndex can carry both a standard human stream (b7=0x00) and
 * a shifted bot stream (b7=0x40), which must be extracted separately.
 *
 * Returns a sorted array of detected entities.
 */
const MIN_PLAYER_FRAMES = 10;

interface DetectedEntity {
  playerIndex: number;
  isBot: boolean;
}

function detectEntities(chunks: Buffer[]): DetectedEntity[] {
  // Standard stream: b7==0x00 (or base 0x08 which has no b7 split) with d0hn==4
  const standardCounts = new Map<number, number>();
  // Bot shifted stream: b7==0x40, p9&1==1, d1hn==0
  const shiftedCounts = new Map<number, number>();

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 14 >= chunk.length) continue;
      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40) continue;

      const base = getBaseType(byte6);
      const pi = getPlayerIndex(byte6);

      if (base === 0x09) {
        const byte7 = chunk[pos + 7];
        if (byte7 === 0x00 && (chunk[pos + 10] >> 4) === 4) {
          standardCounts.set(pi, (standardCounts.get(pi) || 0) + 1);
        } else if (
          byte7 === 0x40 &&
          (chunk[pos + 9] & 0x01) === 1 &&
          (chunk[pos + 11] >> 4) === 0
        ) {
          shiftedCounts.set(pi, (shiftedCounts.get(pi) || 0) + 1);
        }
      } else if (base === 0x08) {
        // 40088064-style frames (no known bot variant)
        standardCounts.set(pi, (standardCounts.get(pi) || 0) + 1);
      }
    }
  }

  const entities: DetectedEntity[] = [];
  for (const [pi, count] of standardCounts) {
    if (count >= MIN_PLAYER_FRAMES) entities.push({ playerIndex: pi, isBot: false });
  }
  for (const [pi, count] of shiftedCounts) {
    if (count >= MIN_PLAYER_FRAMES) entities.push({ playerIndex: pi, isBot: true });
  }

  return entities.sort(
    (a, b) => a.playerIndex - b.playerIndex || Number(a.isBot) - Number(b.isBot)
  );
}

/**
 * Detect if this film uses the PvE embedded-human encoding.
 * True if bot (b9=0x35) frames exist AND embedded '10 0a 30' sub-records
 * with shifted-b9=0x56 are present in meaningful numbers.
 */
function detectPvEEmbeddedMode(chunks: Buffer[]): boolean {
  let botFrames = 0;
  let embeddedHuman = 0;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 45 >= chunk.length) continue;
      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40 || getBaseType(byte6) !== 0x09) continue;
      if (chunk[pos + 9] !== 0x35) continue;
      botFrames++;

      // Check for embedded human sub-record
      for (let off = 30; off <= 38; off++) {
        if (pos + off + 6 >= chunk.length) break;
        if (chunk[pos + off] !== 0x10 || chunk[pos + off + 1] !== 0x0a || chunk[pos + off + 2] !== 0x30) {
          continue;
        }
        const base = pos + off + 3;
        const sb9 = ((chunk[base] & 0x0f) << 4) | (chunk[base + 1] >> 4);
        const sd0 = ((chunk[base + 1] & 0x0f) << 4) | (chunk[base + 2] >> 4);
        if (sb9 === 0x56 && (sd0 >> 4) === 4) embeddedHuman++;
        break;
      }

      // Early exit once we have enough evidence
      if (botFrames >= 50 && embeddedHuman >= MIN_PLAYER_FRAMES) return true;
    }
  }
  return embeddedHuman >= MIN_PLAYER_FRAMES;
}

/**
 * Find all frame markers (A0 7B 42) in a buffer
 */
function findMarkers(buffer: Buffer): number[] {
  const positions: number[] = [];
  for (let i = 0; i < buffer.length - 3; i++) {
    if (buffer[i] === 0xa0 && buffer[i + 1] === 0x7b && buffer[i + 2] === 0x42) {
      positions.push(i);
    }
  }
  return positions;
}

/**
 * Extract positions using frame type 40088064 (Bazaar and most maps)
 * Uses adaptive wraparound with 16384 threshold for positive deltas
 * to handle grappling hook and other fast movements correctly
 * @param targetType - Frame type hex string to match (e.g., '40088064' for player 0, '40288064' for player 1)
 */
function extract40088064(chunks: Buffer[], targetType = '40088064'): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevCoord1: number | null = null;
  let prevCoord2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const typeBytes = chunk.subarray(pos + 5, pos + 9).toString('hex');
      if (typeBytes !== targetType) continue;

      const b0 = chunk[pos + 10];
      const b1 = chunk[pos + 11];
      const b2 = chunk[pos + 12];
      const b3 = chunk[pos + 13] & 0x7f;

      const coord1Raw = b0 * 256 + b1;
      const coord2Raw = b2 * 256 + b3;

      if (prevCoord1 !== null && prevCoord2 !== null) {
        let delta1 = coord1Raw - prevCoord1;
        let delta2 = coord2Raw - prevCoord2;

        // Handle wraparound for coord1 (16-bit)
        // Use 16384 threshold for positive deltas to catch fast movements (grappling hook)
        // that wrap around the coordinate space but appear as large positive jumps
        // NOTE: Use else-if to prevent the negative wraparound from undoing the positive correction
        if (delta1 > 16384) {
          delta1 -= 65536;
        } else if (delta1 < -32768) {
          delta1 += 65536;
        }

        // Handle wraparound for coord2
        // coord2 can span 0-65407 (8-bit b2 + 7-bit b3), so use 16-bit wraparound
        // but also handle the case where it wraps within 15-bit range
        if (delta2 > 32768) delta2 -= 65536;
        else if (delta2 > 16384) delta2 -= 32768;
        if (delta2 < -32768) delta2 += 65536;
        else if (delta2 < -16384) delta2 += 32768;

        // NOTE: No discontinuity filtering for 40088064 - the adaptive wraparound handles it

        cumCoord1 += delta1;
        cumCoord2 += delta2;
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: coord1Raw,
        raw2: coord2Raw,
      });

      prevCoord1 = coord1Raw;
      prevCoord2 = coord2Raw;
    }
  }

  return positions;
}

/**
 * Extract positions using base type 0x09 frames
 * (Live Fire, Aquarius, and similar maps).
 * Uses 12-bit encoding for coord2 with discontinuity filtering.
 *
 * Position frames are identified by: byte5=0x40, base type 0x09,
 * AND data byte 0 high nibble = 4 (d[0] is 0x40 or 0x41).
 *
 * All matching frames are processed sequentially with cumulative deltas.
 * No deduplication — all data points are emitted.
 *
 * @param chunks - Film chunk buffers
 * @param playerIndex - Player index (0-7)
 */
function extractBase09Position(chunks: Buffer[], playerIndex: number): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevC1: number | null = null;
  let prevC2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;
  const DISCONTINUITY_THRESHOLD = 4000;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];

      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;
      // byte7 encodes entity stream type: 0x00=human standard, 0x05=camera/orbit,
      // 0x40=bot shifted. Only accept the standard human stream here.
      if (chunk[pos + 7] !== 0x00) continue;

      const b0 = chunk[pos + 10];

      // Filter: only position-channel frames (data byte 0 high nibble = 4)
      if ((b0 >> 4) !== 4) continue;

      const b1 = chunk[pos + 11];
      const b2 = chunk[pos + 12];
      const b3 = chunk[pos + 13];

      const c1 = b0 * 256 + b1;
      const c2 = ((b2 & 0x0f) << 8) | b3;

      if (prevC1 !== null && prevC2 !== null) {
        let delta1 = c1 - prevC1;
        let delta2 = c2 - prevC2;

        // 16-bit wraparound for coord1
        if (delta1 > 32768) delta1 -= 65536;
        if (delta1 < -32768) delta1 += 65536;

        // 12-bit wraparound for coord2 (range 0-4095)
        if (delta2 > 2048) delta2 -= 4096;
        if (delta2 < -2048) delta2 += 4096;

        // Skip discontinuities (spawn/death jumps or object switches)
        if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD) delta1 = 0;
        if (Math.abs(delta2) > DISCONTINUITY_THRESHOLD) delta2 = 0;

        cumCoord1 += delta1;
        cumCoord2 += delta2;
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: c1,
        raw2: c2,
      });

      prevC1 = c1;
      prevC2 = c2;
    }
  }

  return positions;
}

/**
 * Extract positions from the bot/AI shifted stream (b7=0x40).
 *
 * Bot frames use a one-byte-shifted data layout relative to the standard
 * human stream: coord bytes live at +11..+14 instead of +10..+13, signaled
 * by p9 bit 0 = 1 and a high-nibble-0 check at pos+11 instead of the
 * high-nibble-4 check at pos+10.
 *
 * @param chunks - Film chunk buffers
 * @param playerIndex - Player index (0-7)
 */
function extractBase09BotShifted(chunks: Buffer[], playerIndex: number): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevC1: number | null = null;
  let prevC2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;
  const DISCONTINUITY_THRESHOLD = 4000;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 14 >= chunk.length) continue;

      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];

      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;
      if (chunk[pos + 7] !== 0x40) continue;           // bot/AI stream marker
      if ((chunk[pos + 9] & 0x01) !== 1) continue;     // shifted-layout flag

      const b0 = chunk[pos + 11];
      // Shifted high-nibble check (mirrors the standard d0hn==4 filter)
      if ((b0 >> 4) !== 0) continue;

      const b1 = chunk[pos + 12];
      const b2 = chunk[pos + 13];
      const b3 = chunk[pos + 14];

      const c1 = b0 * 256 + b1;
      const c2 = ((b2 & 0x0f) << 8) | b3;

      if (prevC1 !== null && prevC2 !== null) {
        let delta1 = c1 - prevC1;
        let delta2 = c2 - prevC2;

        // 16-bit wraparound for coord1
        if (delta1 > 32768) delta1 -= 65536;
        if (delta1 < -32768) delta1 += 65536;

        // 12-bit wraparound for coord2 (range 0-4095)
        if (delta2 > 2048) delta2 -= 4096;
        if (delta2 < -2048) delta2 += 4096;

        // Skip discontinuities (spawn/death jumps)
        if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD) delta1 = 0;
        if (Math.abs(delta2) > DISCONTINUITY_THRESHOLD) delta2 = 0;

        cumCoord1 += delta1;
        cumCoord2 += delta2;
      }

      // raw1 is normalized with a +0x4000 bias so its baseline aligns with the
      // standard stream (where d0 high nibble is 4 → c1 ∈ 0x4000..0x4FFF).
      // This lets scaleAllPlayersToWorld register bot and human paths in the
      // same absolute coordinate space. Delta tracking uses local prevC1/c1
      // and is unaffected by this offset.
      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: c1 + 0x4000,
        raw2: c2,
      });

      prevC1 = c1;
      prevC2 = c2;
    }
  }

  return positions;
}

/**
 * Extract human positions from PvE (human + bot) films where human coords
 * are embedded as a 4-BIT-SHIFTED SUB-RECORD inside each bot frame.
 *
 * In PvE films, the bot's presence changes the frame encoding: each bot frame
 * (b9=0x35) carries the bot's own position at the usual pos+11..14 location,
 * AND an embedded human-position sub-record ~34 bytes in, at a 4-bit (one
 * nibble) offset from byte alignment.
 *
 * Sub-record structure:
 *   pos+34: 10 0a 30           ← sub-record marker
 *   pos+37: X5 64 YY ZZ WW ..  ← 4-bit-shifted human coords
 *           └─ nibble-shift decode:
 *              (X5 & 0xF)<<4 | (64>>4) = 0x56  (human b9 marker)
 *              (64 & 0xF)<<4 | (YY>>4) = 0x4?  (d0, position channel)
 *              ... then c1 = d0*256+d1, c2 = (d2&0xF)<<8|d3 as usual.
 *
 * Also merges the few "normal" pi=1 frames present before the bot spawns.
 */
function extractPvEHumanEmbedded(chunks: Buffer[]): MotionPoint[] {
  const frames: Array<{ gp: number; c1: number; c2: number }> = [];
  let globalPos = 0;
  const DISCONTINUITY_THRESHOLD = 4000;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 45 >= chunk.length) continue;
      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40 || getBaseType(byte6) !== 0x09) continue;

      const pi = getPlayerIndex(byte6);
      const b7 = chunk[pos + 7];
      const b9 = chunk[pos + 9];

      // Source A: Normal human frame at pi=1 — rare in PvE, only at match start
      // before bot spawns. Same layout as Solo/PvP.
      if (pi === 1 && b7 === 0x00 && b9 === 0x56 && (chunk[pos + 10] >> 4) === 4) {
        const c1 = chunk[pos + 10] * 256 + chunk[pos + 11];
        const c2 = ((chunk[pos + 12] & 0x0f) << 8) | chunk[pos + 13];
        frames.push({ gp: globalPos + pos, c1, c2 });
        continue;
      }

      // Source B: Embedded 4-bit-shifted sub-record inside bot (b9=0x35) frames.
      // Scan a small window for the '10 0a 30' sub-record marker to tolerate
      // layout drift across b8 variants (0x05 vs 0x15).
      if (b9 === 0x35) {
        for (let off = 30; off <= 38; off++) {
          if (pos + off + 9 >= chunk.length) break;
          if (chunk[pos + off] !== 0x10 || chunk[pos + off + 1] !== 0x0a || chunk[pos + off + 2] !== 0x30) {
            continue;
          }
          // 4-bit-shift decode: shiftByte(k) = (b[k]_lo << 4) | b[k+1]_hi
          const base = pos + off + 3;
          const shiftByte = (k: number): number =>
            ((chunk[base + k] & 0x0f) << 4) | (chunk[base + k + 1] >> 4);

          const sb9 = shiftByte(0);
          const sd0 = shiftByte(1);
          // Validate: shifted b9 must be 0x56 (human marker), d0 hnib must be 4
          if (sb9 !== 0x56 || (sd0 >> 4) !== 4) break;

          const sd1 = shiftByte(2);
          const sd2 = shiftByte(3);
          const sd3 = shiftByte(4);
          const c1 = sd0 * 256 + sd1;
          const c2 = ((sd2 & 0x0f) << 8) | sd3;
          frames.push({ gp: globalPos + pos + off, c1, c2 });
          break; // one sub-record per bot frame
        }
      }
    }
    globalPos += chunk.length;
  }

  // Sort by byte position (NORM and NIB interleave across chunks)
  frames.sort((a, b) => a.gp - b.gp);

  // Convert to MotionPoint with cumulative deltas (same as extractBase09Position)
  const positions: MotionPoint[] = [];
  let prevC1: number | null = null;
  let prevC2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;

  for (let i = 0; i < frames.length; i++) {
    const { c1, c2 } = frames[i];
    if (prevC1 !== null && prevC2 !== null) {
      let delta1 = c1 - prevC1;
      let delta2 = c2 - prevC2;
      if (delta1 > 32768) delta1 -= 65536;
      if (delta1 < -32768) delta1 += 65536;
      if (delta2 > 2048) delta2 -= 4096;
      if (delta2 < -2048) delta2 += 4096;
      if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD) delta1 = 0;
      if (Math.abs(delta2) > DISCONTINUITY_THRESHOLD) delta2 = 0;
      cumCoord1 += delta1;
      cumCoord2 += delta2;
    }
    positions.push({
      frame: i,
      cumCoord1,
      cumCoord2,
      raw1: c1,
      raw2: c2,
    });
    prevC1 = c1;
    prevC2 = c2;
  }

  return positions;
}

/**
 * Extract positions using frame type 40090005 (exact match, legacy path)
 * Used by variant detection for single-player films where exact match works.
 * @param targetType - Frame type hex string to match (e.g., '40090005' for player 0, '40290005' for player 1)
 */
function extract40090005_exact(chunks: Buffer[], targetType = '40090005'): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevCoord1: number | null = null;
  let prevCoord2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;

  const DISCONTINUITY_THRESHOLD = 4000;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const typeBytes = chunk.subarray(pos + 5, pos + 9).toString('hex');
      if (typeBytes !== targetType) continue;

      const b0 = chunk[pos + 10];
      const b1 = chunk[pos + 11];
      const b2 = chunk[pos + 12];
      const b3 = chunk[pos + 13];

      const coord1Raw = b0 * 256 + b1;
      const coord2Raw = ((b2 & 0x0f) << 8) | b3;

      if (prevCoord1 !== null && prevCoord2 !== null) {
        let delta1 = coord1Raw - prevCoord1;
        let delta2 = coord2Raw - prevCoord2;

        // 16-bit wraparound for coord1
        if (delta1 > 32768) delta1 -= 65536;
        if (delta1 < -32768) delta1 += 65536;

        // 12-bit wraparound for coord2 (range 0-4095)
        if (delta2 > 2048) delta2 -= 4096;
        if (delta2 < -2048) delta2 += 4096;

        // Skip discontinuities (spawn/death jumps)
        if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD) delta1 = 0;
        if (Math.abs(delta2) > DISCONTINUITY_THRESHOLD) delta2 = 0;

        cumCoord1 += delta1;
        cumCoord2 += delta2;
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: coord1Raw,
        raw2: coord2Raw,
      });

      prevCoord1 = coord1Raw;
      prevCoord2 = coord2Raw;
    }
  }

  return positions;
}

/**
 * Extract positions using base type 0x09 "b3 variant" (Argyle and similar maps)
 * Uses 9-bit c1 from b0 bit 0 + b1, and 8-bit c2 from b3 alone.
 * Uses flexible matching: base type 0x09 + data[0] high nibble = 4.
 */
function extractBase09_b3variant(chunks: Buffer[], playerIndex: number): MotionPoint[] {
  const positions: MotionPoint[] = [];
  let prevCoord1: number | null = null;
  let prevCoord2: number | null = null;
  let cumCoord1 = 0;
  let cumCoord2 = 0;
  let frameCount = 0;

  const DISCONTINUITY_THRESHOLD = 60;

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);

    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;

      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;
      if (chunk[pos + 7] !== 0x00) continue;

      const b0 = chunk[pos + 10];
      // Only position-channel frames
      if ((b0 >> 4) !== 4) continue;

      const b1 = chunk[pos + 11];
      const b3 = chunk[pos + 13];

      // c1 uses b0 bit 0 as the 9th bit (carry), b1 as the lower 8 bits
      const coord1Raw = ((b0 & 1) << 8) | b1;
      // c2 is just b3 (8-bit)
      const coord2Raw = b3;

      if (prevCoord1 !== null && prevCoord2 !== null) {
        let delta1 = coord1Raw - prevCoord1;
        let delta2 = coord2Raw - prevCoord2;

        // 9-bit wraparound for coord1
        if (delta1 > 256) delta1 -= 512;
        if (delta1 < -256) delta1 += 512;

        // 8-bit wraparound for coord2
        if (delta2 > 128) delta2 -= 256;
        if (delta2 < -128) delta2 += 256;

        // Skip discontinuities (deaths/respawns)
        if (Math.abs(delta1) > DISCONTINUITY_THRESHOLD || Math.abs(delta2) > DISCONTINUITY_THRESHOLD) {
          // Skip this frame's delta
        } else {
          cumCoord1 += delta1;
          cumCoord2 += delta2;
        }
      }

      positions.push({
        frame: frameCount++,
        cumCoord1,
        cumCoord2,
        raw1: coord1Raw,
        raw2: coord2Raw,
      });

      prevCoord1 = coord1Raw;
      prevCoord2 = coord2Raw;
    }
  }

  return positions;
}

/**
 * Detect the encoding variant for base-0x09 position frames.
 *
 * The b5 pattern check is only valid for frames with exact subtype 0005
 * (e.g., 40090005). In multi-player films, other subtypes like 4009004d have
 * different non-data field layouts, so b5 pattern checks on them give false results.
 *
 * Strategy:
 * 1. If there are enough exact-0005 frames, use those for b5 pattern detection
 * 2. Otherwise, check c1 range: if c1 values span a wide range (>500), it's
 *    standard 16-bit encoding; if narrow (<512), might be b3variant with 9-bit c1
 *
 * Returns detection info for all three possible variants:
 * - "9bit": standard (b5 pattern valid on 0005 frames, or standard c1 range)
 * - "b3variant": b3 variant (narrow c1 range, b5 pattern fails on 0005 frames)
 * - "standard": standard 16-bit c1, 12-bit c2
 */
function detectBase09Variant(chunks: Buffer[], playerIndex: number): {
  variant: '9bit' | 'b3variant' | 'standard' | 'invalid';
  frameCount: number;
  b0PatternPct: number;
  b5PatternPct: number;
  uniqueB3: number;
  uniqueC2_9bit: number;
} {
  // Collect data from ALL position frames (base 0x09, d[0] hnib=4)
  const allB0Values: number[] = [];
  const allB3Values: number[] = [];
  const allC1Values: number[] = [];

  // Separately track exact-0005 subtype frames for b5 pattern detection
  const exact0005B5: number[] = [];
  const exact0005C2_9bit: number[] = [];

  const targetExactType = buildFrameTypeHex('40090005', playerIndex);

  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 16 >= chunk.length) continue;

      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;
      if (chunk[pos + 7] !== 0x00) continue;

      const d0 = chunk[pos + 10];
      if ((d0 >> 4) !== 4) continue;

      allB0Values.push(d0);
      allB3Values.push(chunk[pos + 13]);
      allC1Values.push(d0 * 256 + chunk[pos + 11]);

      // Check exact subtype for b5 pattern
      const typeHex = chunk.subarray(pos + 5, pos + 9).toString('hex');
      if (typeHex === targetExactType) {
        exact0005B5.push(chunk[pos + 15]);
        exact0005C2_9bit.push(((chunk[pos + 15] & 1) << 8) | chunk[pos + 16]);
      }
    }
  }

  const frameCount = allB0Values.length;
  if (frameCount < 20) {
    return { variant: 'invalid', frameCount, b0PatternPct: 0, b5PatternPct: 0, uniqueB3: 0, uniqueC2_9bit: 0 };
  }

  const b0PatternPct = allB0Values.filter(v => {
    const hi = v >> 4;
    return hi === 0 || hi === 4;
  }).length / frameCount * 100;

  const uniqueB3 = new Set(allB3Values).size;

  // Use exact-0005 frames for b5 pattern if available (>= 10 frames)
  let b5PatternPct: number;
  let uniqueC2_9bit: number;

  if (exact0005B5.length >= 10) {
    b5PatternPct = exact0005B5.filter(v => (v & 0x1e) === 0).length / exact0005B5.length * 100;
    uniqueC2_9bit = new Set(exact0005C2_9bit).size;
  } else {
    // No exact-0005 frames available - use c1 range heuristic
    // Standard 16-bit c1 has wide range (thousands); b3variant 9-bit c1 max is 511
    const minC1 = Math.min(...allC1Values);
    const maxC1 = Math.max(...allC1Values);
    const c1Range = maxC1 - minC1;

    // If c1 range > 512, it's definitely not b3variant (which uses 9-bit = max 511)
    if (c1Range > 512) {
      b5PatternPct = 100; // Force standard/9bit detection
      uniqueC2_9bit = 100;
    } else {
      b5PatternPct = 0;
      uniqueC2_9bit = 0;
    }
  }

  // Standard 9-bit: b0 pattern >=95% AND b5 pattern >=95% AND unique c2_9bit >=20
  if (b0PatternPct >= 95 && b5PatternPct >= 95 && uniqueC2_9bit >= 20) {
    return { variant: '9bit', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
  }

  // b3 variant: b0 pattern >=95% AND b5 pattern <50% AND b3 has good variation
  if (b0PatternPct >= 95 && b5PatternPct < 50 && uniqueB3 >= 20) {
    return { variant: 'b3variant', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
  }

  // Standard: b3 varies (original validation)
  if (uniqueB3 >= 20) {
    return { variant: 'standard', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
  }

  return { variant: 'invalid', frameCount, b0PatternPct, b5PatternPct, uniqueB3, uniqueC2_9bit };
}

/**
 * Count base-0x09 position frames for a player using flexible matching.
 */
function countBase09PositionFrames(chunks: Buffer[], playerIndex: number): number {
  let count = 0;
  for (const chunk of chunks) {
    const markers = findMarkers(chunk);
    for (const pos of markers) {
      if (pos + 13 >= chunk.length) continue;
      const byte5 = chunk[pos + 5];
      const byte6 = chunk[pos + 6];
      if (byte5 !== 0x40) continue;
      if (getPlayerIndex(byte6) !== playerIndex) continue;
      if (getBaseType(byte6) !== 0x09) continue;
      if (chunk[pos + 7] !== 0x00) continue;
      if ((chunk[pos + 10] >> 4) !== 4) continue;
      count++;
    }
  }
  return count;
}

/**
 * Extract raw position data from film chunks for a specific player.
 * Auto-detects best frame type and encoding variant.
 *
 * Uses flexible matching for base-0x09 frames: matches by base type and
 * data byte 0 pattern rather than exact 4-byte frame type. This correctly
 * handles multi-player films where frame subtypes vary (e.g., 4009004d
 * instead of 40090005).
 *
 * Priority:
 * 1. base-0x09 position frames (standard 12-bit c2) - most maps
 * 2. base-0x09 b3-variant (9-bit c1, 8-bit c2) - Argyle
 * 3. 40088064 exact match (16-bit coords) - Bazaar fallback
 *
 * @param playerIndex - Player index (0 for single-player, 0-7 for multi-player)
 * Returns cumulative delta values (not scaled to world units)
 */
export function extractRawPositions(
  chunks: Buffer[],
  playerIndex = 0,
  onStatus?: (msg: string) => void
): MotionPoint[] {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));
  const type88064 = buildFrameTypeHex('40088064', playerIndex);

  const pos40088064 = extract40088064(chunks, type88064);
  const base09Count = countBase09PositionFrames(chunks, playerIndex);
  const detection = detectBase09Variant(chunks, playerIndex);

  const prefix = playerIndex > 0 ? `[P${playerIndex + 1}] ` : '';

  log(`${prefix}Frame type detection: 40088064=${pos40088064.length}, base-0x09=${base09Count} (${detection.variant})`);

  // Priority 1: standard base-0x09 position (12-bit c2)
  if (detection.variant === '9bit' || detection.variant === 'standard') {
    const pos = extractBase09Position(chunks, playerIndex);
    log(`${prefix}Using: base-0x09 position ${detection.variant} (${pos.length} frames)`);
    return pos;
  }

  // Priority 2: b3 variant (Argyle-type maps)
  if (detection.variant === 'b3variant' && base09Count >= pos40088064.length) {
    const pos = extractBase09_b3variant(chunks, playerIndex);
    log(`${prefix}Using: base-0x09 b3-variant (${pos.length} frames)`);
    return pos;
  }

  // Priority 3: fallback to 40088064
  if (pos40088064.length >= 20) {
    log(`${prefix}Using: 40088064 (${pos40088064.length} frames)`);
    return pos40088064;
  }

  // Last resort: whichever has more frames
  if (base09Count > pos40088064.length) {
    const pos = extractBase09Position(chunks, playerIndex);
    log(`${prefix}Using: base-0x09 position (fallback, ${pos.length} frames)`);
    return pos;
  }

  log(`${prefix}Using: 40088064 (fallback, ${pos40088064.length} frames)`);
  return pos40088064;
}

/**
 * Extract positions for all entity streams detected in the film.
 * Returns an array of PlayerPath objects, one per (playerIndex, isBot) stream.
 */
export function extractAllPlayerPositions(
  chunks: Buffer[],
  onStatus?: (msg: string) => void
): PlayerPath[] {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));

  // Detect PvE embedded-human mode (bot present → human coords are nibble-
  // shifted sub-records inside bot frames, NOT top-level frames)
  const isPvEEmbedded = detectPvEEmbeddedMode(chunks);

  if (isPvEEmbedded) {
    log('Detected PvE embedded-human encoding (bot present)');
    const paths: PlayerPath[] = [];

    // Human: 4-bit-shifted sub-records inside bot frames + rare pi=1 normal frames
    const humanPositions = extractPvEHumanEmbedded(chunks);
    log(`[P1] Using: PvE embedded sub-record (${humanPositions.length} frames)`);
    if (humanPositions.length >= MIN_PLAYER_FRAMES) {
      paths.push({ playerIndex: 0, isBot: false, positions: humanPositions });
    }

    // Bot: existing shifted extractor (pos+11..14) — this was correct all along
    const botPositions = extractBase09BotShifted(chunks, 0);
    log(`[Bot] Using: base-0x09 bot-shifted (${botPositions.length} frames)`);
    if (botPositions.length >= MIN_PLAYER_FRAMES) {
      paths.push({ playerIndex: 0, isBot: true, positions: botPositions });
    }

    return paths;
  }

  // Non-PvE: existing entity detection (Solo, PvP)
  const entities = detectEntities(chunks);
  const entityLabels = entities.map(e => e.isBot ? `${e.playerIndex}(bot)` : `${e.playerIndex}`);
  log(`Detected ${entities.length} entity stream(s) in film: [${entityLabels.join(', ')}]`);

  const paths: PlayerPath[] = [];
  for (const { playerIndex, isBot } of entities) {
    let positions: MotionPoint[];
    if (isBot) {
      positions = extractBase09BotShifted(chunks, playerIndex);
      const prefix = playerIndex > 0 ? `[Bot${playerIndex + 1}] ` : '[Bot] ';
      log(`${prefix}Using: base-0x09 bot-shifted (${positions.length} frames)`);
    } else {
      positions = extractRawPositions(chunks, playerIndex, onStatus);
    }
    if (positions.length >= MIN_PLAYER_FRAMES) {
      paths.push({ playerIndex, isBot, positions });
    }
  }

  return paths;
}

/**
 * Load all decompressed film chunks from a directory
 */
export async function loadFilmChunks(
  filmDir: string,
  onStatus?: (msg: string) => void
): Promise<Buffer[]> {
  const log = onStatus ?? ((msg: string) => console.log(dim(msg)));
  const chunks: Buffer[] = [];

  for (let i = 0; i < 20; i++) {
    const filePath = join(filmDir, `filmChunk${i}_dec`);
    if (existsSync(filePath)) {
      const chunk = await readFile(filePath);
      chunks.push(chunk);
    } else {
      break;
    }
  }

  log(`Loaded ${chunks.length} film chunks`);
  return chunks;
}

/**
 * Compute motion statistics
 * @param filmLengthMs - Film length in milliseconds from metadata (optional, for Hz calculation)
 */
export function computeMotionStats(
  positions: MotionPoint[],
  filmLengthMs?: number
): {
  totalFrames: number;
  durationSeconds: number;
  calculatedHz: number | null;
  maxDeltaCoord1: number;
  maxDeltaCoord2: number;
  rangeCoord1: number;
  rangeCoord2: number;
} {
  if (positions.length === 0) {
    return {
      totalFrames: 0,
      durationSeconds: 0,
      calculatedHz: null,
      maxDeltaCoord1: 0,
      maxDeltaCoord2: 0,
      rangeCoord1: 0,
      rangeCoord2: 0,
    };
  }

  let minC1 = Infinity, maxC1 = -Infinity;
  let minC2 = Infinity, maxC2 = -Infinity;

  for (const p of positions) {
    minC1 = Math.min(minC1, p.cumCoord1);
    maxC1 = Math.max(maxC1, p.cumCoord1);
    minC2 = Math.min(minC2, p.cumCoord2);
    maxC2 = Math.max(maxC2, p.cumCoord2);
  }

  const last = positions[positions.length - 1];

  // Calculate actual Hz if film length is provided
  let calculatedHz: number | null = null;
  let durationSeconds: number;

  if (filmLengthMs && filmLengthMs > 0) {
    const filmLengthSeconds = filmLengthMs / 1000;
    calculatedHz = positions.length / filmLengthSeconds;
    durationSeconds = filmLengthSeconds;
  } else {
    // Fallback: assume 60Hz
    durationSeconds = positions.length / 60;
  }

  return {
    totalFrames: positions.length,
    durationSeconds,
    calculatedHz,
    maxDeltaCoord1: Math.abs(last.cumCoord1),
    maxDeltaCoord2: Math.abs(last.cumCoord2),
    rangeCoord1: maxC1 - minC1,
    rangeCoord2: maxC2 - minC2,
  };
}

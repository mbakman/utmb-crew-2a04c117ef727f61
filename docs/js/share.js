/* share.js — frictionless peer-to-peer sharing of the crew checklist.
 *
 * The problem this solves: four people, four phones, one checklist, and no
 * signal at 3am on a col above Courmayeur. There is no backend and there will
 * never be one, so the checklist has to travel *inside the link itself*.
 *
 * How it travels
 * --------------
 *   content  ->  JSON.stringify
 *            ->  UTF-8 bytes
 *            ->  LZSS (LZ77 + 8-token flag bytes; see section 3)
 *            ->  9-byte frame header (format / raw length / FNV-1a checksum)
 *            ->  base64url
 *            ->  https://<host>/<path>#s=<payload>
 *
 * The payload lives in the URL *fragment*. Fragments are never sent to the
 * server, so this stays private even on a public GitHub Pages host, and it
 * survives AirDrop, iMessage, WhatsApp and a screenshot of a QR code — all of
 * which work peer-to-peer with zero bars of signal.
 *
 * Every link is verified before it is handed out: decode(encode(x)) must equal
 * the exact JSON string that went in, or we fall back to an uncompressed frame,
 * and if *that* fails we refuse to emit a link rather than ship a broken one.
 *
 * Receiving is never silent. A link produces a diff against what this phone
 * already has ("3 added, 1 changed at Courmayeur") and a review sheet with
 * Accept / Keep mine. Accepting replaces *content* only — tick state is stored
 * separately by checklist.js and is left untouched, so anything already ticked
 * off stays ticked as long as its id survives.
 *
 * Receiving is also never EARLY. main.js calls UTMB.share.receivePending() as
 * the last step of bootstrap, and receivePending() itself waits for
 * UTMB.checklist.isReady() before decoding anything: a diff taken before this
 * phone has loaded its own checklist reports every item in the link as new.
 *
 * Fallback for anything that mangles long URLs: export/import a .json file via
 * navigator.share() or a download, plus a paste-a-link box.
 *
 * No network calls. No remote fonts. Nothing here needs a server.
 *
 * Public surface: window.UTMB.share (see the bottom of this file).
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
   * 0. Constants and tiny helpers
   * ═══════════════════════════════════════════════════════════════════════ */

  var PAYLOAD_VERSION = 1;
  var PAYLOAD_MAGIC = 'utmb-crew-checklist';
  var HASH_PREFIX = '#s=';

  /* Above this many characters some messaging apps start truncating or
   * line-wrapping a URL. We still emit it, but we say so. */
  var LONG_LINK_CHARS = 4000;

  /* Refuse to inflate anything sillier than this from an untrusted payload. */
  var MAX_INFLATE_BYTES = 8 * 1024 * 1024;

  var PHASE_FALLBACK = ['before', 'onArrival', 'beforeLeaving'];
  var PHASE_LABEL_FALLBACK = {
    before: 'Before he arrives',
    onArrival: 'On arrival',
    beforeLeaving: 'Before he leaves'
  };

  /* A typed error so every failure path can be reported to a human instead of
   * white-screening the app. */
  function ShareError(message) {
    this.name = 'ShareError';
    this.message = message;
    this.stack = (new Error(message)).stack;
  }
  ShareError.prototype = Object.create(Error.prototype);
  ShareError.prototype.constructor = ShareError;

  function fail(msg) { throw new ShareError(msg); }

  function toast(msg) {
    if (typeof UTMB.toast === 'function') UTMB.toast(msg);
    else console.log('[UTMB share] ' + msg);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      if (c === '&') return '&amp;';
      if (c === '<') return '&lt;';
      if (c === '>') return '&gt;';
      if (c === '"') return '&quot;';
      return '&#39;';
    });
  }

  function clip(s, n) {
    s = String(s === null || s === undefined ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  function nf(n) {
    try { return Number(n).toLocaleString(); } catch (e) { return String(n); }
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 1. UTF-8 codec
   *
   * Hand-rolled rather than TextEncoder so the exact same code path runs in a
   * browser and under `node --check` / the round-trip test, and so a lone
   * surrogate degrades to U+FFFD instead of throwing.
   * ═══════════════════════════════════════════════════════════════════════ */

  function utf8Encode(str) {
    str = String(str);
    var len = str.length;
    var buf = new Uint8Array(len * 3 + 8); /* 3 bytes/UTF-16 unit is the ceiling */
    var p = 0;
    var i = 0;
    while (i < len) {
      var c = str.charCodeAt(i++);
      if (c >= 0xD800 && c <= 0xDBFF) {
        var c2 = i < len ? str.charCodeAt(i) : 0;
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          i++;
        } else {
          c = 0xFFFD; /* unpaired high surrogate */
        }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        c = 0xFFFD; /* stray low surrogate */
      }
      if (c < 0x80) {
        buf[p++] = c;
      } else if (c < 0x800) {
        buf[p++] = 0xC0 | (c >> 6);
        buf[p++] = 0x80 | (c & 63);
      } else if (c < 0x10000) {
        buf[p++] = 0xE0 | (c >> 12);
        buf[p++] = 0x80 | ((c >> 6) & 63);
        buf[p++] = 0x80 | (c & 63);
      } else {
        buf[p++] = 0xF0 | (c >> 18);
        buf[p++] = 0x80 | ((c >> 12) & 63);
        buf[p++] = 0x80 | ((c >> 6) & 63);
        buf[p++] = 0x80 | (c & 63);
      }
    }
    return buf.subarray(0, p);
  }

  function utf8Decode(bytes) {
    var n = bytes.length;
    var out = '';
    var chunk = [];
    var i = 0;
    while (i < n) {
      var b0 = bytes[i++];
      var cp;
      if (b0 < 0x80) {
        cp = b0;
      } else if ((b0 & 0xE0) === 0xC0) {
        if (i >= n) { cp = 0xFFFD; }
        else { cp = ((b0 & 0x1F) << 6) | (bytes[i++] & 63); }
      } else if ((b0 & 0xF0) === 0xE0) {
        if (i + 1 >= n) { cp = 0xFFFD; i = n; }
        else {
          var b1 = bytes[i++], b2 = bytes[i++];
          cp = ((b0 & 0x0F) << 12) | ((b1 & 63) << 6) | (b2 & 63);
        }
      } else if ((b0 & 0xF8) === 0xF0) {
        if (i + 2 >= n) { cp = 0xFFFD; i = n; }
        else {
          var c1 = bytes[i++], c2 = bytes[i++], c3 = bytes[i++];
          cp = ((b0 & 0x07) << 18) | ((c1 & 63) << 12) | ((c2 & 63) << 6) | (c3 & 63);
        }
      } else {
        cp = 0xFFFD; /* continuation byte or 5/6-byte sequence: not valid UTF-8 */
      }
      if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
      if (cp < 0x10000) {
        chunk.push(cp);
      } else {
        cp -= 0x10000;
        chunk.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
      }
      if (chunk.length >= 4096) {
        out += String.fromCharCode.apply(String, chunk);
        chunk.length = 0;
      }
    }
    if (chunk.length) out += String.fromCharCode.apply(String, chunk);
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. base64url codec
   *
   * URL-fragment safe (-_ instead of +/, no padding). The decoder deliberately
   * also accepts +, / and = so a link that has been through a system which
   * "helpfully" re-encoded it still opens.
   * ═══════════════════════════════════════════════════════════════════════ */

  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64_LOOKUP = null;

  function b64Lookup() {
    if (B64_LOOKUP) return B64_LOOKUP;
    var t = new Int16Array(128);
    var i;
    for (i = 0; i < 128; i++) t[i] = -1;
    for (i = 0; i < 64; i++) t[B64_CHARS.charCodeAt(i)] = i;
    t[43] = 62; /* '+' */
    t[47] = 63; /* '/' */
    B64_LOOKUP = t;
    return t;
  }

  function b64urlEncode(bytes) {
    var parts = [];
    var n = bytes.length;
    var i = 0;
    while (i + 2 < n) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      parts.push(
        B64_CHARS.charAt((v >> 18) & 63),
        B64_CHARS.charAt((v >> 12) & 63),
        B64_CHARS.charAt((v >> 6) & 63),
        B64_CHARS.charAt(v & 63)
      );
      i += 3;
    }
    var rem = n - i;
    if (rem === 1) {
      var v1 = bytes[i] << 16;
      parts.push(B64_CHARS.charAt((v1 >> 18) & 63), B64_CHARS.charAt((v1 >> 12) & 63));
    } else if (rem === 2) {
      var v2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      parts.push(
        B64_CHARS.charAt((v2 >> 18) & 63),
        B64_CHARS.charAt((v2 >> 12) & 63),
        B64_CHARS.charAt((v2 >> 6) & 63)
      );
    }
    return parts.join('');
  }

  function b64urlDecode(str) {
    var t = b64Lookup();
    str = String(str);
    var vals = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code === 61) continue;                                   /* '=' padding */
      if (code === 32 || code === 9 || code === 10 || code === 13) continue; /* whitespace */
      if (code > 127 || t[code] < 0) {
        fail('the shared link contains a character that is not part of the payload ("' +
          str.charAt(i) + '"). It was probably cut short or auto-corrected on the way over.');
      }
      vals.push(t[code]);
    }
    var n = vals.length;
    /* n === 0 is a legal (empty) decode; decodeString's frame check rejects it
     * with a better message than this layer could give. */
    if (n % 4 === 1) fail('the shared link is truncated (incomplete base64 payload).');
    var out = new Uint8Array((n * 6) >> 3);
    var acc = 0, bits = 0, p = 0;
    for (i = 0; i < n; i++) {
      acc = (acc << 6) | vals[i];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[p++] = (acc >> bits) & 0xFF;
      }
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. LZSS (LZ77 with 8-token flag bytes)
   *
   * Stream layout, after the frame header:
   *
   *   [flag byte][ up to 8 tokens ][flag byte][ up to 8 tokens ] ...
   *
   *   flag bit i (LSB first)  0 -> literal token:  1 byte, emitted verbatim
   *                           1 -> match token:    3 bytes
   *                                  offset low, offset high (1..65535)
   *                                  length - 4                (4..259)
   *
   * A match token costs 3 bytes and always covers at least 4, so the encoder
   * can never expand beyond one literal per input byte plus one flag byte per
   * eight — which is the size of the output buffer allocated below.
   *
   * Match finding is a deflate-style hash chain over 4-byte prefixes: head[]
   * holds the most recent position for each hash, prev[] chains backwards.
   * Greedy (no lazy matching) — simple, fast, and plenty for a few kilobytes
   * of very repetitive JSON.
   * ═══════════════════════════════════════════════════════════════════════ */

  var LZ_MIN_MATCH = 4;
  var LZ_MAX_MATCH = 259;   /* MIN + 255, the largest a single length byte holds */
  var LZ_MAX_OFFSET = 65535;
  var LZ_HASH_SIZE = 1 << 16;
  var LZ_MAX_CHAIN = 128;

  function lzHash(a, b, c, d) {
    /* Values stay well under 2^53 so the multiplications are exact. */
    var h = a;
    h = (h * 33 + b) >>> 0;
    h = (h * 33 + c) >>> 0;
    h = (h * 33 + d) >>> 0;
    return h & (LZ_HASH_SIZE - 1);
  }

  function lzssCompress(src) {
    var n = src.length;
    if (n === 0) return new Uint8Array(0);

    var out = new Uint8Array(n + (n >> 3) + 16);
    var op = 0;
    var head = new Int32Array(LZ_HASH_SIZE);
    var prev = new Int32Array(n);
    var i;
    for (i = 0; i < LZ_HASH_SIZE; i++) head[i] = -1;
    for (i = 0; i < n; i++) prev[i] = -1;

    var flagPos = -1;
    var flagMask = 0;
    var flags = 0;
    var pos = 0;

    while (pos < n) {
      if (flagMask === 0) {
        if (flagPos >= 0) out[flagPos] = flags;
        flagPos = op++;
        flags = 0;
        flagMask = 1;
      }

      var bestLen = 0;
      var bestOff = 0;

      if (pos + LZ_MIN_MATCH <= n) {
        var h = lzHash(src[pos], src[pos + 1], src[pos + 2], src[pos + 3]);
        var limit = pos - LZ_MAX_OFFSET;
        if (limit < 0) limit = 0;
        var maxLen = n - pos;
        if (maxLen > LZ_MAX_MATCH) maxLen = LZ_MAX_MATCH;

        var cand = head[h];
        var chain = 0;
        while (cand >= limit && chain < LZ_MAX_CHAIN) {
          chain++;
          /* Cheap reject: the byte that would extend the current best must match. */
          if (src[cand + bestLen] === src[pos + bestLen]) {
            var len = 0;
            while (len < maxLen && src[cand + len] === src[pos + len]) len++;
            if (len > bestLen) {
              bestLen = len;
              bestOff = pos - cand;
              if (bestLen >= maxLen) break;
            }
          }
          cand = prev[cand];
        }

        /* Insert the current position into its chain (after searching, so a
         * match can never have offset 0). */
        prev[pos] = head[h];
        head[h] = pos;
      }

      if (bestLen >= LZ_MIN_MATCH) {
        flags |= flagMask;
        out[op++] = bestOff & 0xFF;
        out[op++] = (bestOff >> 8) & 0xFF;
        out[op++] = bestLen - LZ_MIN_MATCH;
        /* Index every position the match swallowed, or the next match has
         * nothing to chain to and the ratio collapses. */
        var end = pos + bestLen;
        for (var j = pos + 1; j < end; j++) {
          if (j + LZ_MIN_MATCH <= n) {
            var hj = lzHash(src[j], src[j + 1], src[j + 2], src[j + 3]);
            prev[j] = head[hj];
            head[hj] = j;
          }
        }
        pos = end;
      } else {
        out[op++] = src[pos];
        pos++;
      }

      flagMask = (flagMask << 1) & 0xFF;
    }

    if (flagPos >= 0) out[flagPos] = flags;
    return out.subarray(0, op);
  }

  function lzssDecompress(src, expectedLen) {
    if (expectedLen === 0) return new Uint8Array(0);
    var out = new Uint8Array(expectedLen);
    var n = src.length;
    var ip = 0, op = 0;
    var flags = 0, flagMask = 0;

    while (op < expectedLen) {
      if (flagMask === 0) {
        if (ip >= n) fail('the shared checklist is truncated (compressed stream ended early).');
        flags = src[ip++];
        flagMask = 1;
      }
      if (flags & flagMask) {
        if (ip + 3 > n) fail('the shared checklist is truncated (incomplete back-reference).');
        var off = src[ip] | (src[ip + 1] << 8);
        ip += 2;
        var len = src[ip++] + LZ_MIN_MATCH;
        if (off === 0 || off > op) fail('the shared checklist is damaged (back-reference points outside the data).');
        if (op + len > expectedLen) fail('the shared checklist is damaged (back-reference overruns the payload).');
        var from = op - off;
        /* Forward byte-by-byte on purpose: overlapping matches are legal LZ77
         * and are how runs get encoded. */
        for (var k = 0; k < len; k++) out[op++] = out[from + k];
      } else {
        if (ip >= n) fail('the shared checklist is truncated (literal missing).');
        out[op++] = src[ip++];
      }
      flagMask = (flagMask << 1) & 0xFF;
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 4. Framing + the payload codec
   *
   *   byte 0      format: 0 = stored (raw bytes), 1 = LZSS
   *   bytes 1-4   uncompressed byte length, big-endian uint32
   *   bytes 5-8   FNV-1a 32 checksum of the uncompressed bytes, big-endian
   *   bytes 9..   the body
   *
   * The length lets the decompressor know exactly when to stop (so the unused
   * bits in the final flag byte are unambiguous) and the checksum turns a
   * silently-corrupted link into a clear message rather than mystery JSON.
   * ═══════════════════════════════════════════════════════════════════════ */

  var FRAME_HEADER = 9;
  var FORMAT_STORED = 0;
  var FORMAT_LZSS = 1;

  function fnv1a(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      /* h *= 16777619, done with shifts so it stays exact in 32 bits */
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function frame(format, rawLen, checksum, body) {
    var out = new Uint8Array(FRAME_HEADER + body.length);
    out[0] = format;
    out[1] = (rawLen >>> 24) & 0xFF;
    out[2] = (rawLen >>> 16) & 0xFF;
    out[3] = (rawLen >>> 8) & 0xFF;
    out[4] = rawLen & 0xFF;
    out[5] = (checksum >>> 24) & 0xFF;
    out[6] = (checksum >>> 16) & 0xFF;
    out[7] = (checksum >>> 8) & 0xFF;
    out[8] = checksum & 0xFF;
    out.set(body, FRAME_HEADER);
    return out;
  }

  /* Encode a JSON string to a base64url payload. `forceStored` skips
   * compression (used as the automatic fallback when a compressed frame fails
   * its own round-trip check, which should never happen but is cheap to cover). */
  function encodeString(json, forceStored) {
    var bytes = utf8Encode(json);
    var sum = fnv1a(bytes);
    var body = bytes;
    var format = FORMAT_STORED;

    if (!forceStored) {
      var packed = null;
      try {
        packed = lzssCompress(bytes);
      } catch (err) {
        console.warn('[UTMB share] compression failed, storing uncompressed', err);
        packed = null;
      }
      /* Only use it if it actually helps. */
      if (packed && packed.length < bytes.length) {
        body = packed;
        format = FORMAT_LZSS;
      }
    }

    return {
      text: b64urlEncode(frame(format, bytes.length, sum, body)),
      rawBytes: bytes.length,
      bodyBytes: body.length,
      framedBytes: FRAME_HEADER + body.length,
      compressed: format === FORMAT_LZSS
    };
  }

  /* Decode a base64url payload back to the exact JSON string. */
  function decodeString(text) {
    if (typeof text !== 'string' || !text.length) fail('there is no payload in that link.');

    /* Some apps percent-encode the fragment on the way through. base64url has
     * no characters that decodeURIComponent would alter, so this is a no-op on
     * a healthy link and a rescue on a mangled one. */
    var raw = text;
    if (raw.indexOf('%') >= 0) {
      try { raw = decodeURIComponent(raw); } catch (e) { /* keep the original */ }
    }

    var buf = b64urlDecode(raw);
    if (buf.length < FRAME_HEADER) fail('the shared link is too short to be a checklist (it was probably cut off).');

    var format = buf[0];
    if (format !== FORMAT_STORED && format !== FORMAT_LZSS) {
      fail('this link was made by a different version of the app (unknown payload format ' + format + ').');
    }

    var rawLen = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
    var sum = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0;
    if (rawLen > MAX_INFLATE_BYTES) {
      fail('the shared checklist claims to be ' + nf(rawLen) + ' bytes, which is not plausible. The link is damaged.');
    }

    var body = buf.subarray(FRAME_HEADER);
    var bytes;
    if (format === FORMAT_LZSS) {
      bytes = lzssDecompress(body, rawLen);
    } else {
      if (body.length < rawLen) fail('the shared checklist is truncated (' + nf(body.length) + ' of ' + nf(rawLen) + ' bytes arrived).');
      bytes = body.subarray(0, rawLen);
    }

    if (fnv1a(bytes) !== sum) {
      fail('the shared checklist did not survive the trip — its checksum does not match. Ask for the link again, or use the .json file instead.');
    }

    return utf8Decode(bytes);
  }

  /* encodePayload / decodePayload work on objects and are what everything else
   * calls. encodePayload NEVER returns a payload it has not decoded back to a
   * byte-identical JSON string first. */
  function encodePayload(obj) {
    var json;
    try {
      json = JSON.stringify(obj);
    } catch (err) {
      fail('this checklist cannot be turned into a link (' + (err && err.message ? err.message : err) + ').');
    }
    if (typeof json !== 'string') fail('this checklist cannot be turned into a link (nothing to serialise).');

    var attempt = encodeString(json, false);
    if (safeDecodeMatches(attempt.text, json)) return attempt;

    console.warn('[UTMB share] compressed payload failed its round-trip check; falling back to uncompressed');
    var stored = encodeString(json, true);
    if (safeDecodeMatches(stored.text, json)) return stored;

    fail('could not produce a link that decodes back to the same checklist. Use "Send checklist file" instead.');
  }

  function safeDecodeMatches(text, json) {
    try {
      return decodeString(text) === json;
    } catch (err) {
      console.warn('[UTMB share] round-trip verification threw', err);
      return false;
    }
  }

  function decodePayload(text) {
    var json = decodeString(text);
    var obj;
    try {
      obj = JSON.parse(json);
    } catch (err) {
      fail('the shared checklist arrived garbled and could not be read. Ask for it again, or use the .json file.');
    }
    return obj;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 5. The content model
   *
   * Canonical shape used everywhere inside this file:
   *
   *   {
   *     cps: { "U7": { name: "Courmayeur",
   *                    phases: { before:[item], onArrival:[item], ... } } },
   *     notes:        { "U7": "free-text crew note" },
   *     sectionNotes: { "U11_U12": "free-text section note" },
   *     scope: 'all' | 'cp'
   *   }
   *   item = { id, text, critical, draft }
   *
   * Reading and writing both go through checklist.js when it exposes an API,
   * and fall back to its localStorage slot ("utmb_checklist") otherwise. The
   * fallback writes back into whatever shape it found, so there is exactly one
   * source of truth on the device — share.js never keeps its own copy.
   * ═══════════════════════════════════════════════════════════════════════ */

  function ctxOf() {
    try {
      return (typeof UTMB.context === 'function') ? (UTMB.context() || null) : null;
    } catch (e) {
      return null;
    }
  }

  function baseChecklists() {
    var ctx = ctxOf();
    return (ctx && isPlainObject(ctx.checklists)) ? ctx.checklists : null;
  }

  function courseCps() {
    var ctx = ctxOf();
    return (ctx && ctx.course && Array.isArray(ctx.course.cps)) ? ctx.course.cps : [];
  }

  function phaseOrder() {
    var base = baseChecklists();
    var order = (base && Array.isArray(base.phaseOrder) && base.phaseOrder.length) ? base.phaseOrder.slice() : PHASE_FALLBACK.slice();
    return order;
  }

  function phaseLabel(name) {
    var base = baseChecklists();
    if (base && isPlainObject(base.phaseLabels) && isPlainObject(base.phaseLabels[name])) {
      var l = base.phaseLabels[name];
      if (l.en) return l.en;
      if (l.tr) return l.tr;
    }
    if (PHASE_LABEL_FALLBACK[name]) return PHASE_LABEL_FALLBACK[name];
    var pretty = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  }

  function orderedPhases(cp) {
    var known = phaseOrder();
    var seen = Object.create(null);
    var out = [];
    known.forEach(function (p) {
      if (cp.phases[p]) { out.push(p); seen[p] = true; }
    });
    Object.keys(cp.phases).sort().forEach(function (p) {
      if (!seen[p]) out.push(p);
    });
    return out;
  }

  /* Checkpoints in course order where we know it, otherwise natural id order. */
  function orderedCpIds(cps) {
    var rank = Object.create(null);
    courseCps().forEach(function (c, i) { rank[c.id] = i; });
    return Object.keys(cps).sort(function (a, b) {
      var ra = (a in rank) ? rank[a] : 9000 + a.localeCompare(b);
      var rb = (b in rank) ? rank[b] : 9000;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  }

  function cpDisplayName(id, content) {
    if (content && content.cps[id] && content.cps[id].name) return content.cps[id].name;
    var list = courseCps();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].name || id;
    var base = baseChecklists();
    if (base && isPlainObject(base.checkpoints) && base.checkpoints[id] && base.checkpoints[id].name) {
      return base.checkpoints[id].name;
    }
    return id;
  }

  /* ── shape sniffing ──────────────────────────────────────────────────── */

  function looksLikeCpEntry(e) {
    if (!isPlainObject(e)) return false;
    if (isPlainObject(e.phases)) return true;
    for (var i = 0; i < PHASE_FALLBACK.length; i++) {
      if (Array.isArray(e[PHASE_FALLBACK[i]])) return true;
    }
    return false;
  }

  function looksLikeCpMap(v) {
    if (!isPlainObject(v)) return false;
    var ks = Object.keys(v);
    for (var i = 0; i < ks.length; i++) {
      if (looksLikeCpEntry(v[ks[i]])) return true;
    }
    return false;
  }

  /* Returns the property name holding the checkpoint map, '' if the object is
   * itself the map, or null if there is no checkpoint data in it at all. */
  function locateCpMapKey(obj) {
    if (!isPlainObject(obj)) return null;
    var candidates = ['checkpoints', 'cps', 'content', 'checklists', 'items'];
    for (var i = 0; i < candidates.length; i++) {
      if (looksLikeCpMap(obj[candidates[i]])) return candidates[i];
    }
    if (looksLikeCpMap(obj)) return '';
    return null;
  }

  /* ── normalising ─────────────────────────────────────────────────────── */

  function normalizeItem(raw, cpId, phase, index, usedIds) {
    var item = { id: '', text: '', critical: false, draft: false };

    if (typeof raw === 'string') {
      item.text = raw;
    } else if (Array.isArray(raw)) {
      item.id = raw[0] ? String(raw[0]) : '';
      item.text = raw[1] === null || raw[1] === undefined ? '' : String(raw[1]);
      var flags = Number(raw[2]) || 0;
      item.critical = !!(flags & 1);
      item.draft = !!(flags & 2);
    } else if (isPlainObject(raw)) {
      item.id = raw.id ? String(raw.id) : '';
      var text = raw.text;
      if (text === null || text === undefined) text = raw.label;
      if (text === null || text === undefined) text = raw.title;
      item.text = text === null || text === undefined ? '' : String(text);
      item.critical = !!raw.critical;
      item.draft = !!raw.draft;
    } else {
      return null;
    }

    if (!item.id) item.id = cpId + '-' + phase + '-' + (index + 1);
    if (usedIds[item.id]) {
      /* Duplicate ids would make the diff lie. Disambiguate deterministically. */
      var n = 2;
      while (usedIds[item.id + '~' + n]) n++;
      item.id = item.id + '~' + n;
    }
    usedIds[item.id] = true;

    if (!item.text && !item.id) return null;
    return item;
  }

  function normalizeCp(cpId, raw) {
    var out = { name: '', phases: {} };
    if (!isPlainObject(raw)) return out;
    out.name = raw.name ? String(raw.name) : (raw.title ? String(raw.title) : '');

    var src = isPlainObject(raw.phases) ? raw.phases : raw;
    var usedIds = Object.create(null);
    var keys = Object.keys(src);
    /* Walk known phases first so generated ids are stable regardless of key
     * insertion order in the source object. */
    var order = phaseOrder().filter(function (p) { return keys.indexOf(p) >= 0; });
    keys.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });

    order.forEach(function (phase) {
      var arr = src[phase];
      if (!Array.isArray(arr)) return;
      var items = [];
      for (var i = 0; i < arr.length; i++) {
        var it = normalizeItem(arr[i], cpId, phase, i, usedIds);
        if (it) items.push(it);
      }
      out.phases[phase] = items;
    });

    return out;
  }

  function normalizeContent(raw) {
    var out = { cps: {}, notes: {}, sectionNotes: {}, scope: 'all' };
    if (!isPlainObject(raw)) return out;

    var key = locateCpMapKey(raw);
    var map = key === null ? null : (key === '' ? raw : raw[key]);
    if (isPlainObject(map)) {
      Object.keys(map).forEach(function (id) {
        if (!looksLikeCpEntry(map[id])) return;
        out.cps[id] = normalizeCp(id, map[id]);
      });
    }

    if (isPlainObject(raw.notes)) {
      Object.keys(raw.notes).forEach(function (k) {
        var v = raw.notes[k];
        if (typeof v === 'string' && v.length) out.notes[k] = v;
      });
    }
    var sn = isPlainObject(raw.sectionNotes) ? raw.sectionNotes : null;
    if (sn) {
      Object.keys(sn).forEach(function (k) {
        var v = sn[k];
        if (typeof v === 'string' && v.length) out.sectionNotes[k] = v;
      });
    }
    if (raw.scope === 'cp' || raw.scope === 'all') out.scope = raw.scope;
    return out;
  }

  /* ── reading what this device currently has ──────────────────────────── */

  var READ_ALIASES = ['exportContent', 'getContent', 'contentSnapshot', 'toJSON', 'snapshot'];

  function readContent() {
    var api = UTMB.checklist;
    if (isPlainObject(api)) {
      for (var i = 0; i < READ_ALIASES.length; i++) {
        var fn = READ_ALIASES[i];
        if (typeof api[fn] === 'function') {
          try {
            var got = api[fn]();
            if (isPlainObject(got) && locateCpMapKey(got) !== null) {
              var c = normalizeContent(got);
              attachNotes(c);
              return c;
            }
          } catch (err) {
            console.warn('[UTMB share] UTMB.checklist.' + fn + '() threw; falling back to storage', err);
          }
        }
      }
    }

    /* Fallback: the seed file overlaid by checklist.js's own storage slot,
     * mirroring how store.js layers SEED under localStorage. */
    var base = baseChecklists();
    var baseCps = (base && isPlainObject(base.checkpoints)) ? base.checkpoints : {};

    var slot = null;
    try {
      slot = UTMB.store ? UTMB.store.get('checklist', null) : null;
    } catch (err) {
      console.warn('[UTMB share] could not read the checklist slot', err);
    }
    var slotKey = locateCpMapKey(slot);
    var slotCps = slotKey === null ? null : (slotKey === '' ? slot : slot[slotKey]);

    var merged = {};
    Object.keys(baseCps).forEach(function (id) { merged[id] = baseCps[id]; });
    if (isPlainObject(slotCps)) {
      Object.keys(slotCps).forEach(function (id) {
        if (looksLikeCpEntry(slotCps[id])) merged[id] = slotCps[id];
      });
    }

    var content = normalizeContent({ checkpoints: merged });
    attachNotes(content);
    return content;
  }

  /* Crew notes and section notes live in store.js, not in the checklist slot. */
  function attachNotes(content) {
    var base = baseChecklists();
    var storeNotes = (UTMB.store && isPlainObject(UTMB.store.notes)) ? UTMB.store.notes : {};
    var storeSecs = (UTMB.store && isPlainObject(UTMB.store.sectionNotes)) ? UTMB.store.sectionNotes : {};

    Object.keys(storeNotes).forEach(function (k) {
      if (typeof storeNotes[k] === 'string' && storeNotes[k].length) content.notes[k] = storeNotes[k];
    });
    if (base && isPlainObject(base.sectionNotes)) {
      Object.keys(base.sectionNotes).forEach(function (k) {
        if (typeof base.sectionNotes[k] === 'string') content.sectionNotes[k] = base.sectionNotes[k];
      });
    }
    Object.keys(storeSecs).forEach(function (k) {
      if (typeof storeSecs[k] === 'string' && storeSecs[k].length) content.sectionNotes[k] = storeSecs[k];
    });
    return content;
  }

  /* ── writing merged content back ─────────────────────────────────────── */

  var WRITE_ALIASES = ['importContent', 'applyContent', 'setContent', 'replaceContent', 'mergeContent'];
  var RENDER_ALIASES = ['render', 'refresh', 'rerender', 'redraw', 'update'];

  /* Every live item on this phone, by id, straight from checklist.js — the only
   * place that knows an item's tick and its lastModified stamp. The share
   * payload carries neither (a link is a CONTENT transfer; ticks are shared
   * through sync.js instead), so toFileShape() has to put them back by hand or
   * setContent() writes done=false / lastModified=0 over the lot. */
  function localItemIndex() {
    var idx = Object.create(null);
    var api = isPlainObject(UTMB.checklist) ? UTMB.checklist : null;
    if (!api || typeof api.getContent !== 'function') return idx;
    var content;
    try { content = api.getContent(); } catch (err) {
      console.warn('[UTMB share] could not read live checklist for tick preservation', err);
      return idx;
    }
    if (!isPlainObject(content) || !isPlainObject(content.checkpoints)) return idx;
    Object.keys(content.checkpoints).forEach(function (cpId) {
      var cp = content.checkpoints[cpId];
      if (!isPlainObject(cp)) return;
      Object.keys(cp).forEach(function (phase) {
        var arr = cp[phase];
        if (!Array.isArray(arr)) return;
        arr.forEach(function (it) {
          if (isPlainObject(it) && it.id) idx[it.id] = it;
        });
      });
    });
    return idx;
  }

  function stampOf(raw) {
    var n = Number(raw);
    return (n === n && isFinite(n) && n > 0) ? n : 0;
  }

  /* Canonical checklists.json-shaped object, so whatever consumes it sees the
   * same structure the app ships with. Metadata (km, cutoff, support, origin,
   * phaseLabels...) is carried over from the seed file.
   *
   * TICKS SURVIVE THIS. toFileShape() rebuilds the WHOLE merged content — all
   * four checkpoints, not just the ones a cp-scoped link covered — so anything
   * it omits is erased everywhere, and because refreshStamps() then dates the
   * erasure to now(), the wipe wins every later item-level merge and takes the
   * crew's ticks with it. Each item therefore leaves here carrying the done and
   * lastModified it already had on this phone. Only items the accepted link
   * genuinely added or altered get a fresh stamp — an accepted edit is a real
   * edit and has to out-rank what the other phones are holding. */
  function toFileShape(content) {
    var base = baseChecklists() || {};
    var baseCps = isPlainObject(base.checkpoints) ? base.checkpoints : {};
    var checkpoints = {};
    var localIdx = localItemIndex();
    var stampNow = Date.now();

    orderedCpIds(content.cps).forEach(function (id) {
      var cp = content.cps[id];
      var seed = isPlainObject(baseCps[id]) ? baseCps[id] : {};
      var entry = {};
      Object.keys(seed).forEach(function (k) {
        if (k === 'phases') return;
        if (Array.isArray(seed[k])) return;   /* seed phase arrays get replaced below */
        entry[k] = seed[k];
      });
      entry.name = cp.name || seed.name || cpDisplayName(id, content);
      orderedPhases(cp).forEach(function (phase) {
        entry[phase] = cp.phases[phase].map(function (it) {
          var out = { id: it.id, text: it.text, critical: !!it.critical, draft: !!it.draft };
          var mine = localIdx[it.id];
          if (!mine) {
            /* New to this phone. New everywhere, as far as it can tell. */
            out.done = false;
            out.lastModified = stampNow;
            return out;
          }
          out.done = !!mine.done;
          var unchanged = mine.text === out.text &&
            !!mine.critical === out.critical &&
            !!mine.draft === out.draft;
          out.lastModified = unchanged ? stampOf(mine.lastModified) : stampNow;
          return out;
        });
      });
      checkpoints[id] = entry;
    });

    var out = {
      version: base.version || '1.0.0',
      updated: new Date().toISOString().slice(0, 10),
      phaseOrder: phaseOrder(),
      phaseLabels: isPlainObject(base.phaseLabels) ? base.phaseLabels : undefined,
      crewCheckpoints: Array.isArray(base.crewCheckpoints) ? base.crewCheckpoints : Object.keys(checkpoints),
      checkpoints: checkpoints,
      sectionNotes: content.sectionNotes
    };
    if (!out.phaseLabels) delete out.phaseLabels;
    return out;
  }

  /* Remove tick entries whose item ids no longer exist. Ticks for surviving ids
   * are never touched — that is the whole point. Bounded walk, and it only ever
   * removes keys that exactly equal a removed item id, so it cannot eat
   * content. */
  function pruneTicks(node, removedSet, depth) {
    if (!isPlainObject(node) || depth > 4) return 0;
    var removed = 0;
    Object.keys(node).forEach(function (k) {
      if (removedSet[k]) {
        delete node[k];
        removed++;
        return;
      }
      removed += pruneTicks(node[k], removedSet, depth + 1);
    });
    return removed;
  }

  /* Ticks are shared crew state, and they ride on the item — toFileShape() has
   * already carried every surviving one across. The only thing left to do is
   * drop the orphans left behind by items the accepted update removed. Every
   * surviving id keeps its tick untouched. */
  function dropTicks(api, removedSet, removedCount) {
    if (!removedCount) return 0;
    var dropped = 0;

    if (api && typeof api.getTicks === 'function' && typeof api.setTicks === 'function') {
      try {
        var ticks = api.getTicks() || {};
        var keep = {};
        Object.keys(ticks).forEach(function (id) {
          if (removedSet[id]) dropped++;
          else keep[id] = ticks[id];
        });
        if (dropped) api.setTicks(keep);
        return dropped;
      } catch (err) {
        console.warn('[UTMB share] checklist tick API threw; pruning storage directly', err);
      }
    }

    /* No tick API: prune the slots directly. Only keys that exactly equal a
     * removed item id are touched, and never inside an array, so this can
     * never reach content. */
    ['checklist_ticks', 'checklist'].forEach(function (name) {
      try {
        var slot = UTMB.store ? UTMB.store.get(name, null) : null;
        if (!isPlainObject(slot)) return;
        var hit = pruneTicks(slot, removedSet, 0);
        if (hit) {
          dropped += hit;
          UTMB.store.set(name, slot);
        }
      } catch (err) {
        console.warn('[UTMB share] could not prune ticks in "' + name + '"', err);
      }
    });
    return dropped;
  }

  function writeContent(content, removedIds) {
    var shaped = toFileShape(content);
    var removed = removedIds || [];
    var removedSet = Object.create(null);
    removed.forEach(function (id) { removedSet[id] = true; });

    var api = isPlainObject(UTMB.checklist) ? UTMB.checklist : null;
    var viaApi = null;

    /* Preferred path. checklist.js owns the content; hand it the merged set and
     * let it persist, repaint and announce. Its setContent() replaces the edit
     * overlay wholesale, so `shaped` has to be complete — including the done
     * and lastModified toFileShape() just restored onto every item. */
    if (api) {
      for (var i = 0; i < WRITE_ALIASES.length && !viaApi; i++) {
        var fn = WRITE_ALIASES[i];
        if (typeof api[fn] === 'function') {
          try {
            api[fn](shaped, { preserveTicks: true, removedIds: removed, source: 'share' });
            viaApi = fn;
          } catch (err) {
            console.warn('[UTMB share] UTMB.checklist.' + fn + '() threw; falling back to storage', err);
          }
        }
      }
    }

    /* Fallback only. Writing the slot after a successful setContent() would
     * clobber what that module just persisted, in a different shape. */
    var wroteSlot = false;
    if (!viaApi) {
      try {
        var slot = null;
        try { slot = UTMB.store ? UTMB.store.get('checklist', null) : null; } catch (e) { slot = null; }
        if (!isPlainObject(slot)) slot = {};

        var key = locateCpMapKey(slot);
        if (key === '') {
          mergeCpMap(slot, shaped.checkpoints, content.scope);
        } else {
          var k = key || 'checkpoints';
          if (!isPlainObject(slot[k])) slot[k] = {};
          mergeCpMap(slot[k], shaped.checkpoints, content.scope);
          if (!slot.version) slot.version = 1;
          slot.savedAt = new Date().toISOString();
        }

        if (UTMB.store && typeof UTMB.store.set === 'function') {
          wroteSlot = UTMB.store.set('checklist', slot) !== false;
        }
      } catch (err) {
        console.warn('[UTMB share] could not write the checklist slot', err);
      }
    }

    var pruned = dropTicks(api, removedSet, removed.length);
    if (pruned) console.log('[UTMB share] dropped ' + pruned + ' orphaned tick(s)');

    /* Announce for anything that is not the checklist module. */
    try {
      if (typeof UTMB.emit === 'function') {
        UTMB.emit('checklist:content', { content: shaped, removedIds: removed, source: 'share' });
      }
    } catch (err) {
      console.warn('[UTMB share] checklist:content listener threw', err);
    }

    /* setContent() already repainted; only chase a render hook if it did not. */
    var rerendered = !!viaApi;
    if (!rerendered && api) {
      for (var r = 0; r < RENDER_ALIASES.length && !rerendered; r++) {
        var rf = RENDER_ALIASES[r];
        if (typeof api[rf] === 'function') {
          try { api[rf](); rerendered = true; } catch (err) {
            console.warn('[UTMB share] UTMB.checklist.' + rf + '() threw', err);
          }
        }
      }
    }

    return { viaApi: viaApi, wroteSlot: wroteSlot, prunedTicks: pruned, rerendered: rerendered };
  }

  function mergeCpMap(target, freshCps, scope) {
    Object.keys(freshCps).forEach(function (id) {
      var old = isPlainObject(target[id]) ? target[id] : null;
      var fresh = freshCps[id];
      if (!old) { target[id] = fresh; return; }
      /* Keep any per-checkpoint metadata the local copy has and we do not. */
      var out = {};
      Object.keys(old).forEach(function (k) { out[k] = old[k]; });
      /* Drop the old phase arrays so removed items really disappear. */
      Object.keys(out).forEach(function (k) { if (Array.isArray(out[k])) delete out[k]; });
      if (isPlainObject(out.phases)) delete out.phases;
      Object.keys(fresh).forEach(function (k) { out[k] = fresh[k]; });
      target[id] = out;
    });
    if (scope === 'all') {
      Object.keys(target).forEach(function (id) {
        if (!freshCps[id] && looksLikeCpEntry(target[id])) delete target[id];
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 6. Payload build / parse
   * ═══════════════════════════════════════════════════════════════════════ */

  function itemFlags(it) {
    return (it.critical ? 1 : 0) | (it.draft ? 2 : 0);
  }

  /* onlyCp !== null narrows the payload to a single checkpoint. */
  function buildPayload(content, onlyCp) {
    var scope = onlyCp ? 'cp' : 'all';
    var payload = {
      v: PAYLOAD_VERSION,
      k: PAYLOAD_MAGIC,
      t: new Date().toISOString(),
      scope: scope,
      c: {},
      n: {},
      s: {}
    };

    orderedCpIds(content.cps).forEach(function (id) {
      if (onlyCp && id !== onlyCp) return;
      var cp = content.cps[id];
      var phases = {};
      orderedPhases(cp).forEach(function (phase) {
        phases[phase] = cp.phases[phase].map(function (it) {
          return [it.id, it.text, itemFlags(it)];
        });
      });
      payload.c[id] = { n: cp.name || cpDisplayName(id, content), p: phases };
    });

    Object.keys(content.notes).forEach(function (id) {
      if (onlyCp && id !== onlyCp) return;
      if (content.notes[id]) payload.n[id] = content.notes[id];
    });

    if (!onlyCp) {
      Object.keys(content.sectionNotes).sort().forEach(function (k) {
        if (content.sectionNotes[k]) payload.s[k] = content.sectionNotes[k];
      });
    }

    return payload;
  }

  function parsePayload(payload) {
    if (!isPlainObject(payload)) fail('that file does not contain a checklist.');
    if (payload.k && payload.k !== PAYLOAD_MAGIC) {
      fail('that is a valid file, but it is not a UTMB crew checklist.');
    }
    if (!isPlainObject(payload.c)) {
      /* Tolerate a raw checklists.json being imported directly. */
      if (isPlainObject(payload.checkpoints)) {
        var direct = normalizeContent(payload);
        direct.scope = 'all';
        return direct;
      }
      fail('that checklist has no checkpoints in it.');
    }
    if (payload.v && Number(payload.v) > PAYLOAD_VERSION) {
      fail('that link was made by a newer version of this app (payload v' + payload.v +
        '). Update the page on this phone first.');
    }

    var content = { cps: {}, notes: {}, sectionNotes: {}, scope: payload.scope === 'cp' ? 'cp' : 'all' };

    Object.keys(payload.c).forEach(function (id) {
      var raw = payload.c[id];
      if (!isPlainObject(raw)) return;
      var phases = isPlainObject(raw.p) ? raw.p : (isPlainObject(raw.phases) ? raw.phases : {});
      content.cps[id] = normalizeCp(id, { name: raw.n || raw.name || '', phases: phases });
    });

    if (isPlainObject(payload.n)) {
      Object.keys(payload.n).forEach(function (k) {
        if (typeof payload.n[k] === 'string') content.notes[k] = payload.n[k];
      });
    }
    if (isPlainObject(payload.s)) {
      Object.keys(payload.s).forEach(function (k) {
        if (typeof payload.s[k] === 'string') content.sectionNotes[k] = payload.s[k];
      });
    }

    if (!Object.keys(content.cps).length && !Object.keys(content.notes).length &&
        !Object.keys(content.sectionNotes).length) {
      fail('that checklist is empty — nothing to import.');
    }

    content.stamp = typeof payload.t === 'string' ? payload.t : '';
    return content;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 7. Diff
   * ═══════════════════════════════════════════════════════════════════════ */

  function indexItems(cp) {
    var byId = Object.create(null);
    if (!cp) return byId;
    Object.keys(cp.phases).forEach(function (phase) {
      cp.phases[phase].forEach(function (it, i) {
        byId[it.id] = { item: it, phase: phase, index: i };
      });
    });
    return byId;
  }

  function diffContent(local, incoming) {
    var result = {
      checkpoints: [],
      sectionNotes: [],
      counts: { added: 0, changed: 0, removed: 0, moved: 0, notes: 0, sections: 0 },
      total: 0,
      removedIds: [],
      scope: incoming.scope
    };

    var ids = Object.create(null);
    Object.keys(incoming.cps).forEach(function (id) { ids[id] = true; });
    Object.keys(incoming.notes).forEach(function (id) { ids[id] = true; });
    if (incoming.scope === 'all') {
      Object.keys(local.cps).forEach(function (id) { ids[id] = true; });
      Object.keys(local.notes).forEach(function (id) { ids[id] = true; });
    }

    orderedCpIds(ids).forEach(function (id) {
      var localCp = local.cps[id] || null;
      var inCp = incoming.cps[id] || null;

      var entry = {
        id: id,
        name: (inCp && inCp.name) || cpDisplayName(id, local),
        added: [],
        changed: [],
        removed: [],
        note: null,
        newCheckpoint: false,
        droppedCheckpoint: false
      };

      if (inCp && !localCp) entry.newCheckpoint = true;
      if (!inCp && localCp && incoming.scope === 'all') entry.droppedCheckpoint = true;

      var localIdx = indexItems(localCp);
      var inIdx = indexItems(inCp);

      if (inCp) {
        orderedPhases(inCp).forEach(function (phase) {
          inCp.phases[phase].forEach(function (it) {
            var prev = localIdx[it.id];
            if (!prev) {
              entry.added.push({ phase: phase, item: it });
              return;
            }
            var textChanged = prev.item.text !== it.text;
            var flagChanged = !!prev.item.critical !== !!it.critical || !!prev.item.draft !== !!it.draft;
            var moved = prev.phase !== phase;
            if (textChanged || flagChanged || moved) {
              entry.changed.push({
                phase: phase,
                fromPhase: prev.phase,
                moved: moved,
                textChanged: textChanged,
                flagChanged: flagChanged,
                before: prev.item,
                item: it
              });
            }
          });
        });
      }

      if (localCp && (inCp || entry.droppedCheckpoint)) {
        orderedPhases(localCp).forEach(function (phase) {
          localCp.phases[phase].forEach(function (it) {
            if (!inIdx[it.id]) entry.removed.push({ phase: phase, item: it });
          });
        });
      }

      var localNote = local.notes[id] || '';
      var hasIncomingNote = Object.prototype.hasOwnProperty.call(incoming.notes, id);
      var inNote = hasIncomingNote ? incoming.notes[id] : null;
      if (hasIncomingNote && inNote !== localNote) {
        entry.note = { before: localNote, after: inNote };
      } else if (!hasIncomingNote && incoming.scope === 'all' && localNote && incoming.cps[id]) {
        /* The sender has this checkpoint but cleared its crew note. */
        entry.note = { before: localNote, after: '' };
      }

      var n = entry.added.length + entry.changed.length + entry.removed.length + (entry.note ? 1 : 0);
      if (!n) return;

      result.counts.added += entry.added.length;
      result.counts.removed += entry.removed.length;
      result.counts.notes += entry.note ? 1 : 0;
      entry.changed.forEach(function (c) {
        if (c.moved && !c.textChanged && !c.flagChanged) result.counts.moved++;
        else result.counts.changed++;
      });
      entry.removed.forEach(function (r) { result.removedIds.push(r.item.id); });
      entry.count = n;
      result.checkpoints.push(entry);
    });

    var secKeys = Object.create(null);
    Object.keys(incoming.sectionNotes).forEach(function (k) { secKeys[k] = true; });
    if (incoming.scope === 'all') Object.keys(local.sectionNotes).forEach(function (k) { secKeys[k] = true; });
    Object.keys(secKeys).sort().forEach(function (k) {
      var before = local.sectionNotes[k] || '';
      var has = Object.prototype.hasOwnProperty.call(incoming.sectionNotes, k);
      if (!has && incoming.scope !== 'all') return;
      var after = has ? incoming.sectionNotes[k] : '';
      if (after === before) return;
      result.sectionNotes.push({ key: k, before: before, after: after });
      result.counts.sections++;
    });

    result.total = result.counts.added + result.counts.changed + result.counts.moved +
      result.counts.removed + result.counts.notes + result.counts.sections;
    return result;
  }

  function diffSummary(diff) {
    var bits = [];
    if (diff.counts.added) bits.push(plural(diff.counts.added, 'item') + ' added');
    if (diff.counts.changed) bits.push(diff.counts.changed + ' changed');
    if (diff.counts.moved) bits.push(diff.counts.moved + ' moved');
    if (diff.counts.removed) bits.push(diff.counts.removed + ' removed');
    if (diff.counts.notes) bits.push(plural(diff.counts.notes, 'crew note') + ' changed');
    if (diff.counts.sections) bits.push(plural(diff.counts.sections, 'section note') + ' changed');
    if (!bits.length) return 'no changes';
    var where = diff.checkpoints.map(function (c) { return c.name; });
    var tail = '';
    if (where.length === 1) tail = ' at ' + where[0];
    else if (where.length === 2) tail = ' at ' + where[0] + ' and ' + where[1];
    else if (where.length > 2) tail = ' across ' + where.length + ' checkpoints';
    return bits.join(', ') + tail;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 8. UI — sheets
   * ═══════════════════════════════════════════════════════════════════════ */

  var dom = {
    scrim: null,
    shareSheet: null,
    shareBody: null,
    reviewSheet: null,
    reviewBody: null,
    reviewFoot: null,
    reviewTitle: null,
    fileInput: null,
    dlAnchor: null
  };
  var activeSheet = null;
  var pendingReview = null;   /* {content, diff, origin} while the review sheet is up */

  function buildChrome() {
    if (dom.scrim || typeof document === 'undefined' || !document.body) return;

    dom.scrim = document.createElement('div');
    dom.scrim.className = 'sh-scrim';
    dom.scrim.addEventListener('click', function () {
      if (activeSheet === dom.reviewSheet) declineReview('dismiss');
      else closeSheet();
    });
    document.body.appendChild(dom.scrim);

    /* ── share sheet ── */
    dom.shareSheet = document.createElement('div');
    dom.shareSheet.className = 'sh-sheet';
    dom.shareSheet.setAttribute('role', 'dialog');
    dom.shareSheet.setAttribute('aria-modal', 'true');
    dom.shareSheet.setAttribute('aria-label', 'Share checklist');
    dom.shareSheet.innerHTML =
      '<div class="sh-grip"></div>' +
      '<div class="sh-head"><h3>Share the checklist</h3>' +
      '<button type="button" class="sh-x" aria-label="Close">✕</button></div>' +
      '<div class="sh-body"></div>';
    dom.shareBody = dom.shareSheet.querySelector('.sh-body');
    dom.shareSheet.querySelector('.sh-x').addEventListener('click', function () { closeSheet(); });
    document.body.appendChild(dom.shareSheet);

    /* ── review sheet ── */
    dom.reviewSheet = document.createElement('div');
    dom.reviewSheet.className = 'sh-sheet sh-review';
    dom.reviewSheet.setAttribute('role', 'dialog');
    dom.reviewSheet.setAttribute('aria-modal', 'true');
    dom.reviewSheet.setAttribute('aria-label', 'Review incoming checklist');
    dom.reviewSheet.innerHTML =
      '<div class="sh-grip"></div>' +
      '<div class="sh-head"><h3 class="sh-rv-title">Checklist update</h3>' +
      '<button type="button" class="sh-x" aria-label="Dismiss, keep mine">✕</button></div>' +
      '<div class="sh-body"></div>' +
      '<div class="sh-foot"></div>';
    dom.reviewBody = dom.reviewSheet.querySelector('.sh-body');
    dom.reviewFoot = dom.reviewSheet.querySelector('.sh-foot');
    dom.reviewTitle = dom.reviewSheet.querySelector('.sh-rv-title');
    dom.reviewSheet.querySelector('.sh-x').addEventListener('click', function () { declineReview('dismiss'); });
    document.body.appendChild(dom.reviewSheet);

    /* ── hidden helpers ── */
    dom.fileInput = document.createElement('input');
    dom.fileInput.type = 'file';
    dom.fileInput.accept = 'application/json,.json';
    dom.fileInput.className = 'sh-file-input';
    dom.fileInput.addEventListener('change', onFilePicked);
    dom.shareSheet.appendChild(dom.fileInput);

    dom.dlAnchor = document.createElement('a');
    dom.dlAnchor.className = 'sh-file-input';
    dom.dlAnchor.rel = 'noopener';
    document.body.appendChild(dom.dlAnchor);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !activeSheet) return;
      if (activeSheet === dom.reviewSheet) declineReview('dismiss');
      else closeSheet();
    });
  }

  function openSheet(sheet) {
    buildChrome();
    if (!sheet) return;
    if (activeSheet && activeSheet !== sheet) activeSheet.classList.remove('open');
    activeSheet = sheet;
    dom.scrim.classList.add('open');
    /* Force a layout read so the browser has the closed state on record and the
     * transform transition actually animates. Doing this synchronously rather
     * than in requestAnimationFrame matters: rAF does not fire in a background
     * tab, which is exactly where a tapped share link often lands. */
    /* eslint-disable-next-line no-unused-expressions */
    sheet.offsetWidth;
    sheet.classList.add('open');
  }

  function closeSheet() {
    if (dom.scrim) dom.scrim.classList.remove('open');
    if (dom.shareSheet) dom.shareSheet.classList.remove('open');
    if (dom.reviewSheet) dom.reviewSheet.classList.remove('open');
    activeSheet = null;
  }

  /* ── share sheet body ────────────────────────────────────────────────── */

  var lastLink = { url: '', stats: null, cp: null };

  function countItems(content, onlyCp) {
    var n = 0;
    Object.keys(content.cps).forEach(function (id) {
      if (onlyCp && id !== onlyCp) return;
      var cp = content.cps[id];
      Object.keys(cp.phases).forEach(function (p) { n += cp.phases[p].length; });
    });
    return n;
  }

  function buildLink(onlyCp) {
    var content = readContent();
    var payload = buildPayload(content, onlyCp || null);
    var enc = encodePayload(payload);
    var base = String(window.location.href).split('#')[0];
    return {
      url: base + HASH_PREFIX + enc.text,
      payload: payload,
      content: content,
      stats: {
        json: JSON.stringify(payload).length,
        rawBytes: enc.rawBytes,
        bodyBytes: enc.bodyBytes,
        framedBytes: enc.framedBytes,
        compressed: enc.compressed,
        payloadChars: enc.text.length,
        urlChars: base.length + HASH_PREFIX.length + enc.text.length,
        items: countItems(content, onlyCp || null),
        checkpoints: onlyCp ? 1 : Object.keys(content.cps).length
      }
    };
  }

  function renderShareSheet(onlyCp) {
    buildChrome();
    if (!dom.shareBody) return;   /* no document.body yet — nothing to open into */
    var built;
    try {
      built = buildLink(onlyCp);
    } catch (err) {
      renderShareError(err, onlyCp);
      openSheet(dom.shareSheet);
      return;
    }

    lastLink = { url: built.url, stats: built.stats, cp: onlyCp || null };
    var s = built.stats;
    var ratio = s.rawBytes > 0 ? Math.round(100 - (s.framedBytes * 100 / s.rawBytes)) : 0;

    var scopeLine = onlyCp
      ? esc(cpDisplayName(onlyCp, built.content)) + ' only'
      : plural(s.items, 'item') + ' across ' + plural(s.checkpoints, 'checkpoint');

    var sizeLine = nf(s.rawBytes) + ' B → ' + nf(s.framedBytes) + ' B' +
      (s.compressed && ratio > 0 ? ' (−' + ratio + '%)' : ' (stored)') +
      ' · link ' + nf(s.urlChars) + ' chars';

    var html = '';
    html += '<p class="sh-lead">Everything travels inside the link. Nothing is uploaded — the part after <code>#</code> never leaves the phone it is on until you send it.</p>';
    html += '<div class="sh-meta"><span>' + scopeLine + '</span><span>' + esc(sizeLine) + '</span></div>';

    if (s.urlChars > LONG_LINK_CHARS) {
      html += '<div class="sh-warn">That is a long link. iMessage, WhatsApp and AirDrop handle it, but if it arrives broken, send the <b>.json file</b> instead.</div>';
    }

    html += '<div class="sh-acts">';
    html += '<button type="button" class="sh-act sh-primary" data-act="link"><span class="sh-ico">🔗</span><span><b>Send checklist link</b><i>' +
      (typeof navigator !== 'undefined' && navigator.share ? 'AirDrop, Messages, WhatsApp…' : 'Copies the link to the clipboard') + '</i></span></button>';
    html += '<button type="button" class="sh-act" data-act="copy"><span class="sh-ico">📋</span><span><b>Copy link</b><i>Paste it anywhere</i></span></button>';
    html += '<button type="button" class="sh-act" data-act="file"><span class="sh-ico">📄</span><span><b>Send .json file</b><i>For anything that mangles long links</i></span></button>';
    html += '</div>';

    html += '<textarea class="sh-link" readonly rows="3" spellcheck="false" aria-label="Shareable link">' + esc(built.url) + '</textarea>';

    html += '<div class="sh-sep"><span>Receive</span></div>';
    html += '<div class="sh-acts">';
    html += '<button type="button" class="sh-act" data-act="import"><span class="sh-ico">📥</span><span><b>Import a .json file</b><i>You will see the changes before anything is applied</i></span></button>';
    html += '</div>';
    html += '<label class="sh-paste-label" for="shPaste">…or paste a link someone sent you</label>';
    html += '<div class="sh-paste-row">';
    html += '<input type="text" id="shPaste" class="sh-paste" placeholder="https://…#s=…" spellcheck="false" autocapitalize="off" autocorrect="off">';
    html += '<button type="button" class="sh-go" data-act="paste">Open</button>';
    html += '</div>';

    dom.shareBody.innerHTML = html;
    wireShareSheet(onlyCp);
    openSheet(dom.shareSheet);
  }

  function renderShareError(err, onlyCp) {
    var msg = (err && err.message) ? err.message : String(err);
    console.error('[UTMB share] could not build a link', err);
    dom.shareBody.innerHTML =
      '<div class="sh-warn sh-bad">Could not build a link: ' + esc(msg) + '</div>' +
      '<div class="sh-acts"><button type="button" class="sh-act" data-act="file">' +
      '<span class="sh-ico">📄</span><span><b>Send .json file instead</b><i>Same content, no URL length limits</i></span></button></div>' +
      '<div class="sh-sep"><span>Receive</span></div>' +
      '<div class="sh-acts"><button type="button" class="sh-act" data-act="import">' +
      '<span class="sh-ico">📥</span><span><b>Import a .json file</b><i>Review before applying</i></span></button></div>';
    wireShareSheet(onlyCp);
  }

  function wireShareSheet(onlyCp) {
    var nodes = dom.shareBody.querySelectorAll('[data-act]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener('click', function (e) {
        var act = e.currentTarget.getAttribute('data-act');
        try {
          if (act === 'link') shareLink(onlyCp);
          else if (act === 'copy') copyLink();
          else if (act === 'file') shareFile(onlyCp);
          else if (act === 'import') pickFile();
          else if (act === 'paste') importFromPasteBox();
        } catch (err) {
          reportError(err);
        }
      });
    }
  }

  /* ── review sheet body ───────────────────────────────────────────────── */

  var MAX_ROWS = 80;

  /* Crew notes and section notes are paragraphs, and an edit is usually a line
   * appended at the end — clipping the head of a 250-character note would hide
   * the very thing the reader needs to see. So for those, show the *change*:
   * common prefix and suffix collapse to context, the middle is struck/added. */
  function textDelta(before, after) {
    before = String(before === null || before === undefined ? '' : before);
    after = String(after === null || after === undefined ? '' : after);
    var lim = Math.min(before.length, after.length);
    var p = 0;
    while (p < lim && before.charAt(p) === after.charAt(p)) p++;
    var lim2 = Math.min(before.length - p, after.length - p);
    var s = 0;
    while (s < lim2 && before.charAt(before.length - 1 - s) === after.charAt(after.length - 1 - s)) s++;
    return {
      pre: before.slice(0, p),
      removed: before.slice(p, before.length - s),
      added: after.slice(p, after.length - s),
      post: before.slice(before.length - s)
    };
  }

  function renderDelta(before, after) {
    var d = textDelta(before, after);
    if (!d.removed && !d.added) {
      return '<span class="sh-txt">' + esc(clip(after, 240)) + '</span>';
    }
    var CTX = 70;
    var pre = d.pre.length > CTX ? '…' + d.pre.slice(-CTX) : d.pre;
    var post = d.post.length > CTX ? d.post.slice(0, CTX) + '…' : d.post;
    var html = '<span class="sh-delta">';
    if (pre) html += '<span class="sh-ctx">' + esc(pre) + '</span>';
    if (d.removed) html += '<del>' + esc(clip(d.removed, 400)) + '</del>';
    if (d.added) html += '<ins>' + esc(clip(d.added, 400)) + '</ins>';
    if (post) html += '<span class="sh-ctx">' + esc(post) + '</span>';
    html += '</span>';
    if (!after) html += '<span class="sh-tags"><em class="sh-tag sh-crit">cleared</em></span>';
    return html;
  }

  function itemRow(kind, phase, text, critical, extra) {
    var sign = kind === 'add' ? '+' : (kind === 'del' ? '−' : '~');
    var html = '<li class="sh-row sh-' + kind + '">';
    html += '<span class="sh-sign">' + sign + '</span>';
    html += '<span class="sh-rowmain">';
    html += '<span class="sh-txt">' + esc(clip(text, 400)) + '</span>';
    var tags = '';
    if (critical) tags += '<em class="sh-tag sh-crit">critical</em>';
    if (phase) tags += '<em class="sh-tag">' + esc(phaseLabel(phase)) + '</em>';
    if (extra) tags += '<em class="sh-tag">' + esc(extra) + '</em>';
    if (tags) html += '<span class="sh-tags">' + tags + '</span>';
    html += '</span></li>';
    return html;
  }

  function renderReviewSheet(incoming, diff, origin) {
    buildChrome();
    if (!dom.reviewBody) {
      /* No place to render a review — say so rather than applying blind. */
      toast('A crew update arrived but the page is not ready. Reload and open the link again.');
      return;
    }
    pendingReview = { content: incoming, diff: diff, origin: origin };

    dom.reviewTitle.textContent = diff.scope === 'cp' ? 'Checkpoint update' : 'Checklist update';

    var when = '';
    if (incoming.stamp) {
      var d = new Date(incoming.stamp);
      if (!isNaN(d.getTime())) {
        when = d.toLocaleString(undefined, {
          weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'
        });
      }
    }

    var html = '';
    html += '<div class="sh-rv-sum"><b>' + esc(diffSummary(diff)) + '</b>';
    html += '<span>' + (origin === 'file' ? 'From an imported file' : 'From a shared link') +
      (when ? ' · sent ' + esc(when) : '') + '</span></div>';

    var rows = 0;
    var truncated = false;

    diff.checkpoints.forEach(function (cp) {
      if (rows >= MAX_ROWS) { truncated = true; return; }
      html += '<div class="sh-rv-cp">';
      html += '<div class="sh-rv-cph">' + esc(cp.name) + ' <span class="sh-cpid">' + esc(cp.id) + '</span>';
      if (cp.newCheckpoint) html += '<em class="sh-tag sh-new">new checkpoint</em>';
      if (cp.droppedCheckpoint) html += '<em class="sh-tag sh-crit">removed entirely</em>';
      html += '</div><ul class="sh-rows">';

      cp.added.forEach(function (a) {
        if (rows++ >= MAX_ROWS) { truncated = true; return; }
        html += itemRow('add', a.phase, a.item.text, a.item.critical, a.item.draft ? 'draft' : '');
      });
      cp.changed.forEach(function (c) {
        if (rows++ >= MAX_ROWS) { truncated = true; return; }
        var extra = c.moved ? ('moved from ' + phaseLabel(c.fromPhase)) : '';
        if (c.textChanged) {
          html += '<li class="sh-row sh-chg"><span class="sh-sign">~</span><span class="sh-rowmain">' +
            '<span class="sh-was">' + esc(clip(c.before.text, 400)) + '</span>' +
            '<span class="sh-txt">' + esc(clip(c.item.text, 400)) + '</span>' +
            '<span class="sh-tags">' +
            (c.item.critical ? '<em class="sh-tag sh-crit">critical</em>' : '') +
            '<em class="sh-tag">' + esc(phaseLabel(c.phase)) + '</em>' +
            (extra ? '<em class="sh-tag">' + esc(extra) + '</em>' : '') +
            '</span></span></li>';
        } else {
          var what = c.moved ? extra : 'flag changed' +
            (c.item.critical !== c.before.critical ? (c.item.critical ? ' → critical' : ' → not critical') : '') +
            (c.item.draft !== c.before.draft ? (c.item.draft ? ' → draft' : ' → confirmed') : '');
          html += itemRow('chg', c.phase, c.item.text, c.item.critical, what);
        }
      });
      cp.removed.forEach(function (r) {
        if (rows++ >= MAX_ROWS) { truncated = true; return; }
        html += itemRow('del', r.phase, r.item.text, r.item.critical, '');
      });
      if (cp.note) {
        if (rows++ < MAX_ROWS) {
          html += '<li class="sh-row sh-chg"><span class="sh-sign">✎</span><span class="sh-rowmain">' +
            '<span class="sh-tags"><em class="sh-tag">crew note</em></span>' +
            renderDelta(cp.note.before, cp.note.after) +
            '</span></li>';
        } else { truncated = true; }
      }
      html += '</ul></div>';
    });

    if (diff.sectionNotes.length) {
      html += '<div class="sh-rv-cp"><div class="sh-rv-cph">Section notes</div><ul class="sh-rows">';
      diff.sectionNotes.forEach(function (s) {
        if (rows++ >= MAX_ROWS) { truncated = true; return; }
        html += '<li class="sh-row sh-chg"><span class="sh-sign">~</span><span class="sh-rowmain">' +
          '<span class="sh-tags"><em class="sh-tag">' + esc(s.key.replace('_', ' → ')) + '</em></span>' +
          renderDelta(s.before, s.after) +
          '</span></li>';
      });
      html += '</ul></div>';
    }

    if (truncated) {
      html += '<div class="sh-more">…and more. Accepting applies every change listed above and below.</div>';
    }

    html += '<div class="sh-rv-note">Ticks stay as they are. Anything you have already checked off keeps its tick as long as the item survives.</div>';

    dom.reviewBody.innerHTML = html;
    dom.reviewBody.scrollTop = 0;

    dom.reviewFoot.innerHTML =
      '<button type="button" class="sh-btn-ghost" data-rv="keep">Keep mine</button>' +
      '<button type="button" class="sh-btn-go" data-rv="accept">Accept ' + diff.total + ' change' + (diff.total === 1 ? '' : 's') + '</button>';

    var btns = dom.reviewFoot.querySelectorAll('[data-rv]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        var what = e.currentTarget.getAttribute('data-rv');
        if (what === 'accept') acceptReview();
        else declineReview('keep');
      });
    }

    openSheet(dom.reviewSheet);
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 9. Actions
   * ═══════════════════════════════════════════════════════════════════════ */

  function reportError(err) {
    var msg = (err && err.message) ? err.message : String(err);
    console.error('[UTMB share]', err);
    toast(msg.length > 120 ? msg.slice(0, 117) + '…' : msg);
    return null;
  }

  function shareLink(onlyCp) {
    var url;
    try {
      url = lastLink.url && lastLink.cp === (onlyCp || null) ? lastLink.url : buildLink(onlyCp).url;
    } catch (err) {
      return reportError(err);
    }

    var title = onlyCp
      ? 'UTMB crew checklist — ' + cpDisplayName(onlyCp, null)
      : 'UTMB 2026 crew checklist';

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      navigator.share({ title: title, url: url }).then(function () {
        closeSheet();
      })['catch'](function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
        console.warn('[UTMB share] navigator.share failed, copying instead', err);
        copyLink();
      });
      return;
    }
    copyLink();
  }

  function copyLink() {
    var url = lastLink.url;
    if (!url) {
      try { url = buildLink(lastLink.cp).url; } catch (err) { return reportError(err); }
    }
    var ta = dom.shareBody ? dom.shareBody.querySelector('.sh-link') : null;

    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(url).then(function () {
        toast('Link copied — paste it to the crew');
      })['catch'](function () {
        legacyCopy(ta, url);
      });
      return;
    }
    legacyCopy(ta, url);
  }

  function legacyCopy(ta, url) {
    if (ta) {
      try {
        ta.value = url;
        ta.focus();
        ta.setSelectionRange(0, url.length);
        var ok = document.execCommand && document.execCommand('copy');
        if (ok) { toast('Link copied — paste it to the crew'); return; }
      } catch (err) {
        console.warn('[UTMB share] execCommand copy failed', err);
      }
      ta.focus();
      try { ta.setSelectionRange(0, url.length); } catch (e) { /* ignore */ }
      toast('Copy not allowed here — the link is selected, copy it by hand');
      return;
    }
    toast('Could not copy automatically — open Share again to see the link');
  }

  function fileName(onlyCp) {
    var d = new Date();
    var pad = function (v) { return (v < 10 ? '0' : '') + v; };
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes());
    return 'utmb-checklist' + (onlyCp ? '-' + String(onlyCp).toLowerCase() : '') + '-' + stamp + '.json';
  }

  function shareFile(onlyCp) {
    var json;
    var name = fileName(onlyCp);
    try {
      var content = readContent();
      json = JSON.stringify(buildPayload(content, onlyCp || null), null, 2);
    } catch (err) {
      return reportError(err);
    }

    /* Preferred: hand the file straight to the OS share sheet (AirDrop works
     * peer-to-peer with no signal at all). */
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function' && typeof File === 'function') {
      var file = null;
      try {
        file = new File([json], name, { type: 'application/json' });
      } catch (err) {
        file = null;
      }
      if (file) {
        var can = false;
        try { can = navigator.canShare({ files: [file] }); } catch (e) { can = false; }
        if (can) {
          navigator.share({ files: [file], title: 'UTMB crew checklist' }).then(function () {
            closeSheet();
          })['catch'](function (err) {
            if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
            console.warn('[UTMB share] file share failed, downloading instead', err);
            downloadJSON(json, name);
          });
          return;
        }
      }
    }
    downloadJSON(json, name);
  }

  function downloadJSON(json, name) {
    buildChrome();
    var url = null;
    try {
      if (typeof Blob === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
        url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      }
    } catch (err) {
      url = null;
    }
    if (!url) {
      /* Very old Safari: a data: URL still downloads. */
      url = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    }
    dom.dlAnchor.href = url;
    dom.dlAnchor.download = name;
    dom.dlAnchor.click();
    toast('Saved ' + name);
    if (url.indexOf('blob:') === 0) {
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      }, 60000);
    }
  }

  function pickFile() {
    buildChrome();
    dom.fileInput.value = '';
    dom.fileInput.click();
  }

  function onFilePicked(e) {
    var files = e.target.files;
    if (!files || !files.length) return;
    var file = files[0];
    if (typeof FileReader !== 'function') {
      toast('This browser cannot read files — use a link instead');
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () {
      toast('Could not read ' + file.name);
    };
    reader.onload = function () {
      var text = String(reader.result || '');
      var obj;
      try {
        obj = JSON.parse(text);
      } catch (err) {
        reportError(new ShareError('"' + file.name + '" is not readable JSON. It may have been truncated in transit.'));
        return;
      }
      handleIncomingPayload(obj, 'file');
    };
    reader.readAsText(file);
  }

  function importFromPasteBox() {
    var input = dom.shareBody ? dom.shareBody.querySelector('#shPaste') : null;
    var raw = input ? String(input.value || '').trim() : '';
    if (!raw) {
      toast('Paste a link first');
      if (input) input.focus();
      return;
    }
    importFromText(raw);
  }

  /* Accepts a full URL, a bare "#s=..." fragment, a bare payload, or the raw
   * JSON of an exported file. */
  function importFromText(raw) {
    raw = String(raw || '').trim();
    if (!raw) return reportError(new ShareError('nothing to import.'));

    if (raw.charAt(0) === '{') {
      var obj;
      try {
        obj = JSON.parse(raw);
      } catch (err) {
        return reportError(new ShareError('that looks like JSON but it does not parse. It was probably cut short.'));
      }
      return handleIncomingPayload(obj, 'file');
    }

    var idx = raw.indexOf(HASH_PREFIX);
    var token = idx >= 0 ? raw.slice(idx + HASH_PREFIX.length) : raw;
    /* A pasted link can carry trailing junk from a chat app. */
    token = token.replace(/[\s"'<>‘’“”]+$/, '').split(/\s/)[0];
    if (!token) return reportError(new ShareError('that link has no checklist payload after the "#s=".'));
    return handleIncomingToken(token, 'link');
  }

  function handleIncomingToken(token, origin) {
    var payload;
    try {
      payload = decodePayload(token);
    } catch (err) {
      return reportError(err);
    }
    return handleIncomingPayload(payload, origin);
  }

  function handleIncomingPayload(payload, origin) {
    var incoming, local, diff;
    try {
      incoming = parsePayload(payload);
      local = readContent();
      diff = diffContent(local, incoming);
    } catch (err) {
      return reportError(err);
    }

    if (!diff.total) {
      closeSheet();
      toast('Already up to date — that checklist matches yours');
      return diff;
    }
    renderReviewSheet(incoming, diff, origin);
    return diff;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 10. Accepting an update
   * ═══════════════════════════════════════════════════════════════════════ */

  function mergeIncoming(local, incoming) {
    var merged = { cps: {}, notes: {}, sectionNotes: {}, scope: incoming.scope };

    Object.keys(local.cps).forEach(function (id) { merged.cps[id] = local.cps[id]; });
    Object.keys(incoming.cps).forEach(function (id) { merged.cps[id] = incoming.cps[id]; });
    if (incoming.scope === 'all') {
      Object.keys(merged.cps).forEach(function (id) {
        if (!incoming.cps[id]) delete merged.cps[id];
      });
    }

    Object.keys(local.notes).forEach(function (k) { merged.notes[k] = local.notes[k]; });
    Object.keys(incoming.notes).forEach(function (k) { merged.notes[k] = incoming.notes[k]; });

    Object.keys(local.sectionNotes).forEach(function (k) { merged.sectionNotes[k] = local.sectionNotes[k]; });
    Object.keys(incoming.sectionNotes).forEach(function (k) { merged.sectionNotes[k] = incoming.sectionNotes[k]; });

    return merged;
  }

  function applyNotes(diff, incoming) {
    if (!UTMB.store) return;
    var touchedNotes = false;
    var touchedSecs = false;

    diff.checkpoints.forEach(function (cp) {
      if (!cp.note) return;
      var val = cp.note.after;
      if (val) UTMB.store.notes[cp.id] = val;
      else delete UTMB.store.notes[cp.id];
      touchedNotes = true;
    });

    diff.sectionNotes.forEach(function (s) {
      if (s.after) UTMB.store.sectionNotes[s.key] = s.after;
      else delete UTMB.store.sectionNotes[s.key];
      touchedSecs = true;
    });

    if (touchedNotes && typeof UTMB.store.saveNotes === 'function') UTMB.store.saveNotes();
    if (touchedSecs && typeof UTMB.store.saveSectionNotes === 'function') UTMB.store.saveSectionNotes();

    /* Keep any textarea that is currently on screen in sync. */
    if (touchedNotes && typeof document !== 'undefined') {
      var active = (UTMB.drawer && typeof UTMB.drawer.activeCp === 'function') ? UTMB.drawer.activeCp() : null;
      if (active) {
        var ta = document.getElementById('dNotes');
        if (ta && document.activeElement !== ta) ta.value = UTMB.store.notes[active] || '';
      }
    }
    if (touchedSecs && typeof document !== 'undefined') {
      var sel = (UTMB.profile && typeof UTMB.profile.getSelected === 'function') ? UTMB.profile.getSelected() : null;
      if (sel && sel.section) {
        var key = sel.section.from + '_' + sel.section.to;
        var sta = document.getElementById('sectionNotesTa');
        if (sta && document.activeElement !== sta) sta.value = UTMB.store.sectionNotes[key] || '';
      }
    }
  }

  function acceptReview() {
    if (!pendingReview) { closeSheet(); return; }
    var review = pendingReview;
    pendingReview = null;

    var res;
    try {
      var local = readContent();
      var merged = mergeIncoming(local, review.content);
      res = writeContent(merged, review.diff.removedIds);
      applyNotes(review.diff, review.content);
      if (UTMB.store && typeof UTMB.store.saveAll === 'function') UTMB.store.saveAll();
      else if (UTMB.store && typeof UTMB.store.markDirty === 'function') UTMB.store.markDirty();
    } catch (err) {
      closeSheet();
      return reportError(err);
    }

    closeSheet();
    var n = review.diff.total;
    var needsReload = !res.rerendered && typeof window !== 'undefined' && !!window.location;
    toast('Applied ' + n + ' change' + (n === 1 ? '' : 's') + ' — ticks kept' +
      (needsReload ? ', reloading…' : ''));

    /* If nothing on the page knows how to redraw the checklist, a reload is the
     * honest way to show the new content: it is all in localStorage now. */
    if (needsReload) {
      setTimeout(function () {
        try { window.location.reload(); } catch (e) { /* ignore */ }
      }, 900);
    }
  }

  function declineReview(reason) {
    pendingReview = null;
    closeSheet();
    if (reason === 'keep') toast('Kept your version — nothing changed');
    else toast('Update dismissed — the link is still in your messages');
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 11. Incoming links, mounts, bootstrap
   * ═══════════════════════════════════════════════════════════════════════ */

  /* Grab the payload at parse time. Nothing else on the page reads the hash,
   * but capturing early means no later navigation can lose it. */
  var pendingToken = null;
  (function captureHash() {
    if (typeof window === 'undefined' || !window.location) return;
    var h = String(window.location.hash || '');
    if (h.indexOf(HASH_PREFIX) !== 0) return;
    pendingToken = h.slice(HASH_PREFIX.length);
    clearHash();
  })();

  /* ── the receive gate ─────────────────────────────────────────────────────
   * An incoming link is only meaningful next to what this phone already has.
   * If we diff before checklist.js has folded checklists.json in, `local` is
   * empty and every single item in the link is reported as ADDED — the crew
   * are shown "31 items added" for a checklist byte-identical to their own,
   * and there is no way for them to tell that from a real update.
   *
   * So: never decode a link until the checklist module says its content is
   * loaded. If that never happens the page itself is broken, and saying so is
   * far better than showing a diff that is a lie — the link stays in their
   * messages either way. */
  var RECEIVE_POLL_MS = 100;
  var RECEIVE_MAX_WAIT_MS = 15000;

  function contentReady() {
    var api = UTMB.checklist;
    /* No checklist module on this page at all: the storage slot is all the
     * content there is, and readContent() gets it synchronously. */
    if (!isPlainObject(api)) return true;
    if (typeof api.isReady === 'function') return !!api.isReady();
    /* An older checklist.js with no readiness signal — fall back to the
     * bootstrap context, which is set at the same point in the boot. */
    return !!ctxOf();
  }

  function whenContentReady(fn) {
    if (contentReady()) { fn(true); return; }
    var waited = 0;
    (function attempt() {
      if (contentReady()) { fn(true); return; }
      waited += RECEIVE_POLL_MS;
      if (waited >= RECEIVE_MAX_WAIT_MS) { fn(false); return; }
      setTimeout(attempt, RECEIVE_POLL_MS);
    })();
  }

  function deliverToken(token, origin) {
    whenContentReady(function (ready) {
      if (!ready) {
        console.error('[UTMB share] refusing to apply an incoming link: this page never finished ' +
          'loading its own checklist, so the comparison would report every item as new.');
        toast('A crew update arrived, but this phone has not finished loading its own checklist. ' +
          'Reload the page and open the link again.');
        return;
      }
      try {
        handleIncomingToken(token, origin);
      } catch (err) {
        reportError(err);
      }
    });
  }

  function clearHash() {
    if (typeof window === 'undefined' || !window.location) return;
    try {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        return;
      }
    } catch (err) {
      /* file:// and some sandboxes reject replaceState — fall through */
    }
    try { window.location.hash = ''; } catch (err) { /* nothing else to try */ }
  }

  /* Called by main.js as the LAST step of bootstrap, once the checklist has its
   * content. Safe to call more than once and safe to call early — the gate
   * above holds it until there is something honest to diff against. */
  function receivePending() {
    if (!pendingToken) return false;
    var token = pendingToken;
    pendingToken = null;
    deliverToken(token, 'link');
    return true;
  }

  function onHashChange() {
    if (typeof window === 'undefined' || !window.location) return;
    var h = String(window.location.hash || '');
    if (h.indexOf(HASH_PREFIX) !== 0) return;
    var token = h.slice(HASH_PREFIX.length);
    clearHash();
    deliverToken(token, 'link');
  }

  function mountHeaderButton() {
    if (typeof document === 'undefined') return;
    var mount = document.getElementById('shareMount');
    if (!mount || mount.querySelector('.sh-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hbtn sh-btn';
    btn.id = 'shShareBtn';
    btn.innerHTML = '📤 Share';
    btn.addEventListener('click', function () {
      try { renderShareSheet(null); } catch (err) { reportError(err); }
    });
    mount.appendChild(btn);
  }

  function renderDrawerMount(cpId) {
    if (typeof document === 'undefined') return;
    var mount = document.getElementById('drawerShareMount');
    if (!mount) return;
    if (!cpId) { mount.innerHTML = ''; return; }

    var content = readContent();
    var cp = content.cps[cpId];
    var n = cp ? countItems(content, cpId) : 0;
    var hasNote = !!content.notes[cpId];
    if (!n && !hasNote) { mount.innerHTML = ''; return; }

    mount.innerHTML =
      '<button type="button" class="sh-cp-btn" id="shCpShare">' +
      '<span class="sh-ico">📤</span>' +
      '<span><b>Share this checkpoint</b><i>' +
      (n ? plural(n, 'item') : 'crew note') + (hasNote && n ? ' + crew note' : '') +
      ' — just ' + esc(cpDisplayName(cpId, content)) + '</i></span></button>';

    var btn = document.getElementById('shCpShare');
    if (btn) {
      btn.addEventListener('click', function () {
        try { renderShareSheet(cpId); } catch (err) { reportError(err); }
      });
    }
  }

  var inited = false;

  function init() {
    if (inited) return;
    inited = true;

    try {
      buildChrome();
      mountHeaderButton();
    } catch (err) {
      console.error('[UTMB share] could not build the share UI', err);
    }

    if (typeof UTMB.on === 'function') {
      UTMB.on('cp:open', function (e) {
        try { renderDrawerMount(e && e.id); } catch (err) { console.warn('[UTMB share] drawer mount failed', err); }
      });
      UTMB.on('cp:close', function () {
        try { renderDrawerMount(null); } catch (err) { /* ignore */ }
      });

      /* Keep the drawer's "share this checkpoint" line honest when items are
       * edited underneath it. Tick changes fire this too and cost nothing to
       * ignore — re-reading all content on every checkbox tap would not. */
      UTMB.on('checklist:change', function (e) {
        var reason = (e && e.reason) || '';
        if (reason.indexOf('tick') >= 0) return;
        if (!UTMB.drawer || typeof UTMB.drawer.activeCp !== 'function') return;
        var cpId = UTMB.drawer.activeCp();
        if (!cpId) return;
        try { renderDrawerMount(cpId); } catch (err) { /* ignore */ }
      });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('hashchange', onHashChange);
    }
  }

  if (typeof UTMB.ready === 'function') UTMB.ready(init);

  if (typeof document !== 'undefined') {
    /* Safety net: if main.js is missing, or its bootstrap dies somewhere it
     * cannot recover from, UTMB.ready() never fires — but a crew member who
     * just tapped a shared link still needs the review sheet. Come up on our
     * own after a moment. receivePending() is still gated on the checklist
     * having content, so this cannot resurrect the empty-diff bug. */
    var armSafetyNet = function () {
      setTimeout(function () {
        init();
        receivePending();
      }, 2500);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', armSafetyNet);
    } else {
      armSafetyNet();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * Public surface
   * ═══════════════════════════════════════════════════════════════════════ */

  UTMB.share = {
    VERSION: PAYLOAD_VERSION,
    HASH_PREFIX: HASH_PREFIX,
    ShareError: ShareError,

    init: init,
    /* main.js calls this last, after checklist.js has its content. */
    receivePending: receivePending,
    hasPending: function () { return !!pendingToken; },
    contentReady: contentReady,
    open: function (cpId) { renderShareSheet(cpId || null); },
    close: closeSheet,

    /* content */
    readContent: readContent,
    writeContent: writeContent,
    buildPayload: buildPayload,
    parsePayload: parsePayload,
    diff: diffContent,
    diffSummary: diffSummary,
    mergeIncoming: mergeIncoming,

    /* links & files */
    buildLink: buildLink,
    shareLink: shareLink,
    copyLink: copyLink,
    shareFile: shareFile,
    importFile: pickFile,
    importText: importFromText,
    handlePayload: handleIncomingPayload,

    /* codec — exported so it can be round-trip tested outside a browser */
    encodePayload: encodePayload,
    decodePayload: decodePayload,
    encodeString: encodeString,
    decodeString: decodeString,
    _lzss: { compress: lzssCompress, decompress: lzssDecompress },
    _utf8: { encode: utf8Encode, decode: utf8Decode },
    _b64: { encode: b64urlEncode, decode: b64urlDecode },
    _fnv1a: fnv1a
  };
})(window.UTMB);

import crypto from "node:crypto";

/** Vaqtga bog'liq bo'lmagan (timing-safe) taqqoslash; uzunlik ham sizib chiqmaydi. */
export function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---------- JWT (HS256) ----------
const b64u = (v) => Buffer.from(v).toString("base64url");

export function signJwt(payload, secret, ttlSec, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ ...payload, iat, exp: iat + ttlSec }));
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token, secret, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expect = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  if (!safeEq(sig, expect)) return null;
  try {
    if (JSON.parse(Buffer.from(head, "base64url")).alg !== "HS256") return null;
    const claims = JSON.parse(Buffer.from(body, "base64url"));
    if (typeof claims.exp !== "number" || claims.exp < now / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------- TOTP (RFC 6238) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(str) {
  const s = String(str).replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("Noto'g'ri base32 belgi");
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
      val &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf) {
  let bits = 0, val = 0, out = "";
  for (const byte of buf) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
    val &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function totp(secretB32, t = Date.now(), { step = 30, digits = 6 } = {}) {
  const counter = Math.floor(t / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** Kod to'g'ri bo'lsa mos kelgan vaqt oynasi (counter) raqamini, aks holda null qaytaradi. */
export function matchTotp(secretB32, code, t = Date.now()) {
  const c = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  for (const d of [-1, 0, 1]) {
    const at = t + d * 30000;
    if (safeEq(totp(secretB32, at), c)) return Math.floor(at / 30000);
  }
  return null;
}

// ---------- Urinishlarni cheklash ----------
export class RateLimiter {
  constructor(max = 5, windowMs = 15 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map();
  }
  _get(key, now) {
    let e = this.map.get(key);
    if (!e || now - e.t > this.windowMs) {
      e = { n: 0, t: now };
      this.map.set(key, e);
    }
    return e;
  }
  allowed(key, now = Date.now()) {
    return this._get(key, now).n < this.max;
  }
  fail(key, now = Date.now()) {
    this._get(key, now).n++;
  }
  reset(key) {
    this.map.delete(key);
  }
  retryAfterSec(key, now = Date.now()) {
    const e = this.map.get(key);
    return e ? Math.max(1, Math.ceil((this.windowMs - (now - e.t)) / 1000)) : 0;
  }
}

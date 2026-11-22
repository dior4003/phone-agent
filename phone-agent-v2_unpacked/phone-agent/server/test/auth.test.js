import test from "node:test";
import assert from "node:assert/strict";
import { signJwt, verifyJwt, totp, matchTotp, base32Encode, base32Decode, RateLimiter, safeEq } from "../src/auth.js";

test("JWT: imzolash va tekshirish", () => {
  const t = signJwt({ sub: "admin" }, "secret-secret-secret", 60);
  assert.equal(verifyJwt(t, "secret-secret-secret").sub, "admin");
});

test("JWT: noto'g'ri kalit, buzilgan token va muddati o'tgan token rad etiladi", () => {
  const t = signJwt({ sub: "admin" }, "secret-secret-secret", 60);
  assert.equal(verifyJwt(t, "boshqa-kalit-boshqa-kalit"), null);
  const [h, p, s] = t.split(".");
  const evil = Buffer.from(JSON.stringify({ sub: "root", exp: 9999999999 })).toString("base64url");
  assert.equal(verifyJwt(`${h}.${evil}.${s}`, "secret-secret-secret"), null);
  assert.equal(verifyJwt("a.b", "x"), null);
  assert.equal(verifyJwt("", "x"), null);
  assert.equal(verifyJwt(t, "secret-secret-secret", Date.now() + 61_000), null);
});

test("JWT: alg=none hujumi rad etiladi", () => {
  const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ sub: "admin", exp: 9999999999 })).toString("base64url");
  assert.equal(verifyJwt(`${h}.${p}.`, "secret-secret-secret"), null);
});

test("TOTP: RFC 6238 test vektori (SHA1, 8 raqam)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totp(secret, 59_000, { digits: 8 }), "94287082");
  assert.equal(totp(secret, 1111111109_000, { digits: 8 }), "07081804");
  assert.equal(totp(secret, 1234567890_000, { digits: 8 }), "89005924");
});

test("TOTP: base32 aylanishi va oyna tekshiruvi", () => {
  const raw = Buffer.from("abcdefghijklmnopqrst");
  assert.deepEqual(base32Decode(base32Encode(raw)), raw);
  const secret = base32Encode(raw);
  const now = 1_700_000_000_000;
  const code = totp(secret, now);
  assert.ok(matchTotp(secret, code, now) > 0);
  assert.ok(matchTotp(secret, code, now + 30_000) > 0); // 1 oyna orqada
  assert.equal(matchTotp(secret, code, now + 120_000), null); // juda eski
  assert.equal(matchTotp(secret, "12345", now), null);
  assert.equal(matchTotp(secret, "abcdef", now), null);
  assert.equal(matchTotp(secret, undefined, now), null);
});

test("RateLimiter: chegaradan keyin bloklaydi va oyna o'tgach tiklanadi", () => {
  const rl = new RateLimiter(3, 1000);
  const t0 = 1000;
  for (let i = 0; i < 3; i++) { assert.ok(rl.allowed("ip", t0)); rl.fail("ip", t0); }
  assert.equal(rl.allowed("ip", t0 + 10), false);
  assert.ok(rl.allowed("ip", t0 + 1500));
  rl.fail("x"); rl.reset("x");
  assert.ok(rl.allowed("x"));
});

test("safeEq", () => {
  assert.ok(safeEq("abc", "abc"));
  assert.ok(!safeEq("abc", "abd"));
  assert.ok(!safeEq("abc", "abcd"));
});

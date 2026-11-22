import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { boot, login, authed, fakeAgent, panelWs, waitFor, sleep, SAMPLE_STATS, AGENT_TOKEN, PASSWORD } from "./helpers.js";
import { totp, base32Encode } from "../src/auth.js";

test("sozlama: majburiy qiymatlar bo'lmasa server ishga tushmaydi", async () => {
  const { createApp } = await import("../src/app.js");
  assert.throws(() => createApp({}), /AGENT_TOKEN/);
  assert.throws(() => createApp({ AGENT_TOKEN: "x".repeat(20), PANEL_PASSWORD: "almashtiring-parol", JWT_SECRET: "y".repeat(20) }), /PANEL_PASSWORD/);
  assert.throws(() => createApp({ AGENT_TOKEN: "x".repeat(20), PANEL_PASSWORD: "parol12345", JWT_SECRET: "y".repeat(20), TOTP_SECRET: "!!!" }));
});

test("GET /api/health ochiq va holatni ko'rsatadi", async () => {
  const s = await boot();
  try {
    const r = await (await fetch(`${s.base}/api/health`)).json();
    assert.deepEqual({ ok: r.ok, agent: r.agent, totp: r.totp }, { ok: true, agent: false, totp: false });
  } finally { await s.close(); }
});

test("POST /api/login: to'g'ri parol token beradi, noto'g'ri parol 401", async () => {
  const s = await boot();
  try {
    const ok = await login(s.base);
    assert.equal(ok.status, 200);
    assert.ok(ok.json.token.split(".").length === 3);
    const bad = await login(s.base, { password: "noto'g'ri" });
    assert.equal(bad.status, 401);
    const empty = await login(s.base, {});
    assert.equal(empty.status, 401);
  } finally { await s.close(); }
});

test("POST /api/login: 5 ta xato urinishdan keyin 429 va Retry-After", async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(s.base, { password: "x" })).status, 401);
    const blocked = await login(s.base, { password: PASSWORD });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  } finally { await s.close(); }
});

test("login: JSON buzuq bo'lsa 400, juda katta bo'lsa 413", async () => {
  const s = await boot();
  try {
    const r1 = await fetch(`${s.base}/api/login`, { method: "POST", body: "{bad" });
    assert.equal(r1.status, 400);
    const r2 = await fetch(`${s.base}/api/login`, { method: "POST", body: JSON.stringify({ password: "x".repeat(6000) }) }).catch(() => ({ status: 413 }));
    assert.equal(r2.status, 413);
  } finally { await s.close(); }
});

test("himoyalangan endpointlar tokensiz 401 beradi", async () => {
  const s = await boot();
  try {
    for (const [m, p] of [["GET", "/api/status"], ["GET", "/api/history"], ["GET", "/api/audit"], ["GET", "/api/services"], ["GET", "/api/pm2"],
      ["POST", "/api/services/nginx/restart"], ["GET", "/api/logs/nginx"], ["POST", "/api/device/reboot"]]) {
      const r = await fetch(`${s.base}${p}`, { method: m });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    const r = await fetch(`${s.base}/api/status`, { headers: { Authorization: "Bearer buzilgan.token.x" } });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

test("agent noto'g'ri token bilan ulana olmaydi", async () => {
  const s = await boot();
  try {
    await assert.rejects(fakeAgent(s.wsBase, undefined, "noto'g'ri-token"), /401/);
  } finally { await s.close(); }
});

test("agent ulanganda va statistika yuborganda /api/status, /api/services, /api/history ishlaydi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    let st = await (await api("/api/status")).json();
    assert.equal(st.agent, false);
    assert.equal(st.stats, null);

    const a = await fakeAgent(s.wsBase);
    a.sendStats();
    await waitFor(async () => (await (await api("/api/status")).json()).stats);
    st = await (await api("/api/status")).json();
    assert.equal(st.agent, true);
    assert.equal(st.stats.battery, 78);

    const svc = await (await api("/api/services")).json();
    assert.deepEqual(svc.services.map((x) => [x.name, x.running]), [["mariadb", true], ["nginx", true], ["php-fpm", false]]);

    const hist = await (await api("/api/history")).json();
    assert.equal(hist.samples.length, 1);
    assert.ok(Math.abs(hist.samples[0].ram - 57.89) < 0.1);
    a.ws.close();
  } finally { await s.close(); }
});

test("panel WebSocket: tokensiz yopiladi, tokenli holat va statistikani oladi", async () => {
  const s = await boot();
  try {
    const bad = await panelWs(s.wsBase, null);
    const closed = await new Promise((res) => { bad.ws.on("close", (code) => res(code)); bad.ws.send(JSON.stringify({ token: "yolg'on" })); });
    assert.equal(closed, 4001);

    const { json } = await login(s.base);
    const a = await fakeAgent(s.wsBase);
    const p = await panelWs(s.wsBase, json.token);
    await waitFor(() => p.msgs.find((m) => m.type === "agent" && m.online === true));
    a.sendStats();
    const stat = await waitFor(() => p.msgs.find((m) => m.type === "stats"));
    assert.equal(stat.data.tempC, 36.4);

    a.ws.close();
    await waitFor(() => p.msgs.find((m) => m.type === "agent" && m.online === false));
    p.ws.close();
  } finally { await s.close(); }
});

test("buyruqlar: servis start/stop/restart agentga yetib boradi va javob qaytadi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a = await fakeAgent(s.wsBase);
    for (const op of ["start", "stop", "restart"]) {
      const r = await api(`/api/services/mariadb/${op}`, { method: "POST" });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.out, `mariadb ${op} ok`);
    }
    const sent = a.received.filter((m) => m.action === "service");
    assert.deepEqual(sent.map((m) => [m.target, m.op]), [["mariadb", "start"], ["mariadb", "stop"], ["mariadb", "restart"]]);
    a.ws.close();
  } finally { await s.close(); }
});

test("buyruqlar: pm2 ro'yxati, pm2 boshqaruvi, loglar va reboot", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a = await fakeAgent(s.wsBase);
    const pm2 = await (await api("/api/pm2")).json();
    assert.equal(pm2.apps[0].name, "api");
    const r = await (await api("/api/pm2/api/restart", { method: "POST" })).json();
    assert.equal(r.out, "pm2:api restart ok");
    const log = await (await api("/api/logs/nginx?lines=5")).json();
    assert.equal(log.out, "log nginx lines=10"); // eng kami 10 ga ko'tariladi
    const log2 = await (await api("/api/logs/laravel?lines=99999")).json();
    assert.equal(log2.out, "log laravel lines=500");
    const log3 = await (await api("/api/logs/pm2%3Aapi")).json();
    assert.equal(log3.out, "log pm2:api lines=100");
    const rb = await (await api("/api/device/reboot", { method: "POST" })).json();
    assert.equal(rb.ok, true);
    a.ws.close();
  } finally { await s.close(); }
});

test("tekshiruv: noto'g'ri nom yoki amal agentgacha yetib bormaydi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a = await fakeAgent(s.wsBase);
    const cases = [
      ["POST", "/api/services/nginx/format"],
      ["POST", "/api/services/ng%20inx/start"],
      ["POST", "/api/services/..%2Fetc/start"],
      ["POST", "/api/services/a;rm%20-rf/start"],
      ["POST", "/api/pm2/x$(id)/restart"],
      ["GET", "/api/logs/..%2F..%2Fetc%2Fpasswd"],
      ["GET", "/api/logs/a%20b"],
    ];
    for (const [m, p] of cases) {
      const r = await api(p, { method: m });
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    }
    await sleep(50);
    assert.equal(a.received.length, 0);
    a.ws.close();
  } finally { await s.close(); }
});

test("agent ulanmagan bo'lsa 503, javob bermasa 504", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    assert.equal((await api("/api/services/nginx/restart", { method: "POST" })).status, 503);
    assert.equal((await api("/api/pm2")).status, 503);

    const a = await fakeAgent(s.wsBase, () => null); // hech qachon javob bermaydi
    const t0 = Date.now();
    const r = await api("/api/services/nginx/restart", { method: "POST" });
    assert.equal(r.status, 504);
    assert.ok(Date.now() - t0 >= 700);
    a.ws.close();
  } finally { await s.close(); }
});

test("buyruq kutilayotganda agent uzilsa 503 qaytadi", async () => {
  const s = await boot({ CMD_TIMEOUT_MS: "5000" });
  try {
    const api = await authed(s.base);
    const a = await fakeAgent(s.wsBase, () => null);
    const pending = api("/api/services/nginx/restart", { method: "POST" });
    await waitFor(() => a.received.length === 1);
    a.ws.close();
    const r = await pending;
    assert.equal(r.status, 503);
  } finally { await s.close(); }
});

test("yangi agent ulansa eskisi almashtiriladi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a1 = await fakeAgent(s.wsBase);
    const closed = new Promise((res) => a1.ws.on("close", (c) => res(c)));
    const a2 = await fakeAgent(s.wsBase);
    assert.equal(await closed, 4000);
    const r = await (await api("/api/services/nginx/start", { method: "POST" })).json();
    assert.equal(r.ok, true);
    assert.equal(a2.received.length, 1);
    a2.ws.close();
  } finally { await s.close(); }
});

test("audit jurnali: kirish, buyruq va natija yoziladi, faylga ham saqlanadi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a = await fakeAgent(s.wsBase);
    await api("/api/services/nginx/restart", { method: "POST" });
    const j = await (await api("/api/audit?limit=20")).json();
    const evs = j.entries.map((e) => e.ev);
    for (const ev of ["login_ok", "agent_up", "cmd", "result"]) assert.ok(evs.includes(ev), ev);
    await sleep(60);
    const file = fs.readFileSync(path.join(s.dir, "audit.log"), "utf8");
    assert.ok(file.includes('"ev":"cmd"'));
    a.ws.close();
  } finally { await s.close(); }
});

test("statik fayllar: xavfsizlik sarlavhalari va yo'l tekshiruvi", async () => {
  const s = await boot();
  try {
    const r = await fetch(`${s.base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("content-type"), /text\/html/);
    for (const p of ["/app.js", "/app.css", "/favicon.svg"]) assert.equal((await fetch(`${s.base}${p}`)).status, 200, p);
    for (const p of ["/../package.json", "/%2e%2e/.env", "/index.js", "/src/app.js", "/.env", "/audit.log"]) {
      assert.equal((await fetch(`${s.base}${p}`)).status, 404, p);
    }
    const post = await fetch(`${s.base}/`, { method: "POST" });
    assert.equal(post.status, 404);
  } finally { await s.close(); }
});

test("2FA: kod bo'lmasa yoki noto'g'ri bo'lsa kirib bo'lmaydi, to'g'ri kod bir marta ishlaydi", async () => {
  const secret = base32Encode(Buffer.from("0123456789abcdefghij"));
  const s = await boot({ TOTP_SECRET: secret });
  try {
    assert.equal((await (await fetch(`${s.base}/api/health`)).json()).totp, true);
    assert.equal((await login(s.base, { password: PASSWORD })).status, 401);
    assert.equal((await login(s.base, { password: PASSWORD, code: "000000" })).status, 401);
    const code = totp(secret);
    assert.equal((await login(s.base, { password: "xato", code })).status, 401);
    assert.equal((await login(s.base, { password: PASSWORD, code })).status, 200);
    // xuddi shu kodni qayta ishlatish mumkin emas
    assert.equal((await login(s.base, { password: PASSWORD, code })).status, 401);
  } finally { await s.close(); }
});

test("Telegram ogohlantirish: harorat yuqori va servis to'xtaganda xabar yuboradi, sovish vaqtini hurmat qiladi", async () => {
  const got = [];
  const tg = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { got.push({ url: req.url, body: JSON.parse(b) }); res.end('{"ok":true}'); });
  });
  await new Promise((r) => tg.listen(0, "127.0.0.1", r));
  const s = await boot({ TELEGRAM_BOT_TOKEN: "T0KEN", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_BASE: `http://127.0.0.1:${tg.address().port}`, ALERT_OFFLINE_SEC: "0" });
  try {
    const a = await fakeAgent(s.wsBase);
    a.sendStats(SAMPLE_STATS);
    await sleep(60);
    assert.equal(got.length, 0); // hammasi me'yorda
    a.sendStats({ ...SAMPLE_STATS, tempC: 48.2, services: { mariadb: false, nginx: true, "php-fpm": false } });
    await waitFor(() => got.length >= 2);
    assert.ok(got.every((g) => g.url === "/botT0KEN/sendMessage" && g.body.chat_id === "42"));
    const texts = got.map((g) => g.body.text).join("\n");
    assert.match(texts, /48\.2/);
    assert.match(texts, /mariadb/);
    const n = got.length;
    a.sendStats({ ...SAMPLE_STATS, tempC: 49, services: { mariadb: false, nginx: true, "php-fpm": false } });
    await sleep(80);
    assert.equal(got.length, n); // sovish vaqti ichida takrorlanmaydi
    a.ws.close();
    await waitFor(() => got.some((g) => /aloqada emas/.test(g.body.text)));
  } finally { await s.close(); tg.close(); }
});

test("panel WebSocket: 5 soniya ichida token yubormasa yopiladi (vaqtni qisqartirib bo'lmaydi, shuning uchun noto'g'ri JSON tekshiriladi)", async () => {
  const s = await boot();
  try {
    const ws = new WebSocket(`${s.wsBase}/panel`);
    await new Promise((r) => ws.once("open", r));
    const code = await new Promise((res) => { ws.on("close", res); ws.send("json-emas"); });
    assert.equal(code, 4001);
  } finally { await s.close(); }
});

test("noma'lum yo'llar: /api/yoq 404 JSON, noma'lum WS yo'li uziladi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const r = await api("/api/yoq");
    assert.equal(r.status, 404);
    assert.ok((await r.json()).error);
    const ws = new WebSocket(`${s.wsBase}/boshqa`);
    await new Promise((res) => { ws.on("error", res); ws.on("close", res); });
  } finally { await s.close(); }
});

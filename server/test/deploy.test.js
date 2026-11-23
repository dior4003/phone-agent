import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { boot, authed, waitFor, sleep, AGENT_TOKEN } from "./helpers.js";

/** Ixtiyoriy kechikish bilan javob beradigan agent. */
async function slowAgent(wsBase, { delayMs = 0, reply } = {}) {
  const ws = new WebSocket(`${wsBase}/agent`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  const received = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    received.push(m);
    const r = reply ? reply(m) : { ok: true, out: "ok" };
    setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "result", id: m.id, ok: r.ok, out: r.out })), delayMs);
  });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  return { ws, received };
}

const post = (api, p, body) => api(p, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

test("git clone: 30 soniyalik umumiy vaqtdan uzoq davom etsa ham uzilmaydi (fon ishi)", async () => {
  const s = await boot({ CMD_TIMEOUT_MS: "200", DEPLOY_TIMEOUT_MS: "5000" });
  try {
    const api = await authed(s.base);
    const a = await slowAgent(s.wsBase, { delayMs: 700 });
    // oddiy buyruq 200 ms dan keyin 504 beradi
    assert.equal((await post(api, "/api/services/nginx/restart")).status, 504);
    // clone esa 700 ms kutadi va muvaffaqiyatli tugaydi
    const r = await post(api, "/api/deploy/clone", { repo: "https://github.com/dior4003/phone-agent.git", dir: "app1" });
    assert.equal(r.status, 202);
    const { jobId } = await r.json();
    const first = await (await api(`/api/jobs/${jobId}`)).json();
    assert.equal(first.status, "running");
    const done = await waitFor(async () => {
      const j = await (await api(`/api/jobs/${jobId}`)).json();
      return j.status === "done" ? j : null;
    });
    assert.equal(done.ok, true);
    a.ws.close();
  } finally { await s.close(); }
});

test("bir xil clone ikki marta bosilsa, bitta ish qaytariladi", async () => {
  const s = await boot({ DEPLOY_TIMEOUT_MS: "5000" });
  try {
    const api = await authed(s.base);
    const a = await slowAgent(s.wsBase, { delayMs: 300 });
    const body = { repo: "https://github.com/dior4003/x.git", dir: "app1" };
    const j1 = await (await post(api, "/api/deploy/clone", body)).json();
    const j2 = await (await post(api, "/api/deploy/clone", body)).json();
    assert.equal(j1.jobId, j2.jobId);
    await waitFor(async () => (await (await api(`/api/jobs/${j1.jobId}`)).json()).status === "done");
    assert.equal(a.received.filter((m) => m.action === "deploy").length, 1);
    a.ws.close();
  } finally { await s.close(); }
});

test("agent xato qaytarsa, ish ok=false va xato matni bilan tugaydi; install ham fon ishi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a = await slowAgent(s.wsBase, { reply: (m) => (m.op === "clone" ? { ok: false, out: "fatal: could not read Username" } : { ok: true, out: "O'rnatildi" }) });
    const { jobId } = await (await post(api, "/api/deploy/clone", { repo: "https://github.com/a/b", dir: "p1" })).json();
    const j = await waitFor(async () => { const x = await (await api(`/api/jobs/${jobId}`)).json(); return x.status === "done" ? x : null; });
    assert.equal(j.ok, false);
    assert.match(j.out, /could not read Username/);

    const inst = await post(api, "/api/deploy/p1/install");
    assert.equal(inst.status, 202);
    const id2 = (await inst.json()).jobId;
    const j2 = await waitFor(async () => { const x = await (await api(`/api/jobs/${id2}`)).json(); return x.status === "done" ? x : null; });
    assert.equal(j2.ok, true);
    a.ws.close();
  } finally { await s.close(); }
});

test("agent ish paytida uzilsa, ish xato bilan tugaydi", async () => {
  const s = await boot({ DEPLOY_TIMEOUT_MS: "10000" });
  try {
    const api = await authed(s.base);
    const a = await slowAgent(s.wsBase, { delayMs: 60_000 });
    const { jobId } = await (await post(api, "/api/deploy/clone", { repo: "https://github.com/a/b", dir: "p1" })).json();
    await waitFor(() => a.received.length === 1);
    a.ws.close();
    const j = await waitFor(async () => { const x = await (await api(`/api/jobs/${jobId}`)).json(); return x.status === "done" ? x : null; });
    assert.equal(j.ok, false);
    assert.match(j.out, /uzildi/);
  } finally { await s.close(); }
});

test("clone: noto'g'ri repo/papka rad etiladi, telefon ulanmagan bo'lsa 503, jobs himoyalangan", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const bad = [
      { repo: "http://github.com/a/b", dir: "x" },
      { repo: "git@github.com:a/b.git", dir: "x" },
      { repo: "https://github.com/a/b; rm -rf /", dir: "x" },
      { repo: "https://github.com/a/b`id`", dir: "x" },
      { repo: "https://github.com/a/b", dir: "../x" },
      { repo: "https://github.com/a/b", dir: "a b" },
      { repo: "", dir: "x" },
    ];
    for (const b of bad) assert.equal((await post(api, "/api/deploy/clone", b)).status, 400, JSON.stringify(b));
    assert.equal((await post(api, "/api/deploy/clone", { repo: "https://github.com/a/b", dir: "x" })).status, 503);
    assert.equal((await api("/api/jobs/yoq")).status, 404);
    assert.equal((await fetch(`${s.base}/api/jobs/yoq`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/deploy/clone`, { method: "POST" })).status, 401);
  } finally { await s.close(); }
});

test("audit jurnalida repo manzilidagi token yashiriladi", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a = await slowAgent(s.wsBase);
    const r = await post(api, "/api/deploy/clone", { repo: "https://dior4003:ghp_SIRLI123token@github.com/dior4003/private.git", dir: "priv" });
    const { jobId } = await r.json();
    await waitFor(async () => (await (await api(`/api/jobs/${jobId}`)).json()).status === "done");
    // agentga to'liq manzil yetib boradi (klon qilish uchun kerak)...
    assert.match(a.received[0].repo, /ghp_SIRLI123token/);
    // ...lekin jurnalga tushmaydi
    await sleep(80);
    const j = await (await api("/api/audit?limit=50")).json();
    assert.ok(!JSON.stringify(j).includes("ghp_SIRLI123token"));
    assert.ok(JSON.stringify(j).includes("//***@github.com"));
    assert.ok(!fs.readFileSync(path.join(s.dir, "audit.log"), "utf8").includes("ghp_SIRLI123token"));
    a.ws.close();
  } finally { await s.close(); }
});

test("deploy: scripts, run, remove va tarmoq/yorqinlik/topish endpointlari", async () => {
  const s = await boot();
  try {
    const api = await authed(s.base);
    const a = await slowAgent(s.wsBase, {
      reply: (m) => {
        if (m.action === "deploy" && m.op === "scripts") return { ok: true, out: JSON.stringify({ start: "node index.js", dev: "vite" }) };
        if (m.action === "network" && m.op === "status") return { ok: true, out: JSON.stringify({ wifi: true, bluetooth: false, mobileData: true }) };
        if (m.action === "brightness" && m.op === "get") return { ok: true, out: JSON.stringify({ value: 120 }) };
        return { ok: true, out: "ok" };
      },
    });
    assert.deepEqual((await (await api("/api/deploy/p1/scripts")).json()).scripts, { start: "node index.js", dev: "vite" });
    assert.equal((await post(api, "/api/deploy/p1/run", { script: "dev" })).status, 200);
    assert.equal((await post(api, "/api/deploy/p1/run", { script: "dev; id" })).status, 400);
    assert.equal((await api("/api/deploy/p1", { method: "DELETE" })).status, 200);
    assert.equal((await api("/api/deploy/..%2Fx", { method: "DELETE" })).status, 400);

    const net = await (await api("/api/network")).json();
    assert.deepEqual([net.wifi, net.bluetooth, net.mobileData], [true, false, true]);
    assert.equal((await post(api, "/api/network/wifi_off")).status, 200);
    assert.equal((await post(api, "/api/network/format")).status, 400);

    assert.equal((await (await api("/api/brightness")).json()).value, 120);
    assert.equal((await post(api, "/api/brightness", { value: 200 })).status, 200);
    for (const v of [-1, 256, "abc", 1.5e9]) assert.equal((await post(api, "/api/brightness", { value: v })).status, 400, String(v));

    assert.equal((await post(api, "/api/find/ring")).status, 200);
    assert.equal((await post(api, "/api/find/stop")).status, 200);
    a.ws.close();
  } finally { await s.close(); }
});

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";

export const AGENT_TOKEN = "agent-token-agent-token-1234";
export const PASSWORD = "panel-parol-123";

export async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-"));
  const app = createApp({
    AGENT_TOKEN,
    PANEL_PASSWORD: PASSWORD,
    JWT_SECRET: "jwt-secret-jwt-secret-1234",
    AUDIT_FILE: path.join(dir, "audit.log"),
    CMD_TIMEOUT_MS: "800",
    ...extra,
  });
  const addr = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  const wsBase = `ws://127.0.0.1:${addr.port}`;
  return { app, base, wsBase, dir, close: () => app.close() };
}

export async function login(base, body = { password: PASSWORD }) {
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json(), headers: r.headers };
}

export async function authed(base) {
  const { json } = await login(base);
  return (path, opts = {}) =>
    fetch(`${base}${path}`, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${json.token}`, "Content-Type": "application/json" } });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(15);
  }
  throw new Error("waitFor: vaqt tugadi");
};

export const SAMPLE_STATS = {
  ramTotalMb: 7600, ramAvailMb: 3200, battery: 78, tempC: 36.4, charging: true,
  diskTotalGb: 128, diskFreeGb: 80, uptimeSec: 3600, load: 0.8,
  services: { mariadb: true, nginx: true, "php-fpm": false }, logs: ["nginx", "laravel"],
  device: "Redmi Note 11", android: "13",
};

/** Haqiqiy agentni taqlid qiladi. handler(msg) -> {ok,out} yoki null (javob bermaydi). */
export async function fakeAgent(wsBase, handler = defaultHandler, token = AGENT_TOKEN) {
  const ws = new WebSocket(`${wsBase}/agent`, { headers: { Authorization: `Bearer ${token}` } });
  const received = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    received.push(m);
    const r = handler(m);
    if (r) ws.send(JSON.stringify({ type: "result", id: m.id, ok: r.ok, out: r.out }));
  });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); ws.once("unexpected-response", (_q, resp) => rej(new Error("HTTP " + resp.statusCode))); });
  return { ws, received, sendStats: (data = SAMPLE_STATS) => ws.send(JSON.stringify({ type: "stats", data })) };
}

function defaultHandler(m) {
  if (m.action === "pm2list") return { ok: true, out: JSON.stringify([{ name: "api", status: "online", mem: 52428800, restarts: 1 }]) };
  if (m.action === "logs") return { ok: true, out: `log ${m.target} lines=${m.lines}` };
  if (m.action === "service") return { ok: true, out: `${m.target} ${m.op} ok` };
  if (m.action === "device") return { ok: true, out: "reboot" };
  return { ok: false, out: "?" };
}

export async function panelWs(wsBase, token) {
  const ws = new WebSocket(`${wsBase}/panel`);
  const msgs = [];
  ws.on("message", (raw) => msgs.push(JSON.parse(raw)));
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  if (token) ws.send(JSON.stringify({ token }));
  return { ws, msgs };
}

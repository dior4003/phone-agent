import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { safeEq, signJwt, verifyJwt, matchTotp, base32Decode, RateLimiter } from "./auth.js";
import { Alerts, evaluate } from "./alerts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

const NAME = /^[a-z0-9_-]{1,40}$/i;
const TARGET = /^(pm2:)?[a-z0-9_-]{1,40}$/i;
const OPS = new Set(["start", "stop", "restart"]);
const HISTORY_MAX = 720; // 5 soniyalik namuna bilan ~1 soat

// Birinchi segment (host + ixtiyoriy https://token@host autentifikatsiya) uzunroq
// chegaraga ega — GitHub'ning "fine-grained" shaxsiy tokenlari 90+ belgi bo'lishi mumkin.
const REPO_URL = /^https:\/\/[a-z0-9@:%._+-]{1,220}(\/[a-z0-9._+-]{1,80}){1,6}(\.git)?$/i;
const SCRIPT_NAME = /^[a-z0-9_:.-]{1,40}$/i;
const NET_OPS = new Set(["wifi_on", "wifi_off", "bt_on", "bt_off", "data_on", "data_off"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB (android/.../Actions.kt dagi limit bilan bir xil bo'lishi kerak

// Fayl menejeri uchun yo'l tekshiruvi: "/" bilan boshlanmasin, ".."siz, NUL belgisisiz.
function validPath(raw) {
  let p = String(raw ?? "").replace(/\\/g, "/").trim();
  if (p === "") return ".";
  if (p.startsWith("/") || p.length > 400 || p.includes("\0")) return null;
  for (const s of p.split("/")) if (s === "" || s === "." || s === "..") return null;
  return p;
}

function parseConfig(env) {
  const need = (key, min) => {
    const v = env[key];
    if (!v || v.length < min || /almashtiring/i.test(v)) {
      throw new Error(`.env: ${key} to'ldirilmagan yoki juda qisqa (kamida ${min} belgi). "npm run setup" ni ishlating.`);
    }
    return v;
  };
  const cfg = {
    agentToken: need("AGENT_TOKEN", 16),
    password: need("PANEL_PASSWORD", 8),
    jwtSecret: need("JWT_SECRET", 16),
    totpSecret: env.TOTP_SECRET || "",
    trustProxy: String(env.TRUST_PROXY || "").toLowerCase() === "true",
    sessionSec: Math.max(1, Number(env.SESSION_HOURS || 12)) * 3600,
    cmdTimeout: Number(env.CMD_TIMEOUT_MS || 30000),
    deployTimeout: Number(env.DEPLOY_TIMEOUT_MS || 15 * 60 * 1000),
    auditFile: env.AUDIT_FILE || path.join(process.cwd(), "audit.log"),
    loginMax: Number(env.LOGIN_MAX_ATTEMPTS || 5),
    thresholds: {
      tempC: Number(env.ALERT_TEMP_C || 45),
      ramMinPct: Number(env.ALERT_RAM_MIN_PCT || 10),
      batteryMin: Number(env.ALERT_BATTERY_MIN || 15),
    },
    offlineSec: Number(env.ALERT_OFFLINE_SEC || 60),
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      apiBase: env.TELEGRAM_API_BASE || "https://api.telegram.org",
      cooldownMs: Number(env.ALERT_COOLDOWN_MS || 10 * 60 * 1000),
    },
  };
  if (cfg.totpSecret) base32Decode(cfg.totpSecret); // noto'g'ri bo'lsa, xato beradi
  return cfg;
}

export function createApp(env) {
  const cfg = parseConfig(env);
  const alerts = new Alerts({ ...cfg.telegram, log: (...a) => console.error(...a) });
  const limiter = new RateLimiter(cfg.loginMax, 15 * 60 * 1000);

  // ---------- Audit jurnali ----------
  const auditRing = [];
  try {
    if (fs.statSync(cfg.auditFile).size > 1_000_000) fs.renameSync(cfg.auditFile, cfg.auditFile + ".old");
  } catch {}
  try {
    for (const line of fs.readFileSync(cfg.auditFile, "utf8").trim().split("\n").slice(-200)) {
      try { auditRing.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  function audit(e) {
    const rec = { t: new Date().toISOString(), ...e };
    auditRing.push(rec);
    if (auditRing.length > 200) auditRing.shift();
    fs.appendFile(cfg.auditFile, JSON.stringify(rec) + "\n", () => {});
  }

  // ---------- Holat ----------
  let agent = null;
  let lastStats = null;
  let lastTotpCounter = 0;
  const history = [];
  const pending = new Map(); // id -> { resolve, timer }
  const panels = new Set();
  let offlineTimer = null;
  let offlineAlertSent = false;

  const sendWs = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
  const broadcast = (obj) => panels.forEach((p) => sendWs(p, obj));

  function clientIp(req) {
    if (cfg.trustProxy) {
      const h = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (h) return h;
    }
    return req.socket.remoteAddress || "?";
  }

  // ---------- Telefonga buyruq yuborish ----------
  function runOnAgent(msg, timeoutMs = cfg.cmdTimeout) {
    return new Promise((resolve) => {
      if (!agent || agent.readyState !== 1) {
        return resolve({ status: 503, body: { ok: false, error: "Telefon ulanmagan" } });
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ status: 504, body: { ok: false, error: "Telefon javob bermadi (vaqt tugadi)" } });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      agent.send(JSON.stringify({ type: "cmd", id, ...msg }));
    });
  }

  // Repo manzilidagi login:token va fayl ma'lumotini (base64) jurnalga to'liq yozib qo'ymaymiz
  const redact = (m) => {
    const out = { ...m };
    if (typeof out.repo === "string") out.repo = out.repo.replace(/\/\/[^/@]*@/, "//***@");
    if (typeof out.data === "string" && out.data.length > 80) out.data = `<${out.data.length} belgi, yashirilgan>`;
    return out;
  };

  async function command(req, msg, timeoutMs) {
    const ip = clientIp(req);
    audit({ ev: "cmd", ip, ...redact(msg) });
    const r = await runOnAgent(msg, timeoutMs);
    audit({ ev: "result", action: msg.action, target: msg.target, op: msg.op, status: r.status, ok: !!r.body.ok });
    return r;
  }

  // ---------- Uzoq ishlar (git clone, npm install) ----------
  // HTTP so'rovi 30-100 soniyadan keyin uziladi (Cloudflare ham), shuning uchun
  // bunday amallar fonda bajariladi va panel natijani /api/jobs/:id orqali so'raydi.
  const jobs = new Map();
  function startJob(req, msg) {
    const key = `${msg.action}:${msg.op}:${msg.target}`;
    for (const j of jobs.values()) if (j.key === key && j.status === "running") return j; // ikki marta boshlanmasin
    const now = Date.now();
    for (const [id, j] of jobs) if (now - j.startedAt > 3600_000 || jobs.size > 50) jobs.delete(id);
    const job = { id: crypto.randomUUID(), key, status: "running", ok: false, out: "", startedAt: now };
    jobs.set(job.id, job);
    command(req, msg, cfg.deployTimeout).then((r) => {
      job.ok = !!r.body.ok;
      job.out = String(r.body.out ?? r.body.error ?? "");
      job.status = "done";
    });
    return job;
  }

  // ---------- HTTP yordamchilari ----------
  function json(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    });
    res.end(body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > 4096) { reject(Object.assign(new Error("Juda katta so'rov"), { status: 413 })); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(Object.assign(new Error("JSON noto'g'ri"), { status: 400 })); }
      });
      req.on("error", reject);
    });
  }

  // readJson 4 KB bilan cheklangan (oddiy buyruqlar uchun yetarli); fayl yuklash
  // (base64) buncha katta bo'lishi mumkin, shuning uchun alohida, kattaroq chegara.
  function readJsonBig(req, maxBytes) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { reject(Object.assign(new Error("Fayl juda katta"), { status: 413 })); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(Object.assign(new Error("JSON noto'g'ri"), { status: 400 })); }
      });
      req.on("error", reject);
    });
  }

  function claimsOf(req) {
    const h = req.headers.authorization || "";
    return h.startsWith("Bearer ") ? verifyJwt(h.slice(7), cfg.jwtSecret) : null;
  }

  function serveStatic(req, res, pathname) {
    const entry = req.method === "GET" || req.method === "HEAD" ? STATIC[pathname] : null;
    if (!entry) return json(res, 404, { error: "Topilmadi" });
    fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, data) => {
      if (err) return json(res, 404, { error: "Topilmadi" });
      const host = String(req.headers.host || "");
      const ws = /^[a-z0-9.\-:\[\]]+$/i.test(host) ? ` ws://${host} wss://${host}` : "";
      res.writeHead(200, {
        "Content-Type": entry[1],
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${ws}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  }

  // ---------- REST API ----------
  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;

    if (p === "/api/health" && m === "GET") {
      return json(res, 200, { ok: true, agent: !!agent, totp: !!cfg.totpSecret, uptimeSec: Math.floor(process.uptime()) });
    }

    if (p === "/api/login" && m === "POST") {
      const ip = clientIp(req);
      if (!limiter.allowed(ip)) {
        return json(res, 429, { error: "Juda ko'p urinish. Keyinroq qayta urining." }, { "Retry-After": String(limiter.retryAfterSec(ip)) });
      }
      const body = await readJson(req);
      const pwOk = safeEq(body.password ?? "", cfg.password);
      let counter = null;
      if (cfg.totpSecret) {
        counter = matchTotp(cfg.totpSecret, body.code);
        if (counter !== null && counter <= lastTotpCounter) counter = null; // kodni qayta ishlatib bo'lmaydi
      }
      if (!pwOk || (cfg.totpSecret && counter === null)) {
        limiter.fail(ip);
        audit({ ev: "login_fail", ip });
        return json(res, 401, { error: cfg.totpSecret ? "Parol yoki 2FA kodi noto'g'ri" : "Parol noto'g'ri" });
      }
      if (counter !== null) lastTotpCounter = counter;
      limiter.reset(ip);
      audit({ ev: "login_ok", ip });
      return json(res, 200, { token: signJwt({ sub: "admin" }, cfg.jwtSecret, cfg.sessionSec), expiresIn: cfg.sessionSec });
    }

    if (!claimsOf(req)) return json(res, 401, { error: "Avtorizatsiya kerak" });

    if (p === "/api/status" && m === "GET") {
      return json(res, 200, { agent: !!agent, stats: lastStats });
    }
    if (p === "/api/history" && m === "GET") {
      return json(res, 200, { samples: history });
    }
    if (p === "/api/audit" && m === "GET") {
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "30", 10) || 30));
      return json(res, 200, { entries: auditRing.slice(-limit).reverse() });
    }
    if (p === "/api/services" && m === "GET") {
      const s = lastStats?.services || {};
      return json(res, 200, { agent: !!agent, services: Object.entries(s).map(([name, running]) => ({ name, running })) });
    }
    if (p === "/api/pm2" && m === "GET") {
      const r = await command(req, { action: "pm2list" });
      if (!r.body.ok) return json(res, r.status, r.body);
      let apps = [];
      try { apps = JSON.parse(r.body.out); } catch {}
      return json(res, 200, { ok: true, apps });
    }

    let mm;
    if ((mm = p.match(/^\/api\/services\/([^/]+)\/([^/]+)$/)) && m === "POST") {
      const [name, op] = [decodeURIComponent(mm[1]), decodeURIComponent(mm[2])];
      if (!NAME.test(name) || !OPS.has(op)) return json(res, 400, { error: "Noto'g'ri servis yoki amal" });
      const r = await command(req, { action: "service", op, target: name });
      return json(res, r.status, r.body);
    }
    if ((mm = p.match(/^\/api\/pm2\/([^/]+)\/([^/]+)$/)) && m === "POST") {
      const [name, op] = [decodeURIComponent(mm[1]), decodeURIComponent(mm[2])];
      if (!NAME.test(name) || !OPS.has(op)) return json(res, 400, { error: "Noto'g'ri nom yoki amal" });
      const r = await command(req, { action: "service", op, target: `pm2:${name}` });
      return json(res, r.status, r.body);
    }
    if ((mm = p.match(/^\/api\/logs\/([^/]+)$/)) && m === "GET") {
      const name = decodeURIComponent(mm[1]);
      if (!TARGET.test(name)) return json(res, 400, { error: "Noto'g'ri log nomi" });
      const lines = Math.min(500, Math.max(10, parseInt(url.searchParams.get("lines") || "100", 10) || 100));
      const r = await command(req, { action: "logs", target: name, lines });
      return json(res, r.status, r.body);
    }
    if (p === "/api/device/reboot" && m === "POST") {
      const r = await command(req, { action: "device", op: "reboot" });
      return json(res, r.status, r.body);
    }

    // ---------- Tarmoq: Wi-Fi / Bluetooth / mobil internet ----------
    if (p === "/api/network" && m === "GET") {
      const r = await command(req, { action: "network", op: "status" });
      if (!r.body.ok) return json(res, r.status, r.body);
      let data = {};
      try { data = JSON.parse(r.body.out); } catch {}
      return json(res, 200, { ok: true, ...data });
    }
    if ((mm = p.match(/^\/api\/network\/([^/]+)$/)) && m === "POST") {
      const op = decodeURIComponent(mm[1]);
      if (!NET_OPS.has(op)) return json(res, 400, { error: "Noto'g'ri amal" });
      const r = await command(req, { action: "network", op });
      return json(res, r.status, r.body);
    }

    // ---------- Ekran yorqinligi ----------
    if (p === "/api/brightness" && m === "GET") {
      const r = await command(req, { action: "brightness", op: "get" });
      if (!r.body.ok) return json(res, r.status, r.body);
      let value = -1;
      try { value = JSON.parse(r.body.out).value; } catch {}
      return json(res, 200, { ok: true, value });
    }
    if (p === "/api/brightness" && m === "POST") {
      const body = await readJson(req);
      const value = parseInt(body.value, 10);
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        return json(res, 400, { error: "Qiymat 0 dan 255 gacha bo'lishi kerak" });
      }
      const r = await command(req, { action: "brightness", op: "set", value });
      return json(res, r.status, r.body);
    }

    // ---------- Chaqmoq ----------
    if ((mm = p.match(/^\/api\/flashlight\/(on|off)$/)) && m === "POST") {
      const r = await command(req, { action: "flashlight", op: mm[1] });
      return json(res, r.status, r.body);
    }

    // ---------- Telefonni topish (ovoz) ----------
    if (p === "/api/find/ring" && m === "POST") {
      const r = await command(req, { action: "find", op: "ring" });
      return json(res, r.status, r.body);
    }
    if (p === "/api/find/stop" && m === "POST") {
      const r = await command(req, { action: "find", op: "stop" });
      return json(res, r.status, r.body);
    }

    // ---------- Yangi loyihani git orqali yuklab, ishga tushirish ----------
    // Erkin shell buyrug'i yo'q: faqat clone -> install -> package.json dagi
    // tayyor skriptlar ro'yxatidan tanlab ishga tushirish (masalan "dev", "start").
    if (p === "/api/deploy/clone" && m === "POST") {
      const body = await readJson(req);
      const dir = String(body.dir || "");
      const repo = String(body.repo || "");
      if (!NAME.test(dir)) return json(res, 400, { error: "Noto'g'ri papka nomi" });
      if (!REPO_URL.test(repo)) return json(res, 400, { error: "Noto'g'ri repo manzili (https://... bilan boshlanishi kerak)" });
      if (!agent) return json(res, 503, { ok: false, error: "Telefon ulanmagan" });
      return json(res, 202, { jobId: startJob(req, { action: "deploy", op: "clone", target: dir, repo }).id });
    }
    if ((mm = p.match(/^\/api\/jobs\/([^/]+)$/)) && m === "GET") {
      const j = jobs.get(decodeURIComponent(mm[1]));
      if (!j) return json(res, 404, { error: "Ish topilmadi (vaqti o'tgan bo'lishi mumkin)" });
      return json(res, 200, { id: j.id, status: j.status, ok: j.ok, out: j.out });
    }
    if ((mm = p.match(/^\/api\/deploy\/([^/]+)\/install$/)) && m === "POST") {
      const dir = decodeURIComponent(mm[1]);
      if (!NAME.test(dir)) return json(res, 400, { error: "Noto'g'ri papka nomi" });
      if (!agent) return json(res, 503, { ok: false, error: "Telefon ulanmagan" });
      return json(res, 202, { jobId: startJob(req, { action: "deploy", op: "install", target: dir }).id });
    }
    if ((mm = p.match(/^\/api\/deploy\/([^/]+)\/scripts$/)) && m === "GET") {
      const dir = decodeURIComponent(mm[1]);
      if (!NAME.test(dir)) return json(res, 400, { error: "Noto'g'ri papka nomi" });
      const r = await command(req, { action: "deploy", op: "scripts", target: dir });
      if (!r.body.ok) return json(res, r.status, r.body);
      let scripts = {};
      try { scripts = JSON.parse(r.body.out); } catch {}
      return json(res, 200, { ok: true, scripts });
    }
    if ((mm = p.match(/^\/api\/deploy\/([^/]+)\/run$/)) && m === "POST") {
      const dir = decodeURIComponent(mm[1]);
      if (!NAME.test(dir)) return json(res, 400, { error: "Noto'g'ri papka nomi" });
      const body = await readJson(req);
      const script = String(body.script || "");
      if (!SCRIPT_NAME.test(script)) return json(res, 400, { error: "Noto'g'ri skript nomi" });
      const r = await command(req, { action: "deploy", op: "run", target: dir, script });
      return json(res, r.status, r.body);
    }
    if ((mm = p.match(/^\/api\/deploy\/([^/]+)$/)) && m === "DELETE") {
      const dir = decodeURIComponent(mm[1]);
      if (!NAME.test(dir)) return json(res, 400, { error: "Noto'g'ri papka nomi" });
      const r = await command(req, { action: "deploy", op: "remove", target: dir });
      return json(res, r.status, r.body);
    }

    // ---------- Fayl menejeri (Termux foydalanuvchisi papkalari bilan cheklangan) ----------
    if (p === "/api/files" && m === "GET") {
      const path = validPath(url.searchParams.get("path"));
      if (path == null) return json(res, 400, { error: "Noto'g'ri yo'l" });
      const r = await command(req, { action: "file", op: "list", target: path });
      if (!r.body.ok) return json(res, r.status, r.body);
      let entries = [];
      try { entries = JSON.parse(r.body.out); } catch {}
      return json(res, 200, { ok: true, path, entries });
    }
    if (p === "/api/files/mkdir" && m === "POST") {
      const body = await readJson(req);
      const path = validPath(body.path);
      if (path == null || path === ".") return json(res, 400, { error: "Noto'g'ri papka nomi" });
      const r = await command(req, { action: "file", op: "mkdir", target: path });
      return json(res, r.status, r.body);
    }
    if (p === "/api/files" && m === "DELETE") {
      const path = validPath(url.searchParams.get("path"));
      if (path == null || path === ".") return json(res, 400, { error: "Noto'g'ri yo'l" });
      const r = await command(req, { action: "file", op: "delete", target: path });
      return json(res, r.status, r.body);
    }
    // O'qish/yozish/zip-yoyish uzoq cho'zilishi mumkin (katta fayl, sekin tarmoq) —
    // shuning uchun fon ishi (jobs) orqali, boshqa deploy amallari kabi.
    if (p === "/api/files/read" && m === "POST") {
      const body = await readJson(req);
      const path = validPath(body.path);
      if (path == null || path === ".") return json(res, 400, { error: "Noto'g'ri yo'l" });
      if (!agent) return json(res, 503, { ok: false, error: "Telefon ulanmagan" });
      return json(res, 202, { jobId: startJob(req, { action: "file", op: "read", target: path }).id });
    }
    if (p === "/api/files/write" && m === "POST") {
      let body;
      try { body = await readJsonBig(req, Math.ceil(MAX_FILE_BYTES * 1.4)); }
      catch (e) { return json(res, e.status || 400, { error: e.message }); }
      const path = validPath(body.path);
      const data = String(body.data || "");
      if (path == null || path === ".") return json(res, 400, { error: "Noto'g'ri yo'l" });
      if (!data) return json(res, 400, { error: "Fayl ma'lumoti bo'sh" });
      if (!agent) return json(res, 503, { ok: false, error: "Telefon ulanmagan" });
      return json(res, 202, { jobId: startJob(req, { action: "file", op: "write", target: path, data }).id });
    }
    if (p === "/api/files/unzip" && m === "POST") {
      const body = await readJson(req);
      const path = validPath(body.path);
      const dest = validPath(body.dest);
      if (path == null || path === "." || dest == null) return json(res, 400, { error: "Noto'g'ri yo'l" });
      if (!agent) return json(res, 503, { ok: false, error: "Telefon ulanmagan" });
      return json(res, 202, { jobId: startJob(req, { action: "file", op: "unzip", target: path, dest }).id });
    }

    return json(res, 404, { error: "Topilmadi" });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else serveStatic(req, res, url.pathname);
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "Server xatosi" });
      if (!e.status) console.error(e);
    }
  });

  // ---------- WebSocket ----------
  // 24 MB: fayl menejeridagi "o'qish/yuklab olish" natijasi (base64, ~15 MB fayl uchun) shu orqali keladi.
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
  const panelWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on("upgrade", (req, socket, head) => {
    const pathname = (req.url || "").split("?")[0];
    if (pathname === "/agent") {
      const t = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!safeEq(t, cfg.agentToken)) {
        audit({ ev: "agent_rejected", ip: clientIp(req) });
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
    } else if (pathname === "/panel") {
      panelWss.handleUpgrade(req, socket, head, (ws) => panelWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  agentWss.on("connection", (ws) => {
    if (agent) agent.close(4000, "replaced");
    agent = ws;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    audit({ ev: "agent_up" });

    clearTimeout(offlineTimer);
    if (offlineAlertSent) {
      offlineAlertSent = false;
      alerts.send("agent-online", "✅ Telefon yana ulandi", { force: true });
    }
    broadcast({ type: "agent", online: true });

    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "stats" && m.data && typeof m.data === "object") {
        // Telegram token/chat ID ilovadan kelgan bo'lsa: Alerts'ni yangilaymiz, lekin
        // bu ikkalasini lastStats'ga SAQLAMAYMIZ va panelga YUBORMAYMIZ (maxfiy ma'lumot).
        const { telegramBotToken, telegramChatId, ...publicData } = m.data;
        if (typeof telegramBotToken === "string" && telegramBotToken.trim()) alerts.token = telegramBotToken.trim();
        if (typeof telegramChatId === "string" && telegramChatId.trim()) alerts.chatId = telegramChatId.trim();

        const prev = lastStats;
        lastStats = { ...publicData, at: Date.now() };
        const ramPct = lastStats.ramTotalMb > 0 ? (1 - lastStats.ramAvailMb / lastStats.ramTotalMb) * 100 : null;
        history.push({ t: lastStats.at, ram: ramPct, temp: lastStats.tempC, bat: lastStats.battery, load: lastStats.load });
        if (history.length > HISTORY_MAX) history.shift();
        broadcast({ type: "stats", data: lastStats });
        if (alerts.enabled) for (const a of evaluate(lastStats, prev, cfg.thresholds)) alerts.send(a.key, a.text);
      } else if (m.type === "result" && typeof m.id === "string") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ status: 200, body: { ok: !!m.ok, out: String(m.out ?? "") } });
      }
    });

    ws.on("close", () => {
      if (agent !== ws) return;
      agent = null;
      lastStats = null;
      audit({ ev: "agent_down" });
      broadcast({ type: "agent", online: false });
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ status: 503, body: { ok: false, error: "Telefon aloqasi uzildi" } });
        pending.delete(id);
      }
      if (alerts.enabled) {
        clearTimeout(offlineTimer);
        offlineTimer = setTimeout(() => {
          offlineAlertSent = true;
          alerts.send("agent-offline", `🔌 Telefon ${cfg.offlineSec} soniyadan beri aloqada emas`, { force: true });
        }, cfg.offlineSec * 1000);
        offlineTimer.unref?.();
      }
    });
  });

  panelWss.on("connection", (ws) => {
    let authed = false;
    const timer = setTimeout(() => !authed && ws.close(4001, "auth"), 5000);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => {
      if (authed) return;
      let m;
      try { m = JSON.parse(raw); } catch { return ws.close(4001, "auth"); }
      if (!verifyJwt(m.token, cfg.jwtSecret)) return ws.close(4001, "auth");
      authed = true;
      clearTimeout(timer);
      panels.add(ws);
      sendWs(ws, { type: "agent", online: !!agent });
      if (lastStats) sendWs(ws, { type: "stats", data: lastStats });
    });
    ws.on("close", () => { clearTimeout(timer); panels.delete(ws); });
  });

  // Uzilib qolgan ulanishlarni aniqlash
  const heartbeat = setInterval(() => {
    for (const set of [agentWss.clients, panelWss.clients]) {
      for (const ws of set) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }, 20000);
  heartbeat.unref?.();

  return {
    server,
    cfg,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        clearTimeout(offlineTimer);
        for (const p of pending.values()) clearTimeout(p.timer);
        for (const ws of [...agentWss.clients, ...panelWss.clients]) ws.terminate();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

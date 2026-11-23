"use strict";

const $ = (s, r = document) => r.querySelector(s);
const NS = "http://www.w3.org/2000/svg";

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

const S = {
  token: sessionStorage.getItem("pa_token"),
  ws: null,
  retry: 1000,
  stats: null,
  agent: false,
  hist: { ram: [], load: [], temp: [] },
  svcSig: "",
  logSig: "",
  busy: new Set(),
};
const HIST_MAX = 360;

// ---------- Yordamchilar ----------
function toast(text, bad = false) {
  const t = el("div", { class: "toast" + (bad ? " bad" : "") }, text);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

function confirmDialog(text, okLabel) {
  const d = $("#confirm");
  $("#confirmText").textContent = text;
  $("#confirmOk").textContent = okLabel;
  return new Promise((res) => {
    d.returnValue = "";
    d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true });
    d.showModal();
  });
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (S.token) headers.Authorization = "Bearer " + S.token;
  let r;
  try {
    r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    return { ok: false, status: 0, data: { error: "Serverga ulanib bo'lmadi" } };
  }
  if (r.status === 401 && path !== "/api/login") {
    logout();
    return { ok: false, status: 401, data: { error: "Sessiya tugadi, qayta kiring" } };
  }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok && !data.error) data.error = "Xato (" + r.status + ")";
  return { ok: r.ok, status: r.status, data };
}

const fmtUp = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} kun ${h} soat` : h ? `${h} soat ${m} daq` : `${m} daq`;
};
const gb = (mb) => (mb / 1024).toFixed(1);

function spark(svg, data) {
  svg.replaceChildren();
  const pts = data.filter((v) => typeof v === "number" && isFinite(v));
  if (pts.length < 2) return;
  let lo = Math.min(...pts), hi = Math.max(...pts);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.15;
  lo -= pad; hi += pad;
  const W = 160, H = 40;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - ((v - lo) / (hi - lo)) * H]);
  const line = xy.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1)).join(" ");
  const mk = (cls, d) => { const p = document.createElementNS(NS, "path"); if (cls) p.setAttribute("class", cls); p.setAttribute("d", d); return p; };
  svg.append(mk("area", `${line} L${W} ${H} L0 ${H} Z`), mk("", line));
}

function pushHist(sample) {
  for (const k of ["ram", "load", "temp"]) {
    if (typeof sample[k] === "number") S.hist[k].push(sample[k]);
    if (S.hist[k].length > HIST_MAX) S.hist[k].shift();
  }
}

// ---------- Ko'rsatish ----------
function setAgent(on) {
  S.agent = on;
  const c = $("#conn");
  c.textContent = on ? "Telefon ulangan" : "Telefon ulanmagan";
  c.className = "pill " + (on ? "on" : "off");
  $("#offline").hidden = on;
  $("#dash").classList.toggle("dim", !on);
  document.querySelectorAll("#dash button").forEach((b) => { if (b.id !== "auditRefresh") b.disabled = !on || S.busy.has(b.dataset.key); });
  document.querySelectorAll("#dash input, #dash select").forEach((i) => { i.disabled = !on; });
  if (!on) {
    S.stats = null;
    $("#deployScripts").hidden = true;
    $("#deployScripts").replaceChildren();
    deployStatus("");
  }
}

function renderStats(s) {
  S.stats = s;
  const used = s.ramTotalMb - s.ramAvailMb;
  const pct = s.ramTotalMb > 0 ? (used / s.ramTotalMb) * 100 : 0;

  // Telefon
  const bat = Math.max(0, Math.min(100, Number(s.battery) || 0));
  const h = (344 * bat) / 100;
  $("#batFill").setAttribute("y", String(392 - h));
  $("#batFill").setAttribute("height", String(h));
  $("#phBat").textContent = bat + "%";
  $("#phBatLabel").textContent = s.charging ? "zaryadlanmoqda" : "batareya";
  $("#phTemp").textContent = Number(s.tempC).toFixed(1) + " °C";
  $("#phUp").textContent = fmtUp(s.uptimeSec || 0);
  const ph = $("#phone");
  ph.classList.toggle("low", bat <= 20 && !s.charging);
  ph.classList.toggle("warm", s.tempC >= 40 && s.tempC < 45);
  ph.classList.toggle("hot", s.tempC >= 45);
  $("#deviceName").textContent = [s.device, s.android ? "Android " + s.android : ""].filter(Boolean).join(", ") || "\u00a0";

  // Plitkalar
  $("#ramVal").textContent = `${gb(used)} / ${gb(s.ramTotalMb)} GB`;
  $("#ramPct").textContent = pct.toFixed(0) + "% band";
  $("#loadVal").textContent = Number(s.load).toFixed(2);
  $("#tempVal").textContent = Number(s.tempC).toFixed(1) + " °C";
  const usedDisk = s.diskTotalGb - s.diskFreeGb;
  const dp = s.diskTotalGb > 0 ? (usedDisk / s.diskTotalGb) * 100 : 0;
  $("#diskVal").textContent = `${usedDisk.toFixed(0)} / ${s.diskTotalGb.toFixed(0)} GB`;
  $("#diskBar").style.width = dp.toFixed(1) + "%";
  $("#diskBar").classList.toggle("full", dp > 90);
  $("#diskFree").textContent = s.diskFreeGb.toFixed(1) + " GB bo'sh";
  spark($("#ramSpark"), S.hist.ram);
  spark($("#loadSpark"), S.hist.load);
  spark($("#tempSpark"), S.hist.temp);

  renderServices(s.services || {});
  renderLogSources(s.logs || []);
}

const OP_LABEL = { start: "Ishga tushirish", stop: "To'xtatish", restart: "Qayta yoqish" };
const OP_DONE = { start: "ishga tushirildi", stop: "to'xtatildi", restart: "qayta ishga tushirildi" };

function opButtons(kind, name) {
  return el("div", { class: "acts" },
    ["start", "stop", "restart"].map((op) => {
      const key = `${kind}:${name}:${op}`;
      return el("button", {
        class: op === "stop" ? "danger" : "", "data-key": key, disabled: !S.agent || S.busy.has(key),
        onclick: (ev) => serviceAction(kind, name, op, ev.currentTarget),
      }, OP_LABEL[op]);
    }));
}

function renderServices(map) {
  const names = Object.keys(map);
  const sig = JSON.stringify(map);
  if (sig === S.svcSig) return;
  S.svcSig = sig;
  const list = $("#svcs");
  list.replaceChildren();
  if (!names.length) return list.append(el("li", { class: "empty" }, "Servislar ro'yxati bo'sh."));
  for (const n of names) {
    list.append(el("li", {},
      el("span", { class: "name" }, n),
      el("span", { class: "meta" }, el("span", { class: "dot" + (map[n] ? " up" : "") }), map[n] ? "Ishlayapti" : "To'xtagan"),
      opButtons("svc", n)));
  }
}

function renderPm2(apps) {
  const list = $("#pm2");
  list.replaceChildren();
  if (!apps.length) return list.append(el("li", { class: "empty" }, "pm2 ilovalari topilmadi."));
  for (const a of apps) {
    list.append(el("li", {},
      el("span", { class: "name" }, a.name),
      el("span", { class: "meta" }, el("span", { class: "dot" + (a.status === "online" ? " up" : "") }), a.status),
      el("span", { class: "meta" }, `${(a.mem / 1048576).toFixed(0)} MB`),
      el("span", { class: "meta" }, `qayta yoqilgan: ${a.restarts}`),
      opButtons("pm2", a.name)));
  }
  renderLogSources(S.stats?.logs || [], apps.map((a) => "pm2:" + a.name));
}

function renderLogSources(base, extra = []) {
  const prev = S.logExtra || [];
  if (extra.length) S.logExtra = extra;
  const all = [...base, ...(extra.length ? extra : prev)];
  const sig = all.join("|");
  if (sig === S.logSig) return;
  S.logSig = sig;
  const sel = $("#logSel");
  const keep = sel.value;
  sel.replaceChildren(...all.map((n) => el("option", { value: n }, n.startsWith("pm2:") ? "pm2: " + n.slice(4) : n)));
  if (all.includes(keep)) sel.value = keep;
}

// ---------- Amallar ----------
async function serviceAction(kind, name, op, btn) {
  const key = `${kind}:${name}:${op}`;
  const label = kind === "pm2" ? `pm2 "${name}"` : name;
  if (op !== "start") {
    const ok = await confirmDialog(`${label}: ${op === "stop" ? "to'xtatilsinmi" : "qayta ishga tushirilsinmi"}?`, OP_LABEL[op]);
    if (!ok) return;
  }
  S.busy.add(key);
  btn.disabled = true;
  btn.textContent = "Bajarilmoqda…";
  const path = kind === "pm2" ? `/api/pm2/${encodeURIComponent(name)}/${op}` : `/api/services/${encodeURIComponent(name)}/${op}`;
  const r = await api(path, { method: "POST" });
  S.busy.delete(key);
  btn.textContent = OP_LABEL[op];
  btn.disabled = !S.agent;
  if (r.ok && r.data.ok) toast(`${label} ${OP_DONE[op]}`);
  else toast(`${label}: ${r.data.error || r.data.out || "xato"}`, true);
  setTimeout(refreshStatus, 1500);
  if (kind === "pm2") setTimeout(loadPm2, 1200);
  loadAudit();
}

async function refreshStatus() {
  const r = await api("/api/status");
  if (r.ok && r.data.stats) renderStats(r.data.stats);
}

async function loadPm2() {
  if (!S.agent) return;
  const r = await api("/api/pm2");
  if (r.ok) renderPm2(r.data.apps || []);
  else {
    const list = $("#pm2");
    list.replaceChildren(el("li", { class: "empty" }, r.data.error || r.data.out || "pm2 ma'lumotini olib bo'lmadi"));
  }
}

async function loadLogs() {
  const name = $("#logSel").value;
  if (!name) return toast("Log manbai tanlanmagan", true);
  const out = $("#logOut");
  out.textContent = "Yuklanmoqda…";
  const r = await api(`/api/logs/${encodeURIComponent(name)}?lines=${$("#logLines").value}`);
  if (r.ok && r.data.ok) { out.textContent = r.data.out || "(bo'sh)"; out.scrollTop = out.scrollHeight; }
  else out.textContent = "Xato: " + (r.data.error || r.data.out || "noma'lum");
}

const AUDIT_TEXT = {
  login_ok: () => "Panelga kirildi",
  login_fail: () => "Kirish urinishi muvaffaqiyatsiz",
  agent_up: () => "Telefon ulandi",
  agent_down: () => "Telefon aloqasi uzildi",
  agent_rejected: () => "Agent noto'g'ri token bilan urindi",
  cmd: (e) => ["Buyruq:", e.action, e.target, e.op].filter(Boolean).join(" "),
  result: (e) => `Natija: ${e.ok ? "muvaffaqiyatli" : "xato"} (${[e.action, e.target].filter(Boolean).join(" ")})`,
};

async function loadAudit() {
  const r = await api("/api/audit?limit=15");
  const list = $("#audit");
  list.replaceChildren();
  const items = r.ok ? r.data.entries : [];
  if (!items.length) return list.append(el("li", { class: "empty" }, "Hozircha yozuv yo'q."));
  for (const e of items) {
    const when = new Date(e.t).toLocaleString("uz-UZ", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit" });
    list.append(el("li", {}, el("span", { class: "meta" }, when), el("span", { class: "grow" }, (AUDIT_TEXT[e.ev] || (() => e.ev))(e))));
  }
}

// ---------- Ulanish ----------
function connect() {
  if (!S.token) return;
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/panel");
  S.ws = ws;
  ws.onopen = () => { S.retry = 1000; ws.send(JSON.stringify({ token: S.token })); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "agent") {
      const was = S.agent;
      setAgent(m.online);
      if (m.online && !was) { setTimeout(loadPm2, 800); setTimeout(loadNetwork, 800); setTimeout(loadBrightness, 800); }
    } else if (m.type === "stats") {
      pushHist({ ram: m.data.ramTotalMb > 0 ? (1 - m.data.ramAvailMb / m.data.ramTotalMb) * 100 : null, load: m.data.load, temp: m.data.tempC });
      if (!S.agent) setAgent(true);
      renderStats(m.data);
    }
  };
  ws.onclose = (ev) => {
    if (S.ws !== ws) return;
    if (ev.code === 4001) return logout();
    setAgent(false);
    if (S.token) setTimeout(connect, (S.retry = Math.min(S.retry * 2, 15000)));
  };
}

function show(which) {
  $("#login").hidden = which !== "login";
  $("#app").hidden = which !== "app";
}

function logout() {
  sessionStorage.removeItem("pa_token");
  S.token = null;
  const ws = S.ws; S.ws = null;
  if (ws) try { ws.close(); } catch {}
  S.svcSig = ""; S.logSig = "";
  show("login");
  initLogin();
}

async function start() {
  show("app");
  setAgent(false);
  const h = await api("/api/history");
  if (h.ok) for (const x of h.data.samples || []) pushHist(x);
  const st = await api("/api/status");
  if (st.ok && st.data.agent) {
    setAgent(true);
    if (st.data.stats) renderStats(st.data.stats);
    loadPm2();
    loadNetwork();
    loadBrightness();
  }
  connect();
  loadAudit();
}

// ---------- Tarmoq: Wi-Fi / Bluetooth / mobil internet ----------
function setSwitch(input, stateEl, on) {
  input.checked = !!on;
  stateEl.textContent = on ? "yoqilgan" : "o'chirilgan";
}

async function loadNetwork() {
  if (!S.agent) return;
  const r = await api("/api/network");
  if (!r.ok) return;
  setSwitch($("#netWifi"), $("#netWifiState"), r.data.wifi);
  setSwitch($("#netBt"), $("#netBtState"), r.data.bluetooth);
  setSwitch($("#netData"), $("#netDataState"), r.data.mobileData);
}

async function toggleNetwork(input, stateEl, onKey, offKey, warnOnOff) {
  const turningOn = input.checked;
  if (!turningOn && warnOnOff) {
    const ok = await confirmDialog(
      "Buni o'chirsangiz, agar telefon shu tarmoq orqali internetga ulangan bo'lsa, ulanish uzilib, panel javob bermay qolishi mumkin. Davom etilsinmi?",
      "Baribir o'chirish"
    );
    if (!ok) { input.checked = true; return; }
  }
  input.disabled = true;
  const r = await api(`/api/network/${turningOn ? onKey : offKey}`, { method: "POST" });
  input.disabled = false;
  if (r.ok && r.data.ok) { setSwitch(input, stateEl, turningOn); toast(r.data.out || "Bajarildi"); }
  else { input.checked = !turningOn; toast(r.data.error || r.data.out || "Xato", true); }
  loadAudit();
}

$("#netWifi").addEventListener("change", (e) => toggleNetwork(e.currentTarget, $("#netWifiState"), "wifi_on", "wifi_off", true));
$("#netBt").addEventListener("change", (e) => toggleNetwork(e.currentTarget, $("#netBtState"), "bt_on", "bt_off", false));
$("#netData").addEventListener("change", (e) => toggleNetwork(e.currentTarget, $("#netDataState"), "data_on", "data_off", true));

// ---------- Telefonni topish ----------
$("#findRing").addEventListener("click", async () => {
  const r = await api("/api/find/ring", { method: "POST" });
  if (r.ok && r.data.ok) toast("Telefon ovoz chalyapti");
  else toast(r.data.error || r.data.out || "Xato", true);
});
$("#findStop").addEventListener("click", async () => {
  const r = await api("/api/find/stop", { method: "POST" });
  if (r.ok && r.data.ok) toast("Ovoz to'xtatildi");
  else toast(r.data.error || r.data.out || "Xato", true);
});

// ---------- Ekran yorqinligi ----------
async function loadBrightness() {
  if (!S.agent) return;
  const r = await api("/api/brightness");
  if (r.ok && Number.isInteger(r.data.value) && r.data.value >= 0) {
    $("#brightRange").value = r.data.value;
    $("#brightVal").textContent = r.data.value;
  }
}
$("#brightRange").addEventListener("input", (e) => { $("#brightVal").textContent = e.currentTarget.value; });
$("#brightSet").addEventListener("click", async () => {
  const value = parseInt($("#brightRange").value, 10);
  const r = await api("/api/brightness", { method: "POST", body: { value } });
  if (r.ok && r.data.ok) toast("Yorqinlik o'rnatildi");
  else toast(r.data.error || r.data.out || "Xato", true);
});

// ---------- Yangi loyiha yuklash ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Uzoq davom etadigan amal (git clone, npm install): server ishni fonda bajaradi, biz natijani so'raymiz.
async function runJob(path, body, onTick) {
  const r = await api(path, { method: "POST", body });
  if (!r.ok) return r; // tekshiruv xatosi yoki 401/503
  const id = r.data.jobId;
  const t0 = Date.now();
  for (;;) {
    await sleep(2000);
    const j = await api("/api/jobs/" + encodeURIComponent(id));
    if (!j.ok) return j;
    if (j.data.status === "done") return { ok: true, status: 200, data: { ok: j.data.ok, out: j.data.out } };
    if (onTick) onTick(Math.round((Date.now() - t0) / 1000));
  }
}

// Git xatosini tushunarli maslahatga aylantiradi
function gitHint(out) {
  const t = String(out || "");
  if (/NOGIT|git: .*(not found|inaccessible)|git: command not found/i.test(t)) return "Termux'da git o'rnatilmagan. Termux'da bajaring: pkg install git";
  if (/could not read Username|Authentication failed|terminal prompts disabled|Repository not found|returned error: 40[134]/i.test(t))
    return "Repo private yoki manzil noto'g'ri. Private repo uchun manzilga token qo'shing: https://FOYDALANUVCHI:TOKEN@github.com/FOYDALANUVCHI/REPO.git";
  if (/Could not resolve host|unable to access|Failed to connect|Network is unreachable|SSL|certificate/i.test(t))
    return "Git internetga chiqa olmayapti. Termux'ning o'zida `git ls-remote <manzil>` ishlaydimi, tekshiring. Termux'da ishlab, bu yerda ishlamasa, root orqali o'tganda tarmoq ruxsati yo'q.";
  return "";
}

function deployStatus(text, bad = false) {
  const p = $("#deployStatus");
  p.textContent = text;
  p.classList.toggle("err", bad);
}

function renderDeployScripts(dir, scripts) {
  const list = $("#deployScripts");
  const names = Object.keys(scripts || {});
  list.hidden = false;
  list.replaceChildren();
  if (!names.length) return list.append(el("li", { class: "empty" }, "package.json ichida \"scripts\" topilmadi."));
  for (const name of names) {
    list.append(el("li", {},
      el("span", { class: "name" }, name),
      el("span", { class: "meta grow" }, scripts[name]),
      el("div", { class: "acts" },
        el("button", { class: "primary", onclick: (ev) => runDeployScript(dir, name, ev.currentTarget) }, "Ishga tushirish"))));
  }
  list.append(el("li", {},
    el("span", { class: "meta grow" }, `Papka: ${dir}`),
    el("div", { class: "acts" },
      el("button", { class: "danger", onclick: () => removeDeployProject(dir) }, "Papkani o'chirish"))));
}

async function removeDeployProject(dir) {
  const ok = await confirmDialog(`"${dir}" papkasi va unga tegishli pm2 jarayoni butunlay o'chirilsinmi?`, "O'chirish");
  if (!ok) return;
  const r = await api(`/api/deploy/${encodeURIComponent(dir)}`, { method: "DELETE" });
  if (r.ok && r.data.ok) { toast(`"${dir}" o'chirildi`); $("#deployScripts").hidden = true; $("#deployScripts").replaceChildren(); deployStatus(""); }
  else toast(r.data.error || r.data.out || "Xato", true);
  setTimeout(loadPm2, 1000);
  loadAudit();
}

async function runDeployScript(dir, script, btn) {
  btn.disabled = true;
  btn.textContent = "Ishga tushirilmoqda…";
  const r = await api(`/api/deploy/${encodeURIComponent(dir)}/run`, { method: "POST", body: { script } });
  btn.disabled = false;
  btn.textContent = "Ishga tushirish";
  if (r.ok && r.data.ok) toast(`"${dir}" (${script}) pm2 orqali ishga tushirildi`);
  else toast(r.data.error || r.data.out || "Xato", true);
  setTimeout(loadPm2, 1200);
  loadAudit();
}

$("#deployGo").addEventListener("click", async () => {
  const repo = $("#deployRepo").value.trim();
  const dir = $("#deployDir").value.trim();
  if (!repo || !dir) return deployStatus("Repo manzili va papka nomini kiriting.", true);
  const btn = $("#deployGo");
  btn.disabled = true;
  $("#deployScripts").hidden = true;

  deployStatus("Yuklab olinmoqda (git clone)…");
  let r = await runJob("/api/deploy/clone", { repo, dir }, (sec) => deployStatus(`Yuklab olinmoqda (git clone)… ${sec} s`));
  if (!r.ok || !r.data.ok) {
    const raw = r.data.error || r.data.out || "Yuklab olishda xato";
    deployStatus([gitHint(raw), raw].filter(Boolean).join("\n\n"), true);
    btn.disabled = false; return;
  }

  deployStatus("Bog'liqliklar o'rnatilmoqda (npm install)…");
  r = await runJob(`/api/deploy/${encodeURIComponent(dir)}/install`, undefined, (sec) => deployStatus(`Bog'liqliklar o'rnatilmoqda (npm install)… ${sec} s. Bu bir necha daqiqa cho'zilishi mumkin.`));
  if (!r.ok || !r.data.ok) { deployStatus(r.data.error || r.data.out || "npm install xato berdi", true); btn.disabled = false; return; }

  deployStatus("Skriptlar ro'yxati o'qilmoqda…");
  r = await api(`/api/deploy/${encodeURIComponent(dir)}/scripts`);
  btn.disabled = false;
  if (!r.ok || !r.data.ok) { deployStatus(r.data.error || r.data.out || "Skriptlarni o'qib bo'lmadi", true); return; }

  deployStatus(`Tayyor. "${dir}" uchun ishga tushirish skriptini tanlang:`);
  renderDeployScripts(dir, r.data.scripts);
  loadAudit();
});

async function initLogin() {
  const h = await api("/api/health");
  $("#codeRow").hidden = !(h.ok && h.data.totp);
  $("#pw").focus();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginBtn");
  btn.disabled = true;
  $("#loginErr").textContent = "";
  const r = await api("/api/login", { method: "POST", body: { password: $("#pw").value, code: $("#code").value } });
  btn.disabled = false;
  if (!r.ok) { $("#loginErr").textContent = r.data.error || "Xato"; return; }
  S.token = r.data.token;
  sessionStorage.setItem("pa_token", S.token);
  $("#pw").value = ""; $("#code").value = "";
  start();
});

$("#logout").addEventListener("click", logout);
$("#pm2refresh").addEventListener("click", loadPm2);
$("#logBtn").addEventListener("click", loadLogs);
$("#auditRefresh").addEventListener("click", loadAudit);
$("#reboot").addEventListener("click", async () => {
  if (!(await confirmDialog("Telefon qayta yoqilsinmi? Barcha servislar vaqtincha to'xtaydi.", "Qayta yoqish"))) return;
  const r = await api("/api/device/reboot", { method: "POST" });
  if (r.ok && r.data.ok) toast("Telefon qayta yoqilmoqda");
  else toast(r.data.error || r.data.out || "Xato", true);
  loadAudit();
});

if (S.token) start(); else { show("login"); initLogin(); }

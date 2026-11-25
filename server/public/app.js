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

const TABS = new Set(["home", "device", "services", "deploy", "files", "terminal", "logs"]);

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
  tab: "home",
  fmLoaded: false,
  serverVersion: "",
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
  if (!r.ok && !data.error) data.error = data.out || ("Xato (" + r.status + ")");
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

// ---------- Navigatsiya ----------
function setTab(tab, pushHash = true) {
  if (!TABS.has(tab)) tab = "home";
  S.tab = tab;
  $("#app").setAttribute("data-active-tab", tab);
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.dataset.tab !== tab;
  });
  if (pushHash && location.hash !== "#" + tab) {
    history.replaceState(null, "", "#" + tab);
  }
  if (tab === "files" && S.agent && !S.fmLoaded) fmLoad(fmPath);
  if (tab === "services" && S.agent) loadPm2();
  if (tab === "device" && S.agent) { loadBgApps(); loadChargeLimit(); }
  if (tab === "logs") loadAudit();
}

document.querySelectorAll(".nav-btn").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.nav));
});
window.addEventListener("hashchange", () => {
  const h = location.hash.slice(1);
  if (TABS.has(h)) setTab(h, false);
});

// ---------- Ko'rsatish ----------
function setAgent(on) {
  S.agent = on;
  const c = $("#conn");
  c.textContent = on ? "Telefon ulangan" : "Telefon ulanmagan";
  c.className = "pill " + (on ? "on" : "off");
  $("#offline").hidden = on;
  $("#dash").classList.toggle("dim", !on);
  document.querySelectorAll("#dash button").forEach((b) => { if (b.id !== "auditRefresh") b.disabled = !on || S.busy.has(b.dataset.key); });
  document.querySelectorAll("#dash input, #dash select, #dash textarea").forEach((i) => { i.disabled = !on; });
  if (!on) {
    S.stats = null;
    S.fmLoaded = false;
    $("#verWarn").hidden = true;
    $("#deployScripts").hidden = true;
    $("#deployScripts").replaceChildren();
    deployStatus("");
  } else if (S.tab === "files" && !S.fmLoaded) {
    fmLoad(fmPath);
  }
}

function checkVersion(agentVer) {
  const w = $("#verWarn");
  if (!S.serverVersion || !agentVer || agentVer === S.serverVersion) {
    w.hidden = true;
    return;
  }
  w.textContent = `Diqqat: Server (v${S.serverVersion}) va Phone Agent APK (v${agentVer}) versiyalari mos emas! GitHub Actions'dan mos APK'ni o'rnating.`;
  w.hidden = false;
}

function renderStats(s) {
  S.stats = s;
  checkVersion(s.agentVersion);
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
  $("#deviceName").textContent = [s.device, s.android ? "Android " + s.android : "", s.agentVersion ? "agent v" + s.agentVersion : ""].filter(Boolean).join(", ") || "\u00a0";

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

const OP_LABEL = { start: "Ishga tushirish", stop: "To'xtatish", restart: "Qayta yoqish", delete: "O'chirish" };
const OP_DONE = { start: "ishga tushirildi", stop: "to'xtatildi", restart: "qayta ishga tushirildi", delete: "o'chirildi" };

function opButtons(kind, name) {
  const ops = kind === "pm2" ? ["start", "stop", "restart"] : ["start", "stop", "restart"];
  const btns = ops.map((op) => {
    const key = `${kind}:${name}:${op}`;
    return el("button", {
      class: op === "stop" ? "danger" : "", "data-key": key, disabled: !S.agent || S.busy.has(key),
      onclick: (ev) => serviceAction(kind, name, op, ev.currentTarget),
    }, OP_LABEL[op]);
  });
  if (kind === "pm2") {
    btns.push(el("button", {
      class: "ghost", disabled: !S.agent,
      onclick: () => openPm2Logs(name),
    }, "Loglar"));
    const updKey = `pm2:${name}:update`;
    btns.push(el("button", {
      class: "ghost", "data-key": updKey, disabled: !S.agent || S.busy.has(updKey),
      onclick: (ev) => updatePm2App(name, ev.currentTarget),
    }, "Git Update"));
    const delKey = `pm2:${name}:delete`;
    btns.push(el("button", {
      class: "danger", "data-key": delKey, disabled: !S.agent || S.busy.has(delKey),
      onclick: (ev) => serviceAction("pm2", name, "delete", ev.currentTarget),
    }, "O'chirish"));
  }
  return el("div", { class: "acts" }, btns);
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

function openPm2Logs(name) {
  const target = "pm2:" + name;
  const sel = $("#logSel");
  if (![...sel.options].some((o) => o.value === target)) {
    sel.append(el("option", { value: target }, "pm2: " + name));
  }
  sel.value = target;
  setTab("logs");
  loadLogs();
}

function setPm2Status(text, bad = false) {
  const p = $("#pm2Status");
  p.textContent = text;
  p.hidden = !text;
  p.classList.toggle("err", bad);
}

async function updatePm2App(name, btn) {
  const ok = await confirmDialog(`"${name}" loyihasi git'dan yangilanib (git pull + npm install) qayta ishga tushirilsinmi?`, "Yangilash");
  if (!ok) return;
  const key = `pm2:${name}:update`;
  S.busy.add(key);
  btn.disabled = true;
  btn.textContent = "Yangilanmoqda…";
  setPm2Status(`"${name}" git'dan yangilanmoqda…`);
  const r = await runJob(`/api/pm2/${encodeURIComponent(name)}/update`, {}, (s) => {
    setPm2Status(`"${name}" yangilanmoqda… ${s} s`);
  });
  S.busy.delete(key);
  btn.textContent = "Git Update";
  btn.disabled = !S.agent;
  if (r.ok && r.data.ok) {
    setPm2Status("");
    toast(`"${name}" yangilandi va qayta ishga tushirildi`);
  } else {
    const msg = r.data.error || r.data.out || "Yangilashda xato";
    setPm2Status(msg, true);
    toast(`"${name}": yangilashda xato`, true);
  }
  setTimeout(loadPm2, 1200);
  loadAudit();
}

// ---------- Amallar ----------
async function serviceAction(kind, name, op, btn) {
  const key = `${kind}:${name}:${op}`;
  const label = kind === "pm2" ? `pm2 "${name}"` : name;
  if (op !== "start") {
    const q = op === "delete" ? "pm2 ro'yxatidan o'chirilsinmi" : op === "stop" ? "to'xtatilsinmi" : "qayta ishga tushirilsinmi";
    const ok = await confirmDialog(`${label}: ${q}?`, OP_LABEL[op]);
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
  if (r.ok && r.data.ok) {
    setPm2Status("");
    renderPm2(r.data.apps || []);
  } else {
    const list = $("#pm2");
    list.replaceChildren(el("li", { class: "empty" }, r.data.error || r.data.out || "pm2 ma'lumotini olib bo'lmadi"));
  }
}

let logTimer = null;
async function loadLogs(silent = false) {
  const name = $("#logSel").value;
  if (!name) return silent ? null : toast("Log manbai tanlanmagan", true);
  const out = $("#logOut");
  if (!silent) out.textContent = "Yuklanmoqda…";
  const r = await api(`/api/logs/${encodeURIComponent(name)}?lines=${$("#logLines").value}`);
  if (r.ok && r.data.ok) {
    const text = r.data.out || "(bo'sh)";
    if (out.textContent !== text) { out.textContent = text; out.scrollTop = out.scrollHeight; }
  } else if (!silent) {
    out.textContent = "Xato: " + (r.data.error || r.data.out || "noma'lum");
  }
}
$("#logLive").addEventListener("change", (e) => {
  clearInterval(logTimer); logTimer = null;
  if (e.currentTarget.checked) {
    loadLogs(true);
    logTimer = setInterval(() => { if (S.agent && S.tab === "logs") loadLogs(true); }, 2500);
  }
});

const AUDIT_TEXT = {
  login_ok: () => "Panelga kirildi",
  login_fail: () => "Kirish urinishi muvaffaqiyatsiz",
  agent_up: () => "Telefon ulandi",
  agent_down: () => "Telefon aloqasi uzildi",
  agent_rejected: () => "Agent noto'g'ri token bilan urindi",
  cmd: (e) => ["Buyruq:", e.action, e.target, e.op].filter(Boolean).join(" "),
  result: (e) => `Natija: ${e.ok ? "muvaffaqiyatli" : "xato"} (${[e.action, e.target].filter(Boolean).join(" ")})`,
  notif: (e) => `🔔 Bildirishnoma: ${[e.target, e.op].filter(Boolean).join(" — ")}`,
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
    } else if (m.type === "audio_up") {
      playPcmChunk(m.data);
    } else if (m.type === "audio_err") {
      toast(m.error || "Audio xatosi", true);
      stopPttListen();
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
  S.svcSig = ""; S.logSig = ""; S.fmLoaded = false;
  clearInterval(logTimer); logTimer = null; $("#logLive").checked = false;
  termCwd = "."; $("#termCwd").textContent = "~";
  show("login");
  initLogin();
}

async function start() {
  show("app");
  const initialTab = TABS.has(location.hash.slice(1)) ? location.hash.slice(1) : "home";
  setTab(initialTab, false);
  setAgent(false);
  const h = await api("/api/history");
  if (h.ok) for (const x of h.data.samples || []) pushHist(x);
  const st = await api("/api/status");
  api("/api/health").then((h) => { if (h.ok && !h.data.totp) $("#termSecWarn").hidden = false; });
  if (st.ok && st.data.serverVersion) {
    S.serverVersion = st.data.serverVersion;
    $("#srvVer").textContent = "v" + S.serverVersion;
  }
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



// ---------- Zaryad chegarasi, Ekran rasmi, Bufer, Backup ----------
async function loadChargeLimit() {
  if (!S.agent) return;
  const r = await api("/api/battery-limit");
  if (r.ok && r.data.ok) {
    $("#chgLimit").checked = !!r.data.enabled;
    $("#chgMin").value = r.data.min ?? 50;
    $("#chgMax").value = r.data.max ?? 80;
  }
}
async function saveChargeLimit() {
  const body = {
    enabled: $("#chgLimit").checked,
    min: parseInt($("#chgMin").value, 10) || 50,
    max: parseInt($("#chgMax").value, 10) || 80,
  };
  const r = await api("/api/battery-limit", { method: "POST", body });
  if (r.ok && r.data.ok) toast(body.enabled ? `Zaryad nazorati yoqildi (${r.data.min}%–${r.data.max}%)` : "Zaryad nazorati o'chirildi");
  else toast(r.data.error || r.data.out || "Xato", true);
}
$("#chgLimit").addEventListener("change", saveChargeLimit);
$("#chgSave").addEventListener("click", saveChargeLimit);

$("#shotBtn").addEventListener("click", async () => {
  const btn = $("#shotBtn");
  const st = $("#shotStatus");
  btn.disabled = true; st.hidden = false; st.textContent = "Ekran rasmi olinmoqda…";
  const r = await runJob("/api/screenshot", {}, (s) => { st.textContent = `Olinmoqda… ${s} s`; });
  btn.disabled = !S.agent;
  if (r.ok && r.data.ok && r.data.out) {
    $("#shotImg").src = "data:image/png;base64," + r.data.out;
    $("#shotImg").hidden = false;
    st.hidden = true;
  } else {
    st.textContent = r.data.error || r.data.out || "Olib bo'lmadi";
  }
});

$("#clipGet").addEventListener("click", async () => {
  const r = await api("/api/clipboard");
  if (r.ok && r.data.ok) { $("#clipText").value = r.data.text || ""; toast("Bufer olindi"); }
  else toast(r.data.error || "Xato", true);
});
$("#clipSet").addEventListener("click", async () => {
  const r = await api("/api/clipboard", { method: "POST", body: { text: $("#clipText").value } });
  if (r.ok && r.data.ok) toast("Telefon buferiga yozildi");
  else toast(r.data.error || r.data.out || "Xato", true);
});

$("#backupBtn").addEventListener("click", async () => {
  const btn = $("#backupBtn");
  const st = $("#backupStatus");
  btn.disabled = true; st.hidden = false; st.textContent = "Zaxira yaratilmoqda…";
  const r = await runJob("/api/backup", {}, (s) => { st.textContent = `Zaxira yaratilmoqda… ${s} s`; });
  btn.disabled = !S.agent;
  if (r.ok && r.data.ok) {
    st.textContent = r.data.out || "Zaxira yaratildi";
    toast("Zaxira yaratildi");
    S.fmLoaded = false;
  } else {
    st.textContent = r.data.error || r.data.out || "Xato";
    toast("Zaxira yaratishda xato", true);
  }
});

// ---------- Fonda ishlayotgan ilovalar va optimizatsiya ----------
async function loadBgApps() {
  if (!S.agent) return;
  const list = $("#bgApps");
  list.replaceChildren(el("li", { class: "empty" }, "Tekshirilmoqda…"));
  const r = await api("/api/apps");
  if (!r.ok || !r.data.ok) {
    list.replaceChildren(el("li", { class: "empty" }, r.data.error || r.data.out || "Ro'yxatni olib bo'lmadi"));
    return;
  }
  const apps = r.data.apps || [];
  list.replaceChildren();
  if (!apps.length) return list.append(el("li", { class: "empty" }, "Fonda ortiqcha ilova topilmadi."));
  for (const a of apps) {
    list.append(el("li", {},
      el("span", { class: "name grow" }, a.pkg),
      el("span", { class: "meta" }, `${a.memMb} MB`),
      el("div", { class: "acts" },
        el("button", { class: "danger", onclick: () => stopBgApp(a.pkg) }, "To'xtatish"))));
  }
}

async function stopBgApp(pkg) {
  const r = await api(`/api/apps/${encodeURIComponent(pkg)}/stop`, { method: "POST" });
  if (r.ok && r.data.ok) { toast(r.data.out || `To'xtatildi: ${pkg}`); loadBgApps(); }
  else toast(r.data.error || r.data.out || "Xato", true);
}

$("#appsRefresh").addEventListener("click", loadBgApps);
$("#appsOptimize").addEventListener("click", async () => {
  const btn = $("#appsOptimize");
  btn.disabled = true;
  btn.textContent = "Tozalanmoqda…";
  const r = await api("/api/apps/optimize", { method: "POST" });
  btn.disabled = !S.agent;
  btn.textContent = "⚡ Optimizatsiya";
  if (r.ok && r.data.ok) { toast(r.data.out || "Optimizatsiya bajarildi"); loadBgApps(); setTimeout(refreshStatus, 1000); }
  else toast(r.data.error || r.data.out || "Xato", true);
});


// ---------- Ratsiya (Jonli ovozli aloqa) ----------
let audioCtx = null;
let nextPlayTime = 0;
let micStream = null;
let micProc = null;
let pttListening = false;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playPcmChunk(b64) {
  if (!b64 || !pttListening) return;
  try {
    const ctx = ensureAudioCtx();
    const bin = atob(b64);
    const len = bin.length >> 1;
    if (!len) return;
    const buf = ctx.createBuffer(1, len, 16000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (nextPlayTime < now) nextPlayTime = now + 0.04;
    src.start(nextPlayTime);
    nextPlayTime += buf.duration;
  } catch {}
}

function downsampleTo16k(input, inRate) {
  if (inRate === 16000) return input;
  const ratio = inRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

async function startPttTalk() {
  if (!S.agent || !S.ws || S.ws.readyState !== 1) return;
  const btn = $("#pttTalk");
  btn.classList.add("talking");
  $("#pttStatus").textContent = "Gapiring… (efirda)";
  try {
    const ctx = ensureAudioCtx();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const src = ctx.createMediaStreamSource(micStream);
    micProc = ctx.createScriptProcessor(1024, 1, 1);
    micProc.onaudioprocess = (e) => {
      if (!btn.classList.contains("talking") || !S.ws || S.ws.readyState !== 1) return;
      const f32 = downsampleTo16k(e.inputBuffer.getChannelData(0), ctx.sampleRate);
      const bytes = new Uint8Array(f32.length * 2);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        const v = s < 0 ? s * 0x8000 : s * 0x7fff;
        bytes[i * 2] = v & 0xff;
        bytes[i * 2 + 1] = (v >> 8) & 0xff;
      }
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      S.ws.send(JSON.stringify({ type: "audio_down", data: btoa(bin) }));
    };
    src.connect(micProc);
    micProc.connect(ctx.destination);
  } catch {
    stopPttTalk();
    toast("Brauzerda mikrofon ruxsati berilmadi", true);
  }
}

function stopPttTalk() {
  $("#pttTalk").classList.remove("talking");
  if (!pttListening) $("#pttStatus").textContent = " ";
  if (micProc) { try { micProc.disconnect(); } catch {} micProc = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
}

const pttBtn = $("#pttTalk");
pttBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startPttTalk(); });
pttBtn.addEventListener("pointerup", stopPttTalk);
pttBtn.addEventListener("pointercancel", stopPttTalk);
pttBtn.addEventListener("pointerleave", stopPttTalk);

function stopPttListen() {
  pttListening = false;
  $("#pttListen").textContent = "🔊 Telefonni eshitish";
  $("#pttListen").className = "ghost";
  $("#pttStatus").textContent = " ";
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "ptt_cmd", op: "listen_off" }));
}

$("#pttListen").addEventListener("click", () => {
  if (!S.agent || !S.ws || S.ws.readyState !== 1) return;
  if (pttListening) {
    stopPttListen();
  } else {
    ensureAudioCtx();
    nextPlayTime = 0;
    pttListening = true;
    $("#pttListen").textContent = "⏹ Eshitishni to'xtatish";
    $("#pttListen").className = "danger";
    $("#pttStatus").textContent = "Telefon mikrofoni eshitilmoqda…";
    S.ws.send(JSON.stringify({ type: "ptt_cmd", op: "listen_on" }));
  }
});

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

// ---------- Chaqmoq ----------
$("#flashOn").addEventListener("click", async () => {
  const r = await api("/api/flashlight/on", { method: "POST" });
  if (r.ok && r.data.ok) toast("Chaqmoq yoqildi");
  else toast(r.data.error || r.data.out || "Xato", true);
});
$("#flashOff").addEventListener("click", async () => {
  const r = await api("/api/flashlight/off", { method: "POST" });
  if (r.ok && r.data.ok) toast("Chaqmoq o'chirildi");
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

// ---------- Fayl menejeri ----------
let fmPath = ".";
let fmRoot = "home";
const fmSel = new Set();

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(1) + " GB";
}

function fmJoin(path, name) {
  return path === "." ? name : path + "/" + name;
}

function fmRenderCrumbs(path) {
  const wrap = $("#fmCrumbs");
  wrap.replaceChildren();
  wrap.append(el("span", { onclick: () => fmLoad(".") }, fmRoot === "sdcard" ? "📱 /sdcard" : "🏠 ~"));
  if (path === ".") return;
  const parts = path.split("/");
  let acc = "";
  parts.forEach((part, i) => {
    acc = acc ? acc + "/" + part : part;
    const target = acc;
    wrap.append(document.createTextNode(" / "));
    wrap.append(el("span", i < parts.length - 1 ? { onclick: () => fmLoad(target) } : {}, part));
  });
}

function setFmRoot(root) {
  fmRoot = root;
  $("#fmRootHome").className = root === "home" ? "primary" : "ghost";
  $("#fmRootSd").className = root === "sdcard" ? "primary" : "ghost";
  fmLoad(".");
}
$("#fmRootHome").addEventListener("click", () => setFmRoot("home"));
$("#fmRootSd").addEventListener("click", () => setFmRoot("sdcard"));

async function fmLoad(path) {
  fmPath = path;
  S.fmLoaded = true;
  fmSel.clear();
  $("#fmDelSel").hidden = true;
  $("#fmList").replaceChildren(el("li", { class: "empty" }, "Yuklanmoqda…"));
  $("#fmStatus").textContent = "\u00a0";
  const r = await api(`/api/files?path=${encodeURIComponent(path)}&root=${fmRoot}`);
  if (!r.ok || !r.data.ok) {
    $("#fmList").replaceChildren(el("li", { class: "empty" }, r.data.error || r.data.out || "Xato"));
    return;
  }
  fmRenderCrumbs(path);
  S.fmEntries = (r.data.entries || []).slice().sort((a, b) => (b.type === "d") - (a.type === "d") || a.name.localeCompare(b.name));
  $("#fmSearch").value = "";
  fmRenderEntries(S.fmEntries);
  const canBuild = fmRoot === "home" && path !== "." && !path.includes("/");
  $("#fmBuild").hidden = !canBuild;
  $("#fmBuild").dataset.dir = canBuild ? path : "";
}

function fmRenderEntries(entries) {
  const path = fmPath;
  $("#fmList").replaceChildren();
  if (!entries.length) { $("#fmList").append(el("li", { class: "empty" }, "Hech narsa topilmadi")); return; }
  for (const e of entries) {
    const isDir = e.type === "d";
    const isZip = !isDir && /\.zip$/i.test(e.name);
    const nameSpan = el("span", {
      class: "name" + (isDir ? " dir" : isZip ? "" : " file"),
      onclick: isDir ? () => fmLoad(fmJoin(path, e.name)) : (isZip ? null : () => fmEdit(path, e.name, e.size))
    }, (isDir ? "📁 " : "📄 ") + e.name);
    const metaSpan = el("span", { class: "meta grow" }, isDir ? "" : fmtBytes(e.size));
    const acts = el("div", { class: "acts" });
    if (!isDir) {
      if (!isZip) acts.append(el("button", { class: "ghost", onclick: () => fmEdit(path, e.name, e.size) }, "Tahrirlash"));
      acts.append(el("button", { class: "ghost", onclick: () => fmDownload(path, e.name) }, "⬇"));
      if (isZip) acts.append(el("button", { class: "ghost", onclick: () => fmUnzip(path, e.name) }, "Yoyish"));
    }
    acts.append(el("button", { class: "ghost", onclick: () => fmCopy(path, e.name) }, "Nusxalash"));
    acts.append(el("button", { class: "ghost", onclick: () => fmRename(path, e.name) }, "Nomlash"));
    acts.append(el("button", { class: "danger", onclick: () => fmDelete(path, e.name, isDir) }, "O'chirish"));
    const chk = el("input", {
      type: "checkbox", class: "fm-chk", checked: fmSel.has(e.name),
      onchange: (ev) => {
        if (ev.currentTarget.checked) fmSel.add(e.name); else fmSel.delete(e.name);
        $("#fmDelSel").hidden = fmSel.size === 0;
        $("#fmDelSel").textContent = `Tanlanganlarni o'chirish (${fmSel.size})`;
      }
    });
    $("#fmList").append(el("li", {}, chk, nameSpan, metaSpan, acts));
  }
}

$("#fmSearch").addEventListener("input", (e) => {
  const q = e.currentTarget.value.trim().toLowerCase();
  const list = q ? (S.fmEntries || []).filter((x) => x.name.toLowerCase().includes(q)) : (S.fmEntries || []);
  fmRenderEntries(list);
});


async function fmCopy(path, name) {
  const next = (prompt(`"${name}" nusxasi uchun yangi nom:`, name + "_copy") || "").trim();
  if (!next || next === name) return;
  const r = await api("/api/files/copy", { method: "POST", body: { path: fmJoin(path, name), dest: fmJoin(path, next), root: fmRoot } });
  if (r.ok && r.data.ok) { toast(`Nusxalandi: "${next}"`); fmLoad(path); }
  else toast(r.data.error || r.data.out || "Xato", true);
}

$("#fmDelSel").addEventListener("click", async () => {
  const names = Array.from(fmSel);
  if (!names.length) return;
  const ok = await confirmDialog(`Tanlangan ${names.length} ta element butunlay o'chirilsinmi?`, "O'chirish");
  if (!ok) return;
  for (const name of names) {
    await api(`/api/files?path=${encodeURIComponent(fmJoin(fmPath, name))}&root=${fmRoot}`, { method: "DELETE" });
  }
  toast(`${names.length} ta element o'chirildi`);
  fmLoad(fmPath);
});

async function fmRename(path, name) {
  const next = (prompt(`"${name}" uchun yangi nom:`, name) || "").trim();
  if (!next || next === name) return;
  const r = await api("/api/files/rename", { method: "POST", body: { path: fmJoin(path, name), dest: fmJoin(path, next), root: fmRoot } });
  if (r.ok && r.data.ok) { toast(`"${name}" → "${next}"`); fmLoad(path); }
  else toast(r.data.error || r.data.out || "Xato", true);
}

async function fmDownload(path, name) {
  const full = fmJoin(path, name);
  $("#fmStatus").textContent = `Yuklab olinmoqda: ${name}…`;
  const r = await runJob("/api/files/read", { path: full, root: fmRoot }, (s) => { $("#fmStatus").textContent = `Yuklab olinmoqda: ${name}… ${s} s`; });
  if (!r.ok || !r.data.ok) { $("#fmStatus").textContent = r.data.error || r.data.out || "Yuklab olishda xato"; return; }
  try {
    const bin = atob(r.data.out);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    $("#fmStatus").textContent = `Yuklandi: ${name}`;
  } catch {
    $("#fmStatus").textContent = "Faylni o'qib bo'lmadi";
  }
}

async function fmDelete(path, name, isDir) {
  const ok = await confirmDialog(`"${name}"${isDir ? " (papka, ichidagi hammasi bilan)" : ""} butunlay o'chirilsinmi?`, "O'chirish");
  if (!ok) return;
  const r = await api(`/api/files?path=${encodeURIComponent(fmJoin(path, name))}&root=${fmRoot}`, { method: "DELETE" });
  if (r.ok && r.data.ok) { toast(`"${name}" o'chirildi`); fmLoad(path); }
  else toast(r.data.error || r.data.out || "Xato", true);
}

async function fmUnzip(path, name) {
  const full = fmJoin(path, name);
  const dest = fmJoin(path, name.replace(/\.zip$/i, ""));
  const ok = await confirmDialog(`"${name}" "${dest}" papkasiga yoyilsinmi?`, "Yoyish");
  if (!ok) return;
  $("#fmStatus").textContent = `Yoyilmoqda: ${name}…`;
  const r = await runJob("/api/files/unzip", { path: full, dest, root: fmRoot }, (s) => { $("#fmStatus").textContent = `Yoyilmoqda… ${s} s`; });
  if (!r.ok || !r.data.ok) { $("#fmStatus").textContent = r.data.error || r.data.out || "Yoyishda xato"; return; }
  $("#fmStatus").textContent = `Yoyildi: ${dest}`;
  fmLoad(fmPath);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("O'qib bo'lmadi"));
    reader.readAsDataURL(file);
  });
}

$("#fmUpload").addEventListener("change", async (e) => {
  const files = Array.from(e.currentTarget.files || []);
  e.currentTarget.value = "";
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) { toast(`"${file.name}" juda katta (limit 15 MB)`, true); continue; }
    $("#fmStatus").textContent = `Yuklanmoqda: ${file.name}…`;
    let data;
    try { data = await fileToBase64(file); } catch { toast(`"${file.name}" o'qilmadi`, true); continue; }
    const full = fmJoin(fmPath, file.name);
    const r = await runJob("/api/files/write", { path: full, data, root: fmRoot }, (s) => { $("#fmStatus").textContent = `Yuklanmoqda: ${file.name}… ${s} s`; });
    if (!r.ok || !r.data.ok) toast(r.data.error || r.data.out || `"${file.name}" yuklashda xato`, true);
  }
  $("#fmStatus").textContent = "Tayyor.";
  fmLoad(fmPath);
});

$("#fmMkdir").addEventListener("click", async () => {
  const name = (prompt("Yangi papka nomi:") || "").trim();
  if (!name) return;
  const r = await api("/api/files/mkdir", { method: "POST", body: { path: fmJoin(fmPath, name), root: fmRoot } });
  if (r.ok && r.data.ok) fmLoad(fmPath);
  else toast(r.data.error || r.data.out || "Xato", true);
});

$("#fmUp").addEventListener("click", () => {
  if (fmPath === ".") return;
  const idx = fmPath.lastIndexOf("/");
  fmLoad(idx === -1 ? "." : fmPath.slice(0, idx));
});
$("#fmRefresh").addEventListener("click", () => fmLoad(fmPath));

$("#fmBuild").addEventListener("click", async () => {
  const dir = $("#fmBuild").dataset.dir;
  if (!dir) return;
  $("#fmStatus").textContent = "Bog'liqliklar o'rnatilmoqda (npm install)… bir necha daqiqa cho'zilishi mumkin.";
  let r = await runJob(`/api/deploy/${encodeURIComponent(dir)}/install`, {}, (s) => { $("#fmStatus").textContent = `npm install… ${s} s`; });
  if (!r.ok || !r.data.ok) { $("#fmStatus").textContent = r.data.error || r.data.out || "npm install xato berdi"; return; }

  r = await api(`/api/deploy/${encodeURIComponent(dir)}/scripts`);
  if (!r.ok || !r.data.ok) { $("#fmStatus").textContent = r.data.error || r.data.out || "Skriptlarni o'qib bo'lmadi"; return; }
  const names = Object.keys(r.data.scripts || {});
  if (!names.length) { $("#fmStatus").textContent = "package.json ichida \"scripts\" topilmadi."; return; }
  const choice = (prompt(`Qaysi skriptni ishga tushiramiz?\n${names.join(", ")}`, names.includes("start") ? "start" : names[0]) || "").trim();
  if (!choice) return;
  if (!names.includes(choice)) { toast("Bu skript ro'yxatda yo'q", true); return; }

  const r2 = await api(`/api/deploy/${encodeURIComponent(dir)}/run`, { method: "POST", body: { script: choice } });
  if (r2.ok && r2.data.ok) {
    toast(`"${dir}" (${choice}) pm2 orqali ishga tushirildi`);
    $("#fmStatus").textContent = "Ishga tushirildi.";
    setTimeout(loadPm2, 1200);
  } else {
    toast(r2.data.error || r2.data.out || "Xato", true);
  }
});

// ---------- Yangi loyiha yuklash ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJob(path, body, onTick) {
  const r = await api(path, { method: "POST", body });
  if (!r.ok) return r;
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

function gitHint(out) {
  const t = String(out || "");
  if (/NOGIT|git: .*(not found|inaccessible)|git: command not found/i.test(t)) return "Termux'da git o'rnatilmagan. Termux'da bajaring: pkg install git";
  if (/could not read Username|Authentication failed|terminal prompts disabled|Repository not found|returned error: 40[134]/i.test(t))
    return "Repo private yoki manzil noto'g'ri. Private repo uchun manzilga token qo'shing: https://FOYDALANUVCHI:TOKEN@github.com/FOYDALANUVCHI/REPO.git";
  if (/Could not resolve host|unable to access|Failed to connect|Network is unreachable|SSL|certificate/i.test(t))
    return "Git internetga chiqa olmayapti. Termux'ning o'zida `git ls-remote <manzil>` ishlaydimi, tekshiring.";
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
  if (r.ok && r.data.ok) {
    toast(`"${dir}" (${script}) pm2 orqali ishga tushirildi`);
    setTimeout(loadPm2, 1200);
  } else {
    toast(r.data.error || r.data.out || "Xato", true);
  }
  loadAudit();
}

function withToken(repo, token) {
  if (!token) return repo;
  if (/^https:\/\/[^/]*@/.test(repo)) return repo;
  return repo.replace(/^https:\/\//, `https://${encodeURIComponent(token)}@`);
}

$("#deployGo").addEventListener("click", async () => {
  const repo = withToken($("#deployRepo").value.trim(), $("#deployToken").value.trim());
  const dir = $("#deployDir").value.trim();
  $("#deployToken").value = "";
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


// ---------- Fayl o'qish / tahrirlash / saqlash ----------
let fmEditTarget = "";

function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function fmEdit(path, name, size = 0) {
  if (size > 1024 * 1024) return toast("Fayl tahrirlash uchun juda katta (> 1 MB), yuklab oling", true);
  const full = fmJoin(path, name);
  $("#fmStatus").textContent = `Ochilmoqda: ${name}…`;
  const r = await runJob("/api/files/read", { path: full, root: fmRoot }, (s) => { $("#fmStatus").textContent = `Ochilmoqda: ${name}… ${s} s`; });
  if (!r.ok || !r.data.ok) { $("#fmStatus").textContent = r.data.error || r.data.out || "Faylni o'qib bo'lmadi"; return; }
  try {
    fmEditTarget = full;
    $("#fmEditName").textContent = full;
    $("#fmEditText").value = b64ToUtf8(r.data.out);
    $("#fmEditor").hidden = false;
    $("#fmStatus").textContent = `Tahrirlanmoqda: ${name}`;
    $("#fmEditor").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch {
    $("#fmStatus").textContent = "Fayl matnini dekodlab bo'lmadi";
  }
}

$("#fmNewFile").addEventListener("click", () => {
  const name = (prompt("Yangi fayl nomi (masalan: .env yoki test.py):") || "").trim();
  if (!name) return;
  const full = fmJoin(fmPath, name);
  fmEditTarget = full;
  $("#fmEditName").textContent = full;
  $("#fmEditText").value = "";
  $("#fmEditor").hidden = false;
  $("#fmEditText").focus();
  $("#fmStatus").textContent = `Yangi fayl: ${name} (saqlash uchun "Saqlash" ni bosing)`;
});

$("#fmSave").addEventListener("click", async () => {
  if (!fmEditTarget) return;
  const btn = $("#fmSave");
  btn.disabled = true;
  btn.textContent = "Saqlanmoqda…";
  const text = $("#fmEditText").value;
  const data = utf8ToB64(text.length ? text : "\n");
  const r = await runJob("/api/files/write", { path: fmEditTarget, data, root: fmRoot }, (s) => { $("#fmStatus").textContent = `Saqlanmoqda… ${s} s`; });
  btn.disabled = !S.agent;
  btn.textContent = "Saqlash";
  if (r.ok && r.data.ok) {
    toast(`Saqlandi: ${fmEditTarget}`);
    $("#fmStatus").textContent = `Saqlandi: ${fmEditTarget}`;
    fmLoad(fmPath);
  } else {
    toast(r.data.error || r.data.out || "Saqlashda xato", true);
    $("#fmStatus").textContent = r.data.error || r.data.out || "Saqlashda xato";
  }
});

$("#fmEditClose").addEventListener("click", () => {
  $("#fmEditor").hidden = true;
  fmEditTarget = "";
});

// ---------- Erkin Terminal ----------
const termHist = [];
let termIdx = 0;
let termCwd = ".";

function termAppend(text) {
  const out = $("#termOut");
  if (out.textContent.startsWith("Termux buyrug'ini kiriting")) out.textContent = "";
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}

$("#termClear").addEventListener("click", () => {
  $("#termOut").textContent = "";
});

$("#termCmd").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && termHist.length) {
    e.preventDefault();
    termIdx = Math.max(0, termIdx - 1);
    e.currentTarget.value = termHist[termIdx] || "";
  } else if (e.key === "ArrowDown" && termHist.length) {
    e.preventDefault();
    termIdx = Math.min(termHist.length, termIdx + 1);
    e.currentTarget.value = termIdx < termHist.length ? termHist[termIdx] : "";
  }
});

$("#termForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inp = $("#termCmd");
  const cmd = inp.value.trim();
  if (!cmd) return;
  termHist.push(cmd);
  if (termHist.length > 50) termHist.shift();
  termIdx = termHist.length;
  inp.value = "";

  const btn = $("#termRun");
  btn.disabled = true;
  btn.textContent = "…";
  termAppend(`\n${termCwd === "." ? "~" : "~/" + termCwd} $ ${cmd}\n`);
  const r = await runJob("/api/shell", { cmd, cwd: termCwd });
  btn.disabled = !S.agent;
  btn.textContent = "Bajarish";
  let outText = r.data.out || "";
  try {
    const parsed = JSON.parse(outText);
    if (parsed && typeof parsed === "object" && "out" in parsed) {
      outText = parsed.out || "";
      if (parsed.cwd) {
        termCwd = parsed.cwd;
        $("#termCwd").textContent = termCwd === "." ? "~" : "~/" + termCwd;
      }
    }
  } catch {}
  if (r.ok && r.data.ok) {
    termAppend((outText || "(bajarildi)") + (String(outText).endsWith("\n") ? "" : "\n"));
  } else {
    termAppend(`[xato] ${r.data.error || outText || "noma'lum"}\n`);
  }
  loadAudit();
});

if (S.token) start(); else { show("login"); initLogin(); }

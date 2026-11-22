/** Telegram orqali ogohlantirish (har bir turdagi xabar uchun sovish vaqti bilan). */
export class Alerts {
  constructor({ token, chatId, apiBase = "https://api.telegram.org", cooldownMs = 10 * 60 * 1000, log = () => {} } = {}) {
    this.token = token;
    this.chatId = chatId;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.cooldownMs = cooldownMs;
    this.log = log;
    this.last = new Map();
  }
  get enabled() {
    return Boolean(this.token && this.chatId);
  }
  async send(key, text, { force = false } = {}) {
    if (!this.enabled) return false;
    const now = Date.now();
    if (!force && now - (this.last.get(key) || 0) < this.cooldownMs) return false;
    this.last.set(key, now);
    try {
      const r = await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text }),
      });
      return r.ok;
    } catch (e) {
      this.log("Telegram xatosi:", e.message);
      return false;
    }
  }
}

const num = (v) => typeof v === "number" && Number.isFinite(v);

/** Yangi statistikaga qarab qaysi ogohlantirishlar kerakligini aniqlaydi. */
export function evaluate(stats, prev, t) {
  const out = [];
  if (num(stats.tempC) && stats.tempC >= t.tempC) {
    out.push({ key: "temp", text: `⚠️ Telefon harorati yuqori: ${stats.tempC.toFixed(1)} °C` });
  }
  if (num(stats.ramTotalMb) && num(stats.ramAvailMb) && stats.ramTotalMb > 0) {
    const pct = (stats.ramAvailMb / stats.ramTotalMb) * 100;
    if (pct < t.ramMinPct) out.push({ key: "ram", text: `⚠️ RAM kam qoldi: ${stats.ramAvailMb} MB bo'sh (${pct.toFixed(0)}%)` });
  }
  if (num(stats.battery) && stats.charging === false && stats.battery <= t.batteryMin) {
    out.push({ key: "battery", text: `🔋 Batareya past: ${stats.battery}% (zaryadlanmayapti)` });
  }
  if (num(stats.diskTotalGb) && num(stats.diskFreeGb) && stats.diskTotalGb > 0) {
    const pct = (stats.diskFreeGb / stats.diskTotalGb) * 100;
    if (pct < 5) out.push({ key: "disk", text: `⚠️ Xotira to'lib qoldi: ${pct.toFixed(1)}% bo'sh` });
  }
  const before = prev?.services || {};
  for (const [name, up] of Object.entries(before)) {
    if (up === true && stats.services && stats.services[name] === false) {
      out.push({ key: `svc:${name}`, text: `🛑 Servis to'xtadi: ${name}` });
    }
  }
  return out;
}

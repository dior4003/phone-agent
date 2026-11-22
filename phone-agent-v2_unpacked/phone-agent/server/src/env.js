import fs from "node:fs";

/** .env faylni o'qiydi. Haqiqiy muhit o'zgaruvchilari (process.env) ustun turadi. */
export function loadEnv(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    /* .env yo'q bo'lsa, faqat process.env ishlatiladi */
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")) };
}

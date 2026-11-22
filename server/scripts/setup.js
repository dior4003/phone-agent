#!/usr/bin/env node
// npm run setup        → .env yaratadi (tasodifiy token, kalit va parol bilan)
// npm run totp         → 2FA uchun yangi TOTP_SECRET yaratib ko'rsatadi
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { base32Encode } from "../src/auth.js";

const root = new URL("../", import.meta.url);
const envPath = fileURLToPath(new URL(".env", root));
const rand = (n) => crypto.randomBytes(n).toString("hex");
const totpOnly = process.argv.includes("--totp-only");

function newTotp() {
  const secret = base32Encode(crypto.randomBytes(20));
  const uri = `otpauth://totp/PhoneAgent?secret=${secret}&issuer=PhoneAgent`;
  return { secret, uri };
}

if (totpOnly) {
  const { secret, uri } = newTotp();
  console.log("\nTOTP_SECRET=" + secret);
  console.log("\nShu qatorni .env fayliga yozing va Authenticator ilovasiga kalitni qo'lda kiriting:");
  console.log("Kalit:", secret);
  console.log("URI  :", uri, "\n");
  process.exit(0);
}

if (fs.existsSync(envPath)) {
  console.error(".env allaqachon mavjud. O'chirib qayta ishga tushiring yoki qo'lda tahrirlang.");
  process.exit(1);
}

const password = crypto.randomBytes(12).toString("base64url");
const agentToken = rand(24);
const jwtSecret = rand(32);
let text = fs.readFileSync(new URL(".env.example", root), "utf8");
text = text
  .replace(/^AGENT_TOKEN=.*$/m, `AGENT_TOKEN=${agentToken}`)
  .replace(/^PANEL_PASSWORD=.*$/m, `PANEL_PASSWORD=${password}`)
  .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${jwtSecret}`);

let totpInfo = "";
if (process.argv.includes("--totp")) {
  const { secret, uri } = newTotp();
  text = text.replace(/^TOTP_SECRET=.*$/m, `TOTP_SECRET=${secret}`);
  totpInfo = `\n2FA kalit (Authenticator ilovasiga kiriting): ${secret}\n${uri}\n`;
}
fs.writeFileSync(envPath, text, { mode: 0o600 });

console.log("\n.env yaratildi.\n");
console.log("Panel paroli :", password);
console.log("Agent token  :", agentToken, "(telefon ilovasiga kiritiladi)");
console.log(totpInfo);
console.log("Bularni xavfsiz joyga saqlang: parol faqat shu yerda ko'rsatiladi.\n");

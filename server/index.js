import { fileURLToPath } from "node:url";
import { loadEnv } from "./src/env.js";
import { createApp } from "./src/app.js";

const env = loadEnv(fileURLToPath(new URL("./.env", import.meta.url)));

let app;
try {
  app = createApp(env);
} catch (e) {
  console.error("\nSozlama xatosi:", e.message, "\n");
  process.exit(1);
}

const port = Number(env.PORT || 4000);
const host = env.HOST || "127.0.0.1";
app.listen(port, host).then(() => {
  console.log(`Phone Agent server ishga tushdi: http://${host}:${port}`);
  console.log(app.cfg.totpSecret ? "2FA: yoqilgan" : "2FA: o'chiq (npm run totp bilan yoqing)");
  console.log(app.cfg.telegram.token ? "Telegram ogohlantirishlari: yoqilgan" : "Telegram ogohlantirishlari: o'chiq");
}).catch((e) => {
  console.error("Ishga tushmadi:", e.message);
  process.exit(1);
});

const stop = () => app.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

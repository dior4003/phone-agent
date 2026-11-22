# Phone Agent Server

Node.js server: veb panel, REST API va telefon agenti uchun WebSocket. Faqat bitta tashqi kutubxona: `ws`.

## Ishga tushirish

```bash
npm install
npm run setup        # .env yaratadi (tasodifiy token, kalit, parol). 2FA bilan: npm run setup -- --totp
npm start
npm test             # 28 ta avtomatik test
```

## Sozlamalar (`.env`)

| O'zgaruvchi | Standart | Izoh |
|---|---|---|
| `AGENT_TOKEN` | majburiy | Agent ulanishi uchun token (>=16 belgi) |
| `PANEL_PASSWORD` | majburiy | Panel paroli (>=8 belgi) |
| `JWT_SECRET` | majburiy | Sessiya imzosi (>=16 belgi) |
| `PORT` | `4000` | |
| `HOST` | `127.0.0.1` | LAN/VPS uchun `0.0.0.0` |
| `TRUST_PROXY` | `false` | Cloudflare/nginx orqasida `true` (haqiqiy IP uchun `CF-Connecting-IP` / `X-Forwarded-For`) |
| `SESSION_HOURS` | `12` | Token amal qilish muddati |
| `CMD_TIMEOUT_MS` | `30000` | Telefon javobini kutish vaqti |
| `TOTP_SECRET` | bo'sh | Bo'lsa, 2FA majburiy bo'ladi (`npm run totp`) |
| `LOGIN_MAX_ATTEMPTS` | `5` | 15 daqiqada xato urinishlar soni |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | bo'sh | Ogohlantirishlar uchun |
| `ALERT_TEMP_C` / `ALERT_RAM_MIN_PCT` / `ALERT_BATTERY_MIN` / `ALERT_OFFLINE_SEC` | `45` / `10` / `15` / `60` | Ogohlantirish chegaralari |
| `ALERT_COOLDOWN_MS` | `600000` | Bir xil ogohlantirishni qayta yuborish oralig'i |

## REST API

Hamma javoblar JSON. `/api/health` va `/api/login` dan boshqa barcha endpointlar uchun sarlavha kerak:
`Authorization: Bearer <token>`.

### Autentifikatsiya

**`GET /api/health`** (ochiq)
```json
{ "ok": true, "agent": false, "totp": true, "uptimeSec": 1234 }
```

**`POST /api/login`**
```bash
curl -X POST https://panel.example.uz/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"...","code":"123456"}'      # "code" faqat 2FA yoqilgan bo'lsa
```
`200` → `{ "token": "...", "expiresIn": 43200 }`
`401` → `{ "error": "..." }`, `429` → juda ko'p urinish (`Retry-After` sarlavhasi bilan).
Bir marta ishlatilgan 2FA kodi qayta qabul qilinmaydi.

### Holat

| Endpoint | Javob |
|---|---|
| `GET /api/status` | `{ "agent": true, "stats": { ... } }` (telefon ulanmagan bo'lsa `stats: null`) |
| `GET /api/history` | `{ "samples": [{ "t", "ram", "temp", "bat", "load" }] }` (oxirgi ~1 soat, 5 soniyalik) |
| `GET /api/services` | `{ "agent": true, "services": [{ "name": "nginx", "running": true }] }` |
| `GET /api/audit?limit=30` | `{ "entries": [{ "t", "ev", ... }] }` (eng yangisi birinchi, 1..200) |

`stats` maydonlari: `ramTotalMb`, `ramAvailMb`, `battery` (%), `charging`, `tempC`, `diskTotalGb`, `diskFreeGb`, `uptimeSec`, `load`, `device`, `android`, `services` (`{nom: true/false}`), `logs` (mavjud log nomlari), `at` (ms vaqt).

### Buyruqlar

Buyruqlar telefonga yuboriladi va javobi kutiladi (`CMD_TIMEOUT_MS` gacha).

| Endpoint | Tavsif |
|---|---|
| `POST /api/services/:name/:op` | `op` = `start` \| `stop` \| `restart`. `name`: `mariadb`, `nginx`, `php-fpm` |
| `GET /api/pm2` | `{ "ok": true, "apps": [{ "name", "status", "mem", "restarts" }] }` |
| `POST /api/pm2/:name/:op` | pm2 ilovasini boshqarish |
| `GET /api/logs/:name?lines=100` | `name`: `nginx`, `laravel` yoki `pm2:<ilova>`. `lines` 10..500 |
| `POST /api/device/reboot` | Telefonni 3 soniyadan keyin qayta yoqadi |

Muvaffaqiyatli javob: `200 { "ok": true, "out": "..." }`. Telefon buyruqni bajara olmasa: `200 { "ok": false, "out": "xato matni" }`.

```bash
TOKEN=...
curl -X POST -H "Authorization: Bearer $TOKEN" https://panel.example.uz/api/services/nginx/restart
curl -H "Authorization: Bearer $TOKEN" "https://panel.example.uz/api/logs/laravel?lines=50"
```

### Xato kodlari

| Kod | Ma'nosi |
|---|---|
| `400` | Noto'g'ri nom, amal yoki JSON |
| `401` | Token yo'q/yaroqsiz yoki login xato |
| `404` | Endpoint topilmadi |
| `413` | So'rov juda katta (>4 KB) |
| `429` | Login urinishlari limiti |
| `503` | Telefon ulanmagan yoki buyruq vaqtida aloqa uzildi |
| `504` | Telefon belgilangan vaqtda javob bermadi |

## WebSocket

### `/agent` (telefon uchun)
Sarlavha: `Authorization: Bearer <AGENT_TOKEN>`. Noto'g'ri token bo'lsa `401`. Bir vaqtda bitta agent: yangisi ulansa, eskisi `4000` kod bilan uziladi.

Agent → server:
```json
{ "type": "stats", "data": { "ramTotalMb": 7600, "...": "..." } }
{ "type": "result", "id": "<buyruq id>", "ok": true, "out": "matn" }
```
Server → agent:
```json
{ "type": "cmd", "id": "uuid", "action": "service", "op": "restart", "target": "nginx" }
{ "type": "cmd", "id": "uuid", "action": "logs", "target": "laravel", "lines": 100 }
{ "type": "cmd", "id": "uuid", "action": "pm2list" }
{ "type": "cmd", "id": "uuid", "action": "device", "op": "reboot" }
```

### `/panel` (brauzer uchun)
Ulangach 5 soniya ichida birinchi xabar sifatida `{ "token": "<JWT>" }` yuborilishi kerak, aks holda `4001` bilan yopiladi (token URL'ga yozilmaydi).
Server → panel: `{ "type": "agent", "online": true }`, `{ "type": "stats", "data": {...} }`.

## Fayllar

```
index.js            ishga tushirish
src/app.js          HTTP + WebSocket + REST
src/auth.js         JWT (HS256), TOTP (RFC 6238), urinishlar limiti
src/alerts.js       Telegram ogohlantirishlari
src/env.js          .env o'qish
public/             veb panel (index.html, app.css, app.js)
scripts/setup.js    .env va 2FA kalit yaratish
test/               avtomatik testlar (node:test)
```

## Telefonda (Termux) ishga tushirish

```bash
pkg install nodejs
cd phone-agent/server && npm install && npm run setup
npm install -g pm2
pm2 start index.js --name phone-agent && pm2 save
```

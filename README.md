# Phone Agent

Rootli Android telefonni (masalan, Redmi Note 11 + Magisk) **masofadan boshqariladigan shaxsiy serverga** aylantiradigan to'liq tizim.

```
[Brauzer: veb panel] <--HTTPS/WSS--> [Node.js server] <--WSS--> [Android agent ilovasi]
                                         REST API                  (root + foreground service)
```

Telefon serverga **o'zi ulanadi** (outbound WebSocket), shuning uchun port ochish, statik IP va DDNS kerak emas. CGNAT orqasida ham ishlaydi.

## Imkoniyatlar

| Bo'lim | Nima qiladi |
|---|---|
| Monitoring | RAM, harorat, batareya, xotira, yuklama, ishlagan vaqt. Grafiklar va telefon rasmi jonli yangilanadi |
| Servislar | `mariadb`, `nginx`, `php-fpm` holati va start / stop / restart |
| pm2 | Node ilovalar ro'yxati va start / stop / restart |
| Loglar | nginx, Laravel va pm2 loglarining oxirgi 10-500 qatori |
| Telefon | Qayta yoqish (reboot) |
| Xavfsizlik | Parol + ixtiyoriy 2FA (TOTP), JWT, urinishlarni cheklash, audit jurnali, faqat ro'yxatdagi amallar |
| Ogohlantirish | Telegram: harorat, RAM, batareya, xotira, servis to'xtashi, telefon aloqasi uzilishi |
| API | To'liq REST API (qarang: `server/README.md`) |

## Papkalar

```
phone-agent/
├── server/    Node.js server, REST API, veb panel, testlar
├── android/   Kotlin agent ilovasi (Gradle loyihasi)
└── .github/workflows/build-apk.yml   APK'ni GitHub'da avtomatik yig'adi
```

## Tezkor boshlash (3 qadam)

### 1. Serverni ishga tushirish

Node.js 18+ kerak (kompyuteringizda, VPS'da yoki Termux'da).

```bash
cd server
npm install
npm run setup          # .env yaratadi va parol/token chiqaradi (faqat bir marta ko'rsatiladi!)
npm start              # http://127.0.0.1:4000
```

2FA ham kerak bo'lsa: `npm run setup -- --totp` (yoki keyin `npm run totp` bilan kalit oling va `.env` ga `TOTP_SECRET=` qilib yozing).

### 2. Serverni internetga chiqarish (HTTPS shart)

Eng oson yo'l: **Cloudflare Tunnel**.

```bash
cloudflared tunnel --url http://localhost:4000      # tez sinov uchun (vaqtinchalik manzil beradi)
```

Doimiy ishlatish uchun o'z domeningizda "named tunnel" yarating va `.env` ga `TRUST_PROXY=true` yozing.
Qo'shimcha himoya sifatida Cloudflare Access (email kodi) ni ham yoqish tavsiya etiladi.

> Server telefonning **o'zida** ishlasa, ilovada `ws://127.0.0.1:4000/agent` manzilini ishlatsangiz bo'ladi (tunnel faqat panelga kirish uchun kerak).
> Lekin telefon o'chsa, panel ham o'chadi. Ishonchli variant: serverni arzon VPS'da yuritish.

### 3. Android ilovani o'rnatish

Android Studio **shart emas**. APK GitHub'da yig'iladi:

1. GitHub'da **private** repo oching va shu papkadagi hamma narsani (`.github` bilan) yuklang.
2. **Actions → Build APK → Run workflow**. 3-5 daqiqadan keyin **Artifacts → phone-agent-apk** dan `app-debug.apk` ni yuklab oling.
3. APK'ni telefonga o'rnating ("noma'lum manbalardan o'rnatish" ruxsati kerak).
4. Ilovani oching va to'ldiring:
   - **Server manzili**: `wss://sizning-domen.uz/agent`
   - **Agent token**: `server/.env` dagi `AGENT_TOKEN`
   - **Termux foydalanuvchisi**: Termux'da `whoami` natijasi (masalan, `u0_a285`)
   - **Laravel papkasi**: Termux home ichidagi loyiha papkasi (masalan, `myapp`)
5. Magisk root so'rovini **ruxsat** bering, "Batareya cheklovini o'chirish" ni bosing, so'ng **Agentni yoqish**.
6. Brauzerda panelni oching, parol bilan kiring. Yuqorida "Telefon ulangan" chiqishi kerak.

Telefon qayta yonganda agent o'zi ko'tariladi (ilova bir marta yoqilgan bo'lsa).

## Telefonda Termux tayyorligi

Agent buyruqlarni Termux ichidagi dasturlarga yuboradi, shuning uchun ular o'rnatilgan bo'lishi kerak:

```bash
pkg install nginx php php-fpm mariadb nodejs procps
npm install -g pm2
```

Servislar `pidof` orqali tekshiriladi. Nomlar: `mariadbd` yoki `mysqld`, `nginx`, `php-fpm`.

## Xavfsizlik

- Agent **erkin shell bermaydi**. Faqat `Actions.kt` dagi ro'yxat bajariladi (servis start/stop/restart, log o'qish, pm2, reboot). Server buzilsa ham ixtiyoriy buyruq yuborib bo'lmaydi.
- Buyruqlar root orqali emas, **Termux foydalanuvchisi** nomidan bajariladi. Root faqat shu foydalanuvchiga o'tish uchun ishlatiladi.
- Panelga kirish: parol + ixtiyoriy 2FA, 15 daqiqada 5 ta xato urinishdan keyin blok, sessiya 12 soat (JWT).
- Server faqat `wss://` (Cloudflare orqali) bilan ishlating. Android ilova `ws://` ni faqat `127.0.0.1` uchun ruxsat qiladi.
- `.env` faylini hech kimga bermang va repoga yuklamang (`.gitignore` da bor). Token oshkor bo'lsa, `.env` da almashtirib, ilovada ham yangilang.
- Har bir kirish va buyruq `server/audit.log` ga va panelning "Amallar jurnali" bo'limiga yoziladi.

## Muammolarni hal qilish

| Belgi | Sabab va yechim |
|---|---|
| Ilovada "Token noto'g'ri (401)" | `AGENT_TOKEN` server `.env` dagi bilan bir xil emas |
| Ilovada "Uzilgan, qayta uriniladi" | Server manzili xato, server o'chiq yoki tunnel ishlamayapti. Manzil `wss://.../agent` bilan tugashi kerak |
| Panelda "Telefon ulanmagan" | Ilovada "Agentni yoqish" bosilganini, batareya cheklovi o'chirilganini tekshiring |
| Servis tugmasi "Termux foydalanuvchisi noto'g'ri" deydi | Ilovada `u0_a...` ko'rinishidagi to'g'ri nom kiriting |
| Servis boshlanmaydi | Termux'da qo'lda sinang: `mysqld_safe`, `nginx`, `php-fpm`. Sozlanmagan bo'lsa, agent ham ishga tushira olmaydi |
| Agent bir necha soatdan keyin o'chadi | Phantom process killer'ni o'chiring (Android 12+): `settings put global settings_enable_monitor_phantom_procs false` |
| Panelga kirganda "Juda ko'p urinish" | 15 daqiqa kuting yoki serverni qayta ishga tushiring |

## Litsenziya

MIT

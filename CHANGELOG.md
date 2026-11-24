# O'zgarishlar tarixi

Versiyalash git tegiga asoslangan: `git tag v1.0.0 && git push --tags` qilinganda
GitHub Actions avtomatik shu versiya bilan APK yig'adi va GitHub Release yaratadi
(qarang: `.github/workflows/build-apk.yml`). Tegsiz oddiy push/`workflow_dispatch`
build'lari `0.<build-raqami>-dev` deb nomlanadi va faqat Artifacts bo'limida chiqadi
(Release yaratilmaydi).

## [Unreleased]
- Android ilova endi versiya nomini (`versionName`) git tegidan oladi; panelda
  "agent v…" sifatida ko'rinadi.
- **Tuzatildi:** `git clone`/`npm install` kabi tarmoqqa chiquvchi buyruqlar
  "ruxsat yo'q" xatosi bilan to'xtab qolar edi, chunki `su <termux_user>` faqat
  UID'ni almashtirib, Termux ilovasiga tegishli "inet" (tarmoq) guruhini olib
  o'tmas edi. Endi `su` chaqirilganda kerakli guruhlar (`inet`, `net_raw`) aniq
  ko'rsatiladi — fayl bilan ishlash o'zgarmaydi, faqat tarmoq huquqi tiklanadi.
- **Qo'shildi — Telegram sozlamalari Android ilovadan:** bot tokeni va chat ID'ni
  endi serverning `.env` faylida emas, to'g'ridan-to'g'ri ilova ichida ("Saqlash"
  tugmasi) kiritish mumkin. Qiymatlar har statistikada serverga boradi, lekin
  panelga (brauzerga) hech qachon yuborilmaydi va saqlanmaydi.
- **Qo'shildi — Private (maxfiy) git repo:** "Yangi loyiha yuklash" formasiga
  alohida "Shaxsiy token" maydoni qo'shildi; kiritilsa, repo manzilining o'ziga
  avtomatik biriktiriladi (`https://TOKEN@host/...`). Repo manzili chegarasi ham
  uzunroq (GitHub'ning uzun "fine-grained" tokenlari sig'ishi uchun).
- **Qo'shildi — Chaqmoq:** yoqish/o'chirish tugmalari (root talab qilmaydi).
- **Qo'shildi — Fayl menejeri (alohida oyna):** Termux foydalanuvchisi papkalari
  bilan cheklangan (tizim fayllariga yo'l yopiq): papkalarda yurish, fayl/papka
  yaratish, o'chirish, yuklash (shu jumladan zip), yuklab olish (download), zip
  faylni yoyish (extract), va bitta bosqichli (home ostidagi) papka uchun
  "O'rnatish va ishga tushirish" (mavjud `npm install` → skript tanlash → `pm2`
  mexanizmini qayta ishlatadi). Fayl hajmi 15 MB bilan cheklangan.

## [0.1.0] — boshlang'ich versiya
### Qo'shildi
- Monitoring: RAM, harorat, batareya, xotira, yuklama, ishlagan vaqt
- Servislar (mariadb/nginx/php-fpm) va pm2 jarayonlari: holat, start/stop/restart
- Loglar: nginx, Laravel, pm2
- Telefonni qayta yoqish (reboot)
- Parol + ixtiyoriy 2FA (TOTP), JWT sessiya, urinishlarni cheklash, audit jurnali
- Telegram ogohlantirishlari (harorat/RAM/batareya/xotira/servis/aloqa)

### Qo'shildi (kengaytirish)
- Tarmoq: Wi-Fi / Bluetooth / mobil internet holatini ko'rish va yoqish/o'chirish
- Ekran yorqinligi (0-255 slayder)
- Telefonni topish: jim rejimda ham baland ovoz chalish (2 daqiqada o'zi to'xtaydi)
- Yangi loyiha yuklash: git repo (https) klonlash → `npm install` → `package.json`
  dagi tayyor skriptdan (masalan `dev`, `start`) birini tanlab pm2 orqali ishga
  tushirish — erkin shell buyrug'i yo'q
- Uzoq davom etadigan amallar (clone/install) uchun fon ishlari (`/api/jobs/:id`),
  shuningdek git xatoliklari (git o'rnatilmagan, private repo, tarmoq) uchun
  tushunarli maslahatlar

## Navbatda (so'ralgan, hali qo'shilmagan)
- Fayl menejeri (Termux foydalanuvchisi papkalari bilan cheklangan)
- Chaqmoq (flashlight) yoqish/o'chirish
- Telegram bot token va chat ID'ni panel orqali (fayl tahrirlamasdan) kiritish

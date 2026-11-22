# Phone Agent: Android ilova

Kotlin, minSdk 26 (Android 8+), targetSdk 34. Rootli telefon va Magisk kerak.

## Nima qiladi

- Foreground service sifatida doim ishlaydi (bildirishnoma ko'rinib turadi)
- Serverga `wss://` orqali **o'zi ulanadi**, uzilsa avtomatik qayta ulanadi (3 s dan 60 s gacha)
- Har 5 soniyada statistika yuboradi, buyruqlarni bajarib natijani qaytaradi
- Telefon qayta yonganda (`BOOT_COMPLETED`) o'zi ishga tushadi

## Fayllar

| Fayl | Vazifasi |
|---|---|
| `MainActivity.kt` | Sozlamalar oynasi, yoqish/o'chirish, ulanish holati |
| `AgentService.kt` | WebSocket ulanishi, statistika sikli, buyruqlarni qabul qilish |
| `Actions.kt` | **Ruxsat etilgan amallar ro'yxati** (servislar, loglar, pm2, reboot, tarmoq, yorqinlik, loyiha yuklash) |
| `Stats.kt` | RAM, batareya, harorat, xotira, yuklama, servis holati |
| `Root.kt` | libsu orqali root; buyruqlar Termux foydalanuvchisi nomidan bajariladi |
| `Finder.kt` | "Telefonni topish" — ALARM ovoz oqimi orqali jim rejimda ham eshitiladigan signal |
| `BootReceiver.kt` | Qayta yonganda avtostart |
| `Prefs.kt` | Sozlamalarni saqlash |

## APK yig'ish

Eng oson: GitHub Actions (asosiy `README.md` dagi 3-qadam). Android Studio bilan: `android/` papkasini oching va **Build → Build APK**.

## Servis yoki log qo'shish

`Actions.kt` dagi `SERVICES` ga yangi qator qo'shing:

```kotlin
"redis" to Svc("redis-server --daemonize yes", "redis-cli shutdown", listOf("redis-server")),
```

Panel servislar ro'yxatini telefondan avtomatik oladi, serverni o'zgartirish shart emas.
Yangi log uchun `logs()` funksiyasiga yo'l qo'shing.

## Eslatma

Agentning xavfsizligi `Actions.kt` dagi ro'yxatga tayanadi. Unga erkin buyruq bajaradigan amal qo'shmang.

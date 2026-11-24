plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Versiya GitHub Actions'dan env orqali keladi (git tegiga qarab); mahalliy
// (Android Studio) build uchun xavfsiz standart qiymatlar ishlatiladi.
val appVersionName = (System.getenv("APP_VERSION_NAME") ?: "0.0.0-local").also {
    println("Phone Agent versiyasi: $it")
}
val appVersionCode = System.getenv("APP_VERSION_CODE")?.toIntOrNull() ?: 1

android {
    namespace = "uz.dior.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "uz.dior.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    buildFeatures {
        buildConfig = true // BuildConfig.VERSION_NAME orqali versiyani ilova ichida ko'rsatish uchun
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.github.topjohnwu.libsu:core:6.0.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
}

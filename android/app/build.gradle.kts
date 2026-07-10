plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// CI passes -PversionName=1.2.3 -PversionCode=10203 from the tv-v* tag;
// local builds fall back to a dev version
val vName = (project.findProperty("versionName") as String?) ?: "0.0.0-dev"
val vCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "io.github.v3djg6gl.hydra.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.v3djg6gl.hydra.tv"
        minSdk = 28 // XGIMI projectors on Android TV 9
        targetSdk = 35
        versionCode = vCode
        versionName = vName
    }

    // release signing only when the CI keystore env is present — a plain
    // `./gradlew assembleRelease` still works locally (unsigned)
    val ksFile = System.getenv("TV_KEYSTORE_FILE")
    if (ksFile != null) {
        signingConfigs {
            create("release") {
                storeFile = file(ksFile)
                storePassword = System.getenv("TV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TV_KEY_ALIAS")
                keyPassword = System.getenv("TV_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // the app is tiny; skipping R8 avoids the classic
            // @JavascriptInterface-stripped-by-shrinker footgun entirely
            isMinifyEnabled = false
            if (ksFile != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    applicationVariants.all {
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl).outputFileName =
                "hydra-tv-${versionName}-${buildType.name}.apk"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
}

// Google Maven (dl.google.com) returns 404 on this network, so we resolve
// Google-hosted artifacts through the Aliyun mirror first and fall back to
// the official repository when it is reachable.
val googleMirror = "https://maven.aliyun.com/repository/google"

pluginManagement {
    repositories {
        maven(url = "https://maven.aliyun.com/repository/google")
        maven(url = "https://maven.aliyun.com/repository/gradle-plugin")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven(url = "https://maven.aliyun.com/repository/google")
        google()
        mavenCentral()
    }
}

rootProject.name = "Najvaa"
include(":app")

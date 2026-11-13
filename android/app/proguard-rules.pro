-keep class androidx.biometric.** { *; }
-keep class org.bouncycastle.math.ec.rfc7748.** { *; }
-dontwarn org.bouncycastle.**
-dontwarn okhttp3.**
-dontwarn okio.**
# No source-file names in release stack traces.
-renamesourcefileattribute ""

# تنوير — R8 rules for the release build.

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.magd.tanweer.**$$serializer { *; }
-keepclassmembers class com.magd.tanweer.** { *** Companion; }
-keepclasseswithmembers class com.magd.tanweer.** { kotlinx.serialization.KSerializer serializer(...); }

# OkHttp / Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# The widget provider and the notification worker are created by the system.
-keep class com.magd.tanweer.widget.** { *; }
-keep class com.magd.tanweer.notifications.** { *; }

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.dashworldng.ai.core.**$$serializer { *; }
-keepclassmembers class com.dashworldng.ai.core.** { *** Companion; }
-keepclasseswithmembers class com.dashworldng.ai.core.** { kotlinx.serialization.KSerializer serializer(...); }

# Retrofit service interfaces
-keep,allowobfuscation interface com.dashworldng.ai.core.remote.DashApiService
-keepattributes Signature, Exceptions
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

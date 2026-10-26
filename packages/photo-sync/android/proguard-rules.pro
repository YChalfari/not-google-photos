# Capacitor loads the plugin and its receivers by name.
-keep class com.notgooglephotos.photosync.PhotoSyncPlugin { *; }
-keep class com.notgooglephotos.photosync.work.** extends androidx.work.ListenableWorker { *; }
-keep class com.notgooglephotos.photosync.work.BootReceiver { *; }
-keep class com.notgooglephotos.photosync.notify.MemoryAlarmReceiver { *; }
-keep class com.notgooglephotos.photosync.notify.NotificationActionReceiver { *; }

# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

package io.github.v3djg6gl.hydra.tv

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Process
import android.util.Log

/**
 * Last-ditch self-recovery, mirroring the Pi kiosk's watchdog: an uncaught
 * exception logs, schedules a relaunch ~2 s out, and kills the process.
 * Crash-looping is capped: within 60 s of the previous crash we just die and
 * leave recovery to the user / next boot.
 */
object CrashRestart {
    fun install(context: Context) {
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try {
                Log.e("HydraTv", "uncaught", e)
                val prefs = Prefs(app)
                prefs.lastError = "crash: ${e.javaClass.simpleName}: ${e.message}"
                val now = System.currentTimeMillis()
                val looping = now - prefs.lastCrashAt < 60_000
                prefs.lastCrashAt = now
                if (!looping) {
                    val pi = PendingIntent.getActivity(
                        app, 0,
                        Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                    val am = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                    // setWindow avoids the exact-alarm permission dance on 31+
                    am.setWindow(AlarmManager.RTC_WAKEUP, now + 2000, 5000, pi)
                }
            } catch (inner: Exception) {
                previous?.uncaughtException(thread, e)
            }
            Process.killProcess(Process.myPid())
        }
    }
}

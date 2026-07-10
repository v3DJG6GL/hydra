package io.github.v3djg6gl.hydra.tv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Autostart at boot. Requires (a) one manual launch after install (stopped-
 * state rule; never fires after a force-stop) and (b) on API 29+ the
 * "display over other apps" grant, which exempts this background activity
 * launch — the settings screen surfaces both. See docs/android-tv.md.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") return
        val prefs = Prefs(context)
        if (!prefs.autostart || prefs.serverUrl.isBlank()) return
        try {
            context.startActivity(
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) { /* BAL blocked without the overlay grant */ }
    }
}

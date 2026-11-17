package com.abyssalgarden.desktop

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

// Abyssal Garden on Android: a fullscreen, landscape WebView running the bundled dist/ (WebGPU via Chromium).
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // the WebView has no Screen Wake Lock API, so the activity keeps the screen on for the whole dive
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    immersive()
    // LAN multiplayer: from Android 17 the local network (other devices on the Wi-Fi) is a runtime permission;
    // without it hosting and joining only reach this device. Asked once; the game works offline either way.
    if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(LOCAL_NETWORK), 1)
    }
  }

  companion object { const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK" }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) immersive()
  }

  // hide the status and navigation bars; a swipe from the edge shows them briefly
  private fun immersive() {
    val c = WindowCompat.getInsetsController(window, window.decorView)
    c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    c.hide(WindowInsetsCompat.Type.systemBars())
  }
}

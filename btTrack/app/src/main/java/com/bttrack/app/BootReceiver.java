package com.bttrack.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/** Restarts background scanning after reboot if it was enabled. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        SharedPreferences p = context.getSharedPreferences("settings", Context.MODE_PRIVATE);
        if (!p.getBoolean("enabled", false)) return;
        Intent i = new Intent(context, BeaconScannerService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }
}

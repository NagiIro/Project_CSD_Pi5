package com.bttrack.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground service that continuously scans for iBeacons, estimates distance,
 * and fires the user-stored HTTP request when a beacon is closer than the
 * configured trigger distance (default 0.5 m — as close as possible).
 */
public class BeaconScannerService extends Service {

    public static final String ACTION_UPDATE = "com.bttrack.app.UPDATE";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_STATUS = "status";

    private static final String CHANNEL_ID = "beacon_scan";
    private static final int NOTIF_ID = 1;

    private BluetoothLeScanner scanner;
    private PowerManager.WakeLock wakeLock;
    private final ExecutorService httpPool = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** per-beacon last trigger timestamp for cooldown */
    private final Map<String, Long> lastTrigger = new HashMap<String, Long>();
    /** latest line per beacon for the UI list */
    private final Map<String, String> seen = new HashMap<String, String>();

    private double triggerDistance;
    private String requestUrl;
    private String requestBody;
    private long cooldownMs;

    private int totalBle;
    private int totalIBeacon;

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            try {
                totalBle++;
                ScanRecord rec = result.getScanRecord();
                byte[] raw = rec != null ? rec.getBytes() : null;
                IBeacon b = IBeacon.fromScanRecord(raw, result.getRssi());
                if (b == null) {
                    // show unknown devices with raw payload so the format can be identified
                    String mac = "?";
                    try {
                        if (result.getDevice() != null) mac = result.getDevice().getAddress();
                    } catch (SecurityException ignored) { }
                    seen.put("raw:" + mac, mac + "  RSSI=" + result.getRssi()
                            + "\n  未知格式 raw=" + IBeacon.hexDump(raw, 31));
                    trimSeen();
                    broadcastUpdate();
                    return;
                }
                totalIBeacon++;
                onBeacon(b);
            } catch (Throwable t) {
                // never let one bad packet kill the scanner
                broadcastStatus("封包處理例外: " + t);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            broadcastStatus("掃描失敗: error=" + errorCode
                    + "（請確認已授予附近裝置/精確定位權限且藍牙已開啟）");
        }
    };

    private void trimSeen() {
        while (seen.size() > 12) {
            String first = seen.keySet().iterator().next();
            seen.remove(first);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            loadPrefs();

            BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = bm != null ? bm.getAdapter() : null;
            scanner = (adapter != null && adapter.isEnabled()) ? adapter.getBluetoothLeScanner() : null;

            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "btTrack:scan");
            wakeLock.acquire();
        } catch (Exception e) {
            broadcastStatus("服務啟動失敗: " + e);
        }
    }

    private void loadPrefs() {
        SharedPreferences p = getSharedPreferences("settings", MODE_PRIVATE);
        triggerDistance = Double.longBitsToDouble(p.getLong("distance", Double.doubleToLongBits(0.5)));
        requestUrl = p.getString("url", "");
        requestBody = p.getString("body", "");
        cooldownMs = p.getInt("cooldown", 30) * 1000L;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            loadPrefs();
            startForeground(NOTIF_ID, buildNotification("背景掃描 beacon 中…"));
            startScan();
            heartbeat();
        } catch (Exception e) {
            broadcastStatus("啟動失敗: " + e);
        }
        return START_STICKY;
    }

    /** Every 3 s report counters so the UI always shows live state, even N=0. */
    private void heartbeat() {
        handler.removeCallbacks(heartbeatTask);
        handler.postDelayed(heartbeatTask, 3000);
    }

    private int beats;

    private final Runnable heartbeatTask = new Runnable() {
        @Override
        public void run() {
            BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = bm != null ? bm.getAdapter() : null;
            String bt = (adapter == null) ? "無藍牙" : (adapter.isEnabled() ? "藍牙開" : "藍牙關");
            String loc;
            try {
                android.location.LocationManager lm =
                        (android.location.LocationManager) getSystemService(Context.LOCATION_SERVICE);
                loc = lm != null && lm.isLocationEnabled() ? "定位開" : "定位關";
            } catch (Exception e) {
                loc = "定位?";
            }
            String perms = "";
            if (Build.VERSION.SDK_INT >= 23) {
                try {
                    boolean scan = Build.VERSION.SDK_INT < 31
                            || checkSelfPermission("android.permission.BLUETOOTH_SCAN")
                                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
                    boolean locPerm = checkSelfPermission(
                            android.Manifest.permission.ACCESS_FINE_LOCATION)
                                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
                    perms = " 掃描權限:" + (scan ? "Y" : "N") + " 定位權限:" + (locPerm ? "Y" : "N");
                } catch (Exception ignored) { }
            }
            broadcastStatus("掃描中（" + bt + "/" + loc + "）已見 " + totalBle + " 個 BLE，"
                    + totalIBeacon + " 個已識別 beacon，觸發 ≤ " + triggerDistance + " m" + perms);
            // restart scan every ~30 s to recover from a silently stalled scanner
            if (++beats % 10 == 0 && totalBle == 0) startScan();
            handler.postDelayed(this, 3000);
        }
    };

    private void startScan() {
        if (scanner == null) {
            BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = bm != null ? bm.getAdapter() : null;
            if (adapter != null && adapter.isEnabled()) {
                try {
                    scanner = adapter.getBluetoothLeScanner();
                } catch (Exception ignored) { }
            }
        }
        if (scanner == null) {
            broadcastStatus("藍牙未開啟或不支援 BLE，5 秒後重試");
            handler.postDelayed(new Runnable() {
                @Override public void run() { startScan(); }
            }, 5000);
            return;
        }
        try {
            scanner.stopScan(scanCallback);
        } catch (Exception ignored) { }
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
        try {
            scanner.startScan(null, settings, scanCallback);
        } catch (SecurityException e) {
            broadcastStatus("缺少定位/藍牙權限");
        }
    }

    private void onBeacon(final IBeacon b) {
        String line = String.format("[%s] %s\n  major=%d minor=%d  RSSI=%d dBm  距離≈%.2f m",
                b.format, b.id, b.major, b.minor, b.rssi, b.distanceMeters);
        seen.put(b.key(), line);
        trimSeen();
        broadcastUpdate();

        if (b.distanceMeters > triggerDistance) return;

        if (requestUrl.isEmpty()) {
            broadcastStatus("beacon 已進入範圍（" + String.format("%.2f", b.distanceMeters)
                    + " m）但未設定 URL，不發送");
            return;
        }

        long now = System.currentTimeMillis();
        Long last = lastTrigger.get(b.key());
        if (last != null && now - last < cooldownMs) {
            long remain = (cooldownMs - (now - last)) / 1000;
            broadcastStatus("beacon 在範圍內，冷卻中（約 " + remain + " 秒後可再觸發）");
            return;
        }
        lastTrigger.put(b.key(), now);
        broadcastStatus("beacon 進入範圍，發送 HTTP 請求中…");

        httpPool.execute(new Runnable() {
            @Override
            public void run() {
                HttpTrigger.Result r = HttpTrigger.send(requestUrl, requestBody);
                broadcastStatus("已觸發 " + b.key() + " → " + r.describe());
            }
        });
    }

    private void broadcastUpdate() {
        StringBuilder sb = new StringBuilder();
        for (String s : seen.values()) {
            sb.append(s).append('\n');
        }
        String text = sb.toString().trim();
        getSharedPreferences("settings", MODE_PRIVATE)
                .edit().putString("lastBeacons", text).apply();
        Intent i = new Intent(ACTION_UPDATE);
        i.putExtra(EXTRA_TEXT, text);
        sendBroadcast(i);
    }

    private void broadcastStatus(String s) {
        getSharedPreferences("settings", MODE_PRIVATE)
                .edit().putString("lastStatus", s).apply();
        Intent i = new Intent(ACTION_UPDATE);
        i.putExtra(EXTRA_STATUS, s);
        sendBroadcast(i);
        updateNotification(s);
    }

    private Notification buildNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "Beacon 掃描", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return nb.setContentTitle("btTrack")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIF_ID, buildNotification(text));
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(heartbeatTask);
        try {
            if (scanner != null) scanner.stopScan(scanCallback);
        } catch (Exception ignored) { }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        httpPool.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

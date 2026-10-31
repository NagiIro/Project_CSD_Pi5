package com.bttrack.app;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    private SharedPreferences prefs;
    private TextView tvDistance, tvStatus, tvBeacons;
    private EditText etUrl, etBody, etCooldown;
    private SeekBar seekDistance;

    private final BroadcastReceiver updateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent.hasExtra(BeaconScannerService.EXTRA_TEXT)) {
                String t = intent.getStringExtra(BeaconScannerService.EXTRA_TEXT);
                tvBeacons.setText(t.isEmpty() ? "尚未偵測到 beacon" : t);
            }
            if (intent.hasExtra(BeaconScannerService.EXTRA_STATUS)) {
                tvStatus.setText(intent.getStringExtra(BeaconScannerService.EXTRA_STATUS));
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        setTitle("btTrack v2.0");
        prefs = getSharedPreferences("settings", MODE_PRIVATE);

        tvDistance = findViewById(R.id.tvDistance);
        tvStatus = findViewById(R.id.tvStatus);
        tvBeacons = findViewById(R.id.tvBeacons);
        etUrl = findViewById(R.id.etUrl);
        etBody = findViewById(R.id.etBody);
        etCooldown = findViewById(R.id.etCooldown);
        final android.widget.CheckBox cbOpenBrowser = findViewById(R.id.cbOpenBrowser);
        seekDistance = findViewById(R.id.seekDistance);
        Button btnStart = findViewById(R.id.btnStart);
        Button btnStop = findViewById(R.id.btnStop);
        Button btnTest = findViewById(R.id.btnTest);

        // restore saved settings
        etUrl.setText(prefs.getString("url", ""));
        etBody.setText(prefs.getString("body", ""));
        etCooldown.setText(String.valueOf(prefs.getInt("cooldown", 30)));
        cbOpenBrowser.setChecked(prefs.getBoolean("openBrowser", false));
        double saved = Double.longBitsToDouble(
                prefs.getLong("distance", Double.doubleToLongBits(0.5)));
        seekDistance.setProgress(distanceToProgress(saved));
        updateDistanceLabel(saved);

        seekDistance.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                double d = progressToDistance(progress);
                updateDistanceLabel(d);
                saveDistance(d);
            }
            @Override public void onStartTrackingTouch(SeekBar sb) { }
            @Override public void onStopTrackingTouch(SeekBar sb) { }
        });

        btnStart.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { startScanning(); }
        });
        btnStop.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                prefs.edit().putBoolean("enabled", false).apply();
                stopService(new Intent(MainActivity.this, BeaconScannerService.class));
                tvStatus.setText("已停止");
            }
        });

        btnTest.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { testHttp(); }
        });

        requestRuntimePermissions();
        autoStart();
        startStatusPoller();
    }

    /** Auto-start scanning as soon as scan permission is granted. */
    private void autoStart() {
        if (Build.VERSION.SDK_INT >= 31) {
            if (checkSelfPermission("android.permission.BLUETOOTH_SCAN")
                    != PackageManager.PERMISSION_GRANTED) return;
        } else if (Build.VERSION.SDK_INT >= 23) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) return;
        }
        startScanning();
    }

    /** Belt-and-suspenders: poll the persisted status even if broadcasts are missed. */
    private void startStatusPoller() {
        final android.os.Handler h = new android.os.Handler();
        h.postDelayed(new Runnable() {
            @Override public void run() {
                String s = prefs.getString("lastStatus", "");
                if (!s.isEmpty()) tvStatus.setText(s);
                String bl = prefs.getString("lastBeacons", "");
                if (!bl.isEmpty()) tvBeacons.setText(bl);
                h.postDelayed(this, 1500);
            }
        }, 1500);
    }

    // slider: 0..99 -> 0.1m..10m
    private double progressToDistance(int progress) {
        return Math.round((0.1 + progress * 0.1) * 10.0) / 10.0;
    }

    private int distanceToProgress(double d) {
        int p = (int) Math.round((d - 0.1) / 0.1);
        return Math.max(0, Math.min(99, p));
    }

    private void updateDistanceLabel(double d) {
        tvDistance.setText(String.format("%.1f m", d));
    }

    private void saveDistance(double d) {
        prefs.edit().putLong("distance", Double.doubleToLongBits(d)).apply();
    }

    private void startScanning() {
        String url = etUrl.getText().toString().trim();
        int cooldown;
        try {
            cooldown = Integer.parseInt(etCooldown.getText().toString().trim());
        } catch (NumberFormatException e) {
            cooldown = 30;
        }
        prefs.edit()
                .putString("url", url)
                .putString("body", etBody.getText().toString())
                .putInt("cooldown", cooldown)
                .putBoolean("openBrowser", cbOpenBrowser.isChecked())
                .putBoolean("enabled", true)
                .apply();

        if (url.isEmpty()) {
            Toast.makeText(this, "未填 URL：只掃描顯示，不發送請求", Toast.LENGTH_LONG).show();
        }
        Intent i = new Intent(this, BeaconScannerService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
        tvStatus.setText("啟動中…");
    }

    /** Fire the stored request immediately on a worker thread, for diagnostics. */
    private void testHttp() {
        final String url = etUrl.getText().toString().trim();
        final String body = etBody.getText().toString();
        if (url.isEmpty()) {
            Toast.makeText(this, "請先填寫 HTTP URL", Toast.LENGTH_LONG).show();
            return;
        }
        tvStatus.setText("測試發送中… " + url);
        new Thread(new Runnable() {
            @Override public void run() {
                final HttpTrigger.Result r = HttpTrigger.send(url, body);
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        tvStatus.setText("測試結果: " + r.describe());
                    }
                });
            }
        }).start();
    }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        java.util.ArrayList<String> btNeed = new java.util.ArrayList<String>();
        if (Build.VERSION.SDK_INT >= 31) {
            btNeed.add("android.permission.BLUETOOTH_SCAN");
            btNeed.add("android.permission.BLUETOOTH_CONNECT");
            if (Build.VERSION.SDK_INT >= 33) {
                btNeed.add("android.permission.POST_NOTIFICATIONS");
            }
        }
        java.util.ArrayList<String> missing = new java.util.ArrayList<String>();
        for (String p : btNeed) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        }
        if (!missing.isEmpty()) {
            // location is requested AFTER this batch completes (see onRequestPermissionsResult)
            requestPermissions(missing.toArray(new String[0]), 1);
            return;
        }
        requestLocationPermission();
    }

    private void requestLocationPermission() {
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                        != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, 2);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == 1) {
            // bluetooth batch answered -> now ask for location, then auto-start
            requestLocationPermission();
            return;
        }
        for (int i = 0; i < permissions.length; i++) {
            if (grantResults[i] != PackageManager.PERMISSION_GRANTED) {
                if (!permissions[i].equals("android.permission.POST_NOTIFICATIONS")) {
                    tvStatus.setText("權限被拒: " + permissions[i]);
                }
            }
        }
        autoStart();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // restore last known status so the screen never looks empty
        String last = prefs.getString("lastStatus", "");
        if (!last.isEmpty()) tvStatus.setText(last);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(updateReceiver,
                    new IntentFilter(BeaconScannerService.ACTION_UPDATE),
                    Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(updateReceiver,
                    new IntentFilter(BeaconScannerService.ACTION_UPDATE));
        }
    }

    @Override
    protected void onPause() {
        unregisterReceiver(updateReceiver);
        super.onPause();
    }
}

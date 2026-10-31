package com.cctv.game;

import android.app.Activity;
import android.app.Presentation;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.view.Display;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 雙屏架構：
 *  - 主屏（觸摸屏）：WebView 載入 assets/www/index.html（遊戲）
 *  - 副屏（HDMI/DisplayLink）：android.app.Presentation 放另一個 WebView 載入 screen2.html
 * 兩個 WebView 之間經 CctvNative JS bridge 互傳指令；
 * localStorage（心跳、螢幕狀態、設定覆寫）兩個 WebView 天然共享。
 */
public class MainActivity extends Activity {

    private static final String MAIN_URL = "http://127.0.0.1:8977/index.html";
    private static final String SCREEN2_URL = "http://127.0.0.1:8977/screen2.html";

    private LocalWebServer webServer;
    private WebView mainWeb;
    private WebView screen2Web; // 由 Presentation 持有，可能為 null（未接副屏）
    private DisplayManager displayManager;
    private Screen2Presentation presentation;

    /** 主屏 → 副屏 橋 */
    private final BusBridge toScreen2 = new BusBridge(new Target() {
        @Override public WebView get() { return screen2Web; }
    });
    /** 副屏 → 主屏 橋（預留，screen2 目前只收指令） */
    private final BusBridge toMain = new BusBridge(new Target() {
        @Override public WebView get() { return mainWeb; }
    });

    /** 給設定頁用的診斷接口：回報系統顯示器列表與副屏狀態 */
    private class DiagBridge {
        @JavascriptInterface
        public String getDisplayInfo() {
            JSONObject out = new JSONObject();
            try {
                JSONArray arr = new JSONArray();
                for (Display d : displayManager.getDisplays()) {
                    JSONObject jd = new JSONObject();
                    jd.put("id", d.getDisplayId());
                    jd.put("name", String.valueOf(d.getName()));
                    jd.put("isPresentation",
                        (d.getFlags() & Display.FLAG_PRESENTATION) != 0);
                    jd.put("state", d.getState()); // 2 = STATE_ON
                    jd.put("size", d.getWidth() + "x" + d.getHeight());
                    arr.put(jd);
                }
                out.put("displays", arr);
                out.put("presentationShowing",
                    presentation != null && presentation.isShowing());
                out.put("screen2Loaded", screen2Web != null);
            } catch (Exception e) {
                try { out.put("error", String.valueOf(e)); } catch (Exception ignored) {}
            }
            return out.toString();
        }
    }

    private interface Target { WebView get(); }

    private class BusBridge {
        private final Target target;
        BusBridge(Target t) { target = t; }

        @JavascriptInterface
        public void send(final String json) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    WebView w = target.get();
                    if (w != null) {
                        w.evaluateJavascript(
                            "window.__cctvNativeReceive && window.__cctvNativeReceive("
                                + JSONObject.quote(json) + ")", null);
                    }
                }
            });
        }
    }

    /* ---------------- 生命週期 ---------------- */

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        goImmersive();

        // 本機 HTTP 伺服器：讓頁面來源是 http://127.0.0.1（secure context），
        // 否則 file:// 來源會被 Chromium 封鎖向區網（PI5）的 request
        webServer = new LocalWebServer(getAssets(), 8977);
        webServer.start();

        mainWeb = makeWebView(this, toScreen2);
        setContentView(mainWeb);
        mainWeb.loadUrl(MAIN_URL);
        WebView.setWebContentsDebuggingEnabled(true); // 可用 chrome://inspect 遠端除錯

        displayManager = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        displayManager.registerDisplayListener(displayListener, null);
        updatePresentation();
        if (displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).length == 0) {
            Toast.makeText(this,
                "未偵測到可投放的副屏（系統只有鏡像模式時屬正常）",
                Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        goImmersive();
        if (mainWeb != null) mainWeb.onResume();
        updatePresentation(); // 回到前景時重試一次（例如中途接上副屏）
    }

    @Override
    protected void onPause() {
        if (mainWeb != null) mainWeb.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        displayManager.unregisterDisplayListener(displayListener);
        dismissPresentation();
        if (mainWeb != null) mainWeb.destroy();
        if (webServer != null) webServer.shutdown();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    private void goImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    /* ---------------- 副屏 Presentation ---------------- */

    private final DisplayManager.DisplayListener displayListener =
        new DisplayManager.DisplayListener() {
            @Override public void onDisplayAdded(int displayId) { updatePresentation(); }
            @Override public void onDisplayChanged(int displayId) { updatePresentation(); }
            @Override public void onDisplayRemoved(int displayId) { updatePresentation(); }
        };

    private void updatePresentation() {
        Display[] displays =
            displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
        if (displays.length > 0) {
            if (presentation == null || presentation.getDisplay() != displays[0]) {
                dismissPresentation();
                presentation = new Screen2Presentation(this, displays[0]);
                presentation.show();
            }
        } else {
            dismissPresentation();
        }
    }

    private void dismissPresentation() {
        if (presentation != null) {
            presentation.dismiss();
            presentation = null;
        }
        screen2Web = null;
    }

    private class Screen2Presentation extends Presentation {
        Screen2Presentation(Context outerContext, Display display) {
            super(outerContext, display);
        }

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            screen2Web = makeWebView(getContext(), toMain);
            setContentView(screen2Web);
            screen2Web.loadUrl(SCREEN2_URL);
            if (getWindow() != null) {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            }
        }
    }

    /* ---------------- WebView 設定 ---------------- */

    @SuppressWarnings("SetJavaScriptEnabled")
    private WebView makeWebView(Context ctx, BusBridge bridge) {
        WebView w = new WebView(ctx);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // localStorage（設定覆寫、心跳、狀態）
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);  // file:// 頁面 fetch config.json
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false); // 副屏影片自動播放
        w.setWebViewClient(new WebViewClient());
        w.addJavascriptInterface(bridge, "CctvNative");
        w.addJavascriptInterface(new DiagBridge(), "CctvNativeDiag");
        return w;
    }
}

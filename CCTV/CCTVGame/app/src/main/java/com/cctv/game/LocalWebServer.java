package com.cctv.game;

import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 極簡本機 HTTP 伺服器：把 assets/www 以 http://127.0.0.1:port/ 提供給 WebView。
 * 目的：讓頁面來源是 http://127.0.0.1（secure context），
 * 這樣 WebView 才允許頁面向區網 HTTP（PI5 播放端）發 request ——
 * file:// 來源會被 Chromium 的 Private Network Access 政策直接封鎖。
 * 支援 Range（mp4 影片播放需要）。
 */
public class LocalWebServer extends Thread {

    private static final String WEB_ROOT = "www";

    private final AssetManager assets;
    private final int port;
    private volatile boolean running = true;
    private ServerSocket serverSocket;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "text/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("gif", "image/gif");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("svg", "image/svg+xml");
        MIME.put("mp4", "video/mp4");
        MIME.put("webm", "video/webm");
        MIME.put("mp3", "audio/mpeg");
    }

    public LocalWebServer(AssetManager assets, int port) {
        this.assets = assets;
        this.port = port;
        setDaemon(true);
    }

    public int getPort() { return port; }

    public void shutdown() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
    }

    @Override
    public void run() {
        try {
            serverSocket = new ServerSocket(port);
            serverSocket.setReuseAddress(true);
            while (running) {
                try {
                    final Socket s = serverSocket.accept();
                    Thread t = new Thread(() -> handle(s));
                    t.setDaemon(true);
                    t.start();
                } catch (IOException e) {
                    if (running) { /* 暫時錯誤，繼續 */ }
                }
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            InputStream in = sock.getInputStream();
            // 讀 request line + headers（簡易解析）
            ByteArrayOutputStream headBuf = new ByteArrayOutputStream();
            int b;
            int prev3 = 0, prev2 = 0, prev1 = 0;
            while ((b = in.read()) != -1) {
                headBuf.write(b);
                if (prev3 == '\r' && prev2 == '\n' && prev1 == '\r' && b == '\n') break;
                prev3 = prev2; prev2 = prev1; prev1 = b;
                if (headBuf.size() > 16384) return; // 防爆
            }
            String head = headBuf.toString("ISO-8859-1");
            String[] lines = head.split("\r\n");
            if (lines.length == 0) return;
            String[] parts = lines[0].split(" ");
            if (parts.length < 2 || !"GET".equalsIgnoreCase(parts[0])) return;

            String path = parts[1];
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            path = java.net.URLDecoder.decode(path, "UTF-8");
            if (path.equals("/")) path = "/index.html";
            // 防目錄穿越
            if (path.contains("..")) { respond(sock, 403, "Forbidden".getBytes(), "text/plain"); return; }

            long rangeStart = -1, rangeEnd = -1;
            for (int i = 1; i < lines.length; i++) {
                String l = lines[i];
                if (l.toLowerCase(Locale.US).startsWith("range:")) {
                    // bytes=start-end
                    String v = l.substring(6).trim();
                    if (v.startsWith("bytes=")) {
                        String[] se = v.substring(6).split("-");
                        try { rangeStart = Long.parseLong(se[0]); } catch (Exception ignored) {}
                        if (se.length > 1 && !se[1].isEmpty()) {
                            try { rangeEnd = Long.parseLong(se[1]); } catch (Exception ignored) {}
                        }
                    }
                }
            }

            String assetPath = WEB_ROOT + path;
            byte[] data;
            try (InputStream ain = assets.open(assetPath)) {
                data = readAll(ain);
            } catch (IOException notFound) {
                respond(sock, 404, "not found".getBytes(), "text/plain");
                return;
            }

            String ext = assetPath.substring(assetPath.lastIndexOf('.') + 1).toLowerCase(Locale.US);
            String mime = MIME.getOrDefault(ext, "application/octet-stream");

            if (rangeStart >= 0) {
                long total = data.length;
                long end = (rangeEnd >= 0 && rangeEnd < total) ? rangeEnd : total - 1;
                if (rangeStart >= total) {
                    respond(sock, 416, "range not satisfiable".getBytes(), "text/plain");
                    return;
                }
                int len = (int) (end - rangeStart + 1);
                byte[] slice = new byte[len];
                System.arraycopy(data, (int) rangeStart, slice, 0, len);
                Map<String, String> extra = new HashMap<>();
                extra.put("Content-Range", "bytes " + rangeStart + "-" + end + "/" + total);
                extra.put("Accept-Ranges", "bytes");
                respond(sock, 206, slice, mime, extra);
            } else {
                Map<String, String> extra = new HashMap<>();
                extra.put("Accept-Ranges", "bytes");
                respond(sock, 200, data, mime, extra);
            }
        } catch (IOException ignored) {
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private void respond(Socket s, int code, byte[] body, String mime) throws IOException {
        respond(s, code, body, mime, null);
    }

    private void respond(Socket s, int code, byte[] body, String mime,
                         Map<String, String> extra) throws IOException {
        String status = code == 200 ? "OK" : code == 206 ? "Partial Content"
            : code == 404 ? "Not Found" : code == 403 ? "Forbidden" : "Error";
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(status).append("\r\n");
        h.append("Content-Type: ").append(mime).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("Connection: close\r\n");
        if (extra != null) for (Map.Entry<String, String> e : extra.entrySet()) {
            h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        }
        h.append("\r\n");
        OutputStream out = s.getOutputStream();
        out.write(h.toString().getBytes("ISO-8859-1"));
        out.write(body);
        out.flush();
    }
}

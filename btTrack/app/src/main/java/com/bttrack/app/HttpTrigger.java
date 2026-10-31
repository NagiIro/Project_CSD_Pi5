package com.bttrack.app;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Sends the user-stored HTTP request when a beacon enters range. */
public class HttpTrigger {

    public static class Result {
        public final int code;
        public final String error;
        Result(int code, String error) { this.code = code; this.error = error; }
        public boolean ok() { return error == null && code >= 200 && code < 300; }
        public String describe() {
            return error != null ? ("錯誤: " + error) : ("HTTP " + code);
        }
    }

    /** If body is empty -> GET, otherwise POST with the body as UTF-8 JSON/text. */
    public static Result send(String urlStr, String body) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            if (body == null || body.trim().isEmpty()) {
                conn.setRequestMethod("GET");
            } else {
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] data = body.getBytes(StandardCharsets.UTF_8);
                OutputStream os = conn.getOutputStream();
                os.write(data);
                os.flush();
                os.close();
            }
            int code = conn.getResponseCode();
            conn.getInputStream().close();
            return new Result(code, null);
        } catch (Exception e) {
            return new Result(-1, e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}

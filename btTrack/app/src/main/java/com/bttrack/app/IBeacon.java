package com.bttrack.app;

/** Parsed BLE beacon advertisement (iBeacon / AltBeacon / Eddystone-UID) + distance estimation. */
public class IBeacon {
    public final String format;  // "iBeacon" | "AltBeacon" | "Eddystone"
    public final String id;      // uuid / namespace+instance
    public final int major;
    public final int minor;
    public final int txPower;
    public final int rssi;
    public final double distanceMeters;

    private IBeacon(String format, String id, int major, int minor, int txPower, int rssi, double dist) {
        this.format = format;
        this.id = id;
        this.major = major;
        this.minor = minor;
        this.txPower = txPower;
        this.rssi = rssi;
        this.distanceMeters = dist;
    }

    private static double distFrom1mTx(int txPowerAt1m, int rssi) {
        if (rssi == 0) return -1;
        return Math.pow(10.0, (txPowerAt1m - rssi) / 20.0);
    }

    public static IBeacon fromScanRecord(byte[] record, int rssi) {
        if (record == null) return null;
        for (int i = 0; i + 1 < record.length; ) {
            int len = record[i] & 0xFF;
            if (len == 0) break;
            if (i + 1 + len > record.length) break;
            int type = record[i + 1] & 0xFF;

            if (type == 0xFF && len >= 5) {
                // manufacturer data: company(2 LE) + payload
                int b2 = record[i + 2] & 0xFF, b3 = record[i + 3] & 0xFF;
                // iBeacon: Apple 4C 00, then 02 15
                if (b2 == 0x4C && b3 == 0x00 && len >= 0x1A
                        && (record[i + 4] & 0xFF) == 0x02 && (record[i + 5] & 0xFF) == 0x15) {
                    String uuid = hex(record, i + 6, 16, true);
                    int major = be16(record, i + 22);
                    int minor = be16(record, i + 24);
                    int tx = record[i + 26];
                    return new IBeacon("iBeacon", uuid, major, minor, tx, rssi,
                            distFrom1mTx(tx, rssi));
                }
                // AltBeacon: any company, then BE AC
                if (len >= 0x1B && (record[i + 4] & 0xFF) == 0xBE && (record[i + 5] & 0xFF) == 0xAC) {
                    String uuid = hex(record, i + 6, 16, true);
                    int major = be16(record, i + 22);
                    int minor = be16(record, i + 24);
                    int tx = record[i + 26];
                    return new IBeacon("AltBeacon", uuid, major, minor, tx, rssi,
                            distFrom1mTx(tx, rssi));
                }
            }

            if (type == 0x16 && len >= 4) {
                // service data: uuid(2 LE) + data; Eddystone service = AA FE (LE of 0xFEAA)
                if ((record[i + 2] & 0xFF) == 0xAA && (record[i + 3] & 0xFF) == 0xFE) {
                    int frame = record[i + 4] & 0xFF;
                    if (frame == 0x00 && len >= 0x15) { // UID
                        int tx0 = record[i + 5];           // tx power at 0 m
                        String ns = hex(record, i + 6, 10, false);
                        String inst = hex(record, i + 16, 6, false);
                        // convert 0m tx to 1m tx: add 41 dB loss
                        return new IBeacon("Eddystone", ns + "-" + inst, 0, 0, tx0, rssi,
                                distFrom1mTx(tx0 + 41, rssi));
                    }
                    if (frame == 0x10) { // URL frame
                        int tx0 = record[i + 5];
                        return new IBeacon("Eddystone-URL", "url-frame", 0, 0, tx0, rssi,
                                distFrom1mTx(tx0 + 41, rssi));
                    }
                }
            }
            i += len + 1;
        }
        return null;
    }

    private static int be16(byte[] a, int off) {
        return ((a[off] & 0xFF) << 8) | (a[off + 1] & 0xFF);
    }

    private static String hex(byte[] a, int off, int n, boolean dashes) {
        StringBuilder sb = new StringBuilder();
        for (int j = 0; j < n; j++) {
            sb.append(String.format("%02x", a[off + j]));
            if (dashes && (j == 3 || j == 5 || j == 7 || j == 9)) sb.append('-');
        }
        return sb.toString();
    }

    /** Compact raw dump of the record for diagnosing unknown formats. */
    public static String hexDump(byte[] record, int max) {
        if (record == null) return "(null)";
        StringBuilder sb = new StringBuilder();
        int n = Math.min(record.length, max);
        for (int j = 0; j < n; j++) sb.append(String.format("%02X", record[j]));
        if (record.length > max) sb.append("…");
        return sb.toString();
    }

    public String key() {
        return format + ":" + id + ":" + major + ":" + minor;
    }
}

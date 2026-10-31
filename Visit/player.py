#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
雙影片循環切換播放器（Raspberry Pi 5 / PC 通用）

行為：
  1. 啟動後全螢幕循環播放影片 A（預設 gifa）。
  2. 按下「空白鍵」→ 立即切換播放影片 B（預設 gifb）。
  3. 影片 B 播放完畢後 → 自動回到影片 A 繼續循環。
  4. Alt+F4（或點視窗關閉鈕）→ 強制結束程式。

設定檔 config.json 可自訂影片路徑、切換按鍵、是否全螢幕等。

支援格式：mp4 / avi / mkv / mov ...（OpenCV 可解碼者）以及 .gif（需 Pillow）。
注意：OpenCV 播放不含聲音。若影片需要聲音請改用 VLC 方案。

用法：
  python player.py                     # 使用同目錄 config.json
  python player.py -c myconfig.json    # 指定設定檔
  python player.py --windowed          # 視窗模式（測試用）
  python player.py --self-test         # 自動化自我測試（模擬按鍵，不需人工操作）
"""

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

WINDOW_NAME = "player"


# ---------------------------------------------------------------- 設定

DEFAULT_CONFIG = {
    "video_a": "gifa.mp4",        # 影片 A：循環播放
    "video_b": "gifb.mp4",        # 影片 B：按空白鍵後播放一次
    "fullscreen": True,           # 全螢幕
    "switch_key": 32,             # 觸發切換的按鍵碼（32 = 空白鍵）
    "escape_key": 27,             # 額外離開鍵（27 = ESC；設為 null 可關閉）
    "default_fps": 25.0,          # 影片讀不到 fps 時的預設值
}


def load_config(cfg_path):
    cfg_path = Path(cfg_path).resolve()
    with open(cfg_path, encoding="utf-8") as f:
        cfg = dict(DEFAULT_CONFIG, **json.load(f))
    base = cfg_path.parent
    for key in ("video_a", "video_b"):
        p = Path(cfg[key])
        cfg[key] = str(p if p.is_absolute() else (base / p))
    return cfg


# ------------------------------------------------- 影格來源（影片 / GIF）

class VideoSource:
    """OpenCV VideoCapture 包裝。next_frame() 播完回傳 None；rewind() 重新播放。"""

    def __init__(self, path, default_fps=25.0):
        self.path = path
        self.default_fps = default_fps
        self._open()

    def _open(self):
        self.cap = cv2.VideoCapture(self.path)
        if not self.cap.isOpened():
            raise RuntimeError(f"無法開啟影片：{self.path}")
        fps = self.cap.get(cv2.CAP_PROP_FPS)
        if not fps or fps < 1:
            fps = self.default_fps
        self.frame_ms = 1000.0 / fps

    def next_frame(self):
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None, self.frame_ms
        return frame, self.frame_ms

    def rewind(self):
        self.cap.release()
        self._open()

    def release(self):
        self.cap.release()


class GifSource:
    """GIF：啟動時一次解碼全部影格（GIF 通常很小），依每格 duration 播放。"""

    def __init__(self, path, default_fps=25.0):
        from PIL import Image, ImageSequence
        self.frames = []
        self.durations = []
        with Image.open(path) as im:
            for fr in ImageSequence.Iterator(im):
                rgb = np.array(fr.convert("RGB"))
                self.frames.append(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
                self.durations.append(max(20, fr.info.get("duration", 100)))
        if not self.frames:
            raise RuntimeError(f"GIF 無影格：{path}")
        self.idx = 0

    def next_frame(self):
        if self.idx >= len(self.frames):
            return None, 0
        i = self.idx
        self.idx += 1
        return self.frames[i], self.durations[i]

    def rewind(self):
        self.idx = 0

    def release(self):
        pass


def make_source(path, default_fps=25.0):
    if path.lower().endswith(".gif"):
        return GifSource(path, default_fps)
    return VideoSource(path, default_fps)


# ----------------------------------------------------------- 播放主迴圈

def run(cfg, windowed=False, self_test=False):
    src_a = make_source(cfg["video_a"], cfg["default_fps"])
    src_b = make_source(cfg["video_b"], cfg["default_fps"])

    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
    if cfg["fullscreen"] and not windowed:
        cv2.setWindowProperty(WINDOW_NAME, cv2.WND_PROP_FULLSCREEN,
                              cv2.WINDOW_FULLSCREEN)

    # 自我測試：於指定秒數注入模擬按鍵（不需人工操作）
    sim_events = []
    if self_test:
        sim_events = [(1.0, cfg["switch_key"])]   # 1 秒後模擬按下空白鍵
    t_start = time.monotonic()
    log = []

    def note(msg):
        line = f"[{time.monotonic() - t_start:5.2f}s] {msg}"
        log.append(line)
        print(line, flush=True)

    state = "A"
    current = src_a
    note("開始循環播放影片 A")

    def switch_to(src, name, reason):
        nonlocal state, current
        src.rewind()
        state = name
        current = src
        note(f"{reason} → 播放影片 {name}")

    try:
        while True:
            frame, frame_ms = current.next_frame()
            if frame is None:  # 目前影片播完
                if state == "B":
                    switch_to(src_a, "A", "影片 B 播畢")
                else:
                    src_a.rewind()
                continue

            t0 = time.monotonic()
            cv2.imshow(WINDOW_NAME, frame)

            # Alt+F4 / 關閉視窗 → 結束
            try:
                if cv2.getWindowProperty(WINDOW_NAME, cv2.WND_PROP_VISIBLE) < 1:
                    note("視窗被關閉（Alt+F4）→ 結束程式")
                    break
            except cv2.error:
                break

            # 依影片 fps 決定等待時間，同時接收按鍵
            wait = max(1, int(frame_ms - (time.monotonic() - t0) * 1000))
            key = cv2.waitKey(wait) & 0xFF

            # 自我測試：到時間就注入模擬按鍵
            while sim_events and time.monotonic() - t_start >= sim_events[0][0]:
                _, key = sim_events.pop(0)
                note("（自我測試）模擬按下空白鍵")

            if key == cfg["switch_key"]:
                switch_to(src_b, "B", "偵測到空白鍵")
            elif cfg.get("escape_key") is not None and key == cfg["escape_key"]:
                note("偵測到 ESC → 結束程式")
                break

            # 自我測試：回到 A 且 B 已播過 → 測試完成，結束
            if self_test and state == "A" and any("影片 B 播畢" in l for l in log):
                note("自我測試完成：A循環 → 空白鍵切B → B播畢回A，全部正確")
                break
    finally:
        src_a.release()
        src_b.release()
        cv2.destroyAllWindows()

    return 0 if not self_test or any("自我測試完成" in l for l in log) else 1


def main():
    ap = argparse.ArgumentParser(description="雙影片循環切換播放器")
    ap.add_argument("-c", "--config", default=str(Path(__file__).parent / "config.json"),
                    help="設定檔路徑（預設程式同目錄的 config.json）")
    ap.add_argument("--windowed", action="store_true", help="視窗模式（不全螢幕）")
    ap.add_argument("--self-test", action="store_true",
                    help="自動化自我測試：模擬按鍵並驗證 A→B→A 流程")
    args = ap.parse_args()

    cfg = load_config(args.config)
    sys.exit(run(cfg, windowed=args.windowed or args.self_test,
                 self_test=args.self_test))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
雙影片循環切換播放器（VLC 版，含聲音）— Raspberry Pi 5

行為：
  1. 啟動後全螢幕循環播放影片 A（預設 gifa），有聲音。
  2. 按下「Enter 鍵」→ 立即切換播放影片 B（預設 gifb）。
  3. 影片 B 播放完畢後 → 自動回到影片 A 繼續循環。
  4. Alt+F4（或關閉視窗）→ 強制結束程式；ESC 也可離開（可在 config 關閉）。

設定檔 config.json 可自訂影片路徑與全螢幕開關。

相依套件（PI5 已安裝）：
  sudo apt install vlc python3-vlc python3-tk

用法：
  python3 vlc_player.py                 # 全螢幕播放（正式使用）
  python3 vlc_player.py --windowed      # 視窗模式
  python3 vlc_player.py --self-test     # 自動化自我測試（模擬按鍵驗證 A→B→A）
"""

import argparse
import json
import os
import subprocess
import sys
import tkinter as tk
from pathlib import Path

import vlc

DEFAULT_CONFIG = {
    "video_a": "gifa.mp4",      # 影片 A：循環播放
    "video_b": "gifb.mp4",      # 影片 B：按Enter 鍵後播放一次
    "fullscreen": True,         # 全螢幕
    "escape_key_enabled": True, # ESC 是否可離開
    "self_test_seconds": 12,    # 自我測試：N 秒後自動結束
}


def load_config(cfg_path):
    cfg_path = Path(cfg_path).resolve()
    with open(cfg_path, encoding="utf-8") as f:
        cfg = dict(DEFAULT_CONFIG, **json.load(f))
    base = cfg_path.parent
    for key in ("video_a", "video_b"):
        p = Path(cfg[key])
        if not p.is_absolute():
            cfg[key] = str(base / p)
    return cfg


def ensure_playable(path):
    """VLC 對 GIF 只會當靜態圖片、不會播動畫也不會產生播畢事件。
    因此 GIF 一律先用 ffmpeg 轉成 mp4（快取在 __gifcache__），再交給 VLC 播放。"""
    p = Path(path)
    if p.suffix.lower() != ".gif":
        return str(p)
    cache_dir = p.parent / "__gifcache__"
    cache_dir.mkdir(exist_ok=True)
    out = cache_dir / (p.stem + ".mp4")
    if out.is_file() and out.stat().st_mtime >= p.stat().st_mtime:
        return str(out)
    print(f"轉換 GIF → mp4：{p.name}", flush=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(p),
         "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)],
        check=True)
    return str(out)


def kill_previous_instances():
    """關掉前一次沒退乾淨的殘留行程（重開黑屏的常見原因），排除自己。"""
    try:
        out = subprocess.run(["pgrep", "-f", "vlc_player.py"],
                             capture_output=True, text=True).stdout.split()
        for pid in out:
            if int(pid) != os.getpid():
                os.kill(int(pid), 9)
                print(f"清除殘留行程 PID {pid}", flush=True)
    except Exception:
        pass


class Player:
    def __init__(self, cfg, windowed=False, self_test=False):
        self.cfg = cfg
        self.self_test = self_test
        self.state = "A"
        self.elapsed_ticks = 0   # 每 100ms 一跳，供自我測試計時

        # --- 視窗（用來顯示影片與接收鍵盤事件）---
        self.root = tk.Tk()
        self.root.title("player")
        self.root.configure(bg="black")
        self.root.bind("<Return>", lambda e: self.play_b())
        if cfg["escape_key_enabled"]:
            self.root.bind("<Escape>", lambda e: self.quit())
        self.root.protocol("WM_DELETE_WINDOW", self.quit)  # Alt+F4 / 關閉鈕
        if cfg["fullscreen"] and not windowed:
            self.root.attributes("-fullscreen", True)

        self.video_frame = tk.Frame(self.root, bg="black")
        self.video_frame.pack(fill=tk.BOTH, expand=True)

        # --- VLC ---
        self.instance = vlc.Instance("--no-video-title-show", "--quiet")
        self.player = self.instance.media_player_new()

        # 等視窗真正顯示（Map 事件）後才嵌入 VLC 並開始播放，
        # 避免 VLC 輸出到尚未就緒的視窗導致黑屏（時好時壞的主因）
        self._mapped = False
        self.root.bind("<Map>", self._on_map)

    def _on_map(self, event):
        if self._mapped:
            return
        self._mapped = True
        self.root.update()
        # 視窗映射後稍候再嵌入 VLC，等合成器（Wayfire/XWayland）穩定
        self.root.after(300, self._start_playback)

    def _start_playback(self):
        self._attach_video()
        self.play_a()
        self.root.after(100, self.tick)

    def _attach_video(self):
        wid = self.video_frame.winfo_id()
        if sys.platform.startswith("win"):
            self.player.set_hwnd(wid)
        else:
            self.player.set_xwindow(wid)

    # ------------------------------------------------ 播放控制

    def _play(self, path):
        self._attach_video()  # 每次播放前重新指定輸出視窗，避免嵌入失效
        media = self.instance.media_new(path)
        self.player.set_media(media)
        self.player.play()

    def play_a(self):
        self.state = "A"
        self._play(self.cfg["video_a"])
        print("播放影片 A（循環）", flush=True)

    def play_b(self):
        if self.state == "B":
            return
        self.state = "B"
        self._play(self.cfg["video_b"])
        print("偵測到Enter 鍵 → 播放影片 B", flush=True)

    # ------------------------------------------------ 每 100ms 檢查狀態

    def tick(self):
        self.elapsed_ticks += 1

        # 自我測試：1 秒後模擬Enter 鍵；self_test_seconds 秒後自動結束
        if self.self_test:
            if self.elapsed_ticks == 10:
                print("（自我測試）模擬按下Enter 鍵", flush=True)
                self.play_b()
            if self.elapsed_ticks >= self.cfg["self_test_seconds"] * 10:
                ok = self.state == "A"
                print("自我測試" + ("通過" if ok else "失敗") +
                      f"：目前狀態={self.state}（應為 A）", flush=True)
                self.quit(exit_code=0 if ok else 1)
                return

        # 影片播完：A → 重播；B → 回 A
        state = self.player.get_state()
        if state in (vlc.State.Ended, vlc.State.Error):
            if self.state == "B":
                print("影片 B 播畢 → 回到影片 A", flush=True)
            self.play_a()
        else:
            self._watchdog(state)

        self.root.after(100, self.tick)

    # ------------------------------------------------ 看門狗

    def _watchdog(self, state):
        """偵測異常卡住（Opened/Stopped/播放中但時間不動）並自動重播。"""
        now_playing = state == vlc.State.Playing
        t = self.player.get_time() if now_playing else -1
        stuck = (state in (vlc.State.Stopped, vlc.State.Opening)
                 or (now_playing and t == getattr(self, "_last_t", -2)))
        if stuck:
            self._stuck_ticks = getattr(self, "_stuck_ticks", 0) + 1
        else:
            self._stuck_ticks = 0
        self._last_t = t
        if self._stuck_ticks >= 50:  # 連續 5 秒異常 → 重播目前影片
            print("偵測到播放異常，自動重播", flush=True)
            self._stuck_ticks = 0
            self.play_a() if self.state == "A" else self.play_b_force()

    def play_b_force(self):
        self.state = "A"  # 讓 play_b 不被同狀態檢查擋下
        self.play_b()

    def quit(self, exit_code=0):
        print("結束程式", flush=True)
        try:
            self.player.stop()
            self.player.release()
            self.instance.release()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass
        # 硬性退出，確保 VLC 執行緒不殘留（避免下次重開黑屏）
        os._exit(exit_code)

    def run(self):
        self.root.mainloop()


def main():
    ap = argparse.ArgumentParser(description="雙影片循環切換播放器（VLC 版，含聲音）")
    ap.add_argument("-c", "--config",
                    default=str(Path(__file__).parent / "config.json"),
                    help="設定檔路徑（預設程式同目錄的 config.json）")
    ap.add_argument("--windowed", action="store_true", help="視窗模式（不全螢幕）")
    ap.add_argument("--self-test", action="store_true",
                    help="自動化自我測試：模擬按鍵並驗證 A→B→A")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if not args.self_test:
        kill_previous_instances()
    for key in ("video_a", "video_b"):
        if not Path(cfg[key]).is_file():
            sys.exit(f"找不到影片：{cfg[key]}（請在 config.json 設定正確路徑）")
        cfg[key] = ensure_playable(cfg[key])  # GIF 預先轉 mp4，避免切換時延遲

    Player(cfg, windowed=args.windowed or args.self_test,
           self_test=args.self_test).run()


if __name__ == "__main__":
    main()

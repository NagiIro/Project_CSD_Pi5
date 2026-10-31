# -*- coding: utf-8 -*-
"""產生測試影片 gifa.mp4（藍色，3 秒）與 gifb.mp4（紅色，2 秒）。"""
import cv2
import numpy as np

W, H, FPS = 640, 360, 25

def make(path, color_bgr, seconds, label):
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    total = int(seconds * FPS)
    for i in range(total):
        f = np.full((H, W, 3), color_bgr, dtype=np.uint8)
        cv2.putText(f, f"{label} {i}/{total}", (20, 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
        vw.write(f)
    vw.release()
    print("已產生", path)

make("gifa.mp4", (200, 60, 30), 3.0, "A")
make("gifb.mp4", (30, 40, 220), 2.0, "B")

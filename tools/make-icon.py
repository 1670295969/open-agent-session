#!/usr/bin/env python3
"""生成 agenthist 图标（PNG + 多尺寸 ICO + macOS ICNS）

为什么不直接塞 SVG：
  Windows 快捷方式的 IconLocation 只认 .ico/.exe/.dll；
  macOS 的 .app 只认 .icns（放在 Contents/Resources 里）。
两者都不认 SVG。所以这里按 Linux 版 SVG 的同一套视觉（蓝紫渐变窗口 + 绿色对勾角标）
重画一份位图，再分别打包成 .ico 与 .icns。

用法：
    python tools/make-icon.py
输出：
    assets/agenthist.ico      多尺寸（16/24/32/48/64/128/256）
    assets/agenthist.icns     macOS 图标（含 1024，Retina 大图标靠它）
    assets/agenthist-256.png  用于文档与 README
"""
import io
import os
import struct
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

# 与 SVG 主色一致
C1 = (61, 90, 254)    # #3d5afe
C2 = (124, 77, 255)   # #7c4dff
DARK = (42, 54, 177)  # #2a36b1 底座
GREEN = (0, 200, 83)  # #00c853
WHITE = (255, 255, 255)

SIZES = [16, 24, 32, 48, 64, 128, 256]

# ICNS 里各尺寸用的 OSType。macOS 10.7+ 起允许这些块直接装 PNG 数据，
# 不必再用老的 RGB/RLE 编码 —— 体积小、跨版本都认。
#   16@1x=icp4  16@2x=ic11   32@1x=icp5  32@2x=ic12
#   128@1x=ic07 128@2x=ic13  256@1x=ic08 256@2x=ic14
#   512@1x=ic09 512@2x=ic10
ICNS_SLOTS = [
    ("icp4", 16), ("icp5", 32), ("icp6", 64),
    ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024),
    ("ic11", 32), ("ic12", 64), ("ic13", 256), ("ic14", 512),
]


def gradient(size):
    """沿对角线做线性渐变，用逐行插值近似（对角方向用 x+y 参数化）"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1)) if size > 1 else 0
            px[x, y] = (
                round(C1[0] + (C2[0] - C1[0]) * t),
                round(C1[1] + (C2[1] - C1[1]) * t),
                round(C1[2] + (C2[2] - C1[2]) * t),
            )
    return img


def render(size):
    # 4 倍超采样后缩小，边缘抗锯齿（小尺寸下尤其明显）
    S = size * 4
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 渐变窗口主体：占 3..61 / 64 的比例，与 SVG 的 rect x=3 y=6 w=58 h=46 对应
    u = S / 64.0
    win = (round(3 * u), round(6 * u), round(61 * u), round(52 * u))
    body = gradient(S).crop(win)
    mask = Image.new("L", (win[2] - win[0], win[3] - win[1]), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, mask.width - 1, mask.height - 1), radius=round(7 * u), fill=255
    )
    canvas.paste(body, (win[0], win[1]), mask)

    d = ImageDraw.Draw(canvas)

    # 四条内容线（opacity .95/.8/.65/.5 换成与底色混合后的实色）
    lines = [
        (11, 15, 26, 0.95),
        (11, 23, 40, 0.80),
        (11, 31, 33, 0.65),
        (11, 39, 20, 0.50),
    ]
    for x, y, w, op in lines:
        col = tuple(round(255 * op + c * (1 - op)) for c in (70, 84, 255))
        d.rounded_rectangle(
            (round(x * u), round(y * u), round((x + w) * u), round((y + 3.4) * u)),
            radius=round(1.7 * u), fill=col + (255,),
        )

    # 显示器底座
    d.polygon(
        [(round(20 * u), round(52 * u)), (round(44 * u), round(52 * u)),
         (round(40 * u), round(59 * u)), (round(24 * u), round(59 * u))],
        fill=DARK + (255,),
    )

    # 绿色对勾角标（带白描边，压在右下角）
    cx, cy, r = 52 * u, 50 * u, 10 * u
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=GREEN + (255,),
              outline=WHITE + (255,), width=max(1, round(2.5 * u)))
    d.line(
        [(round(47.5 * u), round(50.2 * u)), (round(50.7 * u), round(53.4 * u)),
         (round(56.7 * u), round(47 * u))],
        fill=WHITE + (255,), width=max(1, round(3 * u)), joint="curve",
    )

    return canvas.resize((size, size), Image.LANCZOS)


def write_icns(path, cache):
    """按 ICNS 容器格式手写文件。

    结构（全大端）：
        'icns' + 总长度(4B)
        然后若干个块：OSType(4B) + 块长度(4B, 含这 8 字节头) + 数据

    为什么手写而不调 iconutil：iconutil 只在 macOS 上存在，
    这样在 Linux 上也能生成、也能校验产物，不必把打包动作绑到某个平台。

    cache 是 {size: Image}，同一尺寸只渲染一次（ic11 与 icp5 都是 32px）。
    块按 OSType 升序排列——Apple 自己的 icns 就是这个顺序，便于肉眼比对。
    """
    chunks = []
    for ostype, size in sorted(ICNS_SLOTS):
        if size not in cache:
            cache[size] = render(size)
        buf = io.BytesIO()
        cache[size].save(buf, format="PNG")
        data = buf.getvalue()
        chunks.append((ostype.encode("ascii"), data))

    body = b"".join(
        t + struct.pack(">I", len(d) + 8) + d for t, d in chunks
    )
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def verify_icns(path):
    """回读校验：magic、总长度、每块长度自洽、负载是合法 PNG。"""
    raw = open(path, "rb").read()
    assert raw[:4] == b"icns", "magic 不对"
    total = struct.unpack(">I", raw[4:8])[0]
    assert total == len(raw), "总长度字段 %d 与文件实际 %d 不一致" % (total, len(raw))
    pos, found = 8, []
    while pos < total:
        ostype = raw[pos:pos + 4].decode("ascii")
        clen = struct.unpack(">I", raw[pos + 4:pos + 8])[0]
        assert clen >= 8 and pos + clen <= total, "块 %s 长度越界" % ostype
        payload = raw[pos + 8:pos + clen]
        assert payload[:8] == b"\x89PNG\r\n\x1a\n", "块 %s 不是 PNG" % ostype
        found.append((ostype, clen))
        pos += clen
    assert pos == total, "块长度之和与总长度不符"
    return found


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cache = {s: render(s) for s in SIZES}

    ico = os.path.join(OUT_DIR, "agenthist.ico")
    # 最大尺寸作主图，其余进多尺寸序列
    cache[256].save(ico, format="ICO", sizes=[(s, s) for s in SIZES])
    png = os.path.join(OUT_DIR, "agenthist-256.png")
    cache[256].save(png, format="PNG")

    icns = os.path.join(OUT_DIR, "agenthist.icns")
    write_icns(icns, cache)
    found = verify_icns(icns)

    print("生成:", ico, os.path.getsize(ico), "bytes")
    print("生成:", png, os.path.getsize(png), "bytes")
    print("生成:", icns, os.path.getsize(icns), "bytes")
    print("ICO 尺寸:", SIZES)
    print("ICNS 块:", ", ".join("%s=%dB" % (t, n) for t, n in found))


if __name__ == "__main__":
    main()

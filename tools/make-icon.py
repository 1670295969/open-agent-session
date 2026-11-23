#!/usr/bin/env python3
"""生成 opensession 图标（PNG + 多尺寸 ICO + macOS ICNS）

为什么不直接塞 SVG：
  Windows 快捷方式的 IconLocation 只认 .ico/.exe/.dll；
  macOS 的 .app 只认 .icns（放在 Contents/Resources 里）。
两者都不认 SVG。所以这里按同一份矢量设计重画位图，再打包成 .ico 与 .icns。

设计约束（2026-11-23 重做，起因是旧图在 16px 下糊成一团）：
  · 满版渐变圆角底 —— 小尺寸下最易识别的形状是「色块」，不是线条。
  · 白色气泡占画面 62% —— 留白越少，里面的元素越小尺寸越清楚。
  · 气泡内部只放两条粗横条 —— 旧版 4 条细线（3.4/64 ≈ 0.85px @16px）必然糊。
    实测 16px 下：4 条细线糊成灰带；3 个圆点黏成一条毛边横杠；
    两条 6.5 高、间隙 4.5 的横条仍可分辨，故采用。
  · 去掉旧版的绿色对勾角标 —— 直径 20/64 的角标在 16px 下只剩 5px 绿点，
    既看不清，语义（"完成/正确"）也与「会话聚合」无关。
  · 去掉显示器底座 —— 与气泡重叠，小尺寸下变成一团深色。

用法：
    python tools/make-icon.py
输出：
    assets/opensession.ico      多尺寸（16/24/32/48/64/128/256）
    assets/opensession.icns     macOS 图标（含 1024，Retina 大图标靠它）
    assets/opensession-256.png  用于文档与 README
"""
import io
import os
import struct
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

# 渐变底：靛蓝 → 紫，与 install.sh 内嵌 SVG、public/favicon.svg 保持同一份配色
C1 = (61, 90, 254)    # #3d5afe
C2 = (124, 77, 255)   # #7c4dff
INK = (46, 40, 190)   # #2e28be 气泡内横条
WHITE = (255, 255, 255)

SIZES = [16, 24, 32, 48, 64, 128, 256]

# 64x64 设计网格上的几何参数（与 SVG 一一对应，改一处要三处同步）
BG = (3.0, 3.0, 61.0, 61.0)   # 满版底
BG_R = 14.0
BUBBLE = (11.0, 12.0, 53.0, 48.0)
BUBBLE_R = 9.5
TAIL = ((20.0, 44.0), (35.0, 44.0), (23.0, 56.0))
BARS = [(19.5, 20.6, 25.5, 6.5), (19.5, 31.4, 17.5, 6.5)]  # x, y, w, h

# ICNS 里各尺寸用的 OSType。macOS 10.7+ 起允许这些块直接装 PNG 数据，
# 不必再用老的 RGB/RLE 编码 —— 体积小、跨版本都认。
#   16@1x=icp4  32@1x=icp5  64@1x=icp6
#   128@1x=ic07 256@1x=ic08 512@1x=ic09 1024@1x=ic10
#   16@2x=ic11  32@2x=ic12  128@2x=ic13 256@2x=ic14
ICNS_SLOTS = [
    ("icp4", 16), ("icp5", 32), ("icp6", 64),
    ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024),
    ("ic11", 32), ("ic12", 64), ("ic13", 256), ("ic14", 512),
]


def gradient(size):
    """沿对角线做线性渐变，用 x+y 参数化后逐像素插值。"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    d = max(1, 2 * (size - 1))
    for y in range(size):
        for x in range(size):
            t = (x + y) / d
            px[x, y] = tuple(round(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
    return img


def render(size):
    # 4 倍超采样后缩小，边缘抗锯齿（16px 下差别极明显）
    S = size * 4
    u = S / 64.0
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 满版渐变底：先把整个画布铺满渐变，再用圆角矩形遮罩裁出来
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        tuple(v * u for v in BG), radius=BG_R * u, fill=255
    )
    canvas.paste(gradient(S), (0, 0), mask)

    d = ImageDraw.Draw(canvas)

    # 白色气泡 + 左下尾巴（先画尾巴再画气泡，让气泡圆角盖住接缝）
    d.polygon([(x * u, y * u) for x, y in TAIL], fill=WHITE + (255,))
    d.rounded_rectangle(
        tuple(v * u for v in BUBBLE), radius=BUBBLE_R * u, fill=WHITE + (255,)
    )

    # 两条粗横条
    for x, y, w, h in BARS:
        d.rounded_rectangle(
            (x * u, y * u, (x + w) * u, (y + h) * u),
            radius=(h / 2) * u, fill=INK + (255,),
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
        chunks.append((ostype.encode("ascii"), buf.getvalue()))

    body = b"".join(t + struct.pack(">I", len(d) + 8) + d for t, d in chunks)
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

    ico = os.path.join(OUT_DIR, "opensession.ico")
    # 最大尺寸作主图，其余进多尺寸序列
    cache[256].save(ico, format="ICO", sizes=[(s, s) for s in SIZES])
    png = os.path.join(OUT_DIR, "opensession-256.png")
    cache[256].save(png, format="PNG")

    icns = os.path.join(OUT_DIR, "opensession.icns")
    write_icns(icns, cache)
    found = verify_icns(icns)

    print("生成:", ico, os.path.getsize(ico), "bytes")
    print("生成:", png, os.path.getsize(png), "bytes")
    print("生成:", icns, os.path.getsize(icns), "bytes")
    print("ICO 尺寸:", SIZES)
    print("ICNS 块:", ", ".join("%s=%dB" % (t, n) for t, n in found))


if __name__ == "__main__":
    main()

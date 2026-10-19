#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
工具：生成扩展图标与演示用图片（纯标准库，无需 Pillow）。

用法：
    python tools/make_icons.py

产出：
    assets/icons/icon16.png / icon48.png / icon128.png   扩展图标
    demo/assets/photo.png                                演示页大图（山景）
    demo/assets/avatar.png                               演示页小图（圆形徽标）

实现说明（维护者必读）：
    1. 直接手写最小 PNG 编码器（zlib + struct），避免引入第三方依赖；
    2. 4 倍超采样抗锯齿：先在 4 倍分辨率逐点求值，再按"预乘 alpha"平均降采样；
    3. 所有图形都用数学函数定义（圆角矩形 / 圆 / 多边形），
       想调整造型只改下面的坐标参数即可，不必碰编码器。
"""
import os
import struct
import zlib

# ======================================================================
# 最小 PNG 编码器（RGBA8，无隔行）
# ======================================================================

def write_png(path, width, height, pixel_fn):
    """把 pixel_fn(x, y) -> (r, g, b, a) 的逐像素函数编码为 PNG 文件。

    Args:
        path: 输出文件路径（自动创建父目录）
        width: 图像宽度（像素）
        height: 图像高度（像素）
        pixel_fn: 逐像素颜色函数，x/y 为 0 起始的整数坐标
    """
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # 每行前的过滤器类型字节（0 = None）
        for x in range(width):
            r, g, b, a = pixel_fn(x, y)
            raw += bytes((r & 0xFF, g & 0xFF, b & 0xFF, a & 0xFF))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)


def render(width, height, ss, color_at):
    """带超采样抗锯齿的渲染器。

    Args:
        width: 输出宽度（像素）
        height: 输出高度（像素）
        ss: 超采样倍数（每像素采样 ss×ss 次）
        color_at: (u, v) -> (r, g, b, a)，u/v 为 [0, 1] 归一化坐标
    Returns:
        pixel_fn，可直接交给 write_png
    """
    def pixel_fn(x, y):
        sr = sg = sb = sa = 0.0
        for j in range(ss):
            for i in range(ss):
                u = (x + (i + 0.5) / ss) / width
                v = (y + (j + 0.5) / ss) / height
                pr, pg, pb, pa = color_at(u, v)
                sr += pr * pa
                sg += pg * pa
                sb += pb * pa
                sa += pa
        n = ss * ss
        a = sa / n
        if a < 1.0 / 255:
            return (0, 0, 0, 0)
        # 预乘 alpha 平均，避免边缘发暗
        return (int(sr / sa + 0.5), int(sg / sa + 0.5), int(sb / sa + 0.5), int(a * 255 + 0.5))
    return pixel_fn


# ======================================================================
# 基础图形判定（归一化坐标）
# ======================================================================

def in_rounded_rect(u, v, x0, y0, x1, y1, r):
    """点是否在圆角矩形内。"""
    if not (x0 <= u <= x1 and y0 <= v <= y1):
        return False
    cx = min(max(u, x0 + r), x1 - r)
    cy = min(max(v, y0 + r), y1 - r)
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r


def in_circle(u, v, cx, cy, r):
    """点是否在圆内。"""
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r


def in_poly(u, v, pts):
    """点是否在多边形内（射线法）。pts 为 [(x, y), ...]，自动闭合。"""
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > v) != (y2 > v):
            x_cross = x1 + (v - y1) / (y2 - y1) * (x2 - x1)
            if u < x_cross:
                inside = not inside
    return inside


def lerp_color(c1, c2, t):
    """两个 RGB 颜色按 t 线性插值。"""
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t + 0.5) for i in range(3))


# ======================================================================
# 造型定义
# ======================================================================

# 扩展图标：蓝紫渐变圆角底 + 白色"照片"图形（边框 + 太阳 + 山）
ICON_BG_TOP = (59, 130, 246)    # 顶部蓝
ICON_BG_BOTTOM = (139, 92, 246)  # 底部紫
ICON_GLYPH = (255, 255, 255)     # 图形白

# 照片图形参数（归一化坐标）
_FRAME_OUTER = (0.27, 0.27, 0.73, 0.73)  # 外框 x0,y0,x1,y1
_FRAME_RADIUS = 0.09
_FRAME_STROKE = 0.05
_SUN_CENTER = (0.585, 0.40)
_SUN_RADIUS = 0.052
_MOUNTAIN = [(0.35, 0.65), (0.46, 0.45), (0.545, 0.56), (0.60, 0.515), (0.68, 0.65)]


def icon_color_at(u, v):
    """扩展图标的逐点颜色。"""
    # 1) 圆角矩形背景（渐变）
    if not in_rounded_rect(u, v, 0.04, 0.04, 0.96, 0.96, 0.22):
        return (0, 0, 0, 0)  # 圆角外透明
    r, g, b = lerp_color(ICON_BG_TOP, ICON_BG_BOTTOM, v)

    # 2) 白色图形：边框（外框减内框）+ 太阳 + 山
    ox0, oy0, ox1, oy1 = _FRAME_OUTER
    s = _FRAME_STROKE
    in_outer = in_rounded_rect(u, v, ox0, oy0, ox1, oy1, _FRAME_RADIUS)
    in_inner = in_rounded_rect(u, v, ox0 + s, oy0 + s, ox1 - s, oy1 - s, _FRAME_RADIUS - s)
    in_frame = in_outer and not in_inner
    in_sun = in_circle(u, v, _SUN_CENTER[0], _SUN_CENTER[1], _SUN_RADIUS)
    in_mountain = in_poly(u, v, _MOUNTAIN)
    if in_frame or in_sun or in_mountain:
        return ICON_GLYPH + (255,)
    return (r, g, b, 255)


# 演示大图：山景（蓝天渐变 + 太阳 + 三层山 + 草地）
_PHOTO_SKY_TOP = (126, 200, 242)
_PHOTO_SKY_BOTTOM = (207, 234, 251)
_PHOTO_SUN = (255, 224, 102)
_PHOTO_MOUNTAIN_FAR = (159, 180, 204)
_PHOTO_MOUNTAIN_MID = (110, 143, 173)
_PHOTO_MOUNTAIN_NEAR = (70, 103, 127)
_PHOTO_GROUND = (62, 92, 67)
_PHOTO_MOUNTAIN_FAR_POLY = [(0.0, 0.78), (0.12, 0.45), (0.28, 0.62), (0.45, 0.38), (0.62, 0.60), (0.80, 0.42), (1.0, 0.66)]
_PHOTO_MOUNTAIN_MID_POLY = [(0.0, 0.78), (0.20, 0.55), (0.38, 0.70), (0.58, 0.50), (0.78, 0.68), (1.0, 0.56)]
_PHOTO_MOUNTAIN_NEAR_POLY = [(0.0, 0.78), (0.15, 0.62), (0.35, 0.76), (0.60, 0.60), (0.85, 0.74), (1.0, 0.66)]


def photo_color_at(u, v):
    """演示大图（960x600）的逐点颜色。"""
    if v >= 0.78:
        return _PHOTO_GROUND + (255,)
    r, g, b = lerp_color(_PHOTO_SKY_TOP, _PHOTO_SKY_BOTTOM, v / 0.78)
    if in_circle(u, v, 0.80, 0.20, 0.065):
        return _PHOTO_SUN + (255,)
    if in_poly(u, v, _PHOTO_MOUNTAIN_FAR_POLY + [(1.0, 0.78), (0.0, 0.78)]):
        return _PHOTO_MOUNTAIN_FAR + (255,)
    if in_poly(u, v, _PHOTO_MOUNTAIN_MID_POLY + [(1.0, 0.78), (0.0, 0.78)]):
        return _PHOTO_MOUNTAIN_MID + (255,)
    if in_poly(u, v, _PHOTO_MOUNTAIN_NEAR_POLY + [(1.0, 0.78), (0.0, 0.78)]):
        return _PHOTO_MOUNTAIN_NEAR + (255,)
    return (r, g, b, 255)


# 演示小图：圆形徽标（渐变圆 + 白环 + 白山）
_AVATAR_MOUNTAIN = [(0.26, 0.70), (0.42, 0.42), (0.52, 0.58), (0.60, 0.48), (0.74, 0.70)]


def avatar_color_at(u, v):
    """演示小图（256x256）的逐点颜色。"""
    if not in_circle(u, v, 0.5, 0.5, 0.48):
        return (0, 0, 0, 0)
    r, g, b = lerp_color(ICON_BG_TOP, ICON_BG_BOTTOM, v)
    # 白色圆环
    if in_circle(u, v, 0.5, 0.5, 0.40) and not in_circle(u, v, 0.5, 0.5, 0.37):
        return ICON_GLYPH + (255,)
    if in_poly(u, v, _AVATAR_MOUNTAIN):
        return ICON_GLYPH + (255,)
    return (r, g, b, 255)


# ======================================================================
# 入口
# ======================================================================

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # 1) 扩展图标（4 倍超采样）
    for size in (16, 48, 128):
        path = os.path.join(root, 'assets', 'icons', 'icon%d.png' % size)
        write_png(path, size, size, render(size, size, 4, icon_color_at))
        print('生成图标: %s' % path)

    # 2) 演示大图（960x600，2 倍超采样）
    path = os.path.join(root, 'demo', 'assets', 'photo.png')
    write_png(path, 960, 600, render(960, 600, 2, photo_color_at))
    print('生成演示图: %s' % path)

    # 3) 演示小图（256x256，4 倍超采样）
    path = os.path.join(root, 'demo', 'assets', 'avatar.png')
    write_png(path, 256, 256, render(256, 256, 4, avatar_color_at))
    print('生成演示图: %s' % path)


if __name__ == '__main__':
    main()

# -*- coding: utf-8 -*-
"""
生成线条风格图标（替代 emoji），输出到 images/ 目录。
画法：24x24 归一化网格 → 超采样绘制 → LANCZOS 缩放，得到平滑抗锯齿的透明 PNG。
用法：python tools/gen-icons.py
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'images')
SS = 8  # 超采样倍数

# ---------- 调色板 ----------
WHITE = (255, 255, 255, 255)
NAVY = (15, 23, 42, 255)
SLATE = (100, 116, 139, 255)
BRAND = (37, 99, 235, 255)
CYAN = (6, 182, 212, 255)


class Canvas:
    """在 24x24 归一化坐标上作画。"""

    def __init__(self, size=96):
        self.out = size
        self.k = (size * SS) / 24.0
        self.img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    def p(self, x, y):
        return (x * self.k, y * self.k)

    def line(self, pts, w=1.8, color=NAVY, cap=True):
        xy = [self.p(*q) for q in pts]
        self.d.line(xy, fill=color, width=int(w * self.k), joint='curve')
        if cap:
            r = w * self.k / 2.0
            for (x, y) in (xy[0], xy[-1]):
                self.d.ellipse([x - r, y - r, x + r, y + r], fill=color)

    def rect(self, x0, y0, x1, y1, w=1.8, color=NAVY, r=0):
        if r:
            self.d.rounded_rectangle(
                [self.p(x0, y0), self.p(x1, y1)],
                radius=r * self.k, outline=color, width=int(w * self.k))
        else:
            self.d.rectangle(
                [self.p(x0, y0), self.p(x1, y1)],
                outline=color, width=int(w * self.k))

    def circle(self, cx, cy, r, w=1.8, color=NAVY, fill=None):
        box = [self.p(cx - r, cy - r), self.p(cx + r, cy + r)]
        self.d.ellipse(box, outline=color if w else None,
                       width=int(w * self.k) if w else 0, fill=fill)

    def dot(self, cx, cy, r, color=NAVY):
        self.d.ellipse([self.p(cx - r, cy - r), self.p(cx + r, cy + r)], fill=color)

    def ellipse(self, x0, y0, x1, y1, w=1.8, color=NAVY, fill=None):
        """外接矩形形式的椭圆（数据库圆柱顶盖等场景）。"""
        box = [self.p(x0, y0), self.p(x1, y1)]
        self.d.ellipse(box, outline=color if w else None,
                       width=int(w * self.k) if w else 0, fill=fill)

    def arc(self, x0, y0, x1, y1, a0, a1, w=1.8, color=NAVY):
        self.d.arc([self.p(x0, y0), self.p(x1, y1)], a0, a1,
                   fill=color, width=int(w * self.k))

    def poly(self, pts, w=1.8, color=NAVY):
        xy = [self.p(*q) for q in pts]
        self.d.line(xy + [xy[0]], fill=color, width=int(w * self.k), joint='curve')

    def save(self, name):
        out = self.img.resize((self.out, self.out), Image.LANCZOS)
        out.save(os.path.join(OUT, name + '.png'))
        return name


# ---------- 单个图标定义 ----------
def i_scan(c, col):
    # 四角扫描框 + 中心横线
    c.line([(4, 9), (4, 4.6), (8.4, 4.6)], 1.8, col)
    c.line([(15.6, 4.6), (20, 4.6), (20, 9)], 1.8, col)
    c.line([(20, 15), (20, 19.4), (15.6, 19.4)], 1.8, col)
    c.line([(8.4, 19.4), (4, 19.4), (4, 15)], 1.8, col)
    c.line([(6.6, 12), (17.4, 12)], 1.9, col)


def i_qr(c, col):
    c.rect(3.2, 3.2, 9.2, 9.2, 1.8, col, r=1.4)
    c.rect(14.8, 3.2, 20.8, 9.2, 1.8, col, r=1.4)
    c.rect(3.2, 14.8, 9.2, 20.8, 1.8, col, r=1.4)
    c.dot(6.2, 6.2, 1.15, col)
    c.dot(17.8, 6.2, 1.15, col)
    c.dot(6.2, 17.8, 1.15, col)
    c.line([(13.4, 13.4), (20.8, 13.4)], 1.8, col)
    c.line([(13.4, 13.4), (13.4, 20.8)], 1.8, col)
    c.dot(17.4, 17.4, 1.15, col)
    c.dot(20.4, 20.4, 1.15, col)


def i_box(c, col):
    c.poly([(12, 3), (20.5, 7.2), (20.5, 16.8), (12, 21), (3.5, 16.8), (3.5, 7.2)], 1.8, col)
    c.line([(3.5, 7.2), (12, 11.4), (20.5, 7.2)], 1.6, col)
    c.line([(12, 11.4), (12, 21)], 1.6, col)


def i_tool(c, col):
    # 螺丝刀：刀杆 + 刀头 + 手柄
    c.line([(6.2, 19.4), (16.4, 9.2)], 2.0, col)
    c.line([(14.6, 6.6), (19.4, 3.6)], 1.9, col)
    c.line([(16.4, 9.2), (19.4, 12.2)], 1.9, col)
    c.line([(16.4, 9.2), (13.4, 6.2)], 1.9, col)
    c.line([(3.4, 17.6), (6.2, 20.4)], 2.0, col)
    c.line([(4.6, 19.4), (6.2, 20.4), (5.4, 21.6)], 1.8, col)


def i_clipboard(c, col):
    c.rect(5, 4.6, 19, 21, 1.8, col, r=2.2)
    c.rect(8.6, 2.4, 15.4, 6.2, 1.7, col, r=1.4)
    c.line([(8.6, 13), (11, 15.6), (15.6, 10.2)], 2.0, col)


def i_swap(c, col):
    c.line([(4, 8.6), (19, 8.6)], 1.9, col)
    c.poly([(19, 5.4), (22, 8.6), (19, 11.8)], 1.7, col)
    c.line([(20, 15.4), (5, 15.4)], 1.9, col)
    c.poly([(5, 12.2), (2, 15.4), (5, 18.6)], 1.7, col)


def i_chart(c, col):
    c.line([(3.6, 3.4), (3.6, 20.4), (20.8, 20.4)], 1.8, col)
    c.rect(6.4, 12.4, 9.6, 18.6, 1.7, col, r=0.8)
    c.rect(11.4, 8.4, 14.6, 18.6, 1.7, col, r=0.8)
    c.rect(16.4, 5.2, 19.6, 18.6, 1.7, col, r=0.8)


def i_user(c, col):
    c.circle(12, 8, 3.9, 1.8, col)
    c.arc(4.4, 13.6, 19.6, 25.6, 180, 360, 1.8, col)


def i_users(c, col):
    # 后排一人（完整上半身）+ 前排一人
    c.circle(16.4, 7.2, 3.0, 1.7, col)
    c.arc(10.6, 11.4, 22.2, 20.6, 190, 350, 1.7, col)
    c.circle(8.6, 9.2, 3.6, 1.8, col)
    c.arc(1.8, 14.4, 15.4, 25.6, 185, 355, 1.8, col)


def i_search(c, col):
    c.circle(10.6, 10.6, 6.4, 1.9, col)
    c.line([(15.4, 15.4), (20.4, 20.4)], 2.0, col)


def i_logout(c, col):
    # 门框 + 向外出箭头
    c.line([(13.4, 3.4), (5.4, 3.4), (5.4, 20.6), (13.4, 20.6)], 1.8, col)
    c.line([(10.4, 12), (20.4, 12)], 1.9, col)
    c.poly([(20.6, 8.4), (23.4, 12), (20.6, 15.6)], 1.7, col)


def i_chevron(c, col):
    c.line([(9.4, 5.4), (16, 12), (9.4, 18.6)], 2.0, col)


def i_check(c, col):
    c.line([(4.8, 12.6), (9.6, 17.4), (19.2, 6.8)], 2.2, col)


def i_close(c, col):
    c.line([(6, 6), (18, 18)], 2.1, col)
    c.line([(18, 6), (6, 18)], 2.1, col)


def i_bolt(c, col):
    c.poly([(13.4, 2.4), (5.6, 13.4), (11.2, 13.4), (10.2, 21.6),
            (18.4, 10.4), (12.8, 10.4)], 1.8, col)


def i_shield(c, col):
    c.poly([(12, 2.8), (20, 5.8), (20, 11.4), (12, 21.2),
            (4, 11.4), (4, 5.8)], 1.8, col)
    c.line([(8.6, 11.8), (11, 14.4), (15.6, 9)], 1.9, col)


def i_clock(c, col):
    c.circle(12, 12, 8.6, 1.8, col)
    c.line([(12, 6.8), (12, 12.4), (16, 14.6)], 1.9, col)


def i_alert(c, col):
    c.poly([(12, 3.4), (21.6, 20.2), (2.4, 20.2)], 1.8, col)
    c.line([(12, 9.4), (12, 14)], 1.9, col)
    c.dot(12, 17, 0.85, col)


def i_plus(c, col):
    c.line([(12, 5), (12, 19)], 2.1, col)
    c.line([(5, 12), (19, 12)], 2.1, col)


def i_minus(c, col):
    c.line([(5, 12), (19, 12)], 2.1, col)


def i_grid(c, col):
    c.rect(3.4, 3.4, 10.6, 10.6, 1.8, col, r=1.8)
    c.rect(13.4, 3.4, 20.6, 10.6, 1.8, col, r=1.8)
    c.rect(3.4, 13.4, 10.6, 20.6, 1.8, col, r=1.8)
    c.rect(13.4, 13.4, 20.6, 20.6, 1.8, col, r=1.8)


def i_doc(c, col):
    c.poly([(5.4, 2.8), (14.4, 2.8), (18.8, 7.4), (18.8, 21.2), (5.4, 21.2)], 1.8, col)
    c.line([(14.2, 3), (14.2, 7.8), (18.6, 7.8)], 1.6, col)
    c.line([(8.6, 13), (15.6, 13)], 1.6, col)
    c.line([(8.6, 16.8), (15.6, 16.8)], 1.6, col)


def i_db(c, col):
    c.ellipse(4.4, 3.4, 19.6, 8.4, 1.8, col)
    c.line([(4.4, 5.9), (4.4, 18.1)], 1.7, col)
    c.line([(19.6, 5.9), (19.6, 18.1)], 1.7, col)
    c.arc(4.4, 12.6, 19.6, 17.6, 0, 180, 1.7, col)
    c.arc(4.4, 8.1, 19.6, 13.1, 0, 180, 1.7, col)


def i_log(c, col):
    c.rect(3.6, 4.4, 20.4, 19.6, 1.8, col, r=2.4)
    c.line([(7.4, 9), (16.6, 9)], 1.7, col)
    c.line([(7.4, 12.6), (16.6, 12.6)], 1.7, col)
    c.line([(7.4, 16.2), (13.4, 16.2)], 1.7, col)


def i_inbox(c, col):
    c.poly([(3, 13.6), (6, 5.2), (18, 5.2), (21, 13.6)], 1.8, col)
    c.poly([(3, 13.6), (3, 20), (21, 20), (21, 13.6)], 1.8, col)
    c.line([(3, 13.6), (9, 13.6)], 1.7, col)
    c.line([(15, 13.6), (21, 13.6)], 1.7, col)
    c.line([(9, 13.6), (10.8, 16.4), (13.2, 16.4), (15, 13.6)], 1.7, col)


def i_target(c, col):
    c.circle(12, 12, 8.6, 1.8, col)
    c.circle(12, 12, 4.6, 1.8, col)
    c.dot(12, 12, 1.5, col)


def i_link(c, col):
    # 链条：两个交错的圆角环
    c.arc(2.6, 7.6, 14.4, 19.4, 60, 300, 1.9, col)
    c.arc(9.6, 4.6, 21.4, 16.4, 240, 120, 1.9, col)
    c.line([(9.6, 16.6), (14.4, 7.4)], 1.8, col)


ICONS = [
    ('scan', i_scan), ('qr', i_qr), ('box', i_box), ('tool', i_tool),
    ('clipboard', i_clipboard), ('swap', i_swap), ('chart', i_chart),
    ('user', i_user), ('users', i_users), ('search', i_search),
    ('logout', i_logout), ('chevron', i_chevron), ('check', i_check),
    ('close', i_close), ('bolt', i_bolt), ('shield', i_shield),
    ('clock', i_clock), ('alert', i_alert), ('plus', i_plus),
    ('minus', i_minus), ('grid', i_grid), ('doc', i_doc), ('db', i_db),
    ('log', i_log), ('inbox', i_inbox), ('target', i_target), ('link', i_link),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    n = 0
    for name, fn in ICONS:
        for tag, col in (('w', WHITE), ('d', NAVY), ('b', BRAND),
                         ('c', CYAN), ('s', SLATE)):
            c = Canvas(96)
            fn(c, col)
            c.save('ic-%s-%s' % (name, tag))
            n += 1
    # tabBar 图标：81x81，灰(未选) / 蓝(选中)
    for name in ('scan', 'user'):
        for tag, col in (('off', SLATE), ('on', BRAND)):
            c = Canvas(81)
            (i_scan if name == 'scan' else i_user)(c, col)
            c.save('tab-%s-%s' % (name, tag))
            n += 1
    print('生成图标 %d 个 → %s' % (n, os.path.abspath(OUT)))


if __name__ == '__main__':
    main()

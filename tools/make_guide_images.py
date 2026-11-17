# -*- coding: utf-8 -*-
"""
make_guide_images.py —— 生成操作指南配图（界面示意图，非真机截图）
================================================================================
依据小程序真实 WXML/WXSS 的文案、结构与配色绘制，用于《学生与教师操作指南》。
输出到 docs/guide-images/*.png（2x 分辨率，750x1624）。

⚠️ 这些是「界面示意图」，不是真机截图；文档中已明确标注。
   如需真机截图，可在微信开发者工具/真机截图后同名替换。
"""
from __future__ import print_function

import os
import sys

from PIL import Image, ImageDraw, ImageFont

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs', 'guide-images')
os.makedirs(OUT, exist_ok=True)

W, H = 750, 1624
S = 2  # 设计稿 375x812 的 2 倍

DARK = (10, 16, 32)
DARK2 = (16, 25, 46)
BLUE = (43, 108, 255)
CYAN = (34, 191, 196)
AMBER = (245, 158, 11)
RED = (239, 68, 68)
GREEN = (16, 185, 129)
BG = (242, 245, 250)
WHITE = (255, 255, 255)
GRAY = (148, 163, 184)
TEXT = (30, 41, 59)
LINE = (226, 232, 240)
PALE = (239, 246, 255)

FONT = 'C:/Windows/Fonts/msyh.ttc'


def f(size, bold=False):
    try:
        return ImageFont.truetype(FONT, size * S, index=1 if bold else 0)
    except Exception:
        return ImageFont.truetype(FONT, size * S)


def rr(d, box, r, fill, outline=None, width=1):
    d.rounded_rectangle(tuple(v * S for v in box), radius=r * S, fill=fill,
                        outline=outline, width=width * S)


def txt(d, x, y, s, size=13, color=TEXT, bold=False):
    d.text((x * S, y * S), s, font=f(size, bold), fill=color)


def center(d, cx, y, s, size=13, color=TEXT, bold=False):
    bb = d.textbbox((0, 0), s, font=f(size, bold))
    d.text(((cx - (bb[2] - bb[0]) / 2) * S, y * S), s, font=f(size, bold), fill=color)


def base(title=''):
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    # 状态栏
    txt(d, 24, 10, '9:41', 12, WHITE, True)
    center(d, 375, 10, '阿磊的工具箱', 11, WHITE)
    txt(d, 330, 10, '▮▮▮ 100%', 11, WHITE)
    if title:
        rr(d, (0, 32, 375, 76), 0, DARK)
        center(d, 375, 46, title, 16, WHITE, True)
    return im, d


def hero(d, subtitle=''):
    rr(d, (0, 32, 375, 250), 0, DARK)
    # 网格纹理
    for x in range(0, 375, 30):
        d.line([(x * S, 32 * S), (x * S, 250 * S)], fill=(20, 30, 54), width=1)
    for y in range(32, 250, 30):
        d.line([(0, y * S), (375 * S, y * S)], fill=(20, 30, 54), width=1)
    if subtitle:
        txt(d, 24, 56, subtitle, 12, (148, 180, 255))


def card(d, x, y, w, h, accent=False):
    rr(d, (x, y, x + w, y + h), 12, WHITE, outline=(219, 234, 254) if accent else None)
    if accent:
        rr(d, (x, y, x + 4, y + h), 2, BLUE)


def pill(d, x, y, s, color=BLUE, bg=None):
    bg = bg or (239, 246, 255)
    w = 26 + len(s) * 12
    rr(d, (x, y, x + w, y + 24), 12, bg)
    center(d, x + w / 2, y + 4, s, 11, color, True)


def btn(d, x, y, w, h, s, color=BLUE, text_color=WHITE, size=14):
    rr(d, (x, y, x + w, y + h), 8, color)
    center(d, x + w / 2, y + (h - size * 1.3) / 2, s, size, text_color, True)


def field(d, x, y, w, label, value, ph=False):
    txt(d, x, y, label, 12, TEXT, True)
    rr(d, (x, y + 24, x + w, y + 66), 8, WHITE, outline=LINE, width=1)
    txt(d, x + 12, y + 35, value, 13, GRAY if ph else TEXT)


def kv(d, x, y, k, v):
    txt(d, x, y, k, 11, GRAY)
    txt(d, x + 86, y, v, 11, TEXT, True)


def tabbar(d):
    rr(d, (0, 774, 375, 812), 0, WHITE)
    d.line([(0, 774 * S), (375 * S, 774 * S)], fill=LINE, width=2)
    d.ellipse((58 * S, 786 * S, 78 * S, 806 * S), fill=BLUE)
    center(d, 68, 793, '⌂', 10, WHITE, True)
    center(d, 68, 797, '工作台', 10, BLUE, True)
    d.ellipse((282 * S, 786 * S, 302 * S, 806 * S), fill=(203, 213, 225))
    center(d, 292, 793, '◉', 10, WHITE, True)
    center(d, 292, 797, '我的', 10, GRAY, True)


def list_item(d, x, y, w, icon, title, sub, right=''):
    card(d, x, y, w, 62)
    rr(d, (x + 12, y + 13, x + 42, y + 43), 7, PALE)
    center(d, x + 27, y + 18, icon, 13, BLUE, True)
    txt(d, x + 52, y + 12, title, 13, TEXT, True)
    txt(d, x + 52, y + 35, sub, 10, GRAY)
    if right:
        txt(d, x + w - 18 - len(right) * 11, y + 18, right, 11, BLUE, True)


# ============================================================================
# 1. 登录页
# ============================================================================
def img_login():
    im, d = base()
    hero(d)
    # logo
    d.ellipse((148 * S, 88 * S, 226 * S, 166 * S), fill=(37, 99, 235))
    center(d, 187, 108, '⚡', 30, WHITE, True)
    center(d, 375, 176, '阿磊的工具箱', 24, WHITE, True)
    center(d, 375, 210, 'Personal Toolbox · 我的随身工具箱', 12, (148, 180, 255))
    card(d, 28, 270, 319, 350)
    center(d, 375, 292, '登录工具箱', 18, TEXT, True)
    center(d, 375, 322, '首次使用请绑定微信，之后免输入直接进入', 11, GRAY)
    field(d, 52, 356, 271, '姓名', '请输入你的姓名', True)
    field(d, 52, 444, 271, '工号', '请输入工号', True)
    btn(d, 52, 528, 271, 44, '绑定并登录')
    center(d, 375, 586, '登录即表示你已阅读并同意《隐私说明》', 11, GRAY)
    txt(d, 52, 638, '工号与姓名是你本人的账号凭证；一个工号仅可绑定一个微信。', 10, GRAY)
    im.save(os.path.join(OUT, '01-登录.png'))


# ============================================================================
# 2. 工作台（教师视图）
# ============================================================================
def img_workbench():
    im, d = base()
    hero(d, '教师 · WT009')
    txt(d, 24, 80, '上午好，姚老师', 20, WHITE, True)
    txt(d, 24, 112, 'WT009 · 我的工具箱', 12, (148, 180, 255))
    d.ellipse((318 * S, 74 * S, 356 * S, 112 * S), fill=(37, 99, 235))
    center(d, 337, 84, '姚', 14, WHITE, True)
    rr(d, (24, 146, 351, 196), 10, (37, 99, 235))
    center(d, 100, 158, '▣', 16, WHITE, True)
    txt(d, 76, 158, '扫描物品二维码', 14, WHITE, True)
    txt(d, 76, 180, '识别耗材 / 工具，即刻查看详情', 10, (190, 214, 255))
    # 统计瓦片
    for i, (n, l, c) in enumerate([('1', '耗材品类', BLUE), ('1', '在册工具', CYAN), ('3', '待办审批', AMBER)]):
        x = 24 + i * 112
        rr(d, (x, 216, x + 104, 290), 10, WHITE)
        center(d, x + 52, 230, n, 24, c, True)
        center(d, x + 52, 268, l, 11, GRAY)
    # 搜索
    rr(d, (24, 306, 351, 352), 10, WHITE, outline=LINE)
    txt(d, 40, 320, '⌕   搜索名称 / 规格 / 编码', 12, GRAY)
    btn(d, 306, 314, 38, 28, '查询', BLUE, WHITE, 11)
    # 库存预警
    card(d, 24, 368, 327, 92, accent=True)
    txt(d, 44, 382, '2 项耗材低于安全库存', 13, TEXT, True)
    txt(d, 44, 408, '焊锡丝 剩 2卷（下限 5）', 11, GRAY)
    txt(d, 44, 428, '记号笔 剩 1盒（下限 3）', 11, GRAY)
    pill(d, 292, 390, '需补货', RED, (254, 226, 226))
    # 功能导航
    txt(d, 24, 480, '功能导航', 15, TEXT, True)
    txt(d, 24, 504, 'Functional Modules', 9, GRAY)
    items = [('▣', '库存一览'), ('▤', '领用审批'), ('⇄', '出入库登记'),
             ('＋', '物品入库'), ('▥', '使用概况'), ('⌂', '实训室管理'),
             ('⚒', '报修管理'), ('☑', '巡检管理')]
    for i, (ic, name) in enumerate(items):
        x = 24 + (i % 2) * 166
        y = 532 + (i // 2) * 60
        card(d, x, y, 159, 52)
        rr(d, (x + 10, y + 12, x + 38, y + 40), 7, PALE)
        center(d, x + 24, y + 17, ic, 12, BLUE, True)
        txt(d, x + 48, y + 19, name, 12, TEXT, True)
    tabbar(d)
    im.save(os.path.join(OUT, '02-工作台-教师.png'))


# ============================================================================
# 3. 申请领用（学生）
# ============================================================================
def img_apply():
    im, d = base()
    hero(d)
    txt(d, 24, 84, '耗材', 11, (148, 180, 255))
    txt(d, 24, 106, '焊锡丝', 22, WHITE, True)
    txt(d, 24, 138, 'ID M003', 11, (148, 180, 255))
    card(d, 24, 270, 327, 100)
    for i, (n, l, c) in enumerate([('120', '实时库存 (卷)', BLUE), ('50', '安全库存', CYAN), ('焊材', '分类', GREEN)]):
        x = 40 + i * 105
        center(d, x + 40, 286, n, 20, c, True)
        center(d, x + 40, 326, l, 10, GRAY)
    # 底部吸底条示意
    rr(d, (0, 726, 375, 774), 0, WHITE)
    btn(d, 24, 738, 327, 30, '申请领用', BLUE, WHITE, 12)
    # 申请弹层
    rr(d, (0, 110, 375, 774), 0, (15, 23, 42, 190))
    card(d, 24, 380, 327, 320, accent=True)
    center(d, 375, 402, '申请领用', 18, TEXT, True)
    center(d, 375, 432, '焊锡丝 · 当前可用 120 卷', 11, GRAY)
    txt(d, 48, 466, '领用数量 *', 12, TEXT, True)
    rr(d, (48, 494, 327, 540), 8, WHITE, outline=LINE)
    btn(d, 56, 500, 30, 32, '−', (226, 232, 240), TEXT, 16)
    center(d, 187, 502, '3', 18, TEXT, True)
    btn(d, 291, 500, 30, 32, '＋', PALE, BLUE, 16)
    txt(d, 48, 556, '用途说明', 12, TEXT, True)
    for i, tag in enumerate(['实训教学', '设备维修', '技能竞赛']):
        x = 48 + i * 96
        rr(d, (x, 584, x + 86, 610), 15, PALE if i else BLUE)
        center(d, x + 43, 588, tag, 10, WHITE if i == 0 else BLUE, True)
    rr(d, (48, 620, 327, 660), 8, WHITE, outline=LINE)
    txt(d, 58, 630, '或填写具体用途', 12, GRAY)
    btn(d, 48, 674, 130, 32, '取消', (226, 232, 240), TEXT, 12)
    btn(d, 194, 674, 133, 32, '提交申请', BLUE, WHITE, 12)
    im.save(os.path.join(OUT, '03-申请领用.png'))


# ============================================================================
# 4. 领用审批（教师）
# ============================================================================
def img_approve():
    im, d = base()
    hero(d)
    txt(d, 24, 84, '领用审批', 22, WHITE, True)
    txt(d, 24, 118, '审批人：姚丽（WT009）· 教师', 11, (148, 180, 255))
    txt(d, 24, 152, '3', 30, WHITE, True)
    txt(d, 54, 168, '待处理申请', 12, (148, 180, 255))
    # 批量条
    card(d, 24, 270, 327, 52)
    rr(d, (40, 286, 56, 302), 4, WHITE, outline=BLUE, width=2)
    txt(d, 66, 287, '全选（0/3）', 12, TEXT)
    btn(d, 280, 284, 60, 24, '批量通过', BLUE, WHITE, 10)
    # 申请卡片
    card(d, 24, 336, 327, 234, accent=True)
    txt(d, 48, 352, 'M003 × 3 卷', 15, TEXT, True)
    pill(d, 292, 352, '待审批', BLUE)
    txt(d, 48, 382, '申请人 2024DQ101', 11, GRAY)
    kv(d, 48, 410, '申请单号', 'SQ20261116001')
    kv(d, 48, 434, '申请时间', '2026-11-16 08:12')
    kv(d, 48, 458, '归属班级', '2024级电气1班')
    kv(d, 48, 482, '用途说明', '实训教学')
    btn(d, 48, 516, 130, 34, '通过', GREEN, WHITE, 13)
    btn(d, 194, 516, 130, 34, '拒绝', (239, 68, 68), WHITE, 13)
    # 第二张卡片局部
    card(d, 24, 584, 327, 128)
    txt(d, 48, 600, 'M007 × 1 盒', 15, TEXT, True)
    pill(d, 292, 600, '待审批', BLUE)
    txt(d, 48, 630, '申请人 2024DQ201', 11, GRAY)
    kv(d, 48, 656, '归属班级', '2024级电气2班')
    tabbar(d)
    im.save(os.path.join(OUT, '04-领用审批.png'))


# ============================================================================
# 5. 我的（学生：我的申请）
# ============================================================================
def img_mine():
    im, d = base()
    hero(d, '学生 · 2024DQ101')
    d.ellipse((24 * S, 70 * S, 78 * S, 124 * S), fill=(37, 99, 235))
    center(d, 51, 84, '24', 16, WHITE, True)
    txt(d, 94, 76, '24电气1班管理员1', 18, WHITE, True)
    txt(d, 94, 104, '2024DQ101', 12, (148, 180, 255))
    pill(d, 286, 84, '学生', WHITE, (37, 99, 235))
    center(d, 375, 146, '●  数据来源：云数据库', 10, (148, 180, 255))
    txt(d, 24, 208, '账号', 15, TEXT, True)
    list_item(d, 24, 238, 327, '⇄', '切换 / 重新绑定账号', '退出当前身份，回到登录页')
    list_item(d, 24, 308, 327, '▣', '隐私说明', '本工具如何处理你的信息')
    txt(d, 24, 398, '我的申请', 15, TEXT, True)
    card(d, 24, 428, 327, 118)
    txt(d, 44, 444, 'M003 焊锡丝 × 3', 14, TEXT, True)
    pill(d, 292, 444, '待审批', AMBER, (254, 243, 199))
    kv(d, 44, 476, '单号', 'SQ20261116001')
    kv(d, 44, 500, '归属班级', '2024级电气1班')
    card(d, 24, 558, 327, 118)
    txt(d, 44, 574, 'M001 电阻包 × 2', 14, TEXT, True)
    pill(d, 292, 574, '已通过', GREEN, (209, 250, 229))
    kv(d, 44, 606, '单号', 'SQ20261115008')
    kv(d, 44, 630, '归属班级', '2024级电气1班')
    tabbar(d)
    im.save(os.path.join(OUT, '05-我的申请.png'))


# ============================================================================
# 6. 报修管理（教师）
# ============================================================================
def img_repair():
    im, d = base()
    txt(d, 24, 52, '报修管理', 18, TEXT, True)
    btn(d, 292, 48, 60, 28, '＋ 报修', BLUE, WHITE, 10)
    card(d, 24, 96, 327, 132, accent=True)
    txt(d, 44, 112, '电烙铁温度不稳', 14, TEXT, True)
    pill(d, 280, 112, '待处理', AMBER, (254, 243, 199))
    kv(d, 44, 144, '报修人', 'WT009 姚丽')
    kv(d, 44, 168, '实训室', '电气实训室一')
    kv(d, 44, 192, '归属班级', '2024级电气1班')
    btn(d, 260, 190, 76, 24, '处理 / 关闭', BLUE, WHITE, 9)
    card(d, 24, 242, 327, 132)
    txt(d, 44, 258, '示波器屏幕闪烁', 14, TEXT, True)
    pill(d, 280, 258, '处理中', BLUE)
    kv(d, 44, 290, '报修人', '2024DQ101')
    kv(d, 44, 314, '实训室', '电气实训室二')
    kv(d, 44, 338, '归属班级', '2025级电气2班')
    txt(d, 24, 400, '巡检管理（同结构）', 15, TEXT, True)
    card(d, 24, 430, 327, 116)
    txt(d, 44, 446, '实训室安全巡检', 14, TEXT, True)
    pill(d, 280, 446, '待执行', AMBER, (254, 243, 199))
    kv(d, 44, 478, '执行人', 'WT009 姚丽')
    kv(d, 44, 502, '实训室', '电气实训室一')
    btn(d, 260, 500, 76, 24, '执行 / 记录', BLUE, WHITE, 9)
    center(d, 375, 720, '教师端：报修与巡检按实训室分配，流水显示归属班级', 10, GRAY)
    tabbar(d)
    im.save(os.path.join(OUT, '06-报修与巡检.png'))


for fn in (img_login, img_workbench, img_apply, img_approve, img_mine, img_repair):
    fn()
    print('生成', os.path.join(OUT, fn.__name__.replace('img_', '')))
print('✅ 共 6 张界面示意图 →', OUT)

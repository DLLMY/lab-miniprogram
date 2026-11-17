# -*- coding: utf-8 -*-
"""
preview_student_ui.py —— 学生端改动的界面预览（视觉验证用，非交付物）
================================================================================
验证两件事：
  1) 学生工作台新增「我的申请」入口（含待处理角标）的排版效果；
  2) 班级全称（长名 + 全角括号）在列表里完整换行显示、不被省略号截断。
输出：docs/_preview/*.png
"""
from __future__ import print_function

import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_guide_images import (  # noqa: E402  复用同一套绘图原语，保证与真机配色一致
    S, W, H, WHITE, GRAY, TEXT, BLUE, CYAN, AMBER, RED, GREEN, LINE, PALE,
    base, hero, card, pill, btn, txt, center, rr, tabbar, list_item, f,
)

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', '_preview')
os.makedirs(OUT, exist_ok=True)


def preview_student_workbench():
    """学生端工作台：新增「我的申请」入口 + 角标。"""
    im, d = base()
    hero(d, '学生 · 2025WN001')
    txt(d, 24, 80, '上午好，李同学', 20, WHITE, True)
    txt(d, 24, 112, '2025WN001 · 2025级五年制', 12, (148, 180, 255))
    d.ellipse((318 * S, 74 * S, 356 * S, 112 * S), fill=(37, 99, 235))
    center(d, 337, 84, '李', 14, WHITE, True)
    rr(d, (24, 146, 351, 196), 10, (37, 99, 235))
    center(d, 100, 158, '▣', 16, WHITE, True)
    txt(d, 76, 158, '扫描物品二维码', 14, WHITE, True)
    txt(d, 76, 180, '识别耗材 / 工具，即刻查看详情', 10, (190, 214, 255))

    for i, (n, l, c) in enumerate([('1', '耗材品类', BLUE), ('1', '在册工具', CYAN), ('2', '我的申请', AMBER)]):
        x = 24 + i * 112
        rr(d, (x, 216, x + 104, 290), 10, WHITE)
        center(d, x + 52, 230, n, 24, c, True)
        center(d, x + 52, 268, l, 11, GRAY)

    rr(d, (24, 306, 351, 352), 10, WHITE, outline=LINE)
    txt(d, 40, 320, '⌕   搜索名称 / 规格 / 编码', 12, GRAY)
    btn(d, 306, 314, 38, 28, '查询', BLUE, WHITE, 11)

    txt(d, 24, 376, '功能导航', 15, TEXT, True)
    txt(d, 24, 400, 'Functional Modules', 9, GRAY)

    # 学生端两个入口：库存一览 / 我的申请（带角标）
    x, y = 24, 424
    card(d, x, y, 159, 52)
    rr(d, (x + 10, y + 12, x + 38, y + 40), 7, PALE)
    center(d, x + 24, y + 17, '▣', 12, BLUE, True)
    txt(d, x + 48, y + 19, '库存一览', 12, TEXT, True)

    x, y = 190, 424
    card(d, x, y, 159, 52)
    rr(d, (x + 10, y + 12, x + 38, y + 40), 7, PALE)
    center(d, x + 24, y + 17, '✉', 12, BLUE, True)
    txt(d, x + 48, y + 19, '我的申请', 12, TEXT, True)
    # 角标：贴在图标右上角（与真实实现一致）
    d.ellipse((x + 26, y + 4, x + 44, y + 22), fill=RED, outline=WHITE, width=2)
    center(d, x + 35, y + 6, '2', 9, WHITE, True)
    txt(d, x + 48, y + 38, '申请进度与记录', 9, GRAY)

    x, y = 24, 486
    card(d, x, y, 159, 52)
    rr(d, (x + 10, y + 12, x + 38, y + 40), 7, PALE)
    center(d, x + 24, y + 17, '⇄', 12, BLUE, True)
    txt(d, x + 48, y + 19, '切换账号', 12, TEXT, True)

    # 「我的申请」展开态预览
    txt(d, 24, 560, '我的申请', 15, TEXT, True)
    txt(d, 24, 584, '4 条记录', 9, GRAY)
    card(d, 24, 604, 327, 116)
    txt(d, 44, 620, '领用 ×1', 13, TEXT, True)
    txt(d, 44, 644, 'R20261116090046 · 2026-11-16 09:00', 11, GRAY)
    txt(d, 44, 664, '班级：2025级五年制', 11, GRAY)          # 短名
    pill(d, 292, 618, '待审批', AMBER, (255, 243, 224))
    txt(d, 44, 692, '用途：日常使用', 11, GRAY)

    # 长班级名 + 全角括号：验证完整换行显示
    card(d, 24, 736, 327, 116)
    txt(d, 44, 752, '领用 ×2', 13, TEXT, True)
    txt(d, 44, 776, 'R20261116103000 · 2026-11-16 10:30', 11, GRAY)
    txt(d, 44, 796, '班级：2025级电气（3+4）班', 11, GRAY)     # 关键：不截断
    pill(d, 292, 750, '已通过', GREEN, (209, 250, 229))
    txt(d, 44, 824, '用途：实训接线与调试', 11, GRAY)

    card(d, 24, 868, 327, 116)
    txt(d, 44, 884, '借出工具', 13, TEXT, True)
    txt(d, 44, 908, 'T007 · 2026-11-15 16:20', 11, GRAY)
    txt(d, 44, 928, '班级：2024级电气1班', 11, GRAY)
    pill(d, 292, 882, '借出', BLUE, (219, 234, 254))
    txt(d, 44, 956, '应归还：2026-11-22', 11, GRAY)

    tabbar(d)
    im.save(os.path.join(OUT, '学生工作台-我的申请入口.png'))
    return os.path.join(OUT, '学生工作台-我的申请入口.png')


def preview_cls_wrap():
    """班级全称换行效果对照：左=旧(list-sub 省略号)，右=新(cls-line 完整)。"""
    im = Image.new('RGB', (W, 900), (242, 245, 250))
    d = ImageDraw.Draw(im)
    txt(d, 24, 24, '班级全称显示对照（长名 / 全角括号）', 15, TEXT, True)

    card(d, 24, 64, 327, 150)
    txt(d, 44, 80, '修复前 · .list-sub（nowrap + ellipsis）', 13, RED, True)
    txt(d, 44, 106, '班级：2025级电气（3+4）班', 11, GRAY)
    # 模拟被裁剪：画一条灰色底线 + 省略号
    txt(d, 44, 126, '班级：2025级电气（3+4…', 11, GRAY)
    txt(d, 44, 150, '整行被压成一行，超出部分直接省略', 10, (200, 60, 60))
    txt(d, 44, 176, '多班教师的长班级列表更明显', 10, (200, 60, 60))

    card(d, 24, 236, 327, 190)
    txt(d, 44, 252, '修复后 · .cls-line（可换行、完整）', 13, GREEN, True)
    txt(d, 44, 278, '班级：2025级电气（3+4）班', 11, GRAY)
    txt(d, 44, 300, '班级：2024级电气1班', 11, GRAY)
    txt(d, 44, 322, '班级：2025级五年制', 11, GRAY)
    txt(d, 44, 344, '班级：2026级无人机操控与维护班', 11, GRAY)
    txt(d, 44, 366, '整行完整可见，不省略、不截断', 10, (16, 140, 100))
    txt(d, 44, 390, '同时修正 .kv-v（审批页值列）与账号页 u-cls', 10, (16, 140, 100))

    card(d, 24, 448, 327, 130)
    txt(d, 44, 464, '管理员账号页 · 归属班级全称', 13, TEXT, True)
    txt(d, 44, 490, '工号 2025WN001', 11, GRAY)
    txt(d, 44, 512, '归属班级全称：2025级五年制', 11, GRAY)
    txt(d, 44, 534, '带班班级：2025级电气（3+4）班、2025级电气2班', 11, GRAY)
    txt(d, 44, 558, '多班教师不再被一行截断', 10, GRAY)

    im.save(os.path.join(OUT, '班级全称-显示对照.png'))
    return os.path.join(OUT, '班级全称-显示对照.png')


if __name__ == '__main__':
    print('已生成：', preview_student_workbench())
    print('已生成：', preview_cls_wrap())

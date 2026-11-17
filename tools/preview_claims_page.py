# -*- coding: utf-8 -*-
"""
preview_claims_page.py —— 教师端「领用记录」页界面预览（视觉验证用，非交付物）
"""
from __future__ import print_function

import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_guide_images import (  # noqa: E402
    S, WHITE, GRAY, TEXT, BLUE, CYAN, AMBER, RED, GREEN, LINE, PALE,
    base, hero, card, pill, btn, txt, center, rr, tabbar, f,
)

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', '_preview')
os.makedirs(OUT, exist_ok=True)


def preview_claims():
    im, d = base()
    # 顶部 hero（深空底）
    d.rectangle((0, 0, 750 * S // 2, 200), fill=(10, 16, 32))
    txt(d, 24, 26, '领用记录', 19, WHITE, True)
    txt(d, 24, 56, '学生领用了什么 · 谁领的 · 哪个班 · 用途为何', 11, (150, 180, 255))
    txt(d, 24, 92, '12', 30, WHITE, True)
    txt(d, 74, 104, '条记录（当前筛选）', 12, (150, 180, 255))

    y = 118
    # 筛选卡
    card(d, 24, y, 327, 92)
    rr(d, (38, y + 12, 196, y + 44), 9, (248, 250, 252))
    txt(d, 52, y + 21, '物品名称 / ID', 11, GRAY)
    rr(d, (204, y + 12, 336, y + 44), 9, (248, 250, 252))
    txt(d, 216, y + 21, '领用人姓名 / 工号', 10, GRAY)
    rr(d, (38, y + 52, 168, y + 82), 9, (248, 250, 252))
    txt(d, 52, y + 60, '全部班级', 11, GRAY)
    rr(d, (176, y + 52, 290, y + 82), 9, (248, 250, 252))
    txt(d, 190, y + 60, '全部状态', 11, GRAY)
    rr(d, (298, y + 52, 336, y + 82), 9, (232, 240, 255))
    txt(d, 305, y + 60, '重置', 11, BLUE)

    y = 224
    # 按班级汇总
    card(d, 24, y, 327, 96)
    txt(d, 40, y + 12, '按班级汇总', 13, TEXT, True)
    rr(d, (38, y + 36, 190, y + 84), 10, (248, 250, 252))
    txt(d, 50, y + 42, '8', 19, BLUE, True)
    txt(d, 74, y + 50, '笔', 10, GRAY)
    txt(d, 50, y + 64, '2024级电气1班', 10, (90, 107, 133))
    rr(d, (198, y + 36, 340, y + 84), 10, (248, 250, 252))
    txt(d, 210, y + 42, '4', 19, CYAN, True)
    txt(d, 234, y + 50, '笔', 10, GRAY)
    txt(d, 210, y + 64, '2025级电气（3+4）班', 10, (90, 107, 133))

    y = 336
    # 明细列表
    card(d, 24, y, 327, 268)
    rows = [
        ('钳工耗材钢料Q235', '×2 块', '彭满易', '2024级电气1班', '2026-11-16 10:24', 'approved'),
        ('焊锡丝', '×1 卷', '安荣伟', '2024级电气1班', '2026-11-16 09:41', 'approved'),
        ('电子万用表', '×1 台', '汤纯伟', '2024级电气2班', '2026-11-15 16:02', 'pending'),
    ]
    ry = y + 12
    for name, qty, who, cls, t, st in rows:
        txt(d, 40, ry, name, 12, TEXT, True)
        txt(d, 40 + len(name) * 12 + 8, ry, qty, 11, BLUE, True)
        if st == 'approved':
            pill(d, 300, ry - 4, '已通过', GREEN, (209, 250, 229))
        else:
            pill(d, 300, ry - 4, '待审批', AMBER, (255, 243, 224))
        txt(d, 40, ry + 20, '领用人：' + who, 10, GRAY)
        txt(d, 40, ry + 38, '班级：' + cls, 10, GRAY)
        txt(d, 40, ry + 56, t, 10, GRAY)
        ry += 84

    # 展开明细
    d.line((38, ry - 12, 336, ry - 12), fill=(240, 242, 246))
    txt(d, 40, ry - 2, '焊锡丝', 12, TEXT, True)
    txt(d, 100, ry - 2, '×1 卷', 11, BLUE, True)
    pill(d, 300, ry - 6, '已通过', GREEN, (209, 250, 229))
    txt(d, 40, ry + 18, '领用人：安荣伟', 10, GRAY)
    txt(d, 40, ry + 36, '班级：2024级电气1班', 10, GRAY)
    txt(d, 40, ry + 54, '2026-11-16 09:41 · R20261116094120', 10, GRAY)
    txt(d, 40, ry + 74, '用途：电子实训接线练习', 10, (90, 107, 133))
    txt(d, 40, ry + 92, '审批人：WT013 彭满易', 10, (90, 107, 133))

    tabbar(d)
    im.save(os.path.join(OUT, '教师端-领用记录页.png'))
    return os.path.join(OUT, '教师端-领用记录页.png')


if __name__ == '__main__':
    print('已生成：', preview_claims())

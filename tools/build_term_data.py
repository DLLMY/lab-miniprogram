# -*- coding: utf-8 -*-
"""
build_term_data.py —— 每学期「电气教师 → 带班班级」主数据生成器
================================================================================
用途：把学校下发的两份表（教职工通讯录 + 教师工作量安排）转换成
      tools/data/terms/<学期>.json，供 tools/import_teachers.js 导入线上。

设计要点（对应 docs/数据域隔离设计.md「每学期教师带班更新」）：
  * 账号范围 = 工作量表中实际授课的教师（不是通讯录部门全员）；
  * 工号 WT### 按「姓名」永久绑定，跨学期不变；新增教师才追加号码；
    传入 --prev 上期 JSON 即可复用工号，避免每学期重新编号导致身份漂移；
  * 「上该班课就管该班耗材」→ managedClasses = 工作量表中该教师的全部授课班级；
  * 班级名以本文件输出的 classes 清单为唯一权威口径，学生导入必须使用同一字符串；
  * 上学期有、本学期无的教师只列入 retired，由管理员决定停用，绝不自动删除。

用法（在仓库根目录执行）：
  python tools/build_term_data.py \
      --term 2026-2027-1 \
      --roster "<教职工通讯录.xlsx>" \
      --workload "<教师工作量安排.xls>" \
      [--prev tools/data/terms/2025-2026-2.json] \
      [--out tools/data/terms/2026-2027-1.json]

依赖：openpyxl（xlsx）、xlrd（xls）。仅在本机运行，不打包进小程序。
================================================================================
"""
from __future__ import print_function

import argparse
import datetime
import json
import os
import re
import sys

# —— 每学期按需维护的勘误 / 排除规则 ——————————————————————————————
# 用户 2026-11-15 确认：「吴逸锋」是正确写法，通讯录里的「吴逸峰」是另一用字，
# 不得再自动改名。通讯录仅用于核对部门，故用 ROSTER_ALIAS 做只读别名映射。
NAME_FIX = {}
ROSTER_ALIAS = {
    '吴逸锋': '吴逸峰',   # 仅用于查通讯录部门，账号姓名保留工作量表写法
}
# 上期主数据里的姓名勘误回滚：本期已确认「吴逸锋」正确，
# 带 --prev 复用工号时先把上期写法纠正回来，避免 WT008 被当成新教师重新编号。
PREV_NAME_CORRECT = {
    '吴逸峰': '吴逸锋',
}
# 工作量表中明显的班级名笔误
CLASS_FIX = {
    '202025级数控班': '2025级数控班',
}
# 已有超级管理员账号、无需重复建号的人员（可按需增删）
EXCLUDE_TEACHERS = {
    '邓磊',   # 已有 T001 / 邓老师 / super
}
ID_PREFIX = 'WT'
ROLE = 'teacher'

# —— 班级 → 工号短码 / 名字简称 ————————————————————————————————
# 用户指定锚点：24电气1班管理员1 → 工号 2024dq101
# 规则：<4位年份><专业缩写><1位班号><2位管理员序号>
#   专业：电气 dq / 工业 gy / 数控 sk / 无人机 wr / 五年制 wn
#   班号：班级名中的数字；「3+4」取 3，「五年制」取 5，无班号取 0
# 显式固化这 20 条，保证跨学期工号稳定；新增班级由 derive_class_code 兜底推导。
CLASS_CODE = {
    '2026级电气五年制班': ('2026dq5', '26电气五年制班'),
    '2025级工业2班': ('2025gy2', '25工业2班'),
    '2024级电气2班': ('2024dq2', '24电气2班'),
    '2024级电气3班': ('2024dq3', '24电气3班'),
    '2024级工业班': ('2024gy0', '24工业班'),
    '2025级电气2班': ('2025dq2', '25电气2班'),
    '2025级电气1班': ('2025dq1', '25电气1班'),
    '2024级电气4班': ('2024dq4', '24电气4班'),
    '2026级无人机操控与维护班': ('2026wr0', '26无人机班'),
    '2024级数控班': ('2024sk0', '24数控班'),
    '2026级电气1班': ('2026dq1', '26电气1班'),
    '2025级电气（3+4）班': ('2025dq3', '25电气3+4班'),
    '2026级工业2班': ('2026gy2', '26工业2班'),
    '2024级电气1班': ('2024dq1', '24电气1班'),
    '2026级电气2班': ('2026dq2', '26电气2班'),
    '2025级五年制': ('2025wn0', '25五年制班'),
    '2025级工业1班': ('2025gy1', '25工业1班'),
    '2026级工业1班': ('2026gy1', '26工业1班'),
    '2025级数控班': ('2025sk0', '25数控班'),
    '2026级电气3+4班': ('2026dq3', '26电气3+4班'),
}
# 班级管理员账号：角色 student（本班共享申请账号），cls 必须存权威全称，
# 否则与教师 managedClasses 字符串不匹配，任课教师将看不到本班申请。
CLASS_ADMIN_ROLE = 'student'
CLASS_ADMIN_COUNT = 2


def derive_class_code(cls):
    """新增班级的兜底推导：年份 + 专业缩写 + 班号。返回 (code, short)。"""
    m = re.match(r'^(\d{4})级(.*)$', cls)
    year = m.group(1) if m else '0000'
    body = m.group(2) if m else cls
    major = 'zh'
    for kw, ab in (('无人机', 'wr'), ('数控', 'sk'), ('电气', 'dq'),
                   ('工业', 'gy'), ('五年制', 'wn')):
        if kw in body:
            major = ab
            break
    if '五年制' in body:
        no = '5'
    elif '3+4' in body or '3＋4' in body:
        no = '3'
    else:
        nums = re.findall(r'\d+', body)
        no = nums[-1][-1] if nums else '0'
    code = year + major + no
    short = (year[2:] if len(year) == 4 else year) + body
    if not short.endswith(u'班'):
        short += u'班'
    return code, short


def class_code(cls):
    return CLASS_CODE.get(cls) or derive_class_code(cls)


def s(v):
    if v is None:
        return ''
    return str(v).replace('\n', '/').replace('\u3000', ' ').strip()


def norm_name(v):
    """姓名归一化：去所有空白、去括号备注（如「向玲玲（电气）」）。"""
    n = re.sub(r'\s+', '', s(v))
    n = re.sub(r'[（(].*?[)）]', '', n)
    return n


def load_roster(path):
    """通讯录：部门是合并单元格，只在首行有值，需向下填充。返回 {姓名: [{dept,title}]}"""
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    dept = ''
    out = {}
    for r in ws.iter_rows(min_row=3, values_only=True):
        d, name, title = s(r[0]), s(r[1]), s(r[2])
        if d:
            dept = d
        if name:
            out.setdefault(norm_name(name), []).append({'dept': dept, 'title': title})
    wb.close()
    return out


def load_workload(path):
    """工作量表：教师行与课时行成对出现。
    教师行判据 = C 列有姓名 且 D~I 列至少有一个含「级」的班级名（课时行 C 列为空）。"""
    import xlrd
    sh = xlrd.open_workbook(path).sheet_by_index(0)
    rows = []
    for i in range(2, sh.nrows):
        row = [s(sh.cell_value(i, j)) for j in range(sh.ncols)]
        nm = norm_name(row[2])
        classes = [row[j] for j in range(3, 9) if row[j]]
        if not nm or nm.startswith('*'):
            continue
        if not any(u'级' in c for c in classes):
            continue
        rows.append({
            'row': i + 1,
            'seq': row[1],
            'rawName': row[2],
            'name': nm,
            'classes': classes,
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--term', required=True, help='学期标识，如 2026-2027-1')
    ap.add_argument('--roster', required=True, help='教职工通讯录 xlsx 路径')
    ap.add_argument('--workload', required=True, help='教师工作量安排 xls/xlsx 路径')
    ap.add_argument('--prev', default='', help='上一学期 JSON，用于复用工号')
    ap.add_argument('--out', default='', help='输出路径，默认 tools/data/terms/<term>.json')
    a = ap.parse_args()

    for p in (a.roster, a.workload):
        if not os.path.exists(p):
            print('❌ 找不到文件：' + p)
            sys.exit(2)

    roster = load_roster(a.roster)
    rows = load_workload(a.workload)
    if not rows:
        print('❌ 工作量表里没有解析到任何教师行，请检查表结构（班级名应含「级」）')
        sys.exit(2)

    # 1) 勘误姓名 / 班级名，并按行内顺序去重
    applied_names, applied_classes = [], []
    for r in rows:
        if r['name'] in NAME_FIX:
            applied_names.append('%s -> %s' % (r['name'], NAME_FIX[r['name']]))
            r['name'] = NAME_FIX[r['name']]
        fixed = []
        for c in r['classes']:
            c2 = CLASS_FIX.get(c, c)
            if c2 != c and (c + ' -> ' + c2) not in applied_classes:
                applied_classes.append(c + ' -> ' + c2)
            if c2 not in fixed:
                fixed.append(c2)
        r['classes'] = fixed

    # 2) 排除已有超级管理员等不重复建号人员
    excluded = [r['name'] for r in rows if r['name'] in EXCLUDE_TEACHERS]
    active = [r for r in rows if r['name'] not in EXCLUDE_TEACHERS]

    # 3) 工号：优先复用上期「姓名 -> 工号」，新增教师追加到末尾
    prev_map, prev_names = {}, set()
    if a.prev and os.path.exists(a.prev):
        with open(a.prev, 'r', encoding='utf-8') as f:
            prev = json.load(f)
        prev_map = dict(
            (PREV_NAME_CORRECT.get(t['name'], t['name']), t['id'])
            for t in prev.get('teachers', []) if t.get('name') and t.get('id')
        )
        prev_names = set(prev_map.keys())
    used = set(prev_map.values())
    pat = re.compile(r'^' + re.escape(ID_PREFIX) + r'(\d+)$')
    maxno = 0
    for v in used:
        m = pat.match(v)
        if m:
            maxno = max(maxno, int(m.group(1)))
    for r in active:
        if r['name'] in prev_map:
            r['id'] = prev_map[r['name']]
        else:
            maxno += 1
            while ('%s%03d' % (ID_PREFIX, maxno)) in used:
                maxno += 1
            r['id'] = '%s%03d' % (ID_PREFIX, maxno)
            used.add(r['id'])
        depts = roster.get(ROSTER_ALIAS.get(r['name'], r['name']), [])
        r['dept'] = ' / '.join(sorted(set(d['dept'] for d in depts))) or '未匹配通讯录'
        r['matchedRoster'] = bool(depts)
        r['role'] = ROLE
        r['cls'] = ''
        r['status'] = '启用'
        r['managedClasses'] = r.pop('classes')

    # 4) 班级清单：按教师行出现顺序去重，作为全学期唯一权威口径
    classes = []
    for r in active:
        for c in r['managedClasses']:
            if c not in classes:
                classes.append(c)

    retired = sorted(prev_names - set(r['name'] for r in active))

    # 5) 班级管理员账号：每班 2 个，供本班学生共用提交耗材申请。
    #    工号按「班级短码 + 01/02」，跨学期稳定；cls 存权威全称，保证教师可见。
    class_admins = []
    used_admin_ids = set(t['id'].upper() for t in active)
    derived = []
    for cls in classes:
        code, short = class_code(cls)
        if cls not in CLASS_CODE:
            derived.append(cls + ' -> ' + code)
        for n in range(1, CLASS_ADMIN_COUNT + 1):
            aid = (code + '%02d' % n).upper()
            if aid in used_admin_ids:
                raise SystemExit('❌ 班级管理员工号与教师工号冲突：' + aid)
            used_admin_ids.add(aid)
            class_admins.append({
                'id': aid,
                'name': '%s管理员%d' % (short, n),
                'role': CLASS_ADMIN_ROLE,
                'cls': cls,
                'status': '启用',
                'managedClasses': [],
            })

    doc = {
        'term': a.term,
        'generatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'sources': {'roster': a.roster, 'workload': a.workload},
        'idPrefix': ID_PREFIX,
        'role': ROLE,
        'excluded': excluded,
        'corrections': {'names': applied_names, 'classes': applied_classes},
        'classes': classes,
        'teachers': active,
        'classAdmins': class_admins,
        'classAdminRule': {
            'perClass': CLASS_ADMIN_COUNT,
            'role': CLASS_ADMIN_ROLE,
            'idFormat': '<4位年份><专业缩写><1位班号><2位序号>，如 2024dq101',
            'nameFormat': '<班级简称>管理员<序号>，如 24电气1班管理员1',
            'clsFormat': '必须使用 classes 数组中的权威全称，禁止使用简称',
        },
        'retired': retired,
        'stats': {
            'workloadTeacherRows': len(rows),
            'excluded': len(excluded),
            'accounts': len(active),
            'classAdmins': len(class_admins),
            'classes': len(classes),
            'prevReused': len(prev_map),
            'retired': len(retired),
        },
    }

    out = a.out or os.path.join('tools', 'data', 'terms', a.term + '.json')
    outdir = os.path.dirname(out)
    if outdir and not os.path.isdir(outdir):
        os.makedirs(outdir)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    print('✅ 已生成：' + out)
    print('   学期=%s  授课教师行=%d  排除=%d  教师账号=%d  班级管理员=%d  班级=%d  复用工号=%d  离任=%d'
          % (a.term, len(rows), len(excluded), len(active), len(class_admins),
             len(classes), len(prev_map), len(retired)))
    if derived:
        print('   ⚠️ 新班级按规则推导工号（建议复核后固化到 CLASS_CODE）：' + '；'.join(derived))
    if applied_names or applied_classes:
        print('   已应用勘误：姓名 %s ；班级 %s'
              % (', '.join(applied_names) or '无', ', '.join(applied_classes) or '无'))
    if retired:
        print('   ⚠️ 上期有、本期无（需管理员手动停用，脚本不自动删）：' + '、'.join(retired))
    print('\n=== 账号预览 ===')
    for r in active:
        flag = '' if r['matchedRoster'] else '  ⚠未匹配通讯录'
        print('  %-6s %-6s %-2d班  %s%s'
              % (r['id'], r['name'], len(r['managedClasses']), r['dept'], flag))


if __name__ == '__main__':
    main()

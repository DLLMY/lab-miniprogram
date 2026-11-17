# -*- coding: utf-8 -*-
"""
audit_term_mapping.py —— 核查「任课教师 → 带班班级」归属是否正确
================================================================================
用途：每学期导入账号后，用原始工作量表反查学期主数据 JSON 与线上 users 表，
      确认每个教师的 managedClasses 与其实际授课班级一致。

三种运行模式：
  python tools/audit_term_mapping.py --dump
      打印原始工作量表全部单元格（含合并单元格），用于确认表结构
  python tools/audit_term_mapping.py --check
      对比「原始表解析结果」与「学期 JSON」，输出逐人差异
  python tools/audit_term_mapping.py --check --online
      额外通过 MCP 云函数拉取线上 users 表（需 docsProxy 在线且已部署新版）

仅本机运行，不打包进小程序。
"""
from __future__ import print_function

import argparse
import json
import os
import re
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TERM_DIR = os.path.join(ROOT, 'tools', 'data', 'terms')


def pick_term(explicit=''):
    """未指定学期时自动取 terms 目录下最新的学期主数据（跳过 _template）。"""
    if explicit:
        return os.path.join(TERM_DIR, explicit + '.json')
    if not os.path.isdir(TERM_DIR):
        return ''
    files = sorted(f for f in os.listdir(TERM_DIR)
                   if f.endswith('.json') and not f.startswith('_'))
    return os.path.join(TERM_DIR, files[-1]) if files else ''


def s(v):
    if v is None:
        return ''
    return str(v).replace('\n', '/').replace('\u3000', ' ').strip()


def norm_name(v):
    n = re.sub(r'\s+', '', s(v))
    n = re.sub(r'[（(].*?[)）]', '', n)
    return n


def load_sheet(path):
    import xlrd
    book = xlrd.open_workbook(path, formatting_info=False)
    sh = book.sheet_by_index(0)
    return sh


def dump(path):
    sh = load_sheet(path)
    print('=== 工作表 %s : %d 行 x %d 列 ===' % (sh.name, sh.nrows, sh.ncols))
    print('=== 合并单元格 ===')
    try:
        for r0, r1, c0, c1 in sh.merged_cells:
            print('  R%dC%d:R%dC%d' % (r0 + 1, c0 + 1, r1, c1))
    except Exception as e:
        print('  (无法读取合并信息: %s)' % e)
    print('=== 全部单元格 ===')
    for i in range(sh.nrows):
        cells = []
        for j in range(sh.ncols):
            v = s(sh.cell_value(i, j))
            if v:
                cells.append('%s=%s' % (chr(65 + j), v))
        print('R%-3d | %s' % (i + 1, '  '.join(cells)))


def parse_workload(path):
    """按 build_term_data.py 的同款规则复现解析，返回教师行清单。"""
    sh = load_sheet(path)
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
            'name': nm,
            'classes': classes,
            'allCols': row,
        })
    return rows


def check(path, term_json, online=False):
    with open(term_json, 'r', encoding='utf-8') as f:
        doc = json.load(f)
    src = doc.get('sources', {}).get('workload', '')
    rows = parse_workload(path)
    print('=== 原始工作量表解析：%d 个教师行 ===' % len(rows))
    for r in rows:
        print('  R%-3d %-8s seq=%-6s %s' % (r['row'], r['name'], r['seq'], '、'.join(r['classes'])))

    class_fix = {'202025级数控班': '2025级数控班'}
    expect = {}
    for r in rows:
        cls = [class_fix.get(c, c) for c in r['classes']]
        uniq = []
        for c in cls:
            if c not in uniq:
                uniq.append(c)
        expect.setdefault(r['name'], []).extend(uniq)

    actual = {}
    for t in doc['teachers']:
        actual[t['name']] = list(t.get('managedClasses') or [])

    print('\n=== 逐人比对（原始表 vs 学期 JSON） ===')
    bad = 0
    for name in sorted(set(list(expect.keys()) + list(actual.keys()))):
        e, a = expect.get(name, []), actual.get(name, [])
        missing = [c for c in e if c not in a]
        extra = [c for c in a if c not in e]
        ok = not missing and not extra
        if not ok:
            bad += 1
        print('  %-8s %s  期望%-2d 实际%-2d %s%s'
              % (name, 'OK ' if ok else '!! ', len(e), len(a),
                 ('缺:' + '、'.join(missing)) if missing else '',
                 ('多:' + '、'.join(extra)) if extra else ''))
    print('\n差异人数：%d / %d' % (bad, len(set(list(expect.keys()) + list(actual.keys())))))

    unknown = sorted(set(c for a in actual.values() for c in a) - set(doc['classes']))
    print('学期 JSON 中不在权威 classes 清单的班级：%s' % (('、'.join(unknown)) if unknown else '无'))
    uncovered = sorted(set(doc['classes']) - set(c for a in actual.values() for c in a))
    print('无任何任课教师的班级：%s' % (('、'.join(uncovered)) if uncovered else '无'))

    if online:
        print('\n=== 线上 users 表 ===')
        print('  （需通过 MCP docsProxy 的 adminListUsers 拉取，本脚本不直连数据库）')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dump', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--online', action='store_true')
    ap.add_argument('--workload', default='')
    ap.add_argument('--term', default='', help='学期标识，默认取最新主数据')
    a = ap.parse_args()
    term_json = pick_term(a.term)
    if not term_json or not os.path.exists(term_json):
        print('❌ 找不到学期主数据：%s' % term_json)
        sys.exit(2)
    path = a.workload
    if not path:
        with open(term_json, 'r', encoding='utf-8') as f:
            path = json.load(f).get('sources', {}).get('workload', '')
    if not path or not os.path.exists(path):
        print('❌ 找不到工作量表：%s' % path)
        sys.exit(2)
    if a.dump:
        dump(path)
    if a.check:
        check(path, term_json, a.online)
    if not a.dump and not a.check:
        dump(path)


if __name__ == '__main__':
    main()

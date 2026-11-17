// tools/test_roundtrip.js —— 导出 → 导入 往返一致性
//
// 为什么测这个：这是台账维护最典型的流程——"导出一份，改几个数，再导回去"。
//   一旦导出列序与导入解析顺序对不上，用户改完导回，整本台账会被写坏
//   （ID 变成名称、单位变成库存数），而且**看起来导入成功了**，事后才发现。
//
// 校验三件事：
//   1) 新版导出 → 导入解析 → 字段与原始档案一一对应；
//   2) 旧版导出（ID 在前）→ 导入解析 → 同样正确（表头名驱动）；
//   3) 无表头的纯数据清单 → 按位置顺序解析（人工整理的清单仍可用）。
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const td = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
const ds = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'data-scope.js'))
const importer = require(path.join(ROOT, 'utils', 'importer.js'))

let pass = 0, fail = 0
const issues = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); issues.push(name + (detail ? ' → ' + detail : '')) }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
const SUPER = { id: 'T001', name: '超管', role: 'super', cls: '' }

const MATS = [
  { id: 'M001', name: '焊锡丝', spec: '0.8mm', cat: '耗材', loc: 'A柜3层', stock: 12, unit: '卷', safe: 5, expire: Date.UTC(2027, 5, 30, 15, 59, 59) },
  { id: 'M002', name: '万用表笔', spec: '1m', cat: '耗材', loc: 'B柜', stock: 4, unit: '根', safe: 6, expire: 0 }
]
const TOOLS = [
  { id: 'TL1', name: '万用表', spec: 'VC830L', loc: 'A柜1层', status: '在库', holder: '' },
  { id: 'TL2', name: '示波器', spec: 'DS1102Z', loc: 'B柜2层', status: '借出', holder: 'S001' }
]

async function main() {
  td.__setDbForTest(makeDb({
    users: [{ id: 'T001', name: '超管', role: '超级管理员', status: '启用' }],
    materials: MATS.map(r => Object.assign({}, r)), tools: TOOLS.map(r => Object.assign({}, r)),
    requisitions: [], borrow: [], stock_io: [], access: [], logs: [], labs: [], repairs: [], inspections: []
  }))
  const sup = fn => ds.runWithScope(ds.scopeOf(SUPER), fn)

  section('① 耗材：新版导出 → 导入解析 → 字段还原')
  const expM = await sup(() => td.exportData({ kind: 'materials' }))
  ok('导出成功', expM && expM.csv, '')
  const csvM = expM.csv.replace(/^\uFEFF/, '')
  const pm = importer.parseImport(csvM, 'material')
  ok('解析出行数正确', pm.rows.length === MATS.length, pm.rows.length + ' vs ' + MATS.length)
  ok('识别到表头', pm.hasHeader === true, 'hasHeader=' + pm.hasHeader)
  const m0 = pm.rows[0] || {}
  const src0 = MATS[0]
  ok('名称正确', m0.name === src0.name, m0.name + ' vs ' + src0.name)
  ok('编号正确', m0.id === src0.id, m0.id + ' vs ' + src0.id)
  ok('规格正确', m0.spec === src0.spec, m0.spec + ' vs ' + src0.spec)
  ok('类别正确', m0.cat === src0.cat, m0.cat + ' vs ' + src0.cat)
  ok('位置正确', m0.loc === src0.loc, m0.loc + ' vs ' + src0.loc)
  ok('单位正确', m0.unit === src0.unit, m0.unit + ' vs ' + src0.unit)
  ok('库存正确', String(m0.stock) === String(src0.stock), m0.stock + ' vs ' + src0.stock)
  ok('预警线正确', String(m0.safe) === String(src0.safe), m0.safe + ' vs ' + src0.safe)
  ok('效期被带出（往返不丢）', !!m0.expire, 'expire=' + m0.expire)

  section('② 工具：新版导出 → 导入解析 → 字段还原')
  const expT = await sup(() => td.exportData({ kind: 'tools' }))
  const csvT = expT.csv.replace(/^\uFEFF/, '')
  const pt = importer.parseImport(csvT, 'tool')
  ok('解析出行数正确', pt.rows.length === TOOLS.length, pt.rows.length + ' vs ' + TOOLS.length)
  const t0 = pt.rows[0] || {}
  ok('名称正确', t0.name === TOOLS[0].name, t0.name + ' vs ' + TOOLS[0].name)
  ok('编号正确', t0.id === TOOLS[0].id, t0.id + ' vs ' + TOOLS[0].id)
  ok('规格正确', t0.spec === TOOLS[0].spec, t0.spec + ' vs ' + TOOLS[0].spec)
  ok('位置正确', t0.loc === TOOLS[0].loc, t0.loc + ' vs ' + TOOLS[0].loc)
  ok('状态正确', t0.status === TOOLS[0].status, t0.status + ' vs ' + TOOLS[0].status)
  ok('持有人正确', (t0.holder || '') === TOOLS[0].holder, (t0.holder || '') + ' vs ' + TOOLS[0].holder)

  section('③ 旧版导出（编号在前）→ 表头名驱动解析仍正确')
  const oldM = '耗材ID,名称,规格,类别,存放位置,当前库存,单位,预警线\n' +
    'M001,焊锡丝,0.8mm,耗材,A柜3层,12,卷,5\n'
  const pmOld = importer.parseImport(oldM, 'material')
  const om = pmOld.rows[0] || {}
  ok('旧版表头被识别', pmOld.hasHeader === true)
  ok('旧版：名称正确', om.name === '焊锡丝', om.name)
  ok('旧版：编号正确', om.id === 'M001', om.id)
  ok('旧版：单位正确', om.unit === '卷', om.unit)
  ok('旧版：库存正确', String(om.stock) === '12', om.stock)
  ok('旧版：预警线正确', String(om.safe) === '5', om.safe)
  const oldT = '工具ID,名称,规格,存放位置,状态,当前持有人\nTL1,万用表,VC830L,A柜1层,在库,\n'
  const ptOld = importer.parseImport(oldT, 'tool')
  const ot = ptOld.rows[0] || {}
  ok('旧版工具：名称正确', ot.name === '万用表', ot.name)
  ok('旧版工具：编号正确', ot.id === 'TL1', ot.id)
  ok('旧版工具：状态正确', ot.status === '在库', ot.status)

  section('④ 无表头的人工清单 → 按位置顺序解析（保持原有能力）')
  const plainM = '焊锡丝,M001,0.8mm,耗材,A柜3层,卷,12,5\n'
  const pmPlain = importer.parseImport(plainM, 'material')
  const pl = pmPlain.rows[0] || {}
  ok('无表头：识别为无表头', pmPlain.hasHeader === false)
  ok('无表头：名称正确', pl.name === '焊锡丝', pl.name)
  ok('无表头：编号正确', pl.id === 'M001', pl.id)
  ok('无表头：库存正确', String(pl.stock) === '12', pl.stock)

  section('⑤ 效期往返：带效期的耗材导出后再解析，效期不丢')
  ok('M001 导出含有效期列', /有效期/.test(expM.csv), '')
  ok('M001 解析出有效期', !!pm.rows[0].expire, pm.rows[0].expire)

  // ===== 引号/逗号/公式字段的往返（此前裸切列会把整行错位，写坏台账）=====
  section('② 含逗号/引号/公式的字段：导出→导入必须原样还原')
  {
    const tricky = [
      { id: 'M010', name: '焊锡丝, 无铅环保型', spec: '0.8mm 含"特殊"', cat: '耗材', loc: 'A柜3层', stock: 12, unit: '卷', safe: 5 },
      { id: 'M011', name: '=1+1 公式测试', spec: '+5V 电源模块', cat: '耗材', loc: 'B柜', stock: 3, unit: '个', safe: 1 },
      { id: 'M012', name: '绝缘胶带\n第二行', spec: '-40℃ 耐低温', cat: '耗材', loc: 'C柜', stock: 2, unit: '卷', safe: 1 }
    ]
    td.__setDbForTest(makeDb({
      users: [{ id: 'T001', name: '超管', role: '超级管理员', status: '启用' }],
      materials: tricky.map(r => Object.assign({}, r)), tools: [], requisitions: [], borrow: [],
      stock_io: [], access: [], logs: [], labs: [], repairs: [], inspections: []
    }))
    const expT = await sup(() => td.exportData({ kind: 'materials' }))
    const csvT = expT.csv.replace(/^\uFEFF/, '')
    const pt = importer.parseImport(csvT, 'material')
    ok('难例字段条数正确（3 条）', pt.rows.length === 3, '实得 ' + pt.rows.length)
    const r0 = pt.rows[0] || {}
    ok('含逗号的名称原样还原', r0.name === '焊锡丝, 无铅环保型', JSON.stringify(r0.name))
    ok('含逗号时各列不错位（编号/规格/单位）',
      r0.id === 'M010' && r0.spec === '0.8mm 含"特殊"' && r0.unit === '卷' && r0.stock === '12',
      JSON.stringify(r0))
    const r1 = pt.rows[1] || {}
    ok('公式型名称导入后还原为原值（防护单引号被去掉）', r1.name === '=1+1 公式测试', JSON.stringify(r1.name))
    ok('以 + 开头的规格不被误当公式截断', r1.spec === '+5V 电源模块', JSON.stringify(r1.spec))
    const r2 = pt.rows[2] || {}
    ok('含换行的名称不被拆行', r2.name === '绝缘胶带\n第二行', JSON.stringify(r2.name))
    ok('以 - 开头的规格原样还原', r2.spec === '-40℃ 耐低温', JSON.stringify(r2.spec))
    // 导出侧：公式触发符必须被前置单引号保护（否则 Excel 当公式执行）
    ok('导出时公式型字段被前置单引号保护', /'=1\+1 公式测试/.test(csvT) || /"'=1\+1/.test(csvT), csvT.split('\n')[2] || '')
    const src = [
      fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'tencentdocs.js'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'utils', 'export.js'), 'utf8')
    ]
    ok('三处 csvCell 均带公式注入防护',
      src.every(x => /\[\\s\]\*\[=\+\\-\@\]/.test(x)),
      src.map(x => /\[\\s\]\*\[=\+\\-\@\]/.test(x)).join(','))
    ok('导入侧会去掉防护单引号', /unguardFormula/.test(fs.readFileSync(path.join(ROOT, 'utils', 'importer.js'), 'utf8')))
  }

  console.log('\n========== 导出导入往返：' + pass + ' passed, ' + fail + ' failed ==========')
  if (issues.length) { console.log('\n问题明细：'); issues.forEach(i => console.log('  · ' + i)) }
  process.exitCode = fail ? 1 : 0
}

main().catch(e => {
  console.error('往返测试异常：', e && e.stack || e)
  process.exitCode = 1
})

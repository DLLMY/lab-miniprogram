// tools/test_input_bounds.js
// 输入边界回归：数量与效期的取值校验（2026-11-17 第十六轮）。
//
// 背景：本轮实测发现两套生产适配器用 Math.floor(Number(x) || 0) 校验数量，
//   把小数 2.5 静默截断成 2 —— 账面按 2 记、实物给 2.5，账实差 0.5，
//   而提示文案写着「必须是整数」却放行了小数；建档/批量导入更是用 Number(x)||0
//   根本不取整 → 小数直接进库存，而演示 mock 会截断 → 生产与演示口径分叉。
//   同时没有上限，误输 1e12 会把库存写成天文数字。
//   效期同理：只认 YYYY-MM-DD，Excel 常见的 2026/3/5、20260305 一律被静默丢弃，
//   且 2026-02-30 这种假日期会被 Date.UTC 自动进位（实际比用户填的晚 2 天）。
//
// 修复后：统一 parseQty（严格整数 + 上限）与 expireTs（多格式 + 真实日期校验），
//   写入侧非法输入一律明确报错，不再静默改写。
// 本文件同时验证：生产路径 / 本地 mock / 云 mock 三套实现的拒绝口径一致。
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

let CUR_OPENID = ''
const ModuleStub = {
  init: function () {}, database: function () { return {} }, command: {},
  getWXContext: function () { return { OPENID: CUR_OPENID } }
}
const _origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return ModuleStub
  return _origLoad.apply(this, arguments)
}
process.env.DATA_BACKEND = 'cloud'
process.env.USE_MOCK = 'false'
process.env.FALLBACK = 'off'

const ROOT = path.join(__dirname, '..')
const clouddb = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
const cloudMock = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js'))
const localMock = require(path.join(ROOT, 'utils', 'mock.js'))

let pass = 0, fail = 0
const issues = []
function ok(title, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + title) }
  else { fail++; issues.push(title + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + title + (extra ? ' → ' + extra : '')) }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
const CLS = '2024级电气1班'
const SEED = () => ({
  users: [
    { id: 'T001', name: '邓老师', role: 'super', cls: '', status: '启用', openid: 'o_super', managedClasses: '' },
    { id: 'WT001', name: '教师乙', role: 'teacher', cls: '', status: '启用', openid: 'o_teacher', managedClasses: CLS },
    { id: 'S001', name: '学生丙', role: 'student', cls: CLS, status: '启用', openid: 'o_student', managedClasses: '' }
  ],
  materials: [
    { id: 'M001', name: '焊锡丝', spec: '0.8mm', cat: '耗材', loc: 'A柜3层', stock: 10, unit: '卷', safe: 2, status: '正常', expire: '' },
    { id: 'M002', name: '钢料', spec: 'Q235', cat: '钢料', loc: '精工楼509', stock: 5, unit: '块', safe: 1, status: '正常', expire: '' }
  ],
  tools: [{ id: 'T100', name: '万用表', spec: 'VC830L', loc: 'A柜1层', status: '在库', holder: '' }],
  requisitions: [], borrow: [], stock_io: [], access: [], logs: [],
  labs: [], repairs: [], inspections: []
})

const db = makeDb(SEED())
clouddb.__setDbForTest(db)
const main = (evt) => cloudMock.main(evt)
const code = (r) => (r && r.code)
const stock = (id) => (db.store.materials.find(m => m.id === id) || {}).stock

;(async () => {
  section('① 数量边界：非正整数与超上限一律拒绝（生产路径）')
  CUR_OPENID = 'o_teacher'
  const bad = [-5, 0, 2.5, 1e12, 'abc', NaN]
  for (const q of bad) {
    const r = await main({ action: 'io', actor: 'WT001', matId: 'M001', type: 'in', qty: q, note: '边界测试' })
    ok('入库 qty=' + String(q) + ' 被拒（400）', code(r) === 400, JSON.stringify(r))
  }
  ok('非法数量没有改动库存', stock('M001') === 10, '库存=' + stock('M001'))
  for (const q of bad) {
    const r = await main({ action: 'requisition', actor: 'S001', user: 'S001', matId: 'M001', qty: q, reason: '边界测试' })
    ok('申请 qty=' + String(q) + ' 被拒（400）', code(r) === 400, JSON.stringify(r))
  }
  for (const q of bad) {
    const r = await main({ action: 'batchIo', actor: 'WT001', type: 'in', items: [{ matId: 'M001', qty: q }], note: '边界测试' })
    ok('批量入库 qty=' + String(q) + ' 被拒（400）', code(r) === 400, JSON.stringify(r))
  }
  for (const q of bad) {
    if (q === 0) continue   // 实盘 0 是合法业务语义（东西真不在库），单独断言
    const r = await main({ action: 'stocktake', actor: 'WT001', mode: 'check', items: [{ matId: 'M001', real: q }] })
    ok('盘点 real=' + String(q) + ' 被拒（400）', code(r) === 400, JSON.stringify(r))
  }
  // 实盘 0 = 账面直接归零（合法但代价大，前端已加归零项点名确认）
  const zBefore = stock('M001')
  const rz = await main({ action: 'stocktake', actor: 'WT001', mode: 'check', items: [{ matId: 'M001', real: 0 }] })
  ok('盘点 real=0 被接受且账面归零（业务语义：东西真不在库）',
    code(rz) === 0 && stock('M001') === 0, '库存 ' + zBefore + ' → ' + stock('M001'))
  // 归零后库存从 0 起算，后续入库断言用当前值
  await main({ action: 'io', actor: 'WT001', matId: 'M001', type: 'in', qty: 13, note: '恢复基线' })
  // 建档期初数量允许 0，但不允许小数/负数/超上限
  const okZero = await main({ action: 'addMaterial', actor: 'WT001', name: '零库存建档', spec: 'X', cat: '耗材', loc: 'A柜', unit: '卷', safe: 1, qty: 0 })
  ok('建档 qty=0 被接受（期初为 0 合法）', code(okZero) === 0, JSON.stringify(okZero))
  for (const q of [-1, 2.5, 1e12]) {
    const r = await main({ action: 'addMaterial', actor: 'WT001', name: '边界建档' + String(q), spec: 'X', cat: '耗材', loc: 'A柜', unit: '卷', safe: 1, qty: q })
    ok('建档 qty=' + String(q) + ' 被拒（400）', code(r) === 400, JSON.stringify(r))
  }
  const built = await clouddb.listMaterials()
  ok('库存没有出现小数', built.every(m => Number.isInteger(Number(m.stock))),
    JSON.stringify(built.map(m => m.id + ':' + m.stock)))

  section('② 合法数量仍然正常入库')
  const base = stock('M001')
  const good = await main({ action: 'io', actor: 'WT001', matId: 'M001', type: 'in', qty: 3, note: '正常入库' })
  ok('整数数量入库成功', code(good) === 0 && stock('M001') === base + 3, '库存=' + stock('M001'))
  const over = await main({ action: 'io', actor: 'WT001', matId: 'M001', type: 'out', qty: 999999, note: '超量出库' })
  ok('超出库存的出库被拒（400）', code(over) === 400, JSON.stringify(over))

  section('③ 效期：多格式接受、假日期与乱码拒绝')
  const cases = [
    ['2027-03-05', true], ['2027/3/5', true], ['20270305', true], ['2027年3月5日', true],
    ['2026-13-45', false], ['2026-02-30', false], ['not-a-date', false], ['', true]
  ]
  let ei = 0
  for (const [val, shouldOk] of cases) {
    ei++
    const r = await main({ action: 'addMaterial', actor: 'WT001', name: '效期用例' + ei, spec: 'X', cat: '耗材', loc: 'A柜', unit: '卷', safe: 1, qty: 1, expire: val })
    ok('建档效期「' + val + '」' + (shouldOk ? ' 被接受' : ' 被拒（400）'),
      shouldOk ? code(r) === 0 : code(r) === 400, JSON.stringify(r))
  }
  const slash = await main({ action: 'addMaterial', actor: 'WT001', name: '斜杠效期件', spec: 'X', cat: '耗材', loc: 'A柜', unit: '卷', safe: 1, qty: 1, expire: '2027/3/5' })
  const mats = await clouddb.listMaterials()
  const slashRow = mats.find(m => m.name === '斜杠效期件')
  ok('斜杠格式效期被真正存下（可触发临期提示）', code(slash) === 0 && !!slashRow && !!slashRow.expire,
    JSON.stringify(slashRow && slashRow.expire))

  section('④ 批量导入：非法行被跳过并给出原因，不中断整批')
  CUR_OPENID = 'o_super'
  let imp = await main({ action: 'importMaterials', actor: 'T001', rows: [{ name: '正常导入件', stock: 4, unit: '个', safe: 1 }] })
  ok('正常行导入成功', code(imp) === 0 && imp.data && imp.data.created === 1, JSON.stringify(imp && imp.data))
  imp = await main({ action: 'importMaterials', actor: 'T001', rows: [{ name: '小数库存件', stock: 2.5, unit: '个' }] })
  ok('小数库存的行被跳过', code(imp) === 0 && imp.data && imp.data.skipped === 1 && imp.data.created === 0,
    JSON.stringify(imp && imp.data))
  imp = await main({ action: 'importMaterials', actor: 'T001', rows: [{ name: '非法效期件', stock: 1, unit: '个', expire: '2026-13-45' }] })
  ok('非法效期的行被跳过', code(imp) === 0 && imp.data && imp.data.skipped === 1 && imp.data.created === 0,
    JSON.stringify(imp && imp.data))
  imp = await main({ action: 'importMaterials', actor: 'T001', rows: [{ name: '斜杠效期件2', stock: 1, unit: '个', expire: '2027/3/5' }] })
  ok('斜杠效期的行正常导入', code(imp) === 0 && imp.data && imp.data.created === 1, JSON.stringify(imp && imp.data))
  const after = await clouddb.listMaterials()
  ok('被跳过的行没有入库', !after.find(m => m.name === '小数库存件') && !after.find(m => m.name === '非法效期件'),
    JSON.stringify(after.map(m => m.name)))

  section('⑤ 三套实现口径一致：小数与超上限在演示/回退路径同样被拒')
  // 本地 mock（前端回退）
  localMock.__setDbForTest({
    users: [{ id: 'WT001', name: '教师乙', role: 'teacher', cls: CLS, status: '启用' }],
    materials: [{ id: 'M001', name: '焊锡丝', spec: '', cat: '耗材', loc: '', stock: 10, unit: '卷', safe: 2, status: '正常', expire: '' }],
    tools: [], requisitions: [], borrow: [], stock_io: [], access: [], logs: [], labs: [], repairs: [], inspections: []
  })
  const lm1 = localMock.dispatch('io', { actor: 'WT001', matId: 'M001', type: 'in', qty: 2.5, note: 'x' })
  ok('本地 mock 拒绝小数数量', lm1 && lm1.code === 400, JSON.stringify(lm1))
  const lm2 = localMock.dispatch('io', { actor: 'WT001', matId: 'M001', type: 'in', qty: 1e12, note: 'x' })
  ok('本地 mock 拒绝超上限数量', lm2 && lm2.code === 400, JSON.stringify(lm2))
  const lm3 = localMock.dispatch('io', { actor: 'WT001', matId: 'M001', type: 'in', qty: 3, note: 'x' })
  ok('本地 mock 接受正常整数', lm3 && lm3.code === 0, JSON.stringify(lm3))

  // 云 mock（USE_MOCK=true 的独立进程）
  const childScript = `
    const path = require('path'); const Module = require('module')
    const ModuleStub = { init(){}, database(){return {}}, command:{}, getWXContext(){return {OPENID:'o_teacher'}} }
    const orig = Module._load
    Module._load = function (req) { if (req === 'wx-server-sdk') return ModuleStub; return orig.apply(this, arguments) }
    process.env.USE_MOCK = 'true'
    const m = require(${JSON.stringify(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js'))})
    m.__setDbForTest({
      users: [{ id: 'WT001', name: '教师乙', role: 'teacher', cls: '2024级电气1班', status: '启用', managedClasses: '2024级电气1班' }],
      materials: [{ id: 'M001', name: '焊锡丝', spec: '', cat: '耗材', loc: '', stock: 10, unit: '卷', safe: 2, status: '正常', expire: '' }],
      tools: [], requisitions: [], borrow: [], stock_io: [], access: [], logs: [], labs: [], repairs: [], inspections: []
    })
    ;(async () => {
      const out = []
      for (const q of [2.5, 1e12, 3]) {
        const r = await m.main({ action: 'io', actor: 'WT001', matId: 'M001', type: 'in', qty: q, note: 'x' })
        out.push(r && r.code)
      }
      console.log('RESULT:' + JSON.stringify(out))
    })()
  `
  let cmCodes = null
  try {
    const out = execFileSync(process.execPath, ['-e', childScript], { cwd: ROOT, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    const line = (out.split('\n').find(l => l.indexOf('RESULT:') >= 0) || '')
    cmCodes = JSON.parse(line.replace('RESULT:', '').trim())
  } catch (e) {
    cmCodes = null
  }
  ok('云 mock 拒绝小数数量', Array.isArray(cmCodes) && cmCodes[0] === 400, JSON.stringify(cmCodes))
  ok('云 mock 拒绝超上限数量', Array.isArray(cmCodes) && cmCodes[1] === 400, JSON.stringify(cmCodes))
  ok('云 mock 接受正常整数', Array.isArray(cmCodes) && cmCodes[2] === 0, JSON.stringify(cmCodes))

  section('⑥ 源码层：不再残留静默取整写法')
  const fs = require('fs')
  const srcs = [
    'cloudfunctions/docsProxy/clouddb.js', 'cloudfunctions/docsProxy/tencentdocs.js',
    'cloudfunctions/docsProxy/index.js', 'utils/mock.js'
  ].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8'))
  const codeLines = srcs.map(t => t.split('\n').filter(l => /Math\.floor\(Number\(/.test(l) && !/^\s*\/\//.test(l)))
  ok('四套实现都不再有 Math.floor(Number(...)) 静默取整', codeLines.every(a => a.length === 0),
    JSON.stringify(codeLines.map(a => a.length)))
  ok('四套实现都引入了 parseQty', srcs.every(t => /function parseQty\(/.test(t)))

  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====')
  if (issues.length) {
    console.log('\n问题清单：')
    issues.forEach(i => console.log('  · ' + i))
  }
  process.exit(fail ? 1 : 0)
})()

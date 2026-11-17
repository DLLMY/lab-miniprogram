'use strict'
// ============================================================
// 数据域（班级 / 老师）行级隔离 回归套件
// ============================================================
// 覆盖：
//   A 纯函数裁决（scopeOf / rowVisible / canWriteRow / userVisible）
//   B 真实 clouddb 适配器集成（注入内存伪库，走 getRecords/addRecord/updateRecord）
//   C AsyncLocalStorage 并发隔离
//   D 四套实现源码一致性（防只改一套导致行为分叉）
//
// 运行：node tools/test-data-scope.js

const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'cloudfunctions', 'docsProxy')
const ds = require(path.join(SRC, 'data-scope.js'))
const td = require(path.join(SRC, 'clouddb.js'))

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b),
    'got=' + JSON.stringify(a) + ' expect=' + JSON.stringify(b))
}
function section(t) { console.log('\n--- ' + t + ' ---') }

// —— 测试身份 ——
const SUPER = { id: 'T001', name: '超管', role: 'super', cls: '' }
const ADMIN = { id: 'A001', name: '管理员', role: 'admin', cls: '' }
const TA = { id: 'TA', name: '老师A', role: 'teacher', cls: '24电气1', managedClasses: '24电气1' }
const TB = { id: 'TB', name: '老师B', role: 'teacher', cls: '24电气2', managedClasses: '24电气2' }
const TM = { id: 'TM', name: '多班老师', role: 'teacher', cls: '', managedClasses: '24电气1,24电气2' }
const T0 = { id: 'T0', name: '未配班老师', role: 'teacher', cls: '', managedClasses: '' }
const SA = { id: 'S001', name: '学生A', role: 'student', cls: '24电气1' }
const SB = { id: 'S002', name: '学生B', role: 'student', cls: '24电气2' }

// —— 内存伪云库（collection().get/add/doc().update/remove）——
// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
const REQ = [
  { id: 'Q1', user: 'S001', status: '待审批', cls: '24电气1' },
  { id: 'Q2', user: 'S002', status: '待审批', cls: '24电气2' },
  { id: 'Q3', user: 'S001', status: '已通过', cls: '' },   // 公共资源（管理员预置/历史数据）
  { id: 'Q4', user: 'S003', status: '已拒绝', cls: '24电气3' }
]
const seedRows = () => ({
  users: [
    { id: 'T001', name: '超管', role: '超级管理员', cls: '', status: '启用' },
    { id: 'A001', name: '管理员', role: '管理员', cls: '', status: '启用' },
    { id: 'TA', name: '老师A', role: '教师', cls: '24电气1', managedClasses: '24电气1', status: '启用' },
    { id: 'TB', name: '老师B', role: '教师', cls: '24电气2', managedClasses: '24电气2', status: '启用' },
    { id: 'S001', name: '学生A', role: '学生', cls: '24电气1', status: '启用' },
    { id: 'S002', name: '学生B', role: '学生', cls: '24电气2', status: '启用' }
  ],
  materials: [{ id: 'M1', name: '焊锡丝', stock: 10 }],
  tools: [{ id: 'TL1', name: '万用表', status: '在库' }],
  labs: [], repairs: [], inspections: [],
  requisitions: REQ.map(r => Object.assign({}, r)),
  borrow: [
    { id: 'B1', user: 'S001', status: '借出中', cls: '24电气1' },
    { id: 'B2', user: 'S002', status: '借出中', cls: '24电气2' }
  ],
  stock_io: [
    { id: 'I1', item: 'M1', op: 'S001', cls: '24电气1' },
    { id: 'I2', item: 'M1', op: 'S002', cls: '24电气2' }
  ],
  access: [],
  logs: [
    { id: 'L1', actor: 'S001', op: '新增耗材', cls: '24电气1' },
    { id: 'L2', actor: 'S002', op: '新增耗材', cls: '24电气2' }
  ]
})

async function inScope(user, fn) {
  return ds.runWithScope(ds.scopeOf(user), fn)
}

async function main() {
  // ============ A. 纯函数裁决 ============
  section('A. 纯函数裁决')

  eq('parseClasses 支持中英文逗号/分号/空格', ds.parseClasses('24电气1,24电气2；24电气3 24电气4'),
    ['24电气1', '24电气2', '24电气3', '24电气4'])
  ok('super 为 full（不注入过滤）', ds.scopeOf(SUPER).full === true)
  ok('admin 为 full（不注入过滤）', ds.scopeOf(ADMIN).full === true)
  ok('未登录为 full（公开接口不受影响）', ds.scopeOf(null).full === true)
  eq('teacher 带班列表来自 managedClasses', ds.scopeOf(TA).classes, ['24电气1'])
  eq('teacher 多班解析', ds.scopeOf(TM).classes, ['24电气1', '24电气2'])
  eq('teacher 未配 managedClasses 时回退 cls', ds.scopeOf({ id: 'X', role: 'teacher', cls: '24电气1' }).classes, ['24电气1'])
  ok('student 不带班级列表', ds.scopeOf(SA).classes.length === 0)
  ok('needGuard 对 super/admin/未登录为 false',
    !ds.needGuard(ds.scopeOf(SUPER)) && !ds.needGuard(ds.scopeOf(ADMIN)) && !ds.needGuard(null))
  ok('needGuard 对 teacher/student 为 true',
    ds.needGuard(ds.scopeOf(TA)) && ds.needGuard(ds.scopeOf(SA)))

  const sA = ds.scopeOf(TA), sB = ds.scopeOf(TB), sM = ds.scopeOf(TM), s0 = ds.scopeOf(T0), sSA = ds.scopeOf(SA)
  ok('主数据表全局共享（materials 不被隔离）', ds.rowVisible(sA, 'materials', { cls: '24电气9' }))
  ok('主数据表全局共享（labs 不被隔离）', ds.rowVisible(sA, 'labs', { cls: '24电气9' }))
  ok('teacher 可见本班流水', ds.rowVisible(sA, 'requisitions', { cls: '24电气1' }))
  ok('teacher 不可见别班流水', !ds.rowVisible(sA, 'requisitions', { cls: '24电气2' }))
  ok('teacher 可见空 cls 公共资源', ds.rowVisible(sA, 'requisitions', { cls: '' }))
  ok('多班老师可见两个班', ds.rowVisible(sM, 'requisitions', { cls: '24电气1' }) && ds.rowVisible(sM, 'requisitions', { cls: '24电气2' }))
  ok('未配班老师只可见公共资源', ds.rowVisible(s0, 'requisitions', { cls: '' }) && !ds.rowVisible(s0, 'requisitions', { cls: '24电气1' }))
  ok('super 全通', ds.rowVisible(ds.scopeOf(SUPER), 'requisitions', { cls: '任意班' }))
  ok('student 仅可见本人记录', ds.rowVisible(sSA, 'requisitions', { user: 'S001', cls: '24电气1' }))
  ok('student 不可见同班他人记录', !ds.rowVisible(sSA, 'requisitions', { user: 'S009', cls: '24电气1' }))
  ok('student 不可见别班记录', !ds.rowVisible(sSA, 'requisitions', { user: 'S002', cls: '24电气2' }))
  ok('logs 归属人字段为 actor', ds.rowVisible(sSA, 'logs', { actor: 'S001' }) && !ds.rowVisible(sSA, 'logs', { actor: 'S002' }))
  ok('stock_io 归属人字段为 op', ds.rowVisible(sSA, 'stock_io', { op: 'S001' }) && !ds.rowVisible(sSA, 'stock_io', { op: 'S002' }))

  ok('teacher 可写本班', ds.canWriteRow(sA, 'requisitions', { cls: '24电气1' }))
  ok('teacher 跨班写被拒', !ds.canWriteRow(sA, 'requisitions', { cls: '24电气2' }))
  ok('teacher 可写公共资源', ds.canWriteRow(sA, 'requisitions', { cls: '' }))
  ok('student 跨人写被拒', !ds.canWriteRow(sSA, 'requisitions', { user: 'S002' }))
  ok('super 跨班写允许', ds.canWriteRow(ds.scopeOf(SUPER), 'requisitions', { cls: '任意班' }))

  ok('老师可见本班学生', ds.userVisible(sA, { id: 'S001', cls: '24电气1' }))
  ok('老师不可见别班学生', !ds.userVisible(sA, { id: 'S002', cls: '24电气2' }))
  ok('老师不可见无班级账号', !ds.userVisible(sA, { id: 'A001', cls: '' }))
  ok('学生用户列表仅自己', ds.userVisible(sSA, { id: 'S001' }) && !ds.userVisible(sSA, { id: 'S002' }))
  ok('super 用户列表全通', ds.userVisible(ds.scopeOf(SUPER), { id: '任意', cls: '' }))

  eq('sanitizeManagedClasses 规范化', ds.sanitizeManagedClasses(' 24电气1 ， 24电气2 '), '24电气1,24电气2')
  eq('readText 兼容腾讯文档文本列数组', ds.readText({ x: [{ type: 'text', text: '甲' }, { type: 'text', text: '班' }] }, 'x'), '甲班')
  eq('readCls 兼容中文列名', ds.readCls({ '归属班级': '24电气1' }), '24电气1')
  eq('isScopedTable 覆盖 7 张流水表', ds.SCOPED_TABLES.length, 7)
  ok('主数据表不在隔离清单', ds.isGlobalTable('materials') && ds.isGlobalTable('tools') && ds.isGlobalTable('labs') && ds.isGlobalTable('users'))

  // ============ B. 真实适配器集成 ============
  section('B. clouddb 适配器集成（内存伪库）')
  let db = makeDb(seedRows())
  td.__setDbForTest(db)

  const idsVisible = async (user, table) => inScope(user, async () => {
    const rows = await td.getRecords(table)
    return rows.map(r => r.fields.id).sort()
  })

  eq('teacherA 读领用：本班 + 公共资源', await idsVisible(TA, 'requisitions'), ['Q1', 'Q3'])
  eq('teacherB 读领用：本班 + 公共资源', await idsVisible(TB, 'requisitions'), ['Q2', 'Q3'])
  eq('多班老师读领用：两班 + 公共资源', await idsVisible(TM, 'requisitions'), ['Q1', 'Q2', 'Q3'])
  eq('未配班老师读领用：仅公共资源', await idsVisible(T0, 'requisitions'), ['Q3'])
  eq('super 读领用：全部', await idsVisible(SUPER, 'requisitions'), ['Q1', 'Q2', 'Q3', 'Q4'])
  eq('admin 读领用：全部', await idsVisible(ADMIN, 'requisitions'), ['Q1', 'Q2', 'Q3', 'Q4'])
  eq('studentA 读领用：仅本人', await idsVisible(SA, 'requisitions'), ['Q1', 'Q3'])
  eq('teacherA 读借出：本班', await idsVisible(TA, 'borrow'), ['B1'])
  eq('teacherA 读出入库：本班', await idsVisible(TA, 'stock_io'), ['I1'])
  eq('teacherA 读日志：本班（按 cls）', await idsVisible(TA, 'logs'), ['L1'])
  eq('studentA 读日志：仅本人（按 actor）', await idsVisible(SA, 'logs'), ['L1'])
  eq('主数据 materials 对所有角色全通', await idsVisible(TA, 'materials'), ['M1'])
  eq('主数据 tools 对所有角色全通', await idsVisible(SA, 'tools'), ['TL1'])

  // 写入自动盖章归属班级
  await inScope(TA, () => td.addRecord('requisitions', { id: 'QNEW', user: 'S001', status: '待审批' }))
  const stamped = db.store.requisitions.find(r => r.id === 'QNEW')
  ok('addRecord 自动继承发起人班级', !!(stamped && stamped.cls === '24电气1'), JSON.stringify(stamped))
  await inScope(TA, () => td.addRecord('requisitions', { id: 'QEXP', user: 'S001', cls: '24电气9' }))
  ok('addRecord 不覆盖显式指定的归属班级',
    db.store.requisitions.find(r => r.id === 'QEXP').cls === '24电气9')
  await inScope(SUPER, () => td.addRecord('materials', { id: 'M2', name: '电阻' }))
  ok('主数据表不写 cls（保持全局共享）', !('cls' in db.store.materials.find(r => r.id === 'M2')))
  await inScope(SUPER, () => td.addRecord('requisitions', { id: 'QG', user: 'S001' }))
  ok('super/admin 产生的流水 cls 为空 → 公共资源',
    db.store.requisitions.find(r => r.id === 'QG').cls === '')

  // 跨班写守卫
  const q2 = db.store.requisitions.find(r => r.id === 'Q2')
  let denied = ''
  try {
    await inScope(TA, () => td.updateRecord('requisitions', q2._id, { status: '已通过' }))
  } catch (e) { denied = e && e.name }
  ok('teacherA 跨班改 teacherB 班级记录 → ScopeDeniedError', denied === 'ScopeDeniedError', 'got=' + denied)
  ok('跨班改未生效（原记录状态不变）', q2.status === '待审批')

  const q1 = db.store.requisitions.find(r => r.id === 'Q1')
  let ownWriteErr = ''
  try { await inScope(TA, () => td.updateRecord('requisitions', q1._id, { status: '已通过' })) }
  catch (e) { ownWriteErr = e && e.message }
  ok('teacherA 改本班记录成功', ownWriteErr === '' && q1.status === '已通过')

  let delDenied = ''
  try { await inScope(TA, () => td.deleteRecordByIds('requisitions', [q2._id])) }
  catch (e) { delDenied = e && e.name }
  ok('跨班删除被拒', delDenied === 'ScopeDeniedError')
  ok('跨班删除未生效', !!db.store.requisitions.find(r => r.id === 'Q2'))

  // 报表聚合口径：teacherA 的 usage 只统计可见范围
  let usageErr = ''
  let usageResult = null
  try { usageResult = await inScope(TA, () => td.usage()) }
  catch (e) { usageErr = e && e.message }
  ok('usage 报表在隔离下可正常执行', usageErr === '', usageErr)
  if (usageResult) {
    // 动态对账：以当前 scope 下真实可见的领用行重算期望分布，
    // 验证报表聚合口径 == 过滤后数据（而不是全量算完再删行）。
    const visible = await inScope(TA, () => td.getRecords('requisitions'))
    const expect = { pending: 0, approved: 0, rejected: 0, canceled: 0, other: 0 }
    for (const r of visible) {
      const s = td.TR.reqRev['' + r.fields.status] || 'other'
      expect[s] = (expect[s] || 0) + 1
    }
    ok('usage 领用统计 = 过滤后可见数据（报表口径正确）',
      JSON.stringify(usageResult.reqStat) === JSON.stringify(expect),
      'got=' + JSON.stringify(usageResult.reqStat) + ' expect=' + JSON.stringify(expect))
    const total = Object.keys(expect).reduce((n, k) => n + expect[k], 0)
    ok('usage 未把别班记录计入统计', total === visible.length && total < db.store.requisitions.length,
      'visible=' + total + ' all=' + db.store.requisitions.length)
  } else {
    ok('usage 领用统计 = 过滤后可见数据', false, 'usage 未返回结果')
    ok('usage 未把别班记录计入统计', false, 'usage 未返回结果')
  }

  // 用户列表的数据域隔离 + 身份对象必须携带带班字段
  const listA = await inScope(TA, () => td.adminListUsers(TA))
  eq('teacherA 用户列表仅本班学生', listA.map(u => u.id).sort(), ['S001'])
  const listS = await inScope(SUPER, () => td.adminListUsers(SUPER))
  ok('super 用户列表全通', listS.length === 6, 'rows=' + listS.length)
  const fu = await inScope(null, () => td.findUser('TA'))
  ok('findUser 透出 managedClasses（prodHandler 的 me 依赖它）',
    !!(fu && fu.user && fu.user.managedClasses === '24电气1'),
    JSON.stringify(fu && fu.user))

  // 应急开关
  process.env.DATA_SCOPE = 'off'
  eq('DATA_SCOPE=off 时 teacherA 恢复全通', await idsVisible(TA, 'requisitions'),
    ['Q1', 'Q2', 'Q3', 'Q4', 'QEXP', 'QG', 'QNEW'])
  process.env.DATA_SCOPE = 'on'
  ok('开关还原后隔离恢复', (await idsVisible(TA, 'requisitions')).indexOf('Q2') < 0)

  // ============ C. 并发隔离 ============
  section('C. AsyncLocalStorage 并发隔离')
  const [rA, rB, rS] = await Promise.all([
    inScope(TA, () => td.getRecords('requisitions')),
    inScope(TB, () => td.getRecords('requisitions')),
    inScope(SUPER, () => td.getRecords('requisitions'))
  ])
  ok('并发请求 A 只读本班', rA.map(r => r.fields.id).sort().join(',') === 'Q1,Q3,QG,QNEW')
  ok('并发请求 B 只读本班', rB.map(r => r.fields.id).sort().join(',') === 'Q2,Q3,QG')
  ok('并发请求 super 读全量', rS.length === db.store.requisitions.length)
  ok('作用域外 currentScope 为 null（不泄漏）', ds.currentScope() === null)

  // ============ D. 四套实现源码一致性 ============
  section('D. 源码一致性（防行为分叉）')
  const read = f => fs.readFileSync(path.join(SRC, f), 'utf8')
  const cloud = read('clouddb.js'), docs = read('tencentdocs.js'), idx = read('index.js')
  const front = fs.readFileSync(path.join(ROOT, 'utils', 'mock.js'), 'utf8')

  for (const [name, s] of [['clouddb', cloud], ['tencentdocs', docs]]) {
    ok(name + ' 引入 data-scope', s.indexOf("require('./data-scope.js')") >= 0)
    ok(name + ' getRecords 注入 rowVisible', s.indexOf('ds.rowVisible') >= 0)
    ok(name + ' addRecord 注入归属盖章', s.indexOf('ds.shouldStampCls') >= 0)
    ok(name + ' 写操作含跨班守卫', s.indexOf('__assertWritable') >= 0)
    ok(name + ' publicUser 透出 managedClasses', /function publicUser[\s\S]{0,200}managedClasses/.test(s))
    ok(name + ' adminListUsers 含 userVisible', s.indexOf('ds.userVisible') >= 0)
    ok(name + ' users 含 managedClasses 列', /users:\s*\{[^}]*managedClasses/.test(s))
  }
  const scopedCols = ['requisitions', 'borrow', 'stock_io', 'access', 'logs', 'repairs', 'inspections']
  for (const t of scopedCols) {
    ok('clouddb COL.' + t + ' 含 cls', new RegExp(t + ':\\s*\\{[^}]*cls:').test(cloud))
    ok('tencentdocs COL.' + t + ' 含 cls', new RegExp(t + ':\\s*\\{[^}]*cls:').test(docs))
  }
  ok('index.js 用 runWithScope 包裹请求', idx.indexOf('ds.runWithScope') >= 0)
  ok('index.js run() 将 ScopeDeniedError 转 403', /const run = async[\s\S]{0,500}ScopeDeniedError/.test(idx))
  ok('index.js main catch 禁止拒绝异常回退', /catch \(e\)[\s\S]{0,400}ScopeDeniedError/.test(idx))
  ok('前端 mock 明确标注演示模式不做隔离', front.indexOf('数据域隔离') >= 0 || front.indexOf('data-scope') >= 0)

  // ============ E. 流水班级显示契约（用户要求「流水显示班级即可」）============
  section('E. 流水班级显示（四套实现 + 前端列表）')
  const normFns = ['normReq', 'normBorrow', 'normStockIO', 'normAccess', 'normLog', 'normRepair', 'normInspection']
  for (const [name, s] of [['clouddb', cloud], ['tencentdocs', docs]]) {
    for (const fn of normFns) {
      const m = s.match(new RegExp('function ' + fn + '\\(f\\) \\{[\\s\\S]*?\\n\\}'))
      ok(name + ' ' + fn + ' 返回 cls', !!m && m[0].indexOf('cls: ds.readCls(f)') >= 0)
    }
    ok(name + ' 列表 rows 也带 cls（≥10 处）', (s.match(/cls: ds\.readCls\(f\)/g) || []).length >= 10)
  }
  ok('云端 mock 定义 flowCls', idx.indexOf('function flowCls(') >= 0)
  ok('前端 mock 定义 flowCls', front.indexOf('function flowCls(') >= 0)
  const flowPages = ['approve/approve', 'mine/mine', 'io/io', 'logs/logs', 'repair/repair', 'inspection/inspection']
  for (const p of flowPages) {
    const w = fs.readFileSync(path.join(ROOT, 'pages', p + '.wxml'), 'utf8')
    ok('前端 ' + p + ' 显示归属班级', w.indexOf('wx:if="{{item.cls}}"') >= 0 && w.indexOf('{{item.cls}}') >= 0)
  }

  // ============ F. 班级全称不截断 + 学生工作台申请入口 ==================
  section('F. 班级全称完整展示 & 学生端申请记录入口')
  const appWxss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  // .cls-line 必须存在且可换行（.list-sub 带 ellipsis 会把班级压成缩略）
  ok('app.wxss 定义 .cls-line 可换行样式', /\.cls-line\s*\{[^}]*white-space:\s*normal/.test(appWxss))
  ok('.cls-line 不含 text-overflow: ellipsis',
    !/\.cls-line\s*\{[^}]*text-overflow:\s*ellipsis/.test(appWxss))
  // 所有列表型班级行必须使用 .cls-line，而不是会截断的 .list-sub
  const clsPages = ['inspection/inspection', 'io/io', 'logs/logs', 'mine/mine', 'repair/repair']
  for (const p of clsPages) {
    const w = fs.readFileSync(path.join(ROOT, 'pages', p + '.wxml'), 'utf8')
    const bad = /class="list-sub"[^>]*>\s*班级：\s*\{\{item\.cls\}\}/.test(w)
    ok('前端 ' + p + ' 班级行不用会截断的 .list-sub', !bad)
    ok('前端 ' + p + ' 班级行改用 .cls-line', w.indexOf('class="cls-line"') >= 0 && w.indexOf('{{item.cls}}') >= 0)
  }
  // 审批页 kv 结构：值列需允许换行
  const appW = fs.readFileSync(path.join(ROOT, 'pages', 'approve', 'approve.wxml'), 'utf8')
  ok('审批页显示归属班级', appW.indexOf('{{item.cls}}') >= 0)
  ok('.kv-v 允许换行（word-break: break-all + white-space: normal）',
    /\.kv-v\s*\{[^}]*word-break:\s*break-all[^}]*white-space:\s*normal/.test(appWxss))
  // 管理员账号页：班级全称单独一行完整展示
  const auW = fs.readFileSync(path.join(ROOT, 'pages', 'admin-users', 'admin-users.wxml'), 'utf8')
  ok('账号管理页完整展示班级全称', auW.indexOf('u-cls') >= 0 && auW.indexOf('归属班级全称') >= 0)
  // 学生工作台：必须有「我的申请」入口（学生可见）+ 跳转函数 + 待处理角标
  const idxW = fs.readFileSync(path.join(ROOT, 'pages', 'index', 'index.wxml'), 'utf8')
  const idxJs = fs.readFileSync(path.join(ROOT, 'pages', 'index', 'index.js'), 'utf8')
  const mineJs = fs.readFileSync(path.join(ROOT, 'pages', 'mine', 'mine.js'), 'utf8')
  ok('工作台存在学生可见的「我的申请」入口',
    idxW.indexOf('我的申请') >= 0 && /wx:if="\{\{!isStaff\}\}"/.test(idxW))
  ok('工作台「我的申请」绑定 goMyRequests', idxW.indexOf('bindtap="goMyRequests"') >= 0)
  ok('工作台「我的申请」角标挂在图标容器 .grid-ic-wrap（不压标题文字）',
    idxW.indexOf('grid-ic-wrap') >= 0 && idxW.indexOf('grid-badge') >= 0)
  ok('.grid-badge 为绝对定位在图标右上角', /\.grid-badge\s*\{[^}]*position:\s*absolute/.test(appWxss))
  ok('学生入口副标题不过长（≤8 字，避免 nowrap 被裁）',
    /我的申请[\s\S]{0,120}?grid-s">([^<]{1,8})</.test(idxW))
  ok('index.js 实现 goMyRequests 跳转', /goMyRequests\s*\(\)\s*\{[\s\S]{0,400}switchTab/.test(idxJs))
  ok('index.js 通过 globalData 标记让目标页自行定位',
    /scrollToMyRequests\s*=\s*true/.test(idxJs))
  ok('mine.js 在 onShow 中消费标记并滚动定位',
    /scrollToMyRequests\s*\(\)\s*\{[\s\S]{0,600}pageScrollTo/.test(mineJs))
  ok('index.js 统计学生待审批申请数 myPendingCount',
    idxJs.indexOf('myPendingCount') >= 0 && /myPendingCount:\s*myRs\.filter/.test(idxJs))

  // ============ G. 教师端「领用记录」查询 =============================
  section('G. 教师端领用记录查询（listClaims + 页面 + 流水班级继承）')
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  ok('app.json 注册 pages/claims/claims', appJson.pages.indexOf('pages/claims/claims') >= 0)
  ok('claims 页四个文件齐全（含 json 下拉刷新配置）', ['.js', '.wxml', '.wxss', '.json'].every(e =>
    fs.existsSync(path.join(ROOT, 'pages', 'claims', 'claims' + e))))
  // 四套实现必须都实现 listClaims，否则演示/线上/云库行为分叉
  ok('clouddb 实现 listClaims', /async function listClaims\(/.test(cloud))
  ok('tencentdocs 实现 listClaims', /async function listClaims\(/.test(docs))
  ok('云端 mock 实现 listClaims', idx.indexOf("case 'listClaims'") >= 0)
  ok('前端 mock 实现 listClaims', front.indexOf("case 'listClaims'") >= 0)
  ok('两套适配器都导出 listClaims',
    cloud.indexOf('listStockIO, listClaims') >= 0 && docs.indexOf('listStockIO, listClaims') >= 0)
  ok('index.js 分发 listClaims 且限教师以上', /case 'listClaims':[\s\S]{0,120}gStaff\(\)/.test(idx))
  // 领用记录页的核心字段：物品名 / 领用人姓名 / 班级 / 数量 / 用途 / 审批人
  const claimsJs = fs.readFileSync(path.join(ROOT, 'pages', 'claims', 'claims.js'), 'utf8')
  const claimsWxml = fs.readFileSync(path.join(ROOT, 'pages', 'claims', 'claims.wxml'), 'utf8')
  ok('claims.js 调用 listClaims 接口', /api\.call\('listClaims'/.test(claimsJs))
  ok('claims.js 门控为教师及以上', /identity\.isStaff\(\)/.test(claimsJs))
  ;['itemName', 'userName', 'cls', 'qty', 'reason', 'approver'].forEach(k => {
    ok('claims 返回字段含 ' + k, new RegExp(k).test(claimsJs))
  })
  ;['item.itemName', 'item.userName', 'item.cls', 'item.qty', 'item.reason', 'item.approver'].forEach(k => {
    ok('claims 页面渲染 ' + k, claimsWxml.indexOf(k) >= 0)
  })
  ok('claims 页面班级用不截断样式', claimsWxml.indexOf('cls-line') >= 0)
  ok('claims 页面显示按班级汇总', claimsWxml.indexOf('byCls') >= 0)
  ok('claims 页面班级下拉筛选', claimsWxml.indexOf('clsOptions') >= 0)
  ok('工作台有「领用记录」入口（教师可见）',
    idxW.indexOf('/pages/claims/claims') >= 0 && idxW.indexOf('领用记录') >= 0)
  // 【关键】审批写出的领用出库流水必须继承「申请单」的班级，而不是审批人（老师）的班级
  ok('clouddb 审批写流水时继承申请单班级',
    /const reqCls = ds\.readCls\(req\.fields\)[\s\S]{0,400}outFlow\[COL\.stock_io\.cls\] = reqCls/.test(cloud))
  ok('tencentdocs 审批写流水时继承申请单班级',
    /const reqCls = ds\.readCls\(req\.fields\)[\s\S]{0,400}outFlow\[COL\.stock_io\.cls\] = reqCls/.test(docs))
  ok('「我的」页提供 myRequests 锚点供滚动定位',
    fs.readFileSync(path.join(ROOT, 'pages', 'mine', 'mine.wxml'), 'utf8').indexOf('id="myRequests"') >= 0)

  // ============ H. 真实使用缺口（一次过审批次）=========================
  section('H. 真实使用缺口：页面闭环 / 班级展示 / 隔离边界')
  const readPage = (p, f) => fs.readFileSync(path.join(ROOT, 'pages', p, p + '.' + f), 'utf8')
  const ioJs = readPage('io', 'js'), logsJs = readPage('logs', 'js')
  const labsJs = readPage('labs', 'js'), repairJs = readPage('repair', 'js')
  const repairW = readPage('repair', 'wxml'), inspJs = readPage('inspection', 'js')
  const inspW = readPage('inspection', 'wxml'), mineW = readPage('mine', 'wxml')
  const mineJs2 = readPage('mine', 'js'), adminJs = readPage('admin-users', 'js')
  const adminW = readPage('admin-users', 'wxml'), approveJs = readPage('approve', 'js')
  const approveW = readPage('approve', 'wxml'), usageW = readPage('usage', 'wxml')
  const usageJs = readPage('usage', 'js'), loginW = readPage('login', 'wxml')
  const privacyW = readPage('privacy', 'wxml')

  ok('claims.json 存在且开启下拉刷新（16 页中唯一曾缺 json）', (() => {
    const p = path.join(ROOT, 'pages', 'claims', 'claims.json')
    if (!fs.existsSync(p)) return false
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return j.navigationBarTitleText === '领用记录' && j.enablePullDownRefresh === true
  })())
  ok('出入库流水映射 cls（否则流水页班级列永远为空）', /cls:\s*r\.cls\s*\|\|\s*''/.test(ioJs))
  ok('操作日志映射 cls（门禁与业务日志都要带班级）', (logsJs.match(/cls:\s*r\.cls\s*\|\|\s*''/g) || []).length >= 2)
  ok('我的页借出记录提供就地归还入口（带验收备注）',
    mineW.indexOf('openReturn') >= 0 && mineJs2.indexOf("callFull('returnTool'") >= 0 &&
    mineW.indexOf('returnNote') >= 0 && mineJs2.indexOf('note: (this.data.returnNote') >= 0)
  ok('goMyRequests 失败兜底不再 navigateTo tabBar 页',
    idxJs.indexOf('navigateTo') < 0 || !/fail:[\s\S]{0,160}navigateTo\(\{ url: '\/pages\/mine/.test(idxJs))
  ok('报修/巡检筛选 picker 有「全部实训室」且与 filterLabId 同步',
    repairJs.indexOf("['全部实训室']") >= 0 && inspJs.indexOf("['全部实训室']") >= 0 &&
    repairJs.indexOf('filterLabIndex') >= 0 && inspJs.indexOf('filterLabIndex') >= 0)
  ok('报修/巡检表单 picker 与筛选 picker 分离（不让表单选「全部」）',
    repairW.indexOf('formLabLabels') >= 0 && inspW.indexOf('formLabLabels') >= 0)
  ok('报修/巡检新增时默认选中第一间（picker 与提交值一致）',
    /const idx = found >= 0 \? found : \(this\.data\.labs\.length \? 0 : -1\)/.test(repairJs) &&
    /const idx = found >= 0 \? found : \(this\.data\.labs\.length \? 0 : -1\)/.test(inspJs))
  ok('labs 编辑负责人等异步候选加载完再定位',
    /async openEdit\(\)/.test(labsJs) && /await this\.loadManagers\(lab\.managerId\)/.test(labsJs))
  ok('用户管理页有前端权限拦截', adminJs.indexOf('identity.isAdmin()') >= 0 && adminW.indexOf('权限受限') >= 0)
  ok('单条审批通过有二次确认（不可逆写）', /确认通过/.test(approveJs) && /if \(!c\.confirm\) return/.test(approveJs))
  ok('审批页提供领用记录入口', approveW.indexOf('goClaims') >= 0 && approveJs.indexOf("url: '/pages/claims/claims'") >= 0)
  ok('领用记录可按已撤销筛选', claimsJs.indexOf("'已撤销'") >= 0)
  ok('工作台学生端显示我的待批而非恒为 0 的待办审批', idxW.indexOf('我的待批') >= 0)
  ok('usage 列表 wx:key 不再用点路径', usageW.indexOf('wx:key="user.id"') < 0 && usageJs.indexOf('key: (x.user') >= 0)
  ok('品牌文案无旧英文别名混用',
    loginW.indexOf('Personal Toolbox') < 0 && privacyW.indexOf('Personal Toolbox') < 0 &&
    idxW.indexOf('· 我的工具箱') < 0)
  ok('隐私说明按学校实验室管理工具描述，而非个人小工具',
    /学校实验室使用的耗材与工具管理工具/.test(privacyW))
  // 后端：公网匿名不可读校内实训室/报修/巡检
  ok('实训室/报修/巡检读接口加登录门', (() => {
    const cases = ['listLabs', 'getLab', 'labOverview', 'listRepairs', 'listInspections']
    return cases.every(a => new RegExp("case '" + a + "': \\{ const g = gLogin\\(\\); if \\(g\\) return g").test(idx))
  })())
  ok('clouddb recordIDs 快路径也过行级裁决',
    /if \(o\.recordIDs && o\.recordIDs\.length\) \{[\s\S]{0,160}scoped\(/.test(cloud))
  ok('审批产生的全部流水继承申请单班级（overrideOwnerCls 真正被调用）',
    /ds\.overrideOwnerCls\(ds\.readCls\(req\.fields\)\)/.test(cloud) &&
    /ds\.overrideOwnerCls\(ds\.readCls\(req\.fields\)\)/.test(docs))
  ok('mockHandler 用户列表不再引用未定义的 me', !/case 'adminListUsers':[\s\S]{0,360}\(me && me\.role\)/.test(idx))
  ok('migrate 纳入写操作集合（契约完整）', fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'backend-switch.js'), 'utf8').indexOf("'clearAllData', 'migrate'") >= 0)
  ok('云端 mock 的巡检「已逾期」筛选与生产对齐', /f\.status === '已逾期'/.test(idx))
  ok('扫码失败文案不再误称模拟器', idxJs.indexOf('扫码已取消或不可用') >= 0)

  // ============ I. 第二轮深度走查：隐藏 bug / 数据一致性 ==================
  section('I. 第二轮深度走查：状态机 / 账务 / 分页 / 演示一致性')
  const invJs = readPage('inventory', 'js'), invW = readPage('inventory', 'wxml')
  const claimsJs2 = readPage('claims', 'js')

  ok('云库全表读取支持 100 行分页（否则超 100 行数据静默消失）',
    /const CLOUD_PAGE = 100/.test(cloud) && /\.skip\(offset\)\.limit\(CLOUD_PAGE\)\.get\(\)/.test(cloud))
  ok('冲销反向流水不可再次冲销（三端同构）', (() => {
    const okAdapters = /isSettledFlow\(f\)/.test(cloud) && /isSettledFlow\(f\)/.test(docs)
    const okMocks = /\(r\.src \|\| ''\) === '冲销'/.test(idx) && /\(r\.src \|\| ''\) === '冲销'/.test(front)
    return okAdapters && okMocks
  })())
  ok('冲销反向流水与日志继承原流水班级', (() => {
    const has = (s) => /const reverseCls = ds\.readCls\(f\)/.test(s) &&
      /COL\.stock_io\.cls\]: reverseCls/.test(s) && /COL\.logs\.cls\]: reverseCls/.test(s)
    return has(cloud) && has(docs)
  })())
  ok('教师用户管理加带班范围裁决（防跨班改删 IDOR）', (() => {
    return /function userScopeErr\(/.test(cloud) && /function userScopeErr\(/.test(docs) &&
      (cloud.match(/userScopeErr\(ds\.currentScope\(\)/g) || []).length >= 2 &&
      (docs.match(/userScopeErr\(ds\.currentScope\(\)/g) || []).length >= 2
  })())
  ok('演示模式审批通过补写出库流水', (() => {
    const re = /m\.stock -= r\.qty[\s\S]{0,300}DB\.stock_io\.push/
    return re.test(idx) && re.test(front)
  })())
  ok('演示模式日志操作名与生产对齐（审批通过）',
    idx.indexOf("op: '审批通过领用'") < 0 && front.indexOf("op: '审批通过领用'") < 0)
  ok('演示模式 alerts 的 planEnd 为全局函数（不再 ReferenceError）', (() => {
    const re = /function planEnd\(s\)/
    return re.test(idx) && re.test(front) && !/const planEnd = \(s\)/.test(idx) && !/const planEnd = \(s\)/.test(front)
  })())
  ok('演示模式逾期借用按日终判定（不再 NaN 恒空）',
    /planEnd\(b\.plan\)/.test(idx) && /planEnd\(b\.plan\)/.test(front) &&
    /Date\.parse\(\('' \+ s\)\.slice\(0, 10\)/.test(idx))
  ok('巡检排序在 norm 之前按原始时间戳（两套适配器）', (() => {
    const re = /const list = await getRecords\('inspections'\)[\s\S]{0,300}list\.sort\(\(a, b\)/
    return re.test(cloud) && re.test(docs)
  })())
  ok('演示模式领用记录状态别名映射（中文筛选可用）',
    (idx.match(/'已撤销': 'canceled'/g) || []).length >= 1 &&
    (front.match(/'已撤销': 'canceled'/g) || []).length >= 1)
  ok('日志筛选枚举与生产 op 值一致', logsJs.indexOf("'审批通过领用'") < 0 && logsJs.indexOf("'清单导入耗材'") >= 0)
  ok('我的页区分「加载失败」与「暂无记录」',
    /myLoadErr: d === null/.test(readPage('mine', 'js')) && readPage('mine', 'wxml').indexOf('申请记录加载失败') >= 0)
  ok('领用记录页有导出入口（后端早已支持 requisitions）',
    claimsJs2.indexOf("exporter.run('requisitions'") >= 0 && readPage('claims', 'wxml').indexOf('导出领用单') >= 0)
  ok('库存页补上批量建档入口（后端 importMaterials/importTools 原有）',
    invJs.indexOf("'importTools'") >= 0 && invJs.indexOf("'importMaterials'") >= 0 &&
    invW.indexOf('批量建档导入') >= 0)

  // ============ J. 第三轮收口：旧 bug + 5 项新功能契约 ============
  section('J. 第三轮收口（旧 bug + 5 项新功能）')
  const appRaw = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')
  const detailJ = readPage('detail', 'js'), detailWa = readPage('detail', 'wxml')
  const approveJ = readPage('approve', 'js'), approveWa = readPage('approve', 'wxml')
  const claimsJ = readPage('claims', 'js'), claimsWa = readPage('claims', 'wxml')
  const indexWa = readPage('index', 'wxml'), mineWa = readPage('mine', 'wxml')
  const codeUtilSrc = fs.readFileSync(path.join(ROOT, 'utils', 'code.js'), 'utf8')
  const ioJ = readPage('io', 'js'), idxJ = readPage('index', 'js')
  const backupJs = readPage('backup', 'js'), qrJs = readPage('qrprint', 'js')

  // 阶段一：旧 bug 修复守护
  ok('claims「加载更多」按钮已绑定真实方法', claimsJs2.indexOf('loadMore()') >= 0)
  ok('扫码解析抽公共 code.js，io 与首页共用',
    codeUtilSrc.indexOf('function parseItemCode') >= 0 &&
    ioJ.indexOf('codeUtil.parseItemCode') >= 0 && idxJ.indexOf('codeUtil.parseItemCode') >= 0)
  ok('码解析同时支持 ITEM: 前缀与 URL id 参数',
    codeUtilSrc.indexOf('^ITEM[:：]') >= 0 && codeUtilSrc.indexOf('[?&]id=') >= 0)
  ok('云函数与本地 mock 均有 decision→ok 兼容',
    /function normalizeApprove/.test(idx) && /function normalizeApprove/.test(front))
  ok('两套 mock 驳回强制原因', (idx.match(/请填写驳回原因/g) || []).length >= 1 && /请填写驳回原因/.test(front))
  ok('云 mockHandler 补齐批量建档 action', idx.indexOf("case 'importMaterials'") >= 0 && idx.indexOf("case 'importTools'") >= 0)
  ok('本地 mock 补齐 snapshot', front.indexOf("case 'snapshot'") >= 0)
  ok('两适配器 snapshot 覆盖 labs/repairs/inspections 三表',
    /getRecords\('labs'\)/.test(cloud) && /getRecords\('labs'\)/.test(docs) &&
    /labs: labRows\.map/.test(cloud) && /labs: labRows\.map/.test(docs))
  ok('云 mock 借还状态输出做契约归一', /function flowBorrow/.test(idx) && /map\(flowBorrow\)/.test(idx))
  ok('两 mock returnTool 无可归还记录返回 404',
    (idx.match(/没有可归还的记录/g) || []).length >= 1 && /没有可归还的记录/.test(front))
  ok('单号生成加秒+单调序号（两适配器）',
    /_genSeq = \(_genSeq \+ 1\)/.test(cloud) && /_genSeq = \(_genSeq \+ 1\)/.test(docs))
  // 低库存阈值：必须【前后端全链一致】。
  // 此前只断言后端四套同为 <=，而前端 4 处用的是 < → 库存恰好等于安全线时，
  // 统计页「低库存物品数」与库存页/补货列表对不上（老师按简报去补货却找不到该项）。
  // 现统一为「库存 < 安全线才算低库存」（等于安全线视为已达标），并把前端页面纳入断言。
  ok('低库存阈值前后端全链统一为 <（等于安全线视为达标）', (() => {
    const strictLT = /(\(Number\([a-z]+\.stock\) \|\| 0\) < \(Number\([a-z]+\.safe\) \|\| 0\))|(\bstock < safe\b)|(m\.stock < m\.safe)/
    const looseLE = /(\(Number\([a-z]+\.stock\) \|\| 0\) <= \(Number\([a-z]+\.safe\) \|\| 0\))|(\bstock <= safe\b)|(m\.stock <= m\.safe)/
    const be = [idx, front, cloud, docs]
    const pg = ['pages/index/index.js', 'pages/inventory/inventory.js', 'pages/detail/detail.js']
      .map(p => fs.readFileSync(path.join(ROOT, p), 'utf8'))
    return be.every(x => strictLT.test(x) && !looseLE.test(x)) && pg.every(x => !looseLE.test(x))
  })())

  // 幂等键粒度：同物品同数量但备注/描述不同的两次写入必须被当成两次不同的操作。
  // 此前 batchIo 的键缺 note/src、addRepair/addInsp 的键只有 (操作人,实训室,标题)，
  // 实测：第二笔被静默吞掉（库存少加、重复报修只留一条），页面却提示成功。
  ok('幂等键粒度足（batchIo 带备注/来源，addRepair/addInsp 带区分字段）',
    /'batchIo', actor, type, data\.note \|\| '', data\.src \|\| ''/.test(cloud) &&
    /'batchIo', actor, type, data\.note \|\| '', data\.src \|\| ''/.test(docs) &&
    /'addRepair', data\.actor \|\| '', labId, title, \(data\.category \|\| ''\)/.test(cloud) &&
    /'addRepair', data\.actor \|\| '', labId, title, \(data\.category \|\| ''\)/.test(docs) &&
    /'addInsp', data\.actor \|\| '', labId, title, \(data\.planDate \|\| ''\)/.test(cloud) &&
    /'addInsp', data\.actor \|\| '', labId, title, \(data\.planDate \|\| ''\)/.test(docs))

  // approve 幂等闸门：部分写失败后老师重试审批，绝不能再扣一次库存
  ok('approve 幂等闸门存在（检测本单已出库则只补状态不二次扣减）',
    /const priorOut = await getRecords\('stock_io'/.test(cloud) &&
    /const priorOut = await getRecords\('stock_io'/.test(docs) &&
    /idempotent: true/.test(cloud) && /idempotent: true/.test(docs) &&
    /idempotent: true/.test(idx) && /idempotent: true/.test(front) &&
    /warn: '该申请此前已出库/.test(cloud))

  // 匿名读面收口：耗材/工具台账与工号名册不得再对未登录调用开放
  ok('台账与名册读接口已加登录闸', (() => {
    const need = ["case 'listMaterials': { const g = gLogin()", "case 'listTools': { const g = gLogin()",
      "case 'search': { const g = gLogin()", "case 'getItem': { const g = gLogin()"]
    return need.every(x => idx.indexOf(x) >= 0)
  })())

  // 新功能 1：教师直接借出
  ok('directBorrow 五端齐全（prod/mockHandler/两适配器/本地 mock）',
    idx.indexOf("case 'directBorrow': {") >= 0 && front.indexOf("case 'directBorrow'") >= 0 &&
    /async function directBorrow/.test(cloud) && /async function directBorrow/.test(docs))
  ok('directBorrow 归属班级跟随借用人',
    /ds\.overrideOwnerCls\(cls\)/.test(cloud) && /ds\.overrideOwnerCls\(fu\.user\.cls/.test(docs))
  ok('directBorrow 服务端按工号解析并做带班可见性校验',
    /td\.findUser\(borrower\)/.test(idx) && /ds\.userVisible\(sc, \{ id: fu\.user\.id, cls: fu\.user\.cls \}\)/.test(idx))
  ok('directBorrow 纳入写操作白名单（防静默降级）',
    /'directBorrow'/.test(read('backend-switch.js')) &&
    /'directBorrow'/.test(fs.readFileSync(path.join(ROOT, 'mcp', 'docs-proxy-server.js'), 'utf8')))
  ok('详情页教师「直接借出」按钮与弹层齐备',
    detailWa.indexOf('直接借出') >= 0 && detailJ.indexOf("callFull('directBorrow'") >= 0)

  // 新功能 2/3：审批撤销 + 批量驳回
  ok('revokeApprove / batchReject 四套实现齐全',
    /async function revokeApprove/.test(cloud) && /async function revokeApprove/.test(docs) &&
    idx.indexOf("case 'revokeApprove'") >= 0 && front.indexOf("case 'revokeApprove'") >= 0 &&
    /async function batchReject/.test(cloud) && /async function batchReject/.test(docs) &&
    idx.indexOf("case 'batchReject'") >= 0 && front.indexOf("case 'batchReject'") >= 0)
  ok('审批撤销只允许「已通过」，且二次撤销被拒',
    /curStatus !== '已通过'/.test(cloud) && /curStatus !== '已通过'/.test(docs) &&
    /该申请已撤销，不可重复撤销/.test(cloud))
  ok('审批撤销内联回滚（不调用不可重入的 reverseIO）', (() => {
    const seg = cloud.slice(cloud.indexOf('async function revokeApprove'), cloud.indexOf('async function addMaterial'))
    return seg.indexOf('reverseIO(') < 0 && seg.indexOf('updateRecord(\'materials\'') >= 0
  })())
  ok('两适配器导出 revokeApprove / batchReject',
    /revokeApprove, batchReject/.test(cloud) && /revokeApprove, batchReject/.test(docs))
  ok('审批页有批量驳回按钮与统一原因弹层',
    approveWa.indexOf('批量驳回') >= 0 && approveJ.indexOf("callFull('batchReject'") >= 0)
  ok('领用记录页管理员可撤销已通过单（含确认弹层）',
    /isAdmin && item\.approved/.test(claimsWa) && claimsJ.indexOf("callFull('revokeApprove'") >= 0)

  // 新功能 4：数据备份
  ok('backup 页已注册路由', appRaw.indexOf('pages/backup/backup') >= 0)
  ok('备份走 noFallback 真实快照，不回退演示数据',
    backupJs.indexOf("callFull('snapshot', {}, { noFallback: true })") >= 0)
  ok('备份导出 11 张表并写文件转发',
    /labs: '实训室'/.test(backupJs) && /repairs: '报修'/.test(backupJs) && /inspections: '巡检'/.test(backupJs) &&
    /shareFileMessage/.test(backupJs))
  ok('我的页管理员系统管理区有数据备份入口',
    mineWa.indexOf('/pages/backup/backup') >= 0)
  ok('snapshot 管理员门控仍生效', /case 'snapshot': \{ const g = gAdmin\(\)/.test(idx))

  // 新功能 5：二维码批量打印
  ok('qrprint 页已注册路由', appRaw.indexOf('pages/qrprint/qrprint') >= 0)
  ok('二维码标签内容统一 ITEM:<ID>（与扫码端同构）',
    qrJs.indexOf("'ITEM:' + item.id") >= 0 && codeUtilSrc.indexOf('^ITEM[:：]') >= 0)
  ok('批量打印按 A4 网格分页（3×5=15/页）',
    /COLS = 3/.test(qrJs) && /ROWS = 5/.test(qrJs) && /PER_PAGE = COLS \* ROWS/.test(qrJs))
  ok('批量打印支持预览与保存相册', qrJs.indexOf('wx.previewImage') >= 0 && qrJs.indexOf('wx.saveImageToPhotosAlbum') >= 0)
  ok('工作台教师导航含二维码打印入口', indexWa.indexOf('/pages/qrprint/qrprint') >= 0)

  // ============ K. 第四轮收口（本轮新发现并修复的 8 项缺陷）============
  const qrWxss = fs.readFileSync(path.join(ROOT, 'pages', 'qrprint', 'qrprint.wxss'), 'utf8')
  const idxKw = readPage('index', 'wxml')
  const idxKwxss = readPage('index', 'wxss')
  const labKjs = readPage('labs', 'js'), admKjs = readPage('admin-users', 'js')
  const qrKw = readPage('qrprint', 'wxml')

  // K1 画布尺寸必须与绘制坐标同单位（px），否则标签右半边画到画布外被裁掉
  ok('二维码画布用 px 尺寸且与 PAGE_W/PAGE_H 一致（不用 rpx）',
    /width:\s*700px/.test(qrWxss) && /height:\s*990px/.test(qrWxss) &&
    !/700rpx/.test(qrWxss) && !/990rpx/.test(qrWxss))
  // K2 打印标签必须用真实云端数据，演示数据禁止打印
  ok('二维码页取数走 noFallback（云端失败不回退演示数据）',
    qrJs.indexOf("callFull('listMaterials', {}, { noFallback: true })") >= 0 &&
    qrJs.indexOf("callFull('listTools', {}, { noFallback: true })") >= 0)
  ok('二维码页识别演示数据并阻止生成（避免打印不存在的物品标签）',
    qrJs.indexOf('this.data.demo') >= 0 && qrJs.indexOf("api.isDemoData()") >= 0 &&
    /演示数据/.test(qrJs))
  ok('二维码页演示态有醒目提示且按钮禁用', qrKw.indexOf('demo') >= 0 && qrKw.indexOf('|| demo') >= 0)
  // K3 全站演示警示（index.js 此前算了 isDemo 但模板从未渲染）
  ok('首页渲染演示模式警示条', idxKw.indexOf('demo-bar') >= 0 && idxKwxss.indexOf('.demo-bar') >= 0)
  ok('演示态在取数之后判定（避免读到上一次会话的旧值）',
    (() => {
      const seg = idxJs.slice(idxJs.indexOf('async loadStats'), idxJs.indexOf('async loadStats') + 1500)
      return /isDemo: api\.isDemoData\(\)/.test(seg)
    })())
  // K4 撤销回滚不依赖可能缺列的「来源类型」
  ok('撤销回滚查找流水不以 src 为硬条件（腾讯文档缺列也能回补库存）',
    (() => {
      const seg = cloud.slice(cloud.indexOf('async function revokeApprove'), cloud.indexOf('async function addMaterial'))
      return seg.indexOf("if (src && src !== '领用出库') return false") >= 0 &&
        seg.indexOf("=== '领用出库'") < 0
    })())
  ok('撤销找不到账务影响时给出明确告警，不伪装成「无需回滚」',
    (() => {
      const seg = cloud.slice(cloud.indexOf('async function revokeApprove'), cloud.indexOf('async function addMaterial'))
      return seg.indexOf("info.impact = 'missing'") >= 0 && seg.indexOf('info.warn') >= 0 &&
        seg.indexOf('库存未回补') >= 0
    })())
  ok('撤销三态（rolledBack/none/missing）在两适配器与两 mock 一致',
    /info\.impact = 'missing'/.test(cloud) && /info\.impact = 'missing'/.test(docs) &&
    /info\.impact = 'missing'/.test(idx) && /info\.impact = 'missing'/.test(front))
  ok('前端撤销遇到回滚告警时弹窗告知（不是绿色成功提示）',
    claimsJ.indexOf('d.warn') >= 0 && claimsJ.indexOf('已撤销，但需人工核对') >= 0)
  // K5 相册权限拒绝只提示一次
  ok('保存相册权限被拒只弹一次提示（不逐张刷屏）',
    qrJs.indexOf('denied') >= 0 && /let told = false/.test(qrJs))
  // K6 切号后二维码页要重新校验身份并重取数据
  ok('二维码页 onShow 重新校验身份并刷新（不残留上一教师视图）',
    /onShow\(\)/.test(qrJs) && qrJs.indexOf('refreshRole()') >= 0)
  // K7 mock 用户列表按调用者层级过滤（不再默认 super 全量）
  ok('mock 的 adminListUsers 按调用者身份过滤（不再是默认 super 全量）',
    /data\.actor/.test(idx) && /data\.actor/.test(front) &&
    !/data && data\.role/.test(idx))
  ok('前端三处用户列表调用都带上 actor', detailJ.indexOf('{ actor: me }') >= 0 &&
    admKjs.indexOf('{ actor: me.id }') >= 0 && labKjs.indexOf('{ actor: me.id }') >= 0)

  // ============ L. 第五轮：4 项零后端功能 + 借还备注 + 全局样式归集 ============
  const appLw = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  const inspLj = readPage('inspection', 'js'), inspLw = readPage('inspection', 'wxml')
  const repLj = readPage('repair', 'js'), repLw = readPage('repair', 'wxml')
  const invLj = readPage('inventory', 'js'), invLw = readPage('inventory', 'wxml')
  const usLj = readPage('usage', 'js'), usLw = readPage('usage', 'wxml')
  const qrLw = readPage('qrprint', 'wxml')
  const staffLsrc = fs.readFileSync(path.join(ROOT, 'utils', 'staff.js'), 'utf8')

  // L1 报修指派处理人（后端 updateRepair 本就支持 handlerId，纯前端）
  ok('报修页可指派处理人（picker + 传 handlerId/handlerName）',
    repLw.indexOf('onHandler') >= 0 && repLj.indexOf('handlerOptions') >= 0 &&
    repLj.indexOf("callFull('updateRepair'") >= 0 && repLj.indexOf("'procForm.handlerId'") >= 0)
  ok('报修指派时同步 procForm（避免 picker 显示别人、保存却写回自己）',
    repLj.indexOf("'procForm.handlerId': picked.id") >= 0)
  ok('教职工候选走 listStaff，缺 action 时回退 adminListUsers',
    staffLsrc.indexOf("callFull('listStaff'") >= 0 && staffLsrc.indexOf("call('adminListUsers'") >= 0)
  ok('候选只有自己时给出「仅管理员可指派他人」提示',
    repLw.indexOf('handlerOnlySelf') >= 0 && staffLsrc.indexOf('onlySelf') >= 0)

  // L2 巡检指派执行人 + 新建即派活
  ok('巡检页可指派执行人（updateInspection 传 executorId）',
    inspLw.indexOf('openAssign') >= 0 && inspLw.indexOf('submitAssign') >= 0 &&
    inspLj.indexOf("callFull('updateInspection'") >= 0 && inspLj.indexOf('executorId: u.id') >= 0)
  ok('巡检新建表单可直接指定执行人',
    inspLw.indexOf('onFormExec') >= 0 && inspLj.indexOf('executorId: f.executorId') >= 0)
  ok('后端 addInspection 支持指定执行人（此前固定为创建人）',
    /\[COL\.inspections\.executorId\]: \('' \+ \(data\.executorId \|\| data\.actor/.test(cloud) &&
    /\[COL\.inspections\.executorId\]: \('' \+ \(data\.executorId \|\| data\.actor/.test(docs))
  ok('listStaff 教职工名册：两适配器 + prodHandler + 两 mock 齐全',
    /async function listStaff\(\)/.test(cloud) && /async function listStaff\(\)/.test(docs) &&
    /case 'listStaff'/.test(idx) && /case 'listStaff'/.test(front) &&
    /listStaff,/.test(cloud) && /listStaff,/.test(docs))
  ok('listStaff 只返回工号/姓名/角色且过滤停用账号',
    /id: u\.id, name: u\.name, role: u\.role/.test(cloud) && /u\.status !== '停用'/.test(cloud))

  // L3 低库存一键补货入库（复用既有 batchIo，零后端改动）
  ok('库存页低库存一键补货入口（仅耗材分段）',
    invLw.indexOf('openReplenish') >= 0 && invLw.indexOf('补货入库') >= 0)
  ok('补货走既有 batchIo 写操作（type=in）',
    invLj.indexOf("callFull('batchIo'") >= 0 && invLj.indexOf("type: 'in'") >= 0)
  ok('补货默认补到安全线且逐项可改数量',
    invLj.indexOf('Math.max(1, safe - stock)') >= 0 && invLj.indexOf('onReplenishQty') >= 0)
  ok('补货为不可逆写操作，必须 noFallback', invLj.indexOf('{ noFallback: true })') >= 0)

  // L4 统计页导出 + 按班级分析
  ok('统计页导出（本地组装 CSV，不依赖后端 exportData 分支）',
    usLj.indexOf('exportStat') >= 0 && usLj.indexOf('exporter.runLocal') >= 0)
  ok('导出工具新增本地 CSV 组装（带 BOM 与转义，Excel 不乱码）',
    /function csvCell\(v\)/.test(fs.readFileSync(path.join(ROOT, 'utils', 'export.js'), 'utf8')) &&
    fs.readFileSync(path.join(ROOT, 'utils', 'export.js'), 'utf8').indexOf('\\uFEFF') >= 0)
  ok('统计页按班级分布复用 listClaims.byCls（无新增接口）',
    usLj.indexOf("call('listClaims'") >= 0 && usLw.indexOf('按班级领用分布') >= 0)
  ok('按班级分布的班级名用 title 兜底（不直接渲染 item.cls）',
    usLj.indexOf("title: x.cls || '未标注班级'") >= 0 && usLw.indexOf('{{item.title}}') >= 0)

  // L5 二维码按存放位置分组
  ok('二维码页支持按位置分组与整组选中',
    qrLw.indexOf('onGroupToggle') >= 0 && qrLw.indexOf('toggleLocGroup') >= 0 &&
    qrLw.indexOf('locGroups') >= 0)
  ok('分组勾选变化后同步刷新各组已选计数',
    /selected: sel \}, \(\) => this\.applyFilter\(\)\)/.test(qrJs) || qrJs.indexOf('applyFilter()') >= 0)
  ok('生成按钮在分组视图之外（切视图后入口不丢）',
    qrLw.indexOf('生成二维码标签') >= 0 && qrLw.indexOf('wx:else') >= 0)

  // L6 借出 / 归还备注
  ok('借还表新增备注两列（借出备注 + 归还验收备注）',
    /borrow: \{[^\n]*note: 'note'[^\n]*backNote: 'backNote'/.test(cloud) &&
    /borrow: \{[^\n]*note: '借出备注'[^\n]*backNote: '归还验收备注'/.test(docs))
  ok('借出写入备注（borrow / directBorrow / 审批通过）',
    /\[COL\.borrow\.note\]: \('' \+ \(data\.note/.test(cloud) &&
    /\[COL\.borrow\.note\]: \('' \+ \(req\.fields\[COL\.requisitions\.reason\]/.test(cloud) &&
    /\[COL\.borrow\.note\]: \('' \+ \(data\.note/.test(docs))
  ok('归还写入验收备注并记入日志',
    /\[COL\.borrow\.backNote\]: backNote/.test(cloud) &&
    /\[COL\.logs\.result\]: '已归还' \+ \(backNote/.test(cloud))
  ok('借还归一化输出备注（老数据为空不影响渲染）',
    /note: f\[COL\.borrow\.note\] \|\| ''/.test(cloud) &&
    /backNote: f\[COL\.borrow\.backNote\] \|\| ''/.test(cloud))
  ok('两套 mock 同步借出/归还备注',
    /note: \(data\.note \|\| ''\)\.trim\(\)\.slice\(0, 120\)/.test(idx) &&
    /backNote = \(data\.note \|\| ''\)\.trim\(\)\.slice\(0, 120\)/.test(idx) &&
    /note: \(data\.note \|\| ''\)\.trim\(\)\.slice\(0, 120\)/.test(front) &&
    /backNote = \(data\.note \|\| ''\)\.trim\(\)\.slice\(0, 120\)/.test(front))
  ok('详情页直接借出可填备注并随请求提交',
    detailJ.indexOf('lendNote') >= 0 && detailJ.indexOf('note: (this.data.lendNote') >= 0)
  ok('我的页归还可填验收备注并展示借出/归还备注',
    mineWa.indexOf('returnNote') >= 0 && mineWa.indexOf('借出备注') >= 0 &&
    mineWa.indexOf('归还验收') >= 0 && mineJs2.indexOf('note: (this.data.returnNote') >= 0)
  ok('逾期清单展示借出备注（老师最需要知道为什么借）',
    usLw.indexOf('借出备注') >= 0)

  // L7 全局样式归集（此前 mask/sheet 只在一个页面定义，另三页弹层无样式）
  ok('遮罩/底部弹层已提到全局（报修/巡检/实训室三页弹层不再无样式）',
    /^\.mask \{/m.test(appLw) && /^\.sheet \{/m.test(appLw))
  ok('申请弹层 ap-* 已全局化（多页不再各存一份）',
    /^\.ap-mask \{/m.test(appLw) && /^\.ap-panel \{/m.test(appLw))
  ok('输入框占位符 inp-ph 已全局化（8 个页面此前无占位符样式）',
    /^\.inp-ph \{/m.test(appLw))
  ok('详情标题区 dt-* 已全局化（备份/二维码打印页顶部不再裸奔）',
    /^\.dt-hero \{/m.test(appLw) && /^\.dt-name \{/m.test(appLw))
  ok('数量块 iv-* 已全局化（统计页此前完全没样式）',
    /^\.iv-qty \{/m.test(appLw) && /^\.iv-qn \{/m.test(appLw))
  ok('表单说明 field-tip 已全局化',
    /^\.field-tip \{/m.test(appLw))
  ok('全局样式无重复定义（同一类只留一份）',
    (() => {
      const c = {}
      const re = /^\.([A-Za-z_][A-Za-z0-9_-]*)\s*\{/gm
      let m
      while ((m = re.exec(appLw))) c[m[1]] = (c[m[1]] || 0) + 1
      return Object.keys(c).every(k => c[k] === 1)
    })())

  // ============ M. 第六轮：对拍挖出的真缺陷 ============
  const stockMj = readPage('stocktake', 'js'), stockMw = readPage('stocktake', 'wxml')
  const admMwX = readPage('admin-users', 'wxml')
  const apiMsrc = fs.readFileSync(path.join(ROOT, 'utils', 'api.js'), 'utf8')
  const parityExists = fs.existsSync(path.join(ROOT, 'tools', 'test_parity.js'))
  const invMj = readPage('inventory', 'js'), invMw = readPage('inventory', 'wxml')
  const ioMj = readPage('io', 'js')
  const detailMwa = readPage('detail', 'wxml')
  const admMjs = readPage('admin-users', 'js')

  // M1 mock 归一化分叉：演示模式看不到效期提示、工具编号为空
  ok('两套 mock 的 listMaterials/listTools/getItem 均走归一化（与生产字段对齐）',
    /normMatMock/.test(idx) && /normToolMock/.test(idx) &&
    /normMatMock/.test(front) && /normToolMock/.test(front) &&
    /listMaterials': ok\(\(DB\.materials \|\| \[\]\)\.map\(normMatMock\)\)/.test(front) === false)
  ok('mock 归一化产出效期三字段（expire/expired/expiring）与生产一致',
    /expire: expTs \? fmtTsMock\(expTs\) : ''/.test(idx) && /expiring:/.test(idx) &&
    /expire: expTs \? fmtTsMock\(expTs\) : ''/.test(front) && /expiring:/.test(front))
  ok('mock 工具补 sn（前端「编号/出厂编号」不再空白）',
    /sn: f\.sn \|\| f\.spec \|\| ''/.test(idx) && /sn: f\.sn \|\| f\.spec \|\| ''/.test(front))
  ok('存在 mock/生产对拍工具（持续防分叉）', parityExists)

  // M2 效期链路：此前「只有读没有写」，库存页的过期提示永远不显示
  ok('效期有写入路径（addMaterial / importMaterials 新建+更新）',
    /\[COL\.materials\.expire\]: expTs/.test(cloud) &&
    /\[COL\.materials\.expire\]: expTs/.test(docs) &&
    /const expTs = expParsed\.ts/.test(cloud) &&
    /const expTs = expParsed\.ts/.test(docs))
  // 第十六轮：效期解析支持多格式并校验真实日期
  ok('效期解析支持多格式（YYYYMMDD / 斜杠 / 中文）并拒绝假日期',
    /\^\\d\{8\}\$/.test(cloud) && /const dim = new Date\(Date\.UTC\(y, mo, 0\)\)/.test(cloud) &&
    /\^\\d\{8\}\$/.test(docs) && /\^\\d\{8\}\$/.test(idx) && /\^\\d\{8\}\$/.test(front))
  ok('两套 mock 导入新建行写入效期（此前整行没写 expire，且用错 data.expire）',
    /expire: expireTsMock\(raw\.expire\)/.test(idx) && /expire: expireTsMock\(raw\.expire\)/.test(front))
  ok('效期日期由服务端统一换算（避免前端时区差一天）',
    /function expireTs\(v\)/.test(cloud) && /Date\.UTC\(y, mo - 1, d, 15, 59, 59\)/.test(cloud))
  ok('前端有效期录入入口（建档日期 + 批量导入第 9 列）',
    ioMj.indexOf('nmExpire') >= 0 &&
    fs.readFileSync(path.join(ROOT, 'utils', 'importer.js'), 'utf8').indexOf("expire: pick(c, 'expire')") >= 0)
  ok('耗材详情展示效期与过期状态',
    /item\.expire/.test(detailMwa) && /item\.expired/.test(detailMwa))

  // M3 盘点页：非法输入曾被 parseInt||0 静默变成 0 → 一次错字清零库存
  ok('盘点页非法输入不被静默当成 0（保留原始串并标红）',
    stockMj.indexOf('invalid') >= 0 && !/parseInt\(v, 10\) \|\| 0/.test(stockMj))
  ok('盘点提交剔除非法项并提示（不把错字当 0 提交）',
    stockMj.indexOf('invalidItems') >= 0 && stockMw.indexOf('invalidCount') >= 0)

  // M4 最后一个启用超管不可降级/停用/删除（否则全校失去唯一管理入口）
  ok('两套适配器都有最后超管守卫',
    /function lastSuperGuard\(/.test(cloud) && /function lastSuperGuard\(/.test(docs) &&
    /lastSuperGuard\(allUsers\.map/.test(cloud) && /lastSuperGuard\(list\.map/.test(cloud))
  ok('两套 mock 同步最后超管守卫',
    /function lastSuperGuardMock\(/.test(idx) && /function lastSuperGuardMock\(/.test(front) &&
    /lastSuperGuardMock\(DB\.users/.test(idx) && /lastSuperGuardMock\(DB\.users/.test(front))
  ok('超管改自己时前端二次确认并说明后果',
    /确认降级自己/.test(admMjs) && /最后一名启用中的超级管理员/.test(admMjs))

  // M5 集中式演示数据告警：此前只有 3 个页面显示数据来源，其余页静默显示假数据
  ok('api.js 提供一次性演示数据告警并被读/写两条路径触发',
    /function demoNotice\(/.test(apiMsrc) && apiMsrc.indexOf('demoNotice(why)') >= 0 &&
    apiMsrc.indexOf('demoNotice(') >= 0)

  // ============ N. 第七轮：账实相符 / 往返 / 借期 / 分页 / 教师带班守卫 ============
  const impSrc = fs.readFileSync(path.join(ROOT, 'utils', 'importer.js'), 'utf8')
  const invNj = readPage('inventory', 'js'), invW2 = readPage('inventory', 'wxml')
  const logsNj = readPage('logs', 'js')
  const claimsNj = readPage('claims', 'js')
  const detailJ2 = readPage('detail', 'js'), detailW2 = readPage('detail', 'wxml')
  const appJ2 = readPage('approve', 'js'), appW2 = readPage('approve', 'wxml')

  // N1 借期链路：申请填 → 申请单存 → 审批沿用/可调 → 借还记录落应还日期
  ok('申请单有借期列（两套适配器 + 两套 mock 同构）',
    /days: 'days'/.test(cloud) && /days: '借期天数'/.test(docs) &&
    /\[COL\.requisitions\.days\]/.test(cloud) && /\[COL\.requisitions\.days\]/.test(docs))
  ok('审批借期优先级：审批人指定 > 申请单填写 > 默认 7 天',
    /planDue\(data\.days \|\| req\.fields\[COL\.requisitions\.days\]\)/.test(cloud) &&
    /planDue\(data\.days \|\| req\.fields\[COL\.requisitions\.days\]\)/.test(docs))
  ok('学生申请借工具时可填借用天数', detailJ2.indexOf('apDays') >= 0 && detailW2.indexOf('apDays') >= 0)
  ok('审批页显示借期并可由老师调整（自定义弹层，非 showModal editable）',
    appW2.indexOf('showDays') >= 0 && appJ2.indexOf('submitDays') >= 0 &&
    appJ2.indexOf('payload.days') >= 0 && appJ2.indexOf('editable: true') < 0)
  ok('借期归一化下发（老单为空时前端显示默认 7 天）',
    /days: Number\(f\[COL\.requisitions\.days\]\) \|\| 0/.test(cloud) &&
    /days: Number\(f\[COL\.requisitions\.days\]\) \|\| 0/.test(docs))

  // N2 幂等键必须能区分"不同的操作"
  ok('幂等键含区分字段（用途/借期/备注/规格），不同操作不会被静默吞掉',
    /\['req', data\.user \|\| '', matId, qty, reason\]/.test(cloud) &&
    /\['treq', data\.user \|\| '', toolId, reason, data\.days \|\| ''\]/.test(cloud) &&
    /\['io', data\.actor \|\| '', matId, data\.type, qty, data\.note \|\| ''\]/.test(cloud) &&
    /\['req', data\.user \|\| '', matId, qty, reason\]/.test(docs) &&
    /\['io', data\.actor \|\| '', matId, data\.type, qty, data\.note \|\| ''\]/.test(docs))

  // N3 导出/导入往返（列序对齐 + 表头名驱动）
  ok('导出列序与批量导入解析顺序一致（名称在前、编号在后）',
    /header = \['名称', '耗材ID'/.test(cloud) && /header = \['名称', '工具ID'/.test(docs) &&
    /header = \['名称', '耗材ID'/.test(docs))
  ok('导入按表头名映射列（旧导出文件也能正确导入）',
    impSrc.indexOf('isHeaderRow') >= 0 && impSrc.indexOf('FIELD_ALIAS') >= 0 &&
    /expire: pick\(c, 'expire'\)/.test(impSrc))
  ok('库存页使用共享解析器（页面与测试同一份代码）',
    invNj.indexOf("require('../../utils/importer.js')") >= 0 && invNj.indexOf('importer.parseImport') >= 0)
  ok('存在导出导入往返测试工具', fs.existsSync(path.join(ROOT, 'tools', 'test_roundtrip.js')))
  ok('存在账实相符自检工具', fs.existsSync(path.join(ROOT, 'tools', 'test_consistency.js')))

  // N4 分页一致性
  ok('三个分页列表累加时按 key 去重（翻页期间新增数据不会重复出现）',
    /dedupeByKey\(this\.data\.rows\.concat\(mapped\), 'key'\)/.test(logsNj) &&
    /dedupeByKey\(this\.data\.logs\.concat\(mapped\), 'key'\)/.test(ioMj) &&
    /dedupeByKey\(this\.data\.rows\.concat\(mapped\), 'key'\)/.test(claimsNj))
  ok('后端分页排序有稳定次级键（同毫秒记录顺序确定）',
    /COL\.stock_io\.id[^\n]*localeCompare/.test(cloud) && /COL\.logs\.id[^\n]*localeCompare/.test(cloud) &&
    /COL\.requisitions\.id[^\n]*localeCompare/.test(cloud))

  // N5 教师带班守卫 + 账号体检（把 R2 从人工检查变成系统体检）
  ok('新建/改档教师缺带班班级直接拒绝（不再静默失效）',
    /教师账号必须配置带班班级/.test(cloud) && /教师账号必须配置带班班级/.test(docs))
  ok('diag 输出账号配置体检（管理员看全库问题清单）',
    /accountAudit/.test(idx) && /teachersWithoutScope/.test(idx) &&
    /listAllUsersForAudit/.test(cloud) && /listAllUsersForAudit/.test(docs))
  ok('我的页展示账号体检结果', mineWa.indexOf('accountAudit') >= 0)

  // N6 全局样式补齐（审批页借期步进器需要）
  ok('数量步进器 .qty 家族已全局化（审批页不再无样式）',
    /^\.qty \{/m.test(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')) &&
    /^\.qty-btn \{/m.test(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')) &&
    /^\.qty-inp \{/m.test(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')))

  console.log('\n========== 数据域隔离回归：' + pass + ' passed, ' + fail + ' failed ==========')
  process.exitCode = fail ? 1 : 0
}

main().catch(e => {
  console.error('测试执行异常：', e && e.stack || e)
  process.exitCode = 1
})

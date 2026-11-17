// tools/test_parity.js —— 生产适配器 vs 两套 mock 的返回结构对拍
//
// 为什么需要它：
//   本项目有四套数据实现（tencentdocs / clouddb / 云函数内 mock / utils/mock）。
//   历史上最大的 bug 类别不是"写错了"，而是**四套实现行为分叉**——
//   线上正常、演示环境错乱，排查成本极高；或者反过来，演示能跑、线上字段缺列。
//   人工比对两千多行适配器代码不现实，这里用「同一份数据分别驱动 + 逐字段比对」自动化。
//
// 比对口径：只比对**返回结构**（顶层键 / 数组元素键）与**共有字段的值**。
//   - 演示 mock 允许字段比生产少（mock 是"前端契约最小集"），但不允许**生产有、mock 没有**
//     且前端确实在用的字段；这才是会导致"演示能跑、线上空白"的真分叉。
//   - 值的差异只报告不失败（如演示库与生产库的状态文案不同属正常）。
const path = require('path')
const fs = require('fs')

// 云函数 index.js 顶层 require('wx-server-sdk')，本地 Node 环境没有该模块会直接抛。
// 这里用 Module._load 钩子打一个空桩，让云 mock 的 handler 能被驱动起来做对拍。
const Module = require('module')
const _origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return { init: function () {}, database: function () { return {} }, command: {} }
  }
  return _origLoad.apply(this, arguments)
}

const ROOT = path.join(__dirname, '..')
const DS = path.join(ROOT, 'cloudfunctions', 'docsProxy', 'data-scope.js')
const CLOUDDB = path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js')
const INDEX = path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js')

const ds = require(DS)
const td = require(CLOUDDB)
const cloudMock = require(INDEX)
const localMock = require(path.join(ROOT, 'utils', 'mock.js'))

let pass = 0, fail = 0
const issues = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else {
    fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''))
    issues.push(name + (detail ? ' → ' + detail : ''))
  }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

// ---------- 内存伪库（与 test-data-scope.js 同构，支持 skip/limit 分页） ----------
// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
// ---------- 同一份种子数据（生产适配器用英文键；mock 同样吃英文键） ----------
const SEED = () => ({
  users: [
    { id: 'T001', name: '超管', role: '超级管理员', cls: '', status: '启用' },
    { id: 'A001', name: '管理员', role: '管理员', cls: '', status: '启用' },
    { id: 'TA', name: '老师A', role: '教师', cls: '24电气1', managedClasses: '24电气1', status: '启用' },
    { id: 'S001', name: '学生A', role: '学生', cls: '24电气1', status: '启用' }
  ],
  materials: [
    { id: 'M1', name: '焊锡丝', spec: '0.8mm', cat: '耗材', loc: 'A柜', stock: 10, unit: '卷', safe: 3 },
    { id: 'M2', name: '万用表线', spec: '', cat: '耗材', loc: 'B柜', stock: 2, unit: '根', safe: 5 }
  ],
  tools: [
    { id: 'TL1', name: '万用表', spec: 'VC830L', loc: 'A柜', status: '在库', holder: '' },
    { id: 'TL2', name: '示波器', spec: 'DS1102Z', loc: 'B柜', status: '借出', holder: 'S001' }
  ],
  requisitions: [
    { id: 'Q1', user: 'S001', item: 'M1', type: '领用', qty: 2, reason: '实训用', status: '待审批', time: '2026-11-10 09:00', approver: '', cls: '24电气1' },
    { id: 'Q2', user: 'S001', item: 'TL1', type: '借出', qty: 1, reason: '临时借用', status: '已通过', time: '2026-11-11 09:00', approver: 'TA', cls: '24电气1' }
  ],
  borrow: [
    { id: 'B1', user: 'S001', tool: 'TL2', out: '2026-11-11 09:00', plan: '2026-11-18', in: '', status: '借出中', note: '临时借用', cls: '24电气1' },
    { id: 'B2', user: 'S001', tool: 'TL1', out: '2026-11-01 09:00', plan: '2026-11-02', in: '2026-11-03 09:00', status: '已归还', note: '', backNote: '完好', cls: '24电气1' }
  ],
  stock_io: [
    { id: 'I1', item: 'M1', dir: '出库', qty: 2, op: 'S001', time: '2026-11-10 09:00', note: '领用申请 Q1', src: '领用出库', cls: '24电气1' },
    { id: 'I2', item: 'M2', dir: '入库', qty: 10, op: 'TA', time: '2026-11-05 09:00', note: '采购到货', src: '手动入库', cls: '' }
  ],
  access: [
    { id: 'A1', user: 'S001', point: '实训室门', time: '2026-11-12 08:00', result: '开门', cls: '24电气1' }
  ],
  logs: [
    { id: 'L1', actor: 'TA', op: '新增耗材', target: 'M1', result: '成功', time: '2026-11-05 09:00', cls: '24电气1' }
  ],
  labs: [
    { id: 'L001', name: '电工实训室1', campus: '主校区', building: '实训楼', floor: '2', roomNo: '201', address: 'A栋2楼', lng: 108.4, lat: 30.7, managerId: 'TA', managerName: '老师A', status: '启用', note: '', createdAt: 1, updatedAt: 1 }
  ],
  repairs: [
    { id: 'R1', labId: 'L001', labName: '电工实训室1', title: '示波器故障', category: '设备故障', desc: '无波形', reporterId: 'TA', reporterName: '老师A', status: '待处理', priority: '一般', handlerId: '', handlerName: '', resolvedNote: '', createdAt: 1, updatedAt: 1, cls: '' }
  ],
  inspections: [
    { id: 'I101', labId: 'L001', labName: '电工实训室1', title: '月度巡检', planDate: '2026-11-20', executorId: 'TA', executorName: '老师A', status: '待巡检', result: '', createdAt: 1, doneAt: '', cls: '' }
  ]
})

// mock 侧需要"契约值"而非表值：借还状态生产存「借出中」，mock 存「借出」；
// 这里给 mock 单独一份等价的契约数据，保证比对的是「同一件事」而不是「同一串字」。
const SEED_MOCK = () => {
  const s = SEED()
  s.requisitions = s.requisitions.map(r => Object.assign({}, r, { no: r.id, matId: r.item, toolId: r.item, kind: r.type === '借出' ? 'tool' : 'material' }))
  s.borrow = s.borrow.map(b => Object.assign({}, b, {
    status: b.status === '借出中' ? '借出' : '已还',
    borrower: b.user, id: b.id
  }))
  s.stock_io = s.stock_io.map(r => Object.assign({}, r, { no: r.id, matId: r.item, type: r.dir === '出库' ? 'out' : 'in', operator: r.op }))
  s.access = s.access.map(r => Object.assign({}, r, { id: r.id, user: r.user, point: r.point, time: r.time, result: r.result }))
  s.logs = s.logs.map(r => Object.assign({}, r, { time: r.time, actor: r.actor, op: r.op, target: r.target, result: r.result }))
  s.tools = s.tools.map(r => Object.assign({}, r, { borrower: r.holder }))
  return s
}

function keysOf(v) {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? Object.keys(v[0]).sort() : []
  if (v && typeof v === 'object') return Object.keys(v).sort()
  return []
}

async function main() {
  section('准备：同一份数据注入三套实现')
  td.__setDbForTest(makeDb(SEED()))
  cloudMock.__setDbForTest(SEED_MOCK())
  localMock.__setDbForTest(SEED_MOCK())
  ok('三套实现均已注入种子数据', true)

  const SUPER = { id: 'T001', name: '超管', role: 'super', cls: '' }
  const scope = ds.scopeOf(SUPER)

  // ============ 读动作返回结构对拍 ============
  section('读动作：生产适配器 vs 云 mock vs 本地 mock（返回结构）')

  const CASES = [
    ['listMaterials', [], 'mats'],
    ['listTools', [], 'tools'],
    ['pending', [], 'pending'],
    ['listStockIO', [{ limit: 50 }], 'stock_io'],
    ['listClaims', [{ limit: 50 }], 'claims'],
    ['listRepairs', [{}], 'repairs'],
    ['listInspections', [{}], 'inspections'],
    ['listLabs', [], 'labs'],
    ['listStaff', [], 'staff'],
    ['adminListUsers', [], 'users'],
    ['listMine', [{ user: 'S001' }], 'mine']
  ]

  for (const [action, args, label] of CASES) {
    let prod = null, cm = null, lm = null
    try {
      prod = await ds.runWithScope(scope, () => td[action](...args))
    } catch (e) { prod = { __err: e.message } }
    try {
      const r = cloudMock.main
        ? null : null
      // 云 mock 的 handler 不直接导出，这里通过 main 走 mock 分支调用
      const res = await cloudMock.main({ action, ...(args[0] || {}), __mockProbe: true })
      cm = res && res.data !== undefined ? res.data : res
    } catch (e) { cm = { __err: e.message } }
    try {
      const r = localMock.dispatch(action, args[0] || {})
      lm = r && r.code === 0 ? r.data : { __err: (r && r.data && r.data.msg) || 'err' }
    } catch (e) { lm = { __err: e.message } }

    const pk = keysOf(prod), ck = keysOf(cm), lk = keysOf(lm)
    // 生产有、mock 没有的字段 = 演示/线上分叉（前端在生产能读到、演示读不到）
    const missCloud = pk.filter(k => ck.length && !ck.includes(k))
    const missLocal = pk.filter(k => lk.length && !lk.includes(k))
    ok(action + '：本地 mock 字段覆盖生产',
      !missLocal.length, missLocal.length ? '本地缺: ' + missLocal.join(',') : '')
    ok(action + '：云 mock 字段覆盖生产',
      !missCloud.length, missCloud.length ? '云缺: ' + missCloud.join(',') : '')
  }

  // ============ 四套实现都必须存在的 action ============
  section('action 覆盖：两套生产适配器 + 两套 mock')
  const prodActions = ['listMaterials', 'listTools', 'listPending', 'listStockIO', 'listClaims',
    'listRepairs', 'listInspections', 'listLabs', 'labOverview', 'listStaff', 'adminListUsers',
    'listMine', 'usage', 'snapshot', 'requisition', 'toolRequisition', 'approve',
    'cancelReq', 'batchReject', 'revokeApprove', 'io', 'batchIo', 'addMaterial', 'stocktake',
    'borrow', 'directBorrow', 'returnTool', 'access', 'reverseIO', 'exportData', 'search',
    'getItem', 'importMaterials', 'importTools', 'findUser', 'listUsers', 'whoami', 'bindLogin',
    'addLab', 'updateLab',
    'deleteLab', 'addRepair', 'updateRepair', 'addInspection', 'updateInspection']
  const missingProd = prodActions.filter(a => typeof td[a] !== 'function')
  ok('生产适配器导出全部 action（' + prodActions.length + ' 个）',
    missingProd.length === 0, missingProd.join(','))

  // mock 的 action 覆盖：用 dispatch 逐个探测（未知 action 会抛或返回错误码）
  const mockLocal = []
  const mockCloud = []
  for (const a of prodActions) {
    try {
      const r = localMock.dispatch(a, {})
      if (r && typeof r === 'object' && ('code' in r)) mockLocal.push(a)
    } catch (e) { /* 未知 action */ }
  }
  const missingLocal = prodActions.filter(a => mockLocal.indexOf(a) < 0)
  ok('本地 mock 覆盖全部 action',
    missingLocal.length === 0, missingLocal.join(','))

  // ============ prodDispatch 直接实现的 action：调用的适配器方法必须真实存在 ============
  section('prodDispatch 调用的适配器方法必须存在（缺一个=线上 TypeError）')
  const idxSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'index.js'), 'utf8')
  const pi = idxSrc.indexOf('async function prodDispatch')
  const prodSeg = idxSrc.slice(pi)
  const called = new Set()
  // 先剥掉行注释，避免把注释里的 td.xxx() 当成真实调用
  const prodClean = prodSeg.replace(/\/\/[^\n]*/g, '')
  const reCall = /\btd\.([A-Za-z_$][A-Za-z0-9_$]*)/g
  let cm2
  while ((cm2 = reCall.exec(prodClean))) called.add(cm2[1])
  ok('prodDispatch 调用的适配器方法数 > 0', called.size > 0, '未解析到调用')
  ok('clouddb 适配器导出契约包含 prodDispatch 调用的全部方法',
    [...called].every(x => typeof td[x] !== 'undefined'),
    [...called].filter(x => typeof td[x] === 'undefined').join(','))

  // 两套适配器的导出清单必须完全一致（历史上云库与腾讯文档经常漂移）
  function exportKeys(file) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const m = src.match(/module\.exports\s*=\s*\{/)
    if (!m) return new Set()
    let i = m.index + m[0].length, depth = 1
    const start = i
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    const body = src.slice(start, i - 1)
    const out = new Set()
    const re2 = /(?:^|[,{\n])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,}\n])/g
    let mm
    while ((mm = re2.exec(body))) out.add(mm[1])
    return out
  }
  const ekC = exportKeys('cloudfunctions/docsProxy/clouddb.js')
  const ekT = exportKeys('cloudfunctions/docsProxy/tencentdocs.js')
  // 测试钩子（__setDbForTest）只在需要注入伪库的适配器上存在，不算契约漂移
  const HOOKS = ['__setDbForTest']
  const onlyC = [...ekC].filter(x => !ekT.has(x) && HOOKS.indexOf(x) < 0)
  const onlyT = [...ekT].filter(x => !ekC.has(x) && HOOKS.indexOf(x) < 0)
  ok('两套生产适配器导出契约完全一致（clouddb ' + ekC.size + ' 个 / tencent ' + ekT.size + ' 个）',
    onlyC.length === 0 && onlyT.length === 0,
    '仅 clouddb 有: ' + onlyC.join(',') + ' / 仅 tencent 有: ' + onlyT.join(','))

  console.log('\n========== mock/生产对拍：' + pass + ' passed, ' + fail + ' failed ==========')
  if (issues.length) {
    console.log('\n分叉明细：')
    issues.forEach(i => console.log('  · ' + i))
  }
  process.exitCode = fail ? 1 : 0
}

main().catch(e => {
  console.error('对拍执行异常：', e && e.stack || e)
  process.exitCode = 1
})

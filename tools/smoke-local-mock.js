/**
 * 前端本地回退（utils/mock.js）全 action 冒烟
 * ------------------------------------------------------------------
 * 系统里有三套实现必须保持一致：
 *   ① 云函数 prodHandler（真·腾讯文档）
 *   ② 云函数 mockHandler（USE_MOCK 演示）
 *   ③ 前端 utils/mock.js（云函数不可用时的本地回退）
 * ③ 最容易被忘——它只在断网/云函数报错时才走到，一旦缺 action，用户看到的就是
 * "unknown action"，而开发和演示环境都正常。故与 smoke-mock.js 成对回归。
 *
 * 用法：node tools/smoke-local-mock.js
 */
let store = {}
global.wx = {
  getStorageSync: (k) => (k === 'lab_mock' ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] }
}

const mock = require(pathJoin('utils', 'mock.js'))
function pathJoin(...p) { return require('path').join(__dirname, '..', ...p) }

let pass = 0, fail = 0
const bad = []
function report(ok, action, extra) {
  if (ok) { pass++; return }
  fail++
  bad.push(action + (extra ? ' — ' + extra : ''))
  console.log('  ❌ ' + action + (extra ? ' → ' + extra : ''))
}
function call(action, payload, check) {
  const r = mock.dispatch(action, payload || {})
  if (!r || r.code !== 0) return report(false, action, JSON.stringify(r && r.data).slice(0, 140))
  if (check) { const why = check(r.data); if (why) return report(false, action, why) }
  pass++
  return r.data
}
function mustFail(action, payload, why) {
  const r = mock.dispatch(action, payload || {})
  if (r && r.code !== 0) { pass++; return }
  report(false, action, '应当被拒绝（' + why + '）')
}

console.log('=== 前端本地回退冒烟（utils/mock.js）===')

// 1 基础读
call('listMaterials', {}, d => Array.isArray(d) ? null : '应返回数组')
call('listTools', {}, d => Array.isArray(d) ? null : '应返回数组')
call('getItem', { id: 'M001' }, d => d && d.type === 'material' ? null : '应命中耗材')
call('getItem', { id: 'T001' }, d => d && d.type === 'tool' ? null : '应命中工具')
call('search', { kw: '电阻' }, d => Array.isArray(d) && d.length > 0 ? null : '模糊搜索应有结果')
call('listStockIO', {}, d => d && Array.isArray(d.rows) && typeof d.total === 'number' ? null : '应返回 {rows,total,...}')
call('usage', {}, d => d && Array.isArray(d.trend) && Array.isArray(d.lowStock) ? null : '应带报表块 trend/lowStock')

// 2 学生侧
call('requisition', { user: 'S002', matId: 'M001', qty: 1, kind: 'material', reason: '实训用' })
mustFail('requisition', { user: 'S002', matId: 'M001', qty: 1, reason: '' }, '空用途')
call('toolRequisition', { user: 'S002', toolId: 'T001', reason: '测量练习' })
const mine = call('listMine', { user: 'S002' })
const req = (mine && mine.requisitions && mine.requisitions[0]) || {}
call('cancelReq', { no: req.no, user: 'S002' })
mustFail('cancelReq', { no: 'NOT_EXIST', user: 'S002' }, '不存在的单号')

// 3 教师侧写入
call('io', { matId: 'M001', type: 'in', qty: 2, actor: 'T001', src: '采购' })
call('batchIo', { type: 'in', items: [{ matId: 'M002', qty: 1 }, { matId: 'M002', qty: 2 }], actor: 'T001' },
  d => d && d.done === 1 ? null : '同物品应合并为 1 项')
mustFail('batchIo', { type: 'in', items: [], actor: 'T001' }, '空明细')
call('stocktake', { mode: 'stocktake', items: [{ matId: 'M003', real: 45 }], actor: 'T001' })
mustFail('stocktake', { mode: 'stocktake', items: [{ matId: 'M003', real: -1 }], actor: 'T001' }, '负数实盘')

// 4 导出：7 种全通
for (const k of ['materials', 'tools', 'stock_io', 'requisitions', 'borrow', 'logs', 'access']) {
  call('exportData', { kind: k }, d => d && typeof d.csv === 'string' && d.csv.indexOf('\uFEFF') === 0 ? null : 'CSV 需带 BOM')
}

// 5 管理员侧
call('listLogs', {}, d => d && Array.isArray(d.rows) ? null : '应返回 {rows,...}')
call('listAccess', {}, d => d && Array.isArray(d.rows) ? null : '应返回 {rows,...}')
const io = call('listStockIO', {})
const row = (io && io.rows && io.rows[0]) || null
if (row) {
  const before = call('getItem', { id: row.item }).item.stock
  call('reverseIO', { no: row.id, actor: 'A001' }, d => d && typeof d.stock === 'number' ? null : '应返回冲销后库存')
  const after = call('getItem', { id: row.item }).item.stock
  const delta = row.dir === '入库' ? -row.qty : row.qty
  report(after === before + delta, 'reverseIO 库存回滚校验', `${before} → ${after}，应为 ${before + delta}`)
  mustFail('reverseIO', { no: row.id, actor: 'A001' }, '重复冲销')
}
call('adminListUsers', {})

// 6 实训室归属管理体系（前端本地回退 utils/mock.js）
call('listLabs', {}, d => Array.isArray(d) ? null : '应返回数组')
call('labOverview', { labId: 'L001' }, d => d && d.lab && Array.isArray(d.repairs) && Array.isArray(d.inspections) ? null : '应返回 {lab,repairs,inspections}')
call('listRepairs', {}, d => Array.isArray(d) ? null : '应返回数组')
call('listInspections', {}, d => Array.isArray(d) ? null : '应返回数组')
call('addRepair', { title: '冒烟报修', labId: 'L001', actor: 'T001', reporterName: '邓磊' }, d => d && d.id ? null : '应返回新单号')
call('addInspection', { title: '冒烟巡检', labId: 'L001', actor: 'T001', executorName: '邓磊' }, d => d && d.id ? null : '应返回新单号')

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
console.log('前端本地回退与云端两条路径的 action 覆盖面一致 ✅')

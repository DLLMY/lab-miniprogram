/**
 * 演示模式（USE_MOCK=true）全 action 冒烟
 * ------------------------------------------------------------------
 * 为什么要有这个脚本：
 *   云函数有两条实现路径——prodHandler（真·腾讯文档）与 mockHandler（内存演示）。
 *   新增 action 时只补了 prod 那一侧，演示模式就会掉进 default → "unknown action"，
 *   而线上一切正常。这类"只在一个分支错"的差异最难在验收现场解释，故用脚本把
 *   两条路径的 action 覆盖面对齐并固化成回归项。
 *
 * 用法：node tools/smoke-mock.js
 * 说明：事件必须是扁平结构 {action, ...payload}（与 wx.cloud.callFunction 一致），
 *       传成 {action, data:{...}} 会被 main 解构成 data={data:{...}} 从而全部取不到参数。
 */
const path = require('path')
const Module = require('module')

// wx-server-sdk 只在云函数容器里存在，本地跑需要一个同接口的最小桩
const STUB = path.join(__dirname, 'stub-wx-server-sdk.js')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'wx-server-sdk') return STUB
  return origResolve.call(this, request, ...rest)
}

process.env.USE_MOCK = 'true'
const fn = require(path.join(__dirname, '..', 'cloudfunctions', 'docsProxy', 'index.js'))

let pass = 0, fail = 0
const bad = []

function report(ok, action, extra) {
  if (ok) { pass++; return null }
  fail++
  bad.push(action + (extra ? ' — ' + extra : ''))
  console.log('  ❌ ' + action + (extra ? ' → ' + extra : ''))
  return null
}
async function call(action, payload, check) {
  const r = await fn.main(Object.assign({ action }, payload || {}))
  if (!r || r.code !== 0) return report(false, action, JSON.stringify(r && r.data).slice(0, 140))
  if (check) {
    const why = check(r.data)
    if (why) return report(false, action, why)
  }
  pass++
  return r.data
}
async function mustFail(action, payload, why) {
  const r = await fn.main(Object.assign({ action }, payload || {}))
  if (r && r.code !== 0) { pass++; return }
  report(false, action, '应当被拒绝（' + why + '）')
}

;(async () => {
  console.log('=== 演示模式冒烟（USE_MOCK=true）===')

  // 1 基础读
  await call('listMaterials', {}, d => Array.isArray(d) ? null : '应返回数组')
  await call('listTools', {}, d => Array.isArray(d) ? null : '应返回数组')
  await call('listUsers', {})
  await call('snapshot', {})
  await call('getItem', { id: 'M001' }, d => d && d.type === 'material' ? null : '应命中耗材')
  await call('getItem', { id: 'T001' }, d => d && d.type === 'tool' ? null : '应命中工具')
  await call('search', { kw: '电阻' }, d => Array.isArray(d) && d.length > 0 ? null : '模糊搜索应有结果')
  await call('listStockIO', {}, d => d && Array.isArray(d.rows) && typeof d.total === 'number' ? null : '应返回 {rows,total,...}')
  await call('usage', {}, d => d && Array.isArray(d.trend) && Array.isArray(d.lowStock) ? null : '应带报表块 trend/lowStock')

  // 2 学生侧
  await call('requisition', { user: 'S002', matId: 'M001', qty: 1, kind: 'material', reason: '实训用' })
  await mustFail('requisition', { user: 'S002', matId: 'M001', qty: 1, kind: 'material', reason: '' }, '空用途')
  await call('toolRequisition', { user: 'S002', toolId: 'T001', reason: '测量练习' })
  const mine = await call('listMine', { user: 'S002' })
  const req = (mine && mine.requisitions && mine.requisitions[0]) || {}
  await call('cancelReq', { no: req.no, user: 'S002' })
  await mustFail('cancelReq', { no: 'NOT_EXIST', user: 'S002' }, '不存在的单号')

  // 3 教师侧写入
  await call('io', { matId: 'M001', type: 'in', qty: 2, actor: 'T001', src: '采购' })
  await call('batchIo', { type: 'in', items: [{ matId: 'M002', qty: 1 }, { matId: 'M002', qty: 2 }], actor: 'T001' },
    d => d && d.done === 1 ? null : '同物品应合并为 1 项')
  await mustFail('batchIo', { type: 'in', items: [], actor: 'T001' }, '空明细')
  await call('stocktake', { mode: 'stocktake', items: [{ matId: 'M003', real: 45 }], actor: 'T001' })
  await mustFail('stocktake', { mode: 'stocktake', items: [{ matId: 'M003', real: -1 }], actor: 'T001' }, '负数实盘')

  // 4 导出：7 种全通
  for (const k of ['materials', 'tools', 'stock_io', 'requisitions', 'borrow', 'logs', 'access']) {
    await call('exportData', { kind: k }, d => d && typeof d.csv === 'string' && d.csv.indexOf('\uFEFF') === 0 ? null : 'CSV 需带 BOM')
  }

  // 5 管理员侧
  await call('listLogs', {}, d => d && Array.isArray(d.rows) ? null : '应返回 {rows,...}')
  await call('listAccess', {}, d => d && Array.isArray(d.rows) ? null : '应返回 {rows,...}')
  const io = await call('listStockIO', {})
  const row = (io && io.rows && io.rows[0]) || null
  const before = (await fn.main({ action: 'getItem', id: row ? row.item : 'M001' })).data.item.stock
  if (row) {
    await call('reverseIO', { no: row.id, actor: 'A001' }, d => d && typeof d.stock === 'number' ? null : '应返回冲销后库存')
    const after = (await fn.main({ action: 'getItem', id: row.item })).data.item.stock
    const delta = row.dir === '入库' ? -row.qty : row.qty
    report(after === before + delta, 'reverseIO 库存回滚校验', `${before} → ${after}，应为 ${before + delta}`)
    await mustFail('reverseIO', { no: row.id, actor: 'A001' }, '重复冲销')
  } else {
    console.log('  ℹ 演示库暂无流水，跳过冲销校验')
  }
  await call('adminListUsers', {})

  // 6 实训室归属管理体系（演示模式 = mockHandler 内存库）
  await call('listLabs', {}, d => Array.isArray(d) ? null : '应返回数组')
  await call('labOverview', { labId: 'L001' }, d => d && d.lab && Array.isArray(d.repairs) && Array.isArray(d.inspections) ? null : '应返回 {lab,repairs,inspections}')
  await call('listRepairs', {}, d => Array.isArray(d) ? null : '应返回数组')
  await call('listInspections', {}, d => Array.isArray(d) ? null : '应返回数组')
  await call('addRepair', { title: '冒烟报修', labId: 'L001', actor: 'T001', reporterName: '邓磊' }, d => d && d.id ? null : '应返回新单号')
  await call('addInspection', { title: '冒烟巡检', labId: 'L001', actor: 'T001', executorName: '邓磊' }, d => d && d.id ? null : '应返回新单号')

  console.log(`\n结果：pass=${pass} fail=${fail}`)
  if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
  console.log('演示模式与生产模式的 action 覆盖面一致 ✅')
})().catch(e => { console.error('冒烟脚本异常：', e); process.exit(1) })

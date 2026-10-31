// 云函数演示路径（cloudfunctions/docsProxy/index.js 的 mockHandler）定向验证：
//   ① stocktake 期初建账不翻倍（修复 Bug#4 的离线复现）
//   ② usage 排除冲销产生的两类流水（原流水 [已冲销] + 反向流水 src='冲销'）
// 复用 smoke-mock.js 的加载方式：stub wx-server-sdk + USE_MOCK=true，零网络零副作用。
'use strict'
const path = require('path')
const Module = require('module')

const STUB = path.join(__dirname, 'stub-wx-server-sdk.js')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'wx-server-sdk') return STUB
  return origResolve.call(this, request, ...rest)
}
process.env.USE_MOCK = 'true'
const fn = require(path.join(__dirname, '..', 'cloudfunctions', 'docsProxy', 'index.js'))

let pass = 0, fail = 0
const A = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')) }
}
const call = async (action, payload) => fn.main(Object.assign({ action }, payload || {}))

;(async () => {
  const mats = (await call('listMaterials', {})).data || []
  const target = mats[0]
  const id = target.id
  const book = Number(target.stock) || 0

  console.log('=== 云端演示①：stocktake 期初建账不翻倍（账面=' + book + ' → 实盘 80）===')
  const st = await call('stocktake', { mode: 'opening', items: [{ matId: id, real: 80 }], actor: 'T001' })
  A('stocktake 期初成功', st && st.code === 0, JSON.stringify(st && st.data).slice(0, 140))
  const after = (await call('listMaterials', {})).data || []
  const got = Number((after.find(x => x.id === id) || {}).stock)
  A('期初建账后库存=80（修复前会是 ' + (book + 80) + '）', got === 80, 'got=' + got)

  console.log('\n=== 云端演示②：usage 排除冲销流水 ===')
  const totals = async () => {
    const u = await call('usage', {})
    const tr = (u.data || {}).trend || []
    return tr.reduce((s, x) => ({ in: s.in + (x.in || 0), out: s.out + (x.out || 0) }), { in: 0, out: 0 })
  }
  const bi = await call('batchIo', { type: 'out', items: [{ matId: id, qty: 3 }], actor: 'T001', note: '正常出库' })
  A('batchIo 出库成功', bi && bi.code === 0, JSON.stringify(bi && bi.data).slice(0, 140))
  const t1 = await totals()
  A('正常出库已计入趋势 out>=3', t1.out >= 3, 'out=' + t1.out)

  const rows = ((await call('listStockIO', {})).data || {}).rows || []
  const flow = rows.find(r => ('' + (r.note || '')).indexOf('正常出库') >= 0)
  A('能定位到刚写的出库流水', !!flow, 'rows=' + rows.length)
  const rv = await call('reverseIO', { no: flow.id, actor: 'A001' })
  A('reverseIO 成功', rv && rv.code === 0, JSON.stringify(rv && rv.data).slice(0, 140))
  const rows2 = ((await call('listStockIO', {})).data || {}).rows || []
  A('原流水已标记 [已冲销]', rows2.some(r => r.reversed === true), 'reversed 缺失')
  A('已写入反向流水(src=冲销)', rows2.some(r => ('' + (r.src || '')) === '冲销'), '无反向流水')

  const t2 = await totals()
  A('冲销后 out 减少 3（原出库被排除）', t1.out - t2.out === 3, 'before=' + t1.out + ' after=' + t2.out)
  A('冲销后 in 不变（反向流水未被计入）', t2.in === t1.in, 'before=' + t1.in + ' after=' + t2.in)

  console.log('\n=== 结果 ===')
  console.log('pass=' + pass + ' fail=' + fail)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('运行异常:', e); process.exit(2) })

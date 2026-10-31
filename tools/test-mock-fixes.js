// 离线实现（utils/mock.js）定向验证：
//   ① stocktake 期初建账不翻倍（修复 Bug#4 的离线复现）
//   ② usage 排除冲销产生的两类流水（原流水 [已冲销] + 反向流水 src='冲销'）
// stub wx 内存存储后加载真实 mock.js，全程零网络、零真实写入副作用。
'use strict'

// —— stub wx 内存存储（mock.js 模块加载时即读 wx.getStorageSync）——
const mem = {}
global.wx = {
  getStorageSync: (k) => mem[k],
  setStorageSync: (k, v) => { mem[k] = v },
  getStorageInfoSync: () => ({ keys: Object.keys(mem) }),
  removeStorageSync: (k) => { delete mem[k] }
}

const m = require('../utils/mock.js')
const { dispatch } = m

let pass = 0, fail = 0
const A = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')) }
}
const mats = () => dispatch('listMaterials', {}).data || []
const trendTotals = () => {
  const tr = (dispatch('usage', {}).data || {}).trend || []
  return tr.reduce((s, x) => ({ in: s.in + (x.in || 0), out: s.out + (x.out || 0) }), { in: 0, out: 0 })
}

m.reset()
const target = mats()[0]
const id = target.id
const book = Number(target.stock) || 0

;(async () => {
  console.log('=== 离线①：stocktake 期初建账不翻倍（账面=' + book + ' → 实盘 80）===')
  const st = dispatch('stocktake', { mode: 'opening', items: [{ matId: id, real: 80 }], actor: 'T001' })
  A('stocktake 期初成功', st && st.code === 0, JSON.stringify(st).slice(0, 140))
  const got = Number((mats().find(x => x.id === id) || {}).stock)
  // 修复前：m.stock = book + real（翻倍）；修复后应直接收敛到实盘数 80
  A('期初建账后库存=80（修复前会是 ' + (book + 80) + '）', got === 80, 'got=' + got)

  console.log('\n=== 离线②：usage 排除冲销流水 ===')
  // 造一笔正常出库 3（未冲销），先记录趋势基线
  dispatch('batchIo', { type: 'out', items: [{ matId: id, qty: 3 }], actor: 'T001', note: '正常出库' })
  const t1 = trendTotals()
  A('正常出库已计入趋势 out=3', t1.out >= 3, 'out=' + t1.out)

  // 找到这笔「正常出库」流水并冲销 → 产生 原流水标记[已冲销] + 反向流水(src='冲销')
  const rows = (dispatch('listStockIO', {}).data || {}).rows || []
  const flow = rows.find(r => ('' + (r.note || '')).indexOf('正常出库') >= 0)
  A('能定位到刚写的出库流水', !!flow, 'rows=' + rows.length)
  const rv = dispatch('reverseIO', { no: flow.id, actor: 'A001' })
  A('reverseIO 成功', rv && rv.code === 0, JSON.stringify(rv).slice(0, 140))
  const after = (dispatch('listStockIO', {}).data || {}).rows || []
  A('原流水已标记 [已冲销]', after.some(r => r.reversed === true), 'reversed 缺失')
  A('已写入反向流水(src=冲销)', after.some(r => ('' + (r.src || '')) === '冲销'), '无反向流水')

  const t2 = trendTotals()
  // 冲销后：原「出库 3」被排除 → out 减少 3；反向「入库 3」若未排除会多出 in +3。
  // 正确结果：out 少 3、in 不变（净零）。
  A('冲销后 out 减少 3（原出库被排除）', t1.out - t2.out === 3, 'before=' + t1.out + ' after=' + t2.out)
  A('冲销后 in 不变（反向流水未被计入）', t2.in === t1.in, 'before=' + t1.in + ' after=' + t2.in)

  console.log('\n=== 结果 ===')
  console.log('pass=' + pass + ' fail=' + fail)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('运行异常:', e); process.exit(2) })

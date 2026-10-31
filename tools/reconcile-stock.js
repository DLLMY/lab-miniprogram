// tools/reconcile-stock.js —— 库存账实对账（只读，绝不写数据）
//
// 解决什么问题：
//   审批领用扣库存曾长期不写 stock_io（见 Docs 评估报告 A1/P0-1），导致
//   "账面库存 vs 流水"无法互相印证——这正是此前实测"推算期初为负数"的主因之一。
//   本脚本给出可随时运行的对账结论，让"账对不对得上"有一个确定答案。
//
//   检查项：
//     ① 每支耗材：推算期初 = 当前库存 - 流水净变动；期初 < 0 表示有出库未留痕（账不平）
//     ② 每张「已通过」的领用申请：必须在 stock_io 中有备注为「领用申请 <单号>」的出库流水
//     ③ 统计各类流水的数量分布，便于确认补录是否完整
//
// 用法：node tools/reconcile-stock.js
//      （纯只读；若要修复 ② 类缺流水，请用 tools/backfill-req-io.js）
const fs = require('fs')
const path = require('path')
;(function loadEnv() {
  const p = path.join(__dirname, '..', 'env.local.js')
  if (!fs.existsSync(p)) return
  const src = fs.readFileSync(p, 'utf8')
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*(?:module\.exports\.)?([A-Za-z_$][\w$]*)\s*=\s*['"](.*)['"]/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
})()
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

const bj = (t) => {
  const n = Number(t)
  return Number.isFinite(n) && n > 1e12
    ? new Date(n + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    : '(空)'
}

;(async () => {
  const [mats, io, reqs] = await Promise.all([
    td.getRecords('materials'),
    td.getRecords('stock_io'),
    td.getRecords('requisitions')
  ])
  const C = td.COL

  // ---- ① 库存 vs 流水净变动 ----
  console.log('=== ① 库存 vs 流水净变动（推算期初）===')
  const net = {}
  for (const r of io) {
    const f = r.fields
    const k = '' + (f[C.stock_io.item] || '')
    if (!k) continue
    const q = Number(f[C.stock_io.qty]) || 0
    net[k] = (net[k] || 0) + (('' + f[C.stock_io.dir]) === '入库' ? 1 : -1) * q
  }
  let bad = 0
  for (const m of mats) {
    const f = m.fields
    const k = '' + f[C.materials.id]
    const stock = Number(f[C.materials.stock]) || 0
    const nv = net[k] || 0
    const begin = stock - nv
    const flag = begin < 0 ? '❌ 有出库未留痕' : (nv === 0 ? '· 无流水' : '✅ 平')
    if (begin < 0) bad++
    console.log(
      '  ' + k.padEnd(6) +
      ('' + (f[C.materials.name] || '')).padEnd(10) +
      ' 库存=' + String(stock).padStart(4) +
      '  流水净变动=' + String(nv > 0 ? '+' + nv : nv).padStart(5) +
      '  推算期初=' + String(begin).padStart(5) +
      '  ' + flag
    )
  }

  // ---- ② 已通过领用申请 vs 出库流水 ----
  console.log('\n=== ② 已通过领用申请 · 出库流水留痕检查 ===')
  const noted = new Set()
  for (const r of io) {
    const note = '' + (r.fields[C.stock_io.note] || '')
    const m = note.match(/^领用申请\s*(\S+)$/)
    if (m) noted.add(m[1])
  }
  const passed = reqs.filter(r =>
    ('' + r.fields[C.requisitions.type]) === '领用' &&
    ('' + r.fields[C.requisitions.status]) === '已通过'
  )
  let missing = 0
  for (const r of passed) {
    const no = '' + r.fields[C.requisitions.id]
    if (noted.has(no)) continue
    missing++
    console.log(
      '  ❌ 缺流水 ' + no.padEnd(20) +
      ' 物品=' + ('' + r.fields[C.requisitions.item]).padEnd(6) +
      ' 数量=' + r.fields[C.requisitions.qty] +
      ' 申请人=' + ('' + (r.fields[C.requisitions.user] || '')) +
      ' 时间=' + bj(r.fields[C.requisitions.time])
    )
  }
  console.log('  已通过领用申请 ' + passed.length + ' 张，缺流水 ' + missing + ' 张' +
    (missing === 0 ? ' ✅' : ' ⚠️ 请用 node tools/backfill-req-io.js --yes 补录'))

  // ---- ③ 流水构成分布 ----
  console.log('\n=== ③ 流水构成（stock_io 共 ' + io.length + ' 条）===')
  const byDir = {}
  let noItem = 0
  for (const r of io) {
    const d = '' + (r.fields[C.stock_io.dir] || '(空)')
    byDir[d] = (byDir[d] || 0) + 1
    if (!('' + (r.fields[C.stock_io.item] || ''))) noItem++
  }
  for (const k of Object.keys(byDir)) console.log('  ' + k.padEnd(8) + byDir[k] + ' 条')
  if (noItem) console.log('  ⚠️ 有 ' + noItem + ' 条流水缺物品ID（不可用于库存推定）')

  console.log('\n=== 结论 ===')
  if (bad === 0 && missing === 0) {
    console.log('  ✅ 账务健康：所有耗材推算期初非负，已通过领用申请全部有出库流水')
  } else {
    console.log('  ⚠️ 存在 ' + bad + ' 支耗材账不平、' + missing + ' 张申请缺流水')
    console.log('     补录流水：node tools/backfill-req-io.js（先预览，确认后加 --yes）')
    console.log('     若补录后期初仍为负：说明存在"删流水不调库存"等历史遗留，')
    console.log('     需按《功能评估与补充方案报告》A4 做一次实物盘点重置基线。')
  }
  process.exit(bad === 0 && missing === 0 ? 0 : 1)
})().catch(e => { console.error('\n❌ 对账失败：', e.message); process.exit(2) })

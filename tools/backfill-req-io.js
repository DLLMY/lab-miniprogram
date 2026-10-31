// tools/backfill-req-io.js —— 为历史「已通过领用申请」补记出库流水
//
// 为什么需要：
//   approve 通过耗材申请时长期只扣库存、不写 stock_io（评估报告 A1 / P0-①），
//   导致出入库流水缺了最主要的出库方式。新代码已修好写入路径，但历史数据仍在。
//   本脚本把历史上"偷偷扣掉的库存"补成可见的出库流水，让账本追平。
//
// 重要边界：
//   · 只补流水，绝不再扣库存（库存当年已经扣过了，再扣就是双倍扣减）
//   · 幂等：按「备注=领用申请 <单号>」判重，重复运行不会补两遍
//   · 时间用申请单的申请时间（还原当时），不是补录时刻
//   · 默认预览不写；确认无误后加 --yes 才落库
//
// 用法：node tools/backfill-req-io.js          预览
//       node tools/backfill-req-io.js --yes    执行
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

const YES = process.argv.includes('--yes')
const C = td.COL

const bj = (t) => {
  const n = Number(t)
  return Number.isFinite(n) && n > 1e12
    ? new Date(n + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    : '(空)'
}

;(async () => {
  const io = await td.getRecords('stock_io')
  const reqs = await td.getRecords('requisitions')

  // 已有流水的申请单集合（按备注锚点判定）
  const noted = new Set()
  for (const r of io) {
    const m = ('' + (r.fields[C.stock_io.note] || '')).match(/^领用申请\s*(\S+)$/)
    if (m) noted.add(m[1])
  }

  // 需要补流水的：_type=领用 且 status=已通过 且 未留痕
  const todo = []
  for (const r of reqs) {
    const f = r.fields
    if (('' + f[C.requisitions.type]) !== '领用') continue
    if (('' + f[C.requisitions.status]) !== '已通过') continue
    const no = '' + f[C.requisitions.id]
    if (noted.has(no)) continue
    todo.push({
      no,
      item: '' + (f[C.requisitions.item] || ''),
      qty: Number(f[C.requisitions.qty]) || 0,
      user: '' + (f[C.requisitions.user] || ''),
      time: f[C.requisitions.time]
    })
  }

  console.log('需要补记出库流水的领用申请：' + todo.length + ' 张\n')
  for (const t of todo) {
    console.log('  ' + t.no.padEnd(20) + t.item.padEnd(6) +
      ' 数量=' + String(t.qty).padStart(3) +
      ' 申请人=' + t.user.padEnd(6) + ' 时间=' + bj(t.time))
  }

  if (!todo.length) {
    console.log('\n✅ 无历史欠账，无需补录')
    return
  }
  if (!YES) {
    console.log('\n（预览模式，未写入）确认无误后执行：node tools/backfill-req-io.js --yes')
    console.log('提示：本脚本只补流水、不动库存；补完后建议跑 node tools/reconcile-stock.js 复核。')
    return
  }

  console.log('\n开始补录…')
  let done = 0
  for (const t of todo) {
    try {
      await td.addRecord('stock_io', {
        [C.stock_io.item]: t.item,
        [C.stock_io.dir]: '出库',
        [C.stock_io.qty]: t.qty,
        [C.stock_io.op]: t.user || '（历史）',
        [C.stock_io.time]: Number(t.time) || Date.now(),
        [C.stock_io.note]: '领用申请 ' + t.no
      })
      done++
      console.log('  ✅ 已补 ' + t.no)
    } catch (e) {
      console.log('  ❌ 补录失败 ' + t.no + '：' + e.message)
    }
  }
  console.log('\n补录完成：' + done + '/' + todo.length)
  console.log('下一步：node tools/reconcile-stock.js 复核账务是否追平')
})().catch(e => { console.error('\n❌ 失败：', e.message); process.exit(1) })

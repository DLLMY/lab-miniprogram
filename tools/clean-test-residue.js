// tools/clean-test-residue.js —— 清理 2026-10-24 真机测试产生的脏数据：
//   1) 2 条诊断残留流水（IO-20261022-0010/0012，操作时间为空、备注「诊断 x」，
//      第 6 轮 diag-write.js 无确认期写入；该脚本只写 stock_io 不动库存，故删除无需回调）
//   2) 3 笔双写重复流水（IO-20261024-0017/0019/0021——与 0016/0018/0020 间隔 1-2 秒、
//      同人同物同量，系前端 busy 守卫失效前的旧版本包双发所致）
//   3) 与双写对应的 3 条重复日志（LG-20261024-0046/0048/0050）
//   4) 撤销双写第二笔的库存效果：M001 -3、M002 +13、M003 -6
//      （只回撤「今天多写的那一笔」，不重算历史账——早期删流水未调库存导致的期初偏差不在本脚本范围）
//
// 用法：node tools/clean-test-residue.js        （预览，不写任何数据）
//       node tools/clean-test-residue.js --yes  （执行）
const fs = require('fs')
const path = require('path')
const YES = process.argv.includes('--yes')
;(function loadEnv() {
  const f = path.join(__dirname, '.env.local')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const k = m[1], v = m[2].replace(/^["']|["']$/g, '')
    if (process.env[k] === undefined) process.env[k] = v
  }
})()
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

// 待删流水（精确到流水ID，不按模式匹配，避免误删）
const IO_DEL = ['IO-20261022-0010', 'IO-20261022-0012', 'IO-20261024-0017', 'IO-20261024-0019', 'IO-20261024-0021']
// 待删日志（双写产生的第二笔）
const LG_DEL = ['LG-20261024-0046', 'LG-20261024-0048', 'LG-20261024-0050']
// 库存回撤：撤销双写第二笔（0017→M003入库6、0019→M002出库13、0021→M001入库3）
const STOCK_FIX = [
  { id: 'M001', delta: -3, why: '撤销 IO-20261024-0021 重复入库 3' },
  { id: 'M002', delta: 13, why: '撤销 IO-20261024-0019 重复出库 13' },
  { id: 'M003', delta: -6, why: '撤销 IO-20261024-0017 重复入库 6' }
]

;(async () => {
  // 1) 核对目标行确实存在且符合预期（防止线上数据已变化导致误删）
  const ioRows = await td.getRecords('stock_io')
  const lgRows = await td.getRecords('logs')
  const ioHit = ioRows.filter(r => IO_DEL.indexOf(r.fields['流水ID']) >= 0)
  const lgHit = lgRows.filter(r => LG_DEL.indexOf(r.fields['日志ID']) >= 0)
  console.log('=== 预览：待清理清单 ===')
  console.log('流水（stock_io）：命中 ' + ioHit.length + '/' + IO_DEL.length)
  for (const r of ioHit) {
    const f = r.fields
    console.log('  -', f['流水ID'], f['方向'], f['数量'], f['物品ID'], '备注=' + (f['备注'] || '(空)'), '时间=' + (f['操作时间'] || '(空)'))
  }
  const ioMiss = IO_DEL.filter(id => !ioHit.some(r => r.fields['流水ID'] === id))
  if (ioMiss.length) console.log('  ⚠️ 未找到（可能已删）：' + ioMiss.join(', '))
  console.log('日志（logs）：命中 ' + lgHit.length + '/' + LG_DEL.length)
  for (const r of lgHit) {
    const f = r.fields
    console.log('  -', f['日志ID'], f['操作类型'], f['对象'], f['操作人'])
  }
  const lgMiss = LG_DEL.filter(id => !lgHit.some(r => r.fields['日志ID'] === id))
  if (lgMiss.length) console.log('  ⚠️ 未找到（可能已删）：' + lgMiss.join(', '))
  console.log('库存回撤：')
  for (const s of STOCK_FIX) {
    const m = (await td.getRecords('materials', r => ('' + r.fields['耗材ID']) === s.id))[0]
    const cur = m ? Number(m.fields['当前库存']) || 0 : null
    console.log('  -', s.id, '当前=' + cur, '→', cur === null ? '(找不到)' : (cur + s.delta), '（' + s.why + '）')
  }
  if (!YES) {
    console.log('\n（预览模式，未写入）确认执行：node tools/clean-test-residue.js --yes')
    return
  }
  // 2) 执行删除（deleteRecordByIds 自带删后回读验证）
  console.log('\n=== 执行清理 ===')
  if (ioHit.length) {
    const n = await td.deleteRecordByIds('stock_io', ioHit.map(r => r.recordId))
    console.log('✅ 已删流水', n, '条')
  }
  if (lgHit.length) {
    const n = await td.deleteRecordByIds('logs', lgHit.map(r => r.recordId))
    console.log('✅ 已删日志', n, '条')
  }
  // 3) 库存回撤（更新后回读确认）
  for (const s of STOCK_FIX) {
    const m = (await td.getRecords('materials', r => ('' + r.fields['耗材ID']) === s.id, { noCache: true }))[0]
    if (!m) { console.log('❌ 找不到耗材', s.id); continue }
    const cur = Number(m.fields['当前库存']) || 0
    const next = cur + s.delta
    await td.updateRecord('materials', m.recordId, { '当前库存': next })
    const after = (await td.getRecords('materials', r => ('' + r.fields['耗材ID']) === s.id, { noCache: true }))[0]
    const val = after ? Number(after.fields['当前库存']) : null
    console.log((val === next ? '✅' : '❌') + ' ' + s.id + ' 库存 ' + cur + ' → ' + next + (val === next ? '' : '（回读=' + val + '，请到腾讯文档核对）'))
  }
  console.log('\n清理完成。剩余流水：', (await td.getRecords('stock_io')).length, '条')
})().catch(e => { console.error('❌ 失败：', e.message); process.exit(1) })

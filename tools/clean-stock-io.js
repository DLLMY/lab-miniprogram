/**
 * 清理 stock_io 表的历史脏数据。
 *
 * 背景：早期版本 tencentdocs.js 的列名映射与真实文档不一致，写入 stock_io 时
 *      buildValues 找不到对应列而静默跳过，导致这些行只有「数量=1」，
 *      物品ID / 方向 / 操作人 全为空 —— 流水账里会出现无法解释的空行。
 *
 * 用法：
 *   node tools/clean-stock-io.js          # 预览（只列出，不删）
 *   node tools/clean-stock-io.js --yes     # 确认删除
 *   node tools/clean-stock-io.js --keep-diagnostic  # 保留操作人为「诊断」的测试行
 */
const path = require('path')
const td = require(path.join(__dirname, '..', 'cloudfunctions', 'docsProxy', 'tencentdocs.js'))

const args = process.argv.slice(2)
const APPLY = args.includes('--yes')
const KEEP_DIAG = args.includes('--keep-diagnostic')

;(async () => {
  const recs = await td.getRecords('stock_io')
  const dirty = recs.filter(r => {
    const f = r.fields
    const item = f[td.COL.stock_io.item] || ''
    const dir = f[td.COL.stock_io.dir] || ''
    const op = f[td.COL.stock_io.op] || ''
    if (item && dir) return false                 // 正常行
    if (KEEP_DIAG && op === '诊断') return false   // 保留诊断行
    return true
  })

  if (!dirty.length) {
    console.log('没有需要清理的脏数据 ✓')
    return
  }

  console.log('待清理 ' + dirty.length + ' 条（物品ID/方向为空的空壳行）：\n')
  dirty.forEach(r => {
    const f = r.fields
    console.log('  ' + (f[td.COL.stock_io.id] || '(无ID)').padEnd(22) +
      ' 数量=' + f[td.COL.stock_io.qty] +
      ' 操作人=' + (f[td.COL.stock_io.op] || '(空)') +
      ' 备注=' + (f[td.COL.stock_io.note] || '(空)'))
  })

  if (!APPLY) {
    console.log('\n这是预览模式，未做任何删除。确认后执行：')
    console.log('  node tools/clean-stock-io.js --yes')
    return
  }

  const ids = dirty.map(r => r.recordId)
  const n = await td.deleteRecordByIds('stock_io', ids)
  console.log('\n已删除 ' + n + ' 条脏数据')

  const after = await td.getRecords('stock_io')
  const stillBad = after.filter(r => {
    const f = r.fields
    return !(f[td.COL.stock_io.item] || '') || !(f[td.COL.stock_io.dir] || '')
  }).length
  console.log('清理后剩余 ' + after.length + ' 条，其中仍为空壳 ' + stillBad + ' 条')
})().catch(e => {
  console.error('ERR', e.message)
  process.exit(1)
})

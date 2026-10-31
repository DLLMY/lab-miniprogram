// tools/cleanup-orphan-reqs.js
// 清理真实 requisitions 表里「申请人ID 为空」的脏数据（写格式调试期留下的记录）。
// 这些行会出现在教师「待审批」列表里且看不出是谁申请的，建议清掉。
//
// 用法：
//   node tools/cleanup-orphan-reqs.js          # 只列出来，不删（安全）
//   node tools/cleanup-orphan-reqs.js --yes    # 确认删除

const fs = require('fs')
const path = require('path')

;(function loadEnv() {
  const f = path.join(__dirname, '.env.local')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
})()

const td = require('../cloudfunctions/docsProxy/tencentdocs.js')
const COL = td.COL
const YES = process.argv.includes('--yes')

;(async () => {
  const all = await td.getRecords('requisitions')
  const orphans = all.filter(r => {
    const f = r.fields || {}
    const u = f[COL.requisitions.user]
    const item = f[COL.requisitions.item]
    const emptyUser = u === undefined || u === null || ('' + u).trim() === ''
    const emptyItem = item === undefined || item === null || ('' + item).trim() === ''
    // 合法单子必有 申请人ID 与 物品ID；两者任一为空即视为早期调试/e2e 残留脏数据
    return emptyUser || emptyItem
  })

  console.log(`requisitions 共 ${all.length} 条，其中脏数据（申请人ID空 或 物品ID空）${orphans.length} 条：`)
  orphans.forEach(r => {
    const f = r.fields || {}
    console.log('   ', JSON.stringify({
      no: f[COL.requisitions.id], user: f[COL.requisitions.user], item: f[COL.requisitions.item],
      qty: f[COL.requisitions.qty], status: f[COL.requisitions.status]
    }), 'recordId=' + r.recordId)
  })

  if (!orphans.length) { console.log('\n没有需要清理的记录。'); return }
  if (!YES) {
    console.log('\n（仅预览。确认删除请运行：node tools/cleanup-orphan-reqs.js --yes）')
    return
  }

  const n = await td.deleteRecordByIds('requisitions', orphans.map(r => r.recordId))
  console.log(`\n✅ 已删除 ${n} 条脏数据`)
  const after = await td.getRecords('requisitions')
  console.log('清理后 requisitions 剩余', after.length, '条')
})().catch(e => {
  console.error('❌ 清理失败：', e.message)
  console.error('（未完成删除；如部分已删，重跑预览命令核对剩余脏数据）')
  process.exit(1)
})

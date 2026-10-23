// tools/diag-pending-raw.js
// 把 requisitions 表里「待审批」单子的【完整原始字段】逐条打印，
// 用来确认教师端待审批列表里混了哪些脏数据（缺物品ID / 物品类型 / 申请人ID 等）。
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  const all = await td.getRecords('requisitions')
  console.log('requisitions 总条数 =', all.length)
  const pending = all.filter(r => ('' + (r.fields[td.COL.requisitions.status] || '')) === '待审批')
  console.log('其中 待审批 =', pending.length, '\n')

  pending.forEach((r, i) => {
    const f = r.fields
    const col = td.COL.requisitions
    const item = f[col.item]
    const type = f[col.type]
    const user = f[col.user]
    const flag = (!item || ('' + item).trim() === '') ? '  <<< 脏:物品ID为空'
      : (!type || ('' + type).trim() === '') ? '  <<< 脏:物品类型为空'
      : (!user || ('' + user).trim() === '') ? '  <<< 脏:申请人ID为空'
      : ''
    console.log(`#${i + 1} recordId=${r.recordId}`)
    console.log('   申请ID =', f[col.id])
    console.log('   申请人ID =', JSON.stringify(user))
    console.log('   物品ID =', JSON.stringify(item))
    console.log('   物品类型 =', JSON.stringify(type))
    console.log('   数量 =', JSON.stringify(f[col.qty]))
    console.log('   状态 =', JSON.stringify(f[col.status]), flag)
    if (flag) console.log('   完整字段 =', JSON.stringify(f))
  })
})().catch(e => { console.error('诊断失败:', e); process.exit(1) })

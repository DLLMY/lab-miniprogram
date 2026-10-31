/*
 * tools/promote-deng-admin.js
 * 把 T001 邓老师 在腾讯文档 users 表中提升为系统管理员（角色=管理员）。
 * 真实写操作：读 → 校验 → 改角色列 → 回读确认。仅改「角色」一列，不动其它字段。
 */
const td = require('D:/万州职教中心/lab-miniprogram/cloudfunctions/docsProxy/tencentdocs.js')

const COL_ROLE = '角色'

;(async () => {
  // 1) 读取 users 全表，定位 邓老师（优先 T001，回退按姓名）
  const list = await td.getRecords('users')
  const matches = list.filter(r => {
    const id = ('' + (r.fields['用户ID'] || '')).trim().toUpperCase()
    const name = ('' + (r.fields['姓名'] || '')).trim()
    return id === 'T001' || name === '邓老师'
  })
  console.log('匹配到的候选行：', matches.length)
  matches.forEach(r => {
    console.log('  -', r.fields['用户ID'], r.fields['姓名'], '| 角色=', r.fields['角色'], '| 状态=', r.fields['状态'], '| rid=', r.recordId)
  })

  if (!matches.length) {
    console.error('未找到 T001 或「邓老师」，未做任何修改。')
    process.exit(1)
  }
  // 取 T001 优先；若无则取第一个邓老师
  const rec = matches.find(r => ('' + (r.fields['用户ID'] || '')).trim().toUpperCase() === 'T001') || matches[0]
  const curRole = ('' + (rec.fields[COL_ROLE] || '')).trim()
  console.log('\n将操作：', rec.fields['用户ID'], rec.fields['姓名'], '当前角色=', curRole)

  if (curRole === '管理员') {
    console.log('→ 该账号已是管理员，无需修改。')
    process.exit(0)
  }

  // 2) 改写「角色」列（唯一改动）
  console.log('\n执行：updateRecord(users, ' + rec.recordId + ', { 角色: 管理员 })')
  await td.updateRecord('users', rec.recordId, { [COL_ROLE]: '管理员' })

  // 3) 回读确认
  const list2 = await td.getRecords('users')
  const after = list2.find(r => r.recordId === rec.recordId)
  console.log('回读结果：', after.fields['用户ID'], after.fields['姓名'], '| 角色=', after.fields['角色'], '| 状态=', after.fields['状态'])
  console.log(after.fields['角色'] === '管理员' ? '\n✅ 已成功提升为系统管理员。' : '\n⚠️ 回读角色仍为：' + after.fields['角色'] + '，请检查网络或重试。')
})().catch(e => {
  console.error('ERR', e.message)
  process.exit(1)
})

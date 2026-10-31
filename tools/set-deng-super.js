/*
 * tools/set-deng-super.js
 * 将 T001 邓老师 在腾讯文档 users 表中的角色置为「超级管理员」。真实写操作。
 * 读 → 校验当前角色 → 若非超管则改「角色」列 → 回读确认。仅改角色列。
 */
const td = require('D:/万州职教中心/lab-miniprogram/cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  const list = await td.getRecords('users')
  const rec = list.find(r => ('' + (r.fields['用户ID'] || '')).trim().toUpperCase() === 'T001')
  if (!rec) { console.error('未找到 T001，未做任何修改。'); process.exit(1) }
  console.log('当前：', rec.fields['用户ID'], rec.fields['姓名'], '| 角色=', rec.fields['角色'], '| 状态=', rec.fields['状态'])

  if (rec.fields['角色'] === '超级管理员') {
    console.log('→ T001 已是超级管理员，无需修改。')
    process.exit(0)
  }
  console.log('\n执行：updateRecord(users, ' + rec.recordId + ', { 角色: 超级管理员 })')
  await td.updateRecord('users', rec.recordId, { '角色': '超级管理员' })

  const list2 = await td.getRecords('users')
  const after = list2.find(r => r.recordId === rec.recordId)
  console.log('回读：', after.fields['用户ID'], after.fields['姓名'], '| 角色=', after.fields['角色'])
  if (after.fields['角色'] === '超级管理员') {
    // 同步把 openid 空着的事实提示一下：邓老师需本人首次登录绑定后，超管后台才对他可见
    console.log('\n✅ T001 邓老师 已设为超级管理员。')
    console.log('⚠️ 其「微信OpenID」仍为空白，需邓老师本人首次打开小程序、输姓名+工号登录绑定后，身份才会被识别为超级管理员、后台入口才可见。')
  } else {
    console.error('\n⚠️ 回读角色为：' + after.fields['角色'] + '，请检查。')
    process.exit(1)
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1) })

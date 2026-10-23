// tools/clear-openid-binds.js
// 查看 / 清空 users 表「微信OpenID」绑定。
// 用途：① 换绑（工号换了绑定微信）；② 测试后重置，方便用工号重新绑定。
//   node tools/clear-openid-binds.js            # 预览：列出已绑定的工号
//   node tools/clear-openid-binds.js --id=T001  # 只清某工号
//   node tools/clear-openid-binds.js --yes      # 确认清空全部绑定
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  const yes = process.argv.includes('--yes')
  const idArg = (process.argv.find(a => a.startsWith('--id=')) || '').split('=')[1]

  await td.ensureOpenIdColumn()
  const recs = await td.getRecords('users')
  const bound = recs
    .map(r => ({ rid: r.recordId, id: r.fields[td.COL.users.id], name: r.fields[td.COL.users.name], openid: r.fields[td.COL.users.openid] || '' }))
    .filter(u => u.openid)

  if (!bound.length) {
    console.log('当前没有任何工号绑定了微信。')
    return
  }
  const targets = idArg ? bound.filter(u => ('' + u.id).toUpperCase() === idArg.toUpperCase()) : bound
  console.log('已绑定微信的工号 ' + targets.length + ' 个：')
  targets.forEach(u => console.log('   ', u.id, u.name, '→ openid=' + u.openid.slice(0, 10) + '…'))

  if (!yes) {
    console.log('\n（预览模式，未改动）加 --yes 执行清空' + (idArg ? '（仅 ' + idArg + '）' : '全部') + '。')
    return
  }
  for (const u of targets) {
    await td.updateRecord('users', u.rid, { [td.COL.users.openid]: '' })
    console.log('已清空：', u.id, u.name)
  }
  console.log('\n完成。这些工号现在可重新用「姓名+工号」绑定微信。')
})().catch(e => { console.error('❌ 失败：', e.message); process.exit(1) })

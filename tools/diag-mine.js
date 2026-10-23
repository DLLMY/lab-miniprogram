// tools/diag-mine.js
// 诊断「学生登录后看不到领用数据」：
//   ① 真实 users 表里有哪些 用户ID / 姓名 / 角色
//   ② 真实 requisitions 表总条数 + 申请人ID 分布
//   ③ 用演示身份调 listMine 看能命中几条
//
// 用法：node tools/diag-mine.js [学号]

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

;(async () => {
  const arg = process.argv[2]
  try {
    console.log('=== ① 真实 users 表 ===')
    const users = await td.getRecords('users')
    console.log('共', users.length, '条')
    users.slice(0, 25).forEach(u => {
      const f = u.fields || {}
      console.log('   用户ID=' + JSON.stringify(f[COL.users.id]) + '  姓名=' + JSON.stringify(f[COL.users.name]) + '  角色=' + JSON.stringify(f[COL.users.role]))
    })

    console.log('\n=== ② 真实 requisitions 表 ===')
    const reqs = await td.getRecords('requisitions')
    console.log('共', reqs.length, '条')
    const who = {}
    reqs.forEach(r => {
      const f = r.fields || {}
      const k = f[COL.requisitions.user] || '(空)'
      who[k] = (who[k] || 0) + 1
    })
    console.log('申请人ID 分布：', JSON.stringify(who))
    reqs.slice(0, 15).forEach(r => {
      const f = r.fields || {}
      console.log('   ' + JSON.stringify({
        no: f[COL.requisitions.id], user: f[COL.requisitions.user], item: f[COL.requisitions.item],
        qty: f[COL.requisitions.qty], status: f[COL.requisitions.status], time: f[COL.requisitions.time]
      }))
    })

    console.log('\n=== ③ listMine 命中测试（返回 {requisitions, borrow}）===')
    const ids = [...new Set([arg, 'S001', 'S002', 'S003'].filter(Boolean)
      .concat(users.map(u => (u.fields || {})[COL.users.id]).filter(Boolean)))]
    for (const id of ids) {
      const r = await td.listMine(id) || {}
      const rq = r.requisitions || []
      const bw = r.borrow || []
      console.log(`   listMine('${id}') → 领用 ${rq.length} 条 / 借还 ${bw.length} 条`)
    }
  } catch (e) {
    console.error('诊断失败：', e.message)
    process.exit(1)
  }
})()

// 一键全量回归：把各专项脚本串起来跑，任一失败即非零退出。
// 用法：node tools/regress-all.js
const { spawnSync } = require('child_process')
const path = require('path')

const SUITES = [
  ['生产代码深层 bug（planDue/出库流水/报表口径/盘点/审批边界/日期戳）', 'test-prod-fixes.js'],
  ['离线本地 mock 修复（期初不翻倍/冲销排除）', 'test-mock-fixes.js'],
  ['云端演示 mockHandler 修复（期初不翻倍/冲销排除）', 'test-mockhandler-fixes.js'],
  ['前端导出演示数据警示', 'test-export-demo-flag.js'],
  ['上传包体检（Node 专有语法会让服务端拒包）', 'check-pack-ignore.js'],
  ['WXML 标签严格嵌套（漏闭合会编译失败）', 'check-wxml-tags.js'],
  ['云函数路由对齐（mock↔prod 漂移会致生产 404）', 'test-route-parity.js'],
  ['角色权限闸门', 'test-role-gate.js'],
  ['超级管理员 RBAC 裁决', 'test-rbac-super.js'],
  ['演示模式 action 覆盖（云侧）', 'smoke-mock.js'],
  ['演示模式 action 覆盖（前端回退）', 'smoke-local-mock.js'],
  ['8 张表可读性', 'test-all.js'],
  ['数据后端冗余开关（免改代码热切换 + 自动回退）', 'test-backend-switch.js'],
  ['云数据库适配器 clouddb（CRUD + 业务函数契约）', 'test-clouddb-adapter.js'],
  ['后端契约一致性（clouddb ↔ tencentdocs 导出键）', 'test-backend-parity.js'],
  ['数据迁移（腾讯文档→云库 中文列名→英文 key）', 'test-migrate.js'],
  ['WorkBuddy 连接器 L1 写确认门（真实子进程端到端）', 'test-robot-write.js'],
  ['WorkBuddy 连接器 Phase4 多轮记忆编排', 'test-robot-memory.js']
]

const NODE = process.execPath
let failed = 0
const rows = []

for (const [title, file] of SUITES) {
  const r = spawnSync(NODE, [path.join(__dirname, file)], { encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  // 明细有两种形态：① pass=N fail=M ② 「可读表 N/N」（已是 通过/总数，不能再相加）
  let detail = ''
  const pf = out.match(/pass=(\d+)\s*fail=(\d+)/)
  const tbl = out.match(/可读表\s*(\d+)\/(\d+)/)
  if (pf) detail = pf[1] + '/' + (Number(pf[1]) + Number(pf[2])) + ' 通过'
  else if (tbl) detail = tbl[1] + '/' + tbl[2] + ' 通过'
  const ok = r.status === 0
  if (!ok) failed++
  rows.push({ ok, title, file, detail, out })
  console.log((ok ? '  ✅ ' : '  ❌ ') + title + (detail ? '  (' + detail + ')' : ''))
  if (!ok) {
    console.log('     ── 失败输出 ──')
    console.log(out.split('\n').filter(l => /❌|Error|错误|失败/.test(l)).slice(0, 12).map(l => '     ' + l).join('\n'))
  }
}

console.log('\n=== 汇总 ===')
console.log('套件 ' + (SUITES.length - failed) + '/' + SUITES.length + ' 通过' + (failed ? '，' + failed + ' 个失败' : ''))
process.exit(failed ? 1 : 0)

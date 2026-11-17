'use strict'
// ============================================================================
// test_list_claims.js —— 验证 listClaims 接口（本地直连云库，不经云函数）
// 用途：新接口上线前确认返回形状、筛选、班级汇总、行级隔离都正确。
// ============================================================================

const os = require('os')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function loadCreds() {
  let c = {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'mcp.json'), 'utf8'))
    c = (((cfg.mcpServers || {})['lab-docs-proxy'] || {}).env || {})
  } catch (_) { /* env */ }
  const e = process.env
  return {
    TCB_SECRET_ID: (e.TCB_SECRET_ID || c.TCB_SECRET_ID || '').trim(),
    TCB_SECRET_KEY: (e.TCB_SECRET_KEY || c.TCB_SECRET_KEY || '').trim(),
    TCB_ENV: (e.TCB_ENV || c.TCB_ENV || '').trim()
  }
}

function loadSdkInit() {
  for (const c of ['@cloudbase/node-sdk', path.join(ROOT, 'mcp', 'node_modules', '@cloudbase', 'node-sdk')]) {
    try {
      const m = require(c)
      const init = (typeof m === 'function') ? m : m.init
      if (typeof init === 'function') return init
    } catch (_) { /* next */ }
  }
  return null
}

async function main() {
  const creds = loadCreds()
  const init = loadSdkInit()
  if (!init || !creds.TCB_SECRET_ID) { console.log('❌ 缺 SDK 或凭证'); process.exit(1) }
  const app = init({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })

  const cd = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
  cd.__setDbForTest(app.database())

  const show = (label, d) => {
    console.log('\n===== ' + label + ' =====')
    if (!d) { console.log('  返回 null'); return }
    console.log('  键:', Object.keys(d).join(', '))
    console.log('  total=%s offset=%s limit=%s hasMore=%s', d.total, d.offset, d.limit, d.hasMore)
    console.log('  classOptions:', JSON.stringify(d.classOptions))
    console.log('  byCls:', JSON.stringify(d.byCls))
    console.log('  rows:')
    const list = d.rows || []
    list.forEach(r => {
      console.log('    %s | %s ×%s%s | 领用人 %s(%s) | 班级 %s | %s | 用途 %s | 审批人 %s',
        r.no, r.itemName, r.qty, r.unit ? ' ' + r.unit : '',
        r.userName, r.user, r.cls || '(空)', r.status, r.reason || '-', r.approver || '-')
    })
    if (!list.length) console.log('    (无记录)')
  }

  // 1) 全部（admin 视角：full=true）
  const ds = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'data-scope.js'))
  ds.runWithScope ? null : null
  show('全部记录（未限定身份）', await cd.listClaims({ limit: 50 }))

  // 2) 按班级筛选
  const all = await cd.listClaims({ limit: 50 })
  const firstCls = (all.classOptions || [])[0]
  if (firstCls) {
    show('按班级筛选：' + firstCls, await cd.listClaims({ limit: 50, cls: firstCls }))
  }

  // 3) 按物品筛选
  show('按物品筛选 M001', await cd.listClaims({ limit: 50, item: 'M001' }))

  // 4) 按状态筛选
  show('按状态筛选 已通过', await cd.listClaims({ limit: 50, status: '已通过' }))

  // 5) 分页
  show('分页 limit=1', await cd.listClaims({ limit: 1, offset: 0 }))
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })

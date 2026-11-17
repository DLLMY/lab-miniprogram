'use strict'
// ============================================================================
// probe_online_version.js —— 只读探测「线上 docsProxy 实际运行的版本」
// ----------------------------------------------------------------------------
// 目的：判断本地这批改动（隔离引擎 / 幂等 / 输入边界 / 工具借还 / 交付单）
//       到底有多少已经落到线上云函数，而不是只看本地代码。
// 手段：直接调用线上云函数 docsProxy，读取其返回体里「新版才有」的字段，
//       并用「未注册 action」探测路由表是否已更新。
// 全程只读：不写任何业务数据。
// 用法：node tools/probe_online_version.js
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function loadCreds() {
  let c = {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'mcp.json'), 'utf8'))
    c = (((cfg.mcpServers || {})['lab-docs-proxy'] || {}).env || {})
  } catch (_) { /* 允许用环境变量 */ }
  const e = process.env
  return {
    ROBOT_KEY: (e.DOCS_PROXY_ROBOT_KEY || c.DOCS_PROXY_ROBOT_KEY || '').trim(),
    TCB_SECRET_ID: (e.TCB_SECRET_ID || c.TCB_SECRET_ID || '').trim(),
    TCB_SECRET_KEY: (e.TCB_SECRET_KEY || c.TCB_SECRET_KEY || '').trim(),
    TCB_ENV: (e.TCB_ENV || c.TCB_ENV || '').trim()
  }
}

function loadSdkInit() {
  const cands = [
    '@cloudbase/node-sdk',
    path.join(ROOT, 'mcp', 'node_modules', '@cloudbase', 'node-sdk')
  ]
  for (const c of cands) {
    try {
      const m = require(c)
      const init = (typeof m === 'function') ? m : m.init
      if (typeof init === 'function') return init
    } catch (_) { /* next */ }
  }
  return null
}

const NEW_ACTIONS = [
  'listDeliveries',   // 交付单列表（耗材/工具审批后发料）
  'confirmDelivery',  // 确认交付
  'addTool',          // 单件工具建档
  'adminUnbindUser'   // 工号解绑
]

async function call(app, action, robotKey) {
  const r = await app.callFunction({ name: 'docsProxy', data: { action, robotKey } })
  return (r && r.result) || {}
}

async function main() {
  const creds = loadCreds()
  const sdkInit = loadSdkInit()
  if (!sdkInit) { console.error('❌ 找不到 @cloudbase/node-sdk'); process.exit(2) }
  if (!creds.TCB_SECRET_ID || !creds.TCB_SECRET_KEY || !creds.TCB_ENV) {
    console.error('❌ 缺少 TCB 凭证'); process.exit(2)
  }
  if (!creds.ROBOT_KEY) { console.error('❌ 缺少 ROBOT_KEY'); process.exit(2) }

  console.log('云环境：%s', creds.TCB_ENV)
  const app = sdkInit({
    secretId: creds.TCB_SECRET_ID,
    secretKey: creds.TCB_SECRET_KEY,
    env: creds.TCB_ENV
  })

  const out = { backend: null, checks: [] }
  const mark = (name, ok, detail) => {
    out.checks.push({ name, ok, detail })
    console.log('  [%s] %s —— %s', ok ? '新' : '旧', name, detail)
  }

  // ── 1) diag：看新版诊断字段是否在线上存在 ──────────────────────────
  console.log('\n=== 1) 线上 diag 诊断字段 ===')
  try {
    const d = await call(app, 'diag', creds.ROBOT_KEY)
    const info = (d && d.data) || {}
    out.backend = info.backend || null
    console.log('  backend=%s dataBackend=%s useMock=%s ping=%s chain=%s',
      info.backend, info.dataBackend, info.useMock, info.ping, JSON.stringify(info.chain || []))
    mark('diag.accountAudit（账号体检）', !!info.accountAudit,
      info.accountAudit ? '已上线' : '线上无此字段 → 线上仍是旧版云函数')
    mark('diag.stockAudit（账实核对）', !!info.stockAudit,
      info.stockAudit ? '已上线' : '线上无此字段 → 线上仍是旧版云函数')
  } catch (e) {
    console.log('  diag 调用失败：%s', e.message || e)
    mark('diag 可调用', false, '调用异常：' + (e.message || e))
  }

  // ── 2) snapshot：是否回显 managedClasses（行级隔离生效前提） ────────
  console.log('\n=== 2) 线上 snapshot 是否回显 managedClasses ===')
  try {
    const s = await call(app, 'snapshot', creds.ROBOT_KEY)
    const users = (s && s.data && s.data.users) || []
    const has = users.some(u => Object.prototype.hasOwnProperty.call(u.fields || u, 'managedClasses'))
    mark('snapshot 回显 managedClasses', has,
      has ? '已上线' : '未回显 → 线上未部署新版')
  } catch (e) {
    mark('snapshot 可调用', false, '调用异常：' + (e.message || e))
  }

  // ── 3) 新 action 是否已注册（未注册会落到 unknown action） ─────────
  console.log('\n=== 3) 新 action 路由是否已注册（只读调用） ===')
  for (const a of NEW_ACTIONS) {
    try {
      const r = await call(app, a, creds.ROBOT_KEY)
      const msg = (r && (r.data && r.data.msg || r.msg)) || ''
      const isUnknown = /未知|unknown|不支持|not\s*found/i.test(String(msg))
      mark('action:' + a, !isUnknown, isUnknown ? '未注册（线上旧版）' : '已注册')
    } catch (e) {
      const m = String(e.message || e)
      const isUnknown = /未知|unknown|不支持|not\s*found|invalid action/i.test(m)
      mark('action:' + a, !isUnknown, isUnknown ? '未注册（线上旧版）' : '调用异常：' + m)
    }
  }

  console.log('\n=== 汇总 ===')
  const nw = out.checks.filter(c => c.ok).length
  console.log('  新版特征命中 %d/%d', nw, out.checks.length)
  console.log('  结论：%s', nw === 0
    ? '线上 docsProxy 仍为旧版本 —— 本地改动全部尚未部署'
    : '线上已部分含新版特性，需逐项核对')
  console.log('  ⚠ 本次为只读探测，未写入任何业务数据。')
}

main().catch(e => { console.error('💥', e.stack || e.message); process.exit(1) })

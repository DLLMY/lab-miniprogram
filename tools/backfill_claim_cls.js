'use strict'
// ============================================================================
// backfill_claim_cls.js —— 回填历史「领用出库流水」的归属班级
// ----------------------------------------------------------------------------
// 背景：审批通过时写 stock_io 出库流水，cls 此前取 scope.ownerCls（审批人=老师
// 的班级）而实际写成了空 → 学生领用流水不带班级，导致：
//   ① 老师无法按班级查"我班学生领用了什么"；
//   ② 行级隔离下这类行退化为「公共资源」，对所有老师可见。
// 本脚本按「流水的领用人」反查 users.cls 回填，只补空值，不覆盖已有值。
//
// 用法：
//   node tools/backfill_claim_cls.js            # 预演（dry-run，不写）
//   node tools/backfill_claim_cls.js --apply    # 实际写入
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')

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

function txt(v) {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object' ? (x.text || '') : String(x))).join('')
  if (typeof v === 'object') return String(v.text || '')
  return String(v)
}

async function main() {
  const creds = loadCreds()
  const init = loadSdkInit()
  if (!init || !creds.TCB_SECRET_ID) { console.log('❌ 缺 SDK 或凭证'); process.exit(1) }
  const app = init({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
  const db = app.database()

  const uRes = await db.collection('users').limit(500).get()
  const users = uRes.data || []
  const clsByUser = {}
  users.forEach(u => {
    const c = txt(u.cls).trim()
    if (c) clsByUser['' + (u.id || '').trim()] = c
  })
  console.log('用户档案中带班级的账号：%d / %d', Object.keys(clsByUser).length, users.length)

  const sRes = await db.collection('stock_io').limit(500).get()
  const rows = sRes.data || []
  console.log('出入库流水共 %d 行\n', rows.length)

  // 待回填：出库 + 来源是领用出库 + cls 为空 + 领用人能查到班级
  const todo = []
  rows.forEach(r => {
    const src = txt(r.src).trim()
    const dir = txt(r.dir).trim()
    const cls = txt(r.cls).trim()
    if (cls) return                       // 已有班级，不动
    if (dir !== '出库') return
    if (src !== '领用出库') return         // 只处理领用出库，其他出库（手动/冲销）语义不同
    const op = txt(r.op).trim()
    const c = clsByUser[op]
    if (!c) return
    // doc() 的参数是文档 _id（不是业务字段 id）；必须一并记下 _id
    todo.push({ _id: r._id, id: txt(r.id).trim(), op, want: c, note: txt(r.note).trim() })
  })

  console.log('待回填 %d 行\n', todo.length)
  todo.forEach(t => console.log('  ' + t.id.padEnd(22) + '领用人 ' + t.op.padEnd(12) + '→ ' + t.want + '   ' + t.note))
  if (!todo.length) { console.log('✅ 无需回填'); return }

  if (!APPLY) {
    console.log('\nℹ️ 预演模式，未写入。确认后执行：node tools/backfill_claim_cls.js --apply')
    return
  }

  // 实际写入前先备份 stock_io
  const bak = path.join(ROOT, 'tools', 'backup_stock_io_cls_' + Date.now() + '.json')
  fs.writeFileSync(bak, JSON.stringify(rows, null, 2), 'utf8')
  console.log('已备份 %d 行 → %s', rows.length, bak)

  let ok = 0
  let fail = 0
  for (const t of todo) {
    try {
      // Node SDK 的 doc().update() 直接接收顶层字段对象（不是 {data:{...}}）
      // doc() 的参数必须是文档 _id（云库自动生成的 32 位十六进制串），不是业务字段 id
      await db.collection('stock_io').doc(t._id).update({ cls: t.want })
      ok++
      console.log('  ✅ %s → %s', t.id, t.want)
    } catch (e) {
      fail++
      console.log('  ❌ %s 失败：%s', t.id, e.message || e)
    }
  }
  console.log('\n回填完成：成功 %d / 失败 %d', ok, fail)

  // 回读校验：不能只看 update 的返回值，必须确认数据真的变了
  const check = await db.collection('stock_io').limit(500).get()
  let stillEmpty = 0
  todo.forEach(t => {
    const row = (check.data || []).find(x => txt(x.id).trim() === t.id)
    const got = row ? txt(row.cls).trim() : ''
    if (got !== t.want) { stillEmpty++; console.log('  ❌ 校验不通过 %s：期望 %s，实际 %s', t.id, t.want, got || '(空)') }
  })
  if (stillEmpty) {
    console.log('\n⚠️ 仍有 %d 行未生效，请检查写入方式', stillEmpty)
    process.exitCode = 1
  } else {
    console.log('✅ 回读校验通过：%d 行班级已正确写入', todo.length)
  }
  if (fail) process.exitCode = 1
}

main().catch(e => { console.error(e.stack || e); process.exit(1) })

'use strict'
// ============================================================================
// MCP 连接器 · 双传输层（HTTP / CloudBase SDK 直连）回归测试
// ----------------------------------------------------------------------------
// 用 stub 模式（LAB_MCP_TRANSPORT=stub + LAB_MCP_STUB_FILE）模拟「SDK 直连」的
// 回包形态（云函数 main 无 httpMethod 时直接返回 {code,data,...} 信封），驱动真实
// 连接器 docs-proxy-server.js 走完整 JSON-RPC 流程，验证：
//   1) 读/诊断：SDK 信封 {code:0,data} 被正确处理为文本
//   2) L1 写确认门：lab_write 首调只回确认码、不执行；lab_confirm 二次调用才写
//   3) 白名单 fail-closed：非白名单动作被连接器直接拒绝（不到后端）
//   4) 无传输配置：未设 SDK 凭据也未设 HTTP_URL 时返回友好报错，不崩溃
// 同时单独验证「SDK 直连缺配置」分支立即返回错误（不触网）。
//
// 用法：node tools/test-mcp-transports.js
// ============================================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SERVER = path.join(__dirname, '..', 'mcp', 'docs-proxy-server.js')
const STUB_FILE = path.join(os.tmpdir(), 'lab-mcp-stub-' + process.pid + '.json')
function setStub(obj) { fs.writeFileSync(STUB_FILE, JSON.stringify(obj)) }

let pass = 0, fail = 0
function A(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')) }
}

// 启动一个 stub 模式的连接器
function startConnector(extraEnv) {
  const env = Object.assign({}, process.env, {
    LAB_MCP_TRANSPORT: 'stub',
    LAB_MCP_STUB_FILE: STUB_FILE,
    DOCS_PROXY_ROBOT_KEY: 'testkey'
  }, extraEnv || {})
  const child = spawn('node', [SERVER], { env, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = {}
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id && pending[msg.id]) { const cb = pending[msg.id]; delete pending[msg.id]; cb(msg) }
    }
  })
  const call = (method, params, id) => new Promise(res => { pending[id] = res; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const textOf = (r) => (r.result && r.result.content && r.result.content[0].text) || (r.error && r.error.message) || ''
  return { child, call, textOf }
}

async function run() {
  // —— 阶段 1：stub 模拟 SDK 直连全链路 ——
  const { child, call, textOf } = startConnector()
  await call('initialize', {}, 1)
  await call('tools/list', {}, 2)

  // 1) 诊断：SDK 信封 {code:0,data}
  setStub({ code: 0, data: { backend: 'cloud', src: 'sdk' } })
  const r1 = await call('tools/call', { name: 'lab_diag' }, 10)
  const t1 = textOf(r1)
  A('lab_diag：SDK 信封 {code:0,data} 正确处理为文本', /cloud/.test(t1), 'text=' + t1.slice(0, 50))

  // 2) L1 写确认门：首调只回确认码、不执行
  setStub({ code: 0, confirm: true, token: 'T1', summary: '将执行 io' })
  const r2 = await call('tools/call', { name: 'lab_write', arguments: { action: 'io', params: { labId: 'L001', qty: 5 } } }, 11)
  const t2 = textOf(r2)
  A('lab_write(io)：首调返回确认码且未真正执行', /确认码\s*C\w+/.test(t2) && /将执行 io/.test(t2), 'text=' + t2.slice(0, 50))

  // 3) 确认后执行：把 stub 换成"已执行"信封，连接器应读取它
  setStub({ code: 0, data: '已执行 io（操作人 T023）' })
  const r3 = await call('tools/call', { name: 'lab_confirm' }, 12)
  const t3 = textOf(r3)
  A('lab_confirm：二次调用真正执行并返回结果', /已执行 io/.test(t3) && /T023/.test(t3), 'text=' + t3.slice(0, 50))

  // 4) 白名单 fail-closed：非白名单动作被连接器直接拒绝
  const r4 = await call('tools/call', { name: 'lab_write', arguments: { action: 'migrate' } }, 13)
  const t4 = textOf(r4)
  A('lab_write(migrate)：被连接器白名单拒绝（不到后端）', /不在写操作白名单/.test(t4), 'text=' + t4.slice(0, 60))

  // 5) 无待确认时 lab_confirm 报错
  const r5 = await call('tools/call', { name: 'lab_confirm' }, 14)
  const t5 = textOf(r5)
  A('lab_confirm 无待确认时返回错误', /没有待确认的写操作/.test(t5), 'text=' + t5.slice(0, 40))

  child.kill()

  // —— 阶段 2：无任何传输配置 → 友好报错（不崩溃）——
  const { child: c2, call: call2, textOf: textOf2 } = startConnector({ LAB_MCP_TRANSPORT: '' })
  // 清掉可能从父进程继承的 URL/TCB 变量，确保"未配置"分支触发
  delete process.env.DOCS_PROXY_HTTP_URL
  await call2('initialize', {}, 1)
  setStub({ code: 0, data: 'x' })
  const r6 = await call2('tools/call', { name: 'lab_diag' }, 20)
  const t6 = textOf2(r6)
  A('无传输配置：返回友好报错而非崩溃', /未配置传输方式/.test(t6), 'text=' + t6.slice(0, 60))
  c2.kill()

  // —— 阶段 3：SDK 直连"缺配置"分支立即报错（不触网）——
  const { child: c3, call: call3, textOf: textOf3 } = startConnector({ LAB_MCP_TRANSPORT: 'sdk', TCB_SECRET_ID: 'AKIDxxxx' /* 缺 key/env */ })
  await call3('initialize', {}, 1)
  setStub({ code: 0, data: 'x' })
  const r7 = await call3('tools/call', { name: 'lab_diag' }, 30)
  const t7 = textOf3(r7)
  A('SDK 模式缺 TCB_SECRET_KEY/TCB_ENV：立即报错不触网', /SDK 直连缺少必要配置/.test(t7), 'text=' + t7.slice(0, 60))
  c3.kill()

  try { fs.unlinkSync(STUB_FILE) } catch (e) {}
  console.log('\npass=' + pass + ' fail=' + fail)
  process.exit(fail ? 1 : 0)
}
run()

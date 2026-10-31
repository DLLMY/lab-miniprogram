'use strict'
// ============================================================================
// L1 写操作二次确认门 · 端到端回归测试
// ----------------------------------------------------------------------------
// 启动一个「忠实的伪后端」模拟 docsProxy 的机器人通道（密钥哈希反查身份 +
// ROBOT_WRITE 闸门 + HMAC 确认令牌），再以子进程拉起真实连接器
// mcp/docs-proxy-server.js，通过 JSON-RPC 驱动 lab_write → lab_confirm 全流程，
// 验证：写操作首调只回确认码不执行、确认后才以教师本人身份执行、读操作直达、
// 非白名单动作被连接器拒绝、无待确认时 lab_confirm 报错。
//
// 用法：node tools/test-robot-write.js
// ============================================================================
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')
const path = require('path')

const PEPPER = 'lab-robot-key-v1'
const SUPER_KEY = 'test-global-robot-key'           // 等同云函数 ENV.ROBOT_KEY
const TEACHER_KEY = 'teacher-personal-key-123'      // 等同教师个人密钥
const hashKey = k => crypto.createHash('sha256').update(PEPPER + ':' + k).digest('hex')
const makeToken = (payload, action, params) =>
  crypto.createHmac('sha256', SUPER_KEY)
    .update(JSON.stringify({ a: action, p: params || {}, r: payload }))
    .digest('hex').slice(0, 24)

// 与后端 ROBOT_WRITE 对齐（连接器开放给教师的写动作全集）
const ROBOT_WRITE = new Set([
  'requisition', 'toolRequisition', 'cancelReq', 'io', 'borrow', 'returnTool',
  'approve', 'addMaterial', 'stocktake', 'addRepair', 'updateRepair',
  'addInspection', 'updateInspection'
])
// 教师个人密钥通道可执行的身份（teacher 通过全部 gStaff 闸门）
const teachers = { [hashKey(TEACHER_KEY)]: { id: 'T023', name: '王老师', role: 'teacher' } }

let executed = []   // 记录真正执行了的写操作（身份 + action）

const server = http.createServer((req, res) => {
  let b = ''
  req.on('data', c => b += c)
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(b) } catch (e) {}
    const action = body.action
    const rk = body.robotKey
    res.setHeader('Content-Type', 'application/json')
    // 身份解析（镜像 index.js robot 通道）
    let me = null
    if (rk === SUPER_KEY) me = { id: 'T001', name: '超管', role: 'super' }
    else if (rk) { const t = teachers[hashKey(rk)]; if (t) me = t }
    if (!me) { res.end(JSON.stringify({ code: 401, data: { msg: '机器人身份校验失败' } })); return }
    if (!ROBOT_WRITE.has(action)) { res.end(JSON.stringify({ code: 403, data: { msg: '该动作不在机器人写白名单' } })); return }
    // L1 二次确认闸门（镜像 prodHandler）
    const clean = Object.assign({}, body); delete clean.__confirm; delete clean.robotKey
    if (body.__confirm) {
      const expect = makeToken(hashKey(rk), action, clean)
      if (body.__confirm === expect) {
        executed.push({ id: me.id, action })
        res.end(JSON.stringify({ code: 0, data: '已执行 ' + action + '（操作人 ' + me.id + '）' })); return
      }
      res.end(JSON.stringify({ code: 403, data: { msg: '确认令牌无效或已过期，写操作未执行' } })); return
    }
    res.end(JSON.stringify({
      code: 0, confirm: true,
      token: makeToken(hashKey(rk), action, clean),
      summary: '【' + me.name + '(' + me.id + ')】将执行 ' + action,
      action, params: body
    }))
  })
})

// —— JSON-RPC 客户端（驱动真实连接器）——
function startConnector(port) {
  const env = Object.assign({}, process.env, {
    DOCS_PROXY_HTTP_URL: 'http://127.0.0.1:' + port + '/',
    DOCS_PROXY_ROBOT_KEY: TEACHER_KEY
  })
  const child = spawn('node', [path.join(__dirname, '..', 'mcp', 'docs-proxy-server.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] })
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
  return { child, call }
}

let pass = 0, fail = 0
function A(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')) }
}

server.listen(0, async () => {
  const port = server.address().port
  const { child, call } = startConnector(port)
  const WRITE_ACTIONS = ['requisition', 'toolRequisition', 'cancelReq', 'io', 'borrow', 'returnTool',
    'approve', 'addMaterial', 'stocktake', 'addRepair', 'updateRepair', 'addInspection', 'updateInspection']
  try {
    await call('initialize', {}, 1)
    // 每个写动作：首调仅确认、确认后执行
    for (const action of WRITE_ACTIONS) {
      executed = []
      const params = { sample: 'x', labId: 'L001', title: '测试' }
      const r1 = await call('tools/call', { name: 'lab_write', arguments: { action, params } }, 10 + WRITE_ACTIONS.indexOf(action) * 2)
      const t1 = (r1.result && r1.result.content && r1.result.content[0].text) || ''
      const hasCode = /确认码\s*(C\w+)/.test(t1)
      A('lab_write ' + action + ' 首调返回确认码且未执行', hasCode && executed.length === 0,
        'text=' + t1.slice(0, 40))
      const r2 = await call('tools/call', { name: 'lab_confirm' }, 11 + WRITE_ACTIONS.indexOf(action) * 2)
      const t2 = (r2.result && r2.result.content && r2.result.content[0].text) || ''
      A('lab_confirm ' + action + ' 以教师 T023 身份执行', /操作人 T023/.test(t2) && executed.length === 1,
        'text=' + t2.slice(0, 40))
    }
    // 读操作直达（无确认）
    executed = []
    const r3 = await call('tools/call', { name: 'lab_query', arguments: { action: 'alerts' } }, 90)
    const t3 = (r3.result && r3.result.content && r3.result.content[0].text) || ''
    A('lab_query(alerts) 读操作直达不触发确认', executed.length === 0 && t3.indexOf('确认码') < 0, 'text=' + t3.slice(0, 40))
    // 非白名单动作：连接器直接拒绝（fail-closed，不到后端）
    const r4 = await call('tools/call', { name: 'lab_write', arguments: { action: 'migrate' } }, 91)
    const t4 = (r4.result && r4.result.content && r4.result.content[0].text) || (r4.error && JSON.stringify(r4.error)) || ''
    A('lab_write(migrate) 被连接器白名单拒绝', /不在写操作白名单/.test(t4), 'text=' + t4.slice(0, 60))
    // 无待确认时 lab_confirm 报错
    const r5 = await call('tools/call', { name: 'lab_confirm' }, 92)
    const t5 = (r5.error && r5.error.message) || (r5.result && r5.result.content && r5.result.content[0].text) || ''
    A('lab_confirm 无待确认时返回错误', /没有待确认的写操作/.test(t5), 'text=' + t5.slice(0, 40))
    // 令牌篡改：直接 POST 错误令牌，后端必须 403（fail-closed 令牌校验）
    const crypto2 = crypto
    const badTok = crypto2.createHash('sha256').update('tampered').digest('hex').slice(0, 24)
    const postJson = (payload) => new Promise((resolve) => {
      const data = JSON.stringify(payload)
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let c = ''; res.on('data', x => c += x); res.on('end', () => resolve(JSON.parse(c)))
      }); req.write(data); req.end()
    })
    const bad = await postJson({ action: 'io', robotKey: TEACHER_KEY, __confirm: badTok })
    A('篡改确认令牌被后端拒绝（403）', bad.code === 403, 'code=' + bad.code)
  } catch (e) {
    fail++; console.error('  ❌ 测试异常：', e)
  } finally {
    child.kill(); server.close()
    console.log('\npass=' + pass + ' fail=' + fail)
    process.exit(fail ? 1 : 0)
  }
})

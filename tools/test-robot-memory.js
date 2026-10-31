'use strict'
// Phase 4 多轮记忆编排端到端测试：驱动真实连接器子进程，验证 lab_context / lab_forget。
// 用本地假后端响应只读/概览查询；lab_context/lab_forget 由连接器本地处理，不触后端。
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

const SUPER_KEY = 'test-robot-key'
const server = http.createServer((req, res) => {
  let b = ''
  req.on('data', c => (b += c))
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(b) } catch (e) {}
    res.setHeader('Content-Type', 'application/json')
    if (body.robotKey !== SUPER_KEY) { res.end(JSON.stringify({ code: 401, data: { msg: 'bad key' } })); return }
    if (body.__confirm) { res.end(JSON.stringify({ code: 0, data: 'confirmed' })); return }
    // 只读/概览一律成功返回，锚点由连接器从 params 提取
    res.end(JSON.stringify({ code: 0, data: 'OK action=' + body.action }))
  })
})

const asserts = []
function A(name, cond, extra) { asserts.push({ name, ok: !!cond }); if (!cond) console.error('  ✗ ' + name + '  ' + (extra || '')) }

server.listen(0, () => {
  const port = server.address().port
  const env = Object.assign({}, process.env, {
    DOCS_PROXY_HTTP_URL: 'http://127.0.0.1:' + port + '/',
    DOCS_PROXY_ROBOT_KEY: SUPER_KEY
  })
  const child = spawn('node', [path.join(__dirname, '..', 'mcp', 'docs-proxy-server.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const pending = {}
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch (e) { continue }
      if (msg.id && pending[msg.id]) { const cb = pending[msg.id]; delete pending[msg.id]; cb(msg) }
    }
  })
  const call = (method, params, id) => new Promise(res => { pending[id] = res; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const textOf = m => (m.result && m.result.content && m.result.content[0].text) || ''

  ;(async () => {
    await call('initialize', {}, 1)
    // 1) 查询 L001 报修，应写入实训室锚点
    let r = await call('tools/call', { name: 'lab_query', arguments: { action: 'listRepairs', params: { labId: 'L001' } } }, 2)
    A('lab_query L001 成功', !r.error && /OK/.test(textOf(r)))
    // 2) 读上下文，应含 实训室=L001
    r = await call('tools/call', { name: 'lab_context' }, 3)
    const c1 = textOf(r)
    A('lab_context 含锚点 实训室=L001', /实训室=L001/.test(c1), 'ctx=' + c1.slice(0, 60))
    // 3) 再查关键词物料，锚点应叠加
    r = await call('tools/call', { name: 'lab_query', arguments: { action: 'listMaterials', params: { keyword: '电阻' } } }, 4)
    A('lab_query 物料成功', !r.error)
    r = await call('tools/call', { name: 'lab_context' }, 5)
    const c2 = textOf(r)
    A('lab_context 叠加 物料关键词=电阻', /物料关键词=电阻/.test(c2), 'ctx=' + c2.slice(0, 80))
    A('lab_context 仍保留 实训室=L001', /实训室=L001/.test(c2))
    // 4) 空参数查询不应清除已有锚点
    r = await call('tools/call', { name: 'lab_query', arguments: { action: 'listLabs' } }, 6)
    r = await call('tools/call', { name: 'lab_context' }, 7)
    A('空参数查询不清除锚点', /实训室=L001/.test(textOf(r)))
    // 5) 清除记忆
    r = await call('tools/call', { name: 'lab_forget' }, 8)
    A('lab_forget 成功', !r.error)
    r = await call('tools/call', { name: 'lab_context' }, 9)
    A('清除后 实训室=L001 不再出现', !/实训室=L001/.test(textOf(r)), 'ctx=' + textOf(r).slice(0, 40))
    // 6) 隐私红线：上下文不应含 robotKey
    A('上下文不含 robotKey（隐私）', !/ROBOT_KEY|test-robot-key/.test(c2))

    child.kill()
    server.close()
    const passed = asserts.filter(a => a.ok).length
    console.log('\nPhase4 多轮记忆: ' + passed + '/' + asserts.length + ' 通过')
    process.exit(passed === asserts.length ? 0 : 1)
  })()
})

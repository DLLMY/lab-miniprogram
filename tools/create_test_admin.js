'use strict'
// ============================================================================
// create_test_admin.js —— 在「阿磊的工具箱」云函数里新建一个账号
// ----------------------------------------------------------------------------
// 走云函数「可信机器通道 · 应急超级通道」(robotKey === 全局 ROBOT_KEY)，
// 自动以 ROBOT_ACTOR_ID 对应的管理员身份执行 adminUpsertUser。
//
// adminUpsertUser 属于 ROBOT_WRITE 写操作，经此通道需「二次确认」：
//   第 1 次调用 → 返回 {code:0, confirm:true, token, summary}
//   第 2 次调用（带 __confirm=token）→ 真正写入
// 本脚本自动完成两段式握手，无需手动处理。
//
// 传输方式（与 mcp/docs-proxy-server.js 完全一致，自动择优）：
//   • SDK 直连：需 TCB_SECRET_ID / TCB_SECRET_KEY / TCB_ENV
//   • HTTP 触发：需 DOCS_PROXY_HTTP_URL
//   凭据通过环境变量提供，不在脚本里硬编码。
//
// 用法：
//   DOCS_PROXY_HTTP_URL=https://<你的HTTP触发URL> \
//   DOCS_PROXY_ROBOT_KEY=<全局ROBOT_KEY> \
//   node tools/create_test_admin.js
//
//   自定义字段：
//   node tools/create_test_admin.js --id T100 --name "test李" --role admin
// ============================================================================

const http = require('http')
const https = require('https')
const { URL } = require('url')

// —— 目标账号（默认值，可用命令行参数覆盖）——
const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const TARGET = {
  id: (arg('id', 'T100') || '').trim().toUpperCase(),
  name: (arg('name', 'test李') || '').trim(),
  role: (arg('role', 'admin') || '').trim().toLowerCase(),
  cls: (arg('cls', '') || '').trim(),
  status: (arg('status', '启用') || '').trim() || '启用'
}

// —— 凭据（仅来自环境变量）——
const HTTP_URL = (process.env.DOCS_PROXY_HTTP_URL || '').trim()
const ROBOT_KEY = (process.env.DOCS_PROXY_ROBOT_KEY || '').trim()
const TCB_SECRET_ID = (process.env.TCB_SECRET_ID || '').trim()
const TCB_SECRET_KEY = (process.env.TCB_SECRET_KEY || '').trim()
const TCB_ENV = (process.env.TCB_ENV || '').trim()
const TRANSPORT = (process.env.LAB_MCP_TRANSPORT || '').trim().toLowerCase()

function postJson(url, bodyObj) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('HTTP_URL 非法: ' + url)) }
    const data = JSON.stringify(bodyObj)
    const lib = u.protocol === 'https:' ? https : http
    const port = u.port || (u.protocol === 'https:' ? 443 : 80)
    const req = lib.request({
      hostname: u.hostname, port,
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(chunks) } catch (e) { return reject(new Error('云函数响应非 JSON: ' + chunks.slice(0, 200))) }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('请求云函数超时(15s)')))
    req.write(data); req.end()
  })
}

async function invokeProxy(payload) {
  if (TRANSPORT === 'sdk' || (!TRANSPORT && TCB_SECRET_ID && TCB_SECRET_KEY && TCB_ENV)) {
    let init
    try {
      const sdk = require('@cloudbase/node-sdk')
      init = (typeof sdk === 'function') ? sdk : sdk.init
      if (typeof init !== 'function') throw new Error('SDK 导出既非函数也无 init 方法')
    } catch (e) { return { error: '未安装/不兼容 @cloudbase/node-sdk，无法 SDK 直连：' + e.message } }
    const app = init({ secretId: TCB_SECRET_ID, secretKey: TCB_SECRET_KEY, env: TCB_ENV })
    const res = await app.callFunction({ name: 'docsProxy', data: payload })
    if (res && Object.prototype.hasOwnProperty.call(res, 'result')) {
      return (res.result && typeof res.result === 'object') ? res.result : { code: 0, data: res.result }
    }
    return { error: 'TCB 调用失败: ' + JSON.stringify(res).slice(0, 200) }
  }
  if (TRANSPORT === 'http' || (!TRANSPORT && HTTP_URL)) {
    if (!HTTP_URL) return { error: '未配置 DOCS_PROXY_HTTP_URL' }
    const resp = await postJson(HTTP_URL, payload)
    return resp.body || {}
  }
  return { error: '未配置传输方式：请设置 DOCS_PROXY_HTTP_URL（HTTP 触发）或 TCB_SECRET_ID/TCB_SECRET_KEY/TCB_ENV（SDK 直连）。' }
}

async function main() {
  console.log('目标账号：', JSON.stringify(TARGET))
  if (!TARGET.id || !TARGET.name) { console.error('❌ 工号和姓名必填'); process.exit(2) }
  if (['student', 'teacher', 'admin', 'super'].indexOf(TARGET.role) < 0) {
    console.error('❌ 角色非法（应为 student/teacher/admin/super）'); process.exit(2)
  }
  if (!ROBOT_KEY) { console.error('❌ 未设置 DOCS_PROXY_ROBOT_KEY（全局超级钥匙）'); process.exit(2) }

  // 第 1 段：发起写操作，拿确认令牌
  const first = await invokeProxy(Object.assign({}, TARGET, { action: 'adminUpsertUser', robotKey: ROBOT_KEY }))
  if (first.error) { console.error('❌ 调用失败：', first.error); process.exit(1) }
  if (first.code === 0 && first.confirm === true) {
    console.log('· 已收到写操作确认摘要：', first.summary || '(无摘要)')
    // 第 2 段：携令牌真正写入
    const second = await invokeProxy(Object.assign({}, TARGET, {
      action: 'adminUpsertUser', robotKey: ROBOT_KEY, __confirm: first.token
    }))
    if (second.error) { console.error('❌ 确认写入失败：', second.error); process.exit(1) }
    if (second.code === 0) { console.log('✅ 账号已创建/更新：', JSON.stringify(second.data || {})); return }
    console.error('❌ 确认写入返回异常：', JSON.stringify(second).slice(0, 300)); process.exit(1)
  }
  // 非二次确认路径（如通道未启用二次确认）：直接看结果
  if (first.code === 0) { console.log('✅ 账号已创建/更新：', JSON.stringify(first.data || {})); return }
  console.error('❌ 云函数返回：', JSON.stringify(first).slice(0, 400)); process.exit(1)
}

main().catch(e => { console.error('💥 异常：', e.message); process.exit(1) })

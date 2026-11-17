'use strict'
// ============================================================================
// clear_all_data.js —— 清空线上云数据库/腾讯文档的全库业务数据（super 专属，高危不可逆）
// ----------------------------------------------------------------------------
// 用途：录入真实数据前，把历史演示/走查测试数据一次性清干净。
//
// 安全设计（务必理解再执行）：
//   ① 经云函数「机器人超级通道」(robotKey === 全局 ROBOT_KEY，身份=ROBOT_ACTOR_ID/super) 调用；
//      普通教师密钥、微信端均无法调用（后端 gSuper + robotMode==='super' 双重拦截）。
//   ② 属于写操作，必经 L1 二次确认：第 1 次拿摘要+令牌，第 2 次携令牌才真正删除。
//   ③ 默认【保留 users 表】——否则会把执行清库的 super 账号自身删掉，导致无人可登录。
//      只有显式加 --include-users 才会连用户表一起清（清完必须重新建 super 账号）。
//
// 传输方式（与 create_test_admin.js 完全一致，自动择优）：
//   • SDK 直连：需 TCB_SECRET_ID / TCB_SECRET_KEY / TCB_ENV
//   • HTTP 触发：需 DOCS_PROXY_HTTP_URL
//
// 用法：
//   DOCS_PROXY_HTTP_URL=https://<你的HTTP触发URL> \
//   DOCS_PROXY_ROBOT_KEY=<全局ROBOT_KEY> \
//   node tools/clear_all_data.js
//
//   连用户表一起清（危险，清完无法登录）：
//   node tools/clear_all_data.js --include-users
//
//   —— 强烈建议：执行前先调用 snapshot 备份全库（脚本默认会先拉快照并提示）——
// ============================================================================

const http = require('http')
const https = require('https')
const { URL } = require('url')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const has = (name) => argv.indexOf('--' + name) >= 0
const INCLUDE_USERS = has('include-users')
const SKIP_BACKUP = has('no-backup')

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
    req.setTimeout(30000, () => req.destroy(new Error('请求云函数超时(30s)')))
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
  console.log('\n============================================================')
  console.log(' ⚠️  高危操作：清空线上全库业务数据（不可逆）')
  console.log('    用户表：' + (INCLUDE_USERS ? '❌ 将一并清空（清完无法登录！）' : '✅ 保留'))
  console.log('============================================================\n')
  if (!ROBOT_KEY) { console.error('❌ 未设置 DOCS_PROXY_ROBOT_KEY（全局超级钥匙）'); process.exit(2) }

  // 步骤 0：拉快照备份（默认执行，--no-backup 可跳过）
  if (!SKIP_BACKUP) {
    console.log('· 正在拉取全库快照备份…')
    const snap = await invokeProxy({ action: 'snapshot', robotKey: ROBOT_KEY })
    if (snap && snap.code === 0 && snap.data) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = path.join(__dirname, 'backup_' + stamp + '.json')
      fs.writeFileSync(file, JSON.stringify(snap.data, null, 2), 'utf8')
      console.log('✅ 快照已备份到：' + file)
    } else {
      console.error('❌ 快照备份失败，已中止清库（防止无备份误删）：', JSON.stringify(snap).slice(0, 300))
      process.exit(1)
    }
  } else {
    console.warn('⚠ 已跳过备份（--no-backup），请确认你已有其他备份手段！')
  }

  const params = { action: 'clearAllData', robotKey: ROBOT_KEY, includeUsers: INCLUDE_USERS }

  // 第 1 段：拿二次确认摘要+令牌（不真正删除）
  console.log('· 请求清库确认令牌…')
  const first = await invokeProxy(Object.assign({}, params))
  if (first.error) { console.error('❌ 调用失败：', first.error); process.exit(1) }
  if (first.code === 0 && first.confirm === true) {
    console.log('\n>>> 后端确认摘要：' + (first.summary || '(无摘要)'))
    console.log('>>> 5 秒后携令牌执行真正删除…（Ctrl+C 可中止）\n')
    await new Promise(r => setTimeout(r, 5000))
    const second = await invokeProxy(Object.assign({}, params, { __confirm: first.token }))
    if (second.error) { console.error('❌ 确认清库失败：', second.error); process.exit(1) }
    if (second.code === 0) {
      const d = second.data || {}
      console.log('✅ 清库完成：共删除 ' + (d.total != null ? d.total : '?') + ' 行')
      console.log('   各表明细：' + JSON.stringify(d.cleared || {}))
      if ((d.skipped || []).length) console.log('   已保留：' + d.skipped.join(', '))
      if ((d.errors || []).length) console.warn('   ⚠ 部分表失败：' + JSON.stringify(d.errors))
      return
    }
    console.error('❌ 确认清库返回异常：', JSON.stringify(second).slice(0, 400)); process.exit(1)
  }
  if (first.code === 0) { console.log('✅ 清库返回：', JSON.stringify(first.data || {})); return }
  console.error('❌ 云函数返回：', JSON.stringify(first).slice(0, 400)); process.exit(1)
}

main().catch(e => { console.error('💥 异常：', e.message); process.exit(1) })

'use strict'
// ============================================================================
// diag-sdk.js —— 本地连通性联调（与 mcp/docs-proxy-server.js 的 SDK 调用路径逐字一致）
// ----------------------------------------------------------------------------
// 用途：在不启动 WorkBuddy 的情况下，直接用 @cloudbase/node-sdk 的 callFunction
//       调一次 docsProxy 的 diag，验证「账号选对没 / 密钥通不通 / 环境可达」。
//       与服务端 invokeSdk() 完全同构：app.callFunction({ name:'docsProxy', data:{action,robotKey} })
//
// 凭据来源（二选一，优先环境变量）：
//   ① 环境变量 TCB_SECRET_ID / TCB_SECRET_KEY / TCB_ENV / DOCS_PROXY_ROBOT_KEY
//   ② 本地文件 mcp/diag.local（JSON，已被 .gitignore 的 *.local 忽略，不会入库）
//       内容：{ "secretId":"...", "secretKey":"...", "env":"cloud1-xxxxxxxx", "robotKey":"..." }
// ============================================================================
const fs = require('fs')
const path = require('path')

function loadCreds() {
  const env = {
    secretId: (process.env.TCB_SECRET_ID || '').trim(),
    secretKey: (process.env.TCB_SECRET_KEY || '').trim(),
    env: (process.env.TCB_ENV || '').trim(),
    robotKey: (process.env.DOCS_PROXY_ROBOT_KEY || '').trim()
  }
  if (env.secretId && env.secretKey && env.env && env.robotKey) return { src: '环境变量', ...env }
  const f = path.join(__dirname, '..', 'mcp', 'diag.local')
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return {
      src: 'mcp/diag.local',
      secretId: (j.secretId || '').trim(),
      secretKey: (j.secretKey || '').trim(),
      env: (j.env || '').trim(),
      robotKey: (j.robotKey || '').trim()
    }
  } catch (e) {
    return env
  }
}

async function main() {
  const c = loadCreds()
  if (!c.secretId || !c.secretKey || !c.env) {
    console.error('✗ 缺少 TCB 配置：请设置环境变量 TCB_SECRET_ID/TCB_SECRET_KEY/TCB_ENV，或在 mcp/diag.local 填写。')
    process.exit(2)
  }
  if (!c.robotKey) {
    console.error('✗ 缺少 DOCS_PROXY_ROBOT_KEY：diag 需要带一个有效 robotKey（可用控制台 ROBOT_KEY 应急值先做连通测试）。')
    process.exit(2)
  }

  let tcb
  try {
    tcb = require(path.join(__dirname, '..', 'mcp', 'node_modules', '@cloudbase', 'node-sdk'))
  } catch (e) {
    console.error('✗ 未安装 @cloudbase/node-sdk：请在 mcp/ 目录执行 npm install @cloudbase/node-sdk。')
    process.exit(2)
  }

  console.log('凭据来源：', c.src)
  console.log('目标环境：', c.env)
  console.log('调用 action=diag ...\n')

  try {
    const app = tcb.init({ secretId: c.secretId, secretKey: c.secretKey, env: c.env })
    const res = await app.callFunction({ name: 'docsProxy', data: { action: 'diag', robotKey: c.robotKey } })

    // SDK 返回 { result, requestId }，result 即云函数 main 的返回值 {code,data,...}
    const r = (res && Object.prototype.hasOwnProperty.call(res, 'result'))
      ? (res.result && typeof res.result === 'object' ? res.result : { code: 0, data: res.result })
      : null

    if (!r) {
      console.error('✗ TCB 返回结构异常：', JSON.stringify(res).slice(0, 300))
      process.exit(1)
    }
    if (r.code !== 0) {
      console.error('✗ 云函数返回非零 code=' + r.code)
      console.error('  详情：', JSON.stringify(r.data || r, null, 2).slice(0, 500))
      if (/环境不存在|无权限|ResourceNotFound|AuthFailure|not found|denied/i.test(JSON.stringify(r))) {
        console.error('\n⮕ 判断：多半是「腾讯云账号选错了」——你登录的是另一个小程序自动创建的账号，里面没有 cloud1。')
        console.error('   换另一个腾讯云账号重做「访问管理 → API 密钥管理 → 新建密钥」，再用新密钥跑本脚本。')
      }
      process.exit(1)
    }
    console.log('✓ 连通成功！返回信封 code=0')
    console.log('  后端：', r.backend, '| 来源：', r.src, '| 回退：', r.fallback ? '是' : '否')
    console.log('  诊断数据：', JSON.stringify(r.data, null, 2).slice(0, 800))
    console.log('\n⮕ 下一步：把同样的 TCB_SECRET_ID/KEY/ENV + 你的个人 robotKey 填进 WorkBuddy 的 mcp.json，重启连接器即可用自然语言操作。')
  } catch (e) {
    console.error('✗ TCB SDK 调用异常：', e.message)
    const m = e.message || ''
    if (/ResourceNotFound|EnvNotFound|环境不存在|无权限|AuthFailure|denied|not found/i.test(m)) {
      console.error('\n⮕ 判断：腾讯云账号选错了——该账号下没有 cloud1 环境。换另一个账号重做密钥。')
    } else if (/SecretId|SecretKey|签名|signature|鉴权|Auth/i.test(m)) {
      console.error('\n⮕ 判断：SecretId/SecretKey 不对或已失效，重新在「API 密钥管理」新建一对。')
    } else if (/timeout|超时|ETIMEDOUT|ENOTFOUND|network/i.test(m)) {
      console.error('\n⮕ 判断：网络不通（本机需能访问腾讯云 API，必要时走代理）。')
    }
    process.exit(1)
  }
}

main()

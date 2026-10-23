// tools/test-conn.js
// 验证凭证是否真能读到《数据底座》智能表格（v2 API）。
//
// 用法（个人开发者凭证模型）：
//   1) 复制 tools/.env.local.example 为 tools/.env.local
//   2) 填入 FILE_ID / CLIENT_ID / ACCESS_TOKEN / OPEN_ID 四项
//   3) node tools/test-conn.js
//
// 退出码：0 = 读通（可上线）；1 = 失败（多半凭证/账号无权限，需路径 A 重建）。

const fs = require('fs')
const path = require('path')

// 先加载 .env.local —— 必须在 require tencentdocs 之前，
// 因为适配器在模块加载时就把 process.env 读进 CFG 了。
;(function loadEnv() {
  const f = path.join(__dirname, '.env.local')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const k = m[1]
    const v = m[2].replace(/^["']|["']$/g, '')
    if (process.env[k] === undefined) process.env[k] = v // 已存在的环境变量优先
  }
})()

const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  const hasDirect = !!process.env.TENCENT_DOCS_ACCESS_TOKEN
  const hasOAuth = !!(process.env.TENCENT_DOCS_CLIENT_SECRET && process.env.TENCENT_DOCS_REFRESH_TOKEN)
  const need = ['TENCENT_DOCS_FILE_ID', 'TENCENT_DOCS_CLIENT_ID', 'TENCENT_DOCS_OPEN_ID']
  const miss = need.filter(k => !process.env[k])

  if (miss.length || (!hasDirect && !hasOAuth)) {
    if (miss.length) console.error('缺少环境变量：', miss.join(', '))
    if (!hasDirect && !hasOAuth) {
      console.error('缺少凭证：请设 TENCENT_DOCS_ACCESS_TOKEN（个人开发者凭证），')
      console.error('          或 TENCENT_DOCS_CLIENT_SECRET + TENCENT_DOCS_REFRESH_TOKEN（企业 OAuth）。')
    }
    console.error('→ 可复制 tools/.env.local.example 为 tools/.env.local 填写后重跑。')
    process.exit(1)
  }

  console.log('凭证模型：', hasDirect ? '个人开发者 access_token（直连）' : '企业应用 OAuth refresh_token')
  console.log('FILE_ID：', process.env.TENCENT_DOCS_FILE_ID)
  console.log('CLIENT_ID：', process.env.TENCENT_DOCS_CLIENT_ID, '\n')

  try {
    const list = await td.listMaterials()
    console.log('✅ 连通成功！materials 表读取到', list.length, '条，前 3 条：')
    console.log(JSON.stringify(list.slice(0, 3), null, 2))
    console.log('\n→ 把 .env.local 里这四项原样填进云函数环境变量，USE_MOCK 置 false 即可上线：')
    console.log('   TENCENT_DOCS_FILE_ID / TENCENT_DOCS_CLIENT_ID / TENCENT_DOCS_ACCESS_TOKEN / TENCENT_DOCS_OPEN_ID')
    process.exit(0)
  } catch (e) {
    console.error('\n❌ 读取失败：', e.message)
    console.error('→ 若是 403/无权限：该文档可能不在此凭证对应账号下，需改走路径 A')
    console.error('   （node tools/bootstrap-schema.js 在你自己账号重建 8 表，再用新 sheet_id 覆盖 TABLE）。')
    process.exit(1)
  }
})()

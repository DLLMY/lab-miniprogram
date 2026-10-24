// tencentdocs.js —— 腾讯文档（智能表格）适配器
// ============================================================
// 本文件把云函数 docsProxy 与腾讯文档开放平台 API 解耦。
// 生产路径（index.js 中 USE_MOCK=false）下，index.js 只调用本文件的业务函数，
// 不直接碰 HTTP / token / 限频等细节。
//
// 关键约定（与前端 / mock.js 完全一致，保证填了凭证即可无缝切换）：
//   • 前端发来的字段用英文名：user / matId / toolId / qty / ok(bool) / actor / no / type(in|out)
//   • 返回给前端的对象也与 mock.js 同形（material/tool 形状、申请英文状态等）
//   • 腾讯文档里列名与状态用中文（人读友好）；本文件负责中英翻译
//
// ✅ 官方 v2 契约（2026-10 按 docs.qq.com/open/document/app/openapi/v2 核实）：
//   • 请求头：Access-Token / Client-Id / Open-Id（不是 Authorization: Bearer！）
//   • 请求体：{ "<action>": <params> }，如 { "getRecords": { "offset":0, "limit":100 } }
//   • 响应体：{ ret:0, msg:'Succeed', data:{ "<action>": {...} } }
//   • 记录结构：{ recordID, values:{ 列名: 值 } }；文本值为 [{type:'text',text}] 数组
//
// 云函数【环境变量】两种凭证模型，任选其一：
//
// ① 个人开发者凭证（最简单，推荐；开放平台「首页 → 开发者信息」直接给三项）
//   TENCENT_DOCS_FILE_ID        —— 智能表格 API file_id（本仓库 = DDJvsIIuHZKh，注意不是浏览器网址那段）
//   TENCENT_DOCS_CLIENT_ID      —— 控制台 client_id（应用ID）
//   TENCENT_DOCS_ACCESS_TOKEN   —— 控制台 access_token（30 天有效；到期点「重置」后更新此变量）
//   TENCENT_DOCS_OPEN_ID        —— 控制台 open_id
//
// ② 企业应用 OAuth（需自建应用 + HTTPS 回调，走授权码换 token）
//   TENCENT_DOCS_CLIENT_ID / TENCENT_DOCS_CLIENT_SECRET / TENCENT_DOCS_REFRESH_TOKEN /
//   TENCENT_DOCS_OPEN_ID（= token 回包 user_id） / TENCENT_DOCS_REDIRECT_URI / TENCENT_DOCS_FILE_ID
//
// 端点（2026-10 核实）：
//   授权：GET https://docs.qq.com/oauth/v2/authorize
//   换/刷：GET https://docs.qq.com/oauth/v2/token
//   智能表格：POST https://docs.qq.com/openapi/smartbook/v2/files/{fileID}/sheets[/{sheetID}]
// ============================================================

// 表 ID 来自腾讯文档·智能表格《实训室管理系统数据底座》。
// ✅ 走"授权给自有应用"路径：同一份文档、同一账号授权，下方 8 个 sheet_id 原样保留，不用改。
// ⚠️ 只有"在你账号下重新建表"时，才需要用 tools/bootstrap-schema.js 输出的新 sheet_id 覆盖下方。
const TABLE = {
  users: 'tyR05n',
  materials: 't2KB8x',
  tools: 'ti1nff',
  requisitions: 'tJOBvr',
  borrow: 'tX2nVn',
  stock_io: 'tAgqo0',
  access: 'tCvzwQ',
  logs: 'tzomXO'
}

// ---- 配置（极少需要改；如平台调整 action / 字段结构，集中在此调）----
// 注意：智能表格 smartbook API 的 fileID 必须带命名空间前缀（drive 元数据返回的 ID 形如
// "300000000$DDJvsIIuHZKh"），而很多地方（URL、建表脚本）只用短 id "DDJvsIIuHZKh"。
// 这里做归一化：若环境变量给的是短 id，自动补 "300000000$" 前缀，避免 smartbook 报 200063。
function normFileId(id) {
  if (!id) return ''
  return id.includes('$') ? id : '300000000$' + id
}

// ---- 可选兜底：云函数目录下的 env.local.js（不入仓库）----
// 用途：控制台「配置云函数 → 环境变量」保存失败/一直转圈时的应急通道。
// 规则：**只补 process.env 里缺失的键**，绝不覆盖 —— 控制台配成功的值永远优先，
//      所以这份文件即使过期也不会盖掉控制台的新 token；控制台修好后可直接删掉本文件。
try {
  const local = require('./env.local.js') // eslint-disable-line
  if (local && typeof local === 'object') {
    const filled = []
    Object.keys(local).forEach((k) => {
      const v = local[k]
      if (v === undefined || v === null || v === '') return
      if (process.env[k] === undefined || process.env[k] === '') {   // 仅补缺失
        process.env[k] = String(v)
        filled.push(k)
      }
    })
    if (filled.length) console.log('[tencentdocs] 环境变量自 env.local.js 补齐：', filled.join(', '))
  }
} catch (e) {
  // 没有 env.local.js 属正常情况，静默跳过
}

// ---- 运行态自检（供云函数 diag 接口用；只回显"是否就绪"，不泄露完整密钥）----
function mask(v) {
  if (!v) return ''
  return v.length <= 10 ? v.slice(0, 2) + '****' : v.slice(0, 6) + '****' + v.slice(-4)
}
// 从 JWT 里解出到期时间（access_token 是 JWT，payload.exp 是秒级时间戳）
function tokenExp() {
  try {
    const p = String(process.env.TENCENT_DOCS_ACCESS_TOKEN || '').split('.')[1]
    if (!p) return ''
    const json = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    if (!json || !json.exp) return ''
    // 云函数运行时时区通常是 UTC，而用户看的是北京时间：
    // 固定按 UTC+8 渲染，避免出现「云端 09:44 / 本地 17:44」的同一时刻两种显示。
    const d = new Date(json.exp * 1000 + 8 * 3600 * 1000)
    const pad = n => ('' + n).padStart(2, '0')
    return d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
  } catch (e) { return '' }
}
function runtimeInfo() {
  return {
    node: process.version,
    envUseMock: process.env.USE_MOCK === undefined ? '(未设置)' : String(process.env.USE_MOCK),
    fileId: CFG.FILE_ID || '(空)',
    clientId: mask(CFG.CLIENT_ID),
    accessToken: mask(CFG.ACCESS_TOKEN),
    openId: mask(CFG.OPEN_ID),
    tokenExp: tokenExp() || '(无法解析)',
    hasFetch: typeof fetch === 'function'
  }
}

const CFG = {
  BASE: 'https://docs.qq.com/openapi/smartbook/v2',
  TOKEN_URL: 'https://docs.qq.com/oauth/v2/token',
  FILE_ID: normFileId(process.env.TENCENT_DOCS_FILE_ID || ''),
  CLIENT_ID: process.env.TENCENT_DOCS_CLIENT_ID || '',
  CLIENT_SECRET: process.env.TENCENT_DOCS_CLIENT_SECRET || '',
  REFRESH_TOKEN: process.env.TENCENT_DOCS_REFRESH_TOKEN || '',
  ACCESS_TOKEN: process.env.TENCENT_DOCS_ACCESS_TOKEN || '',
  OPEN_ID: process.env.TENCENT_DOCS_OPEN_ID || '',
  REDIRECT_URI: process.env.TENCENT_DOCS_REDIRECT_URI || '',
  ACT: {
    addSheet: 'addSheet',
    getSheet: 'getSheet',
    deleteSheet: 'deleteSheet',
    getRecords: 'getRecords',
    addRecords: 'addRecords',
    updateRecords: 'updateRecords',
    deleteRecords: 'deleteRecords',
    getFields: 'getFields',
    addFields: 'addFields'
  },
  PAGE: 100
}

// 腾讯文档各表的列名（中文）。必须与真实文档的列名【逐字一致】，否则读写会拿到 undefined / 被静默跳过。
// 下列名称已按 2026-10-22 拉取的 8 张表真实列名校准。
const COL = {
  users: { id: '用户ID', name: '姓名', role: '角色', cls: '班级', status: '状态', openid: '微信OpenID' },
  materials: { id: '耗材ID', name: '名称', spec: '规格', cat: '类别', loc: '存放位置', stock: '当前库存', unit: '单位', safe: '预警线', status: '状态' },
  tools: { id: '工具ID', name: '名称', spec: '规格', loc: '存放位置', status: '状态', holder: '当前持有人' },
  requisitions: { id: '申请ID', user: '申请人ID', item: '物品ID', type: '物品类型', qty: '数量', reason: '用途说明', status: '状态', time: '申请时间', approver: '审批人' },
  borrow: { id: '借还ID', user: '借用人ID', tool: '工具ID', out: '借出时间', plan: '计划归还', in: '实际归还', status: '状态' },
  stock_io: { id: '流水ID', item: '物品ID', dir: '方向', qty: '数量', op: '操作人', time: '操作时间', note: '备注' },
  access: { id: '记录ID', user: '用户ID', point: '门禁点', time: '刷卡时间', result: '结果' },
  logs: { id: '日志ID', time: '时间', actor: '操作人', op: '操作类型', target: '对象', result: '结果' }
}

// 中英状态翻译（腾讯文档存中文，前端用英文名；这里双向映射）
const TR = {
  reqFwd: { pending: '待审批', approved: '已通过', rejected: '已拒绝' },
  // 反向映射要容忍历史/手写数据的多种写法：表里同时存在「通过/已通过」「拒绝/已拒绝」
  reqRev: {
    '待审批': 'pending', '待审核': 'pending', '审批中': 'pending',
    '已通过': 'approved', '通过': 'approved', '同意': 'approved', '已同意': 'approved',
    '已拒绝': 'rejected', '拒绝': 'rejected', '不同意': 'rejected', '已驳回': 'rejected'
  },
  borrowFwd: { out: '借出中', returned: '已归还' },
  borrowRev: { '借出中': '借出', '已归还': '已还' },
  ioFwd: { in: '入库', out: '出库' },
  ioRev: { '入库': 'in', '出库': 'out' },
  role: { '学生': 'student', '教师': 'teacher', '管理员': 'admin', 'student': 'student', 'teacher': 'teacher', 'admin': 'admin' },
  // 英文角色 → 中文存储（腾讯文档「角色」列存中文；normUser 反向读回英文）
  roleFwd: { student: '学生', teacher: '教师', admin: '管理员' }
}

// ============================================================
// 0. HTTP 兼容层
// 云函数运行时不一定是 Node 18+，全局 fetch 可能不存在。
// 有 fetch 就用 fetch（本地/node18+ 云函数走这条，行为与已通过的 e2e 完全一致）；
// 没有则用内置 https/http 兜底 —— 保证「运行时版本」不会成为上线失败原因。
// 统一返回 { status, text }，调用方自行 parseJson。
// ============================================================
const https = require('https')
const http = require('http')

// 复用 TCP/TLS 连接：一次审批要打多个腾讯文档请求，默认每次新建连接（含 TLS 握手）
// 会很慢；开启 keepAlive 后同域名连接复用，单次请求可省 ~100-300ms。
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 })
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 })

function rawRequest(url, opts) {
  opts = opts || {}
  if (typeof fetch === 'function') {
    return fetch(url, opts).then(async (res) => ({ status: res.status, text: await res.text() }))
  }
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('非法 URL：' + url)) }
    const mod = u.protocol === 'http:' ? http : https
    const body = opts.body
    const headers = Object.assign({}, opts.headers || {})
    if (body) headers['Content-Length'] = Buffer.byteLength(body)
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        agent: u.protocol === 'http:' ? httpAgent : httpsAgent,
        timeout: 20000
      },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { buf += c })
        res.on('end', () => resolve({ status: res.statusCode || 0, text: buf }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时：' + url)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function parseJson(text, tag) {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${tag} 返回非 JSON：${String(text).slice(0, 200)}`)
  }
}

function okStatus(s) { return s >= 200 && s < 300 }

// ============================================================
// 1. Token 管理：缓存 + 刷新锁 + 401 重试
// ============================================================
let _token = ''
let _tokenExpire = 0
let _refreshing = null
let _openId = CFG.OPEN_ID   // 官方要求的 Open-Id 头（= token 回包 user_id）

async function getToken() {
  // ① 个人开发者凭证模型：控件台「开发者信息」直接给 access_token，无需刷新。
  //    优先级最高；30 天到期后在控制台点「重置」，把新值更新到 TENCENT_DOCS_ACCESS_TOKEN。
  if (CFG.ACCESS_TOKEN) { _token = CFG.ACCESS_TOKEN; return _token }

  const now = Date.now()
  if (_token && _tokenExpire - now > 60000) return _token
  if (_refreshing) return _refreshing

  _refreshing = (async () => {
    try {
      if (!CFG.REFRESH_TOKEN) {
        throw new Error('缺少 TENCENT_DOCS_REFRESH_TOKEN 环境变量（请先用 authorizeWithCode 授权并回填）')
      }
      const url =
        `${CFG.TOKEN_URL}?grant_type=refresh_token` +
        `&refresh_token=${encodeURIComponent(CFG.REFRESH_TOKEN)}` +
        `&client_id=${encodeURIComponent(CFG.CLIENT_ID)}` +
        `&client_secret=${encodeURIComponent(CFG.CLIENT_SECRET)}`
      const r = await rawRequest(url)
      if (!okStatus(r.status)) throw new Error(`token 刷新失败 HTTP ${r.status} ${String(r.text).slice(0, 200)}`)
      const j = parseJson(r.text, 'token 刷新')
      if (!j.access_token) throw new Error('token 响应缺少 access_token：' + JSON.stringify(j))
      _token = j.access_token
      _tokenExpire = now + ((j.expires_in || 2592000) - 60) * 1000
      if (j.user_id) _openId = j.user_id          // 刷新回包也可能带 user_id
      return _token
    } finally {
      _refreshing = null
    }
  })()
  return _refreshing
}

// 首次授权：用授权回调拿到的 code 换 token。
// 官方要求必须带 redirect_uri，且与 /oauth/v2/authorize 时完全一致，否则 HTTP 401。
// 调用后请把 refresh_token 与 user_id(Open ID) 回填到云函数环境变量。
async function authorizeWithCode(code) {
  if (!CFG.REDIRECT_URI) throw new Error('缺少 TENCENT_DOCS_REDIRECT_URI（换 token 时必须与授权时一致）')
  const url =
    `${CFG.TOKEN_URL}?grant_type=authorization_code` +
    `&code=${encodeURIComponent(code)}` +
    `&client_id=${encodeURIComponent(CFG.CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(CFG.CLIENT_SECRET)}` +
    `&redirect_uri=${encodeURIComponent(CFG.REDIRECT_URI)}`
  const r = await rawRequest(url)
  if (!okStatus(r.status)) throw new Error(`授权换 token 失败 HTTP ${r.status} ${String(r.text).slice(0, 200)}`)
  const j = parseJson(r.text, '授权换 token')
  if (!j.access_token) throw new Error('授权响应缺少 access_token：' + JSON.stringify(j))
  _token = j.access_token
  _tokenExpire = Date.now() + ((j.expires_in || 2592000) - 60) * 1000
  if (j.user_id) _openId = j.user_id
  console.log('[tencentdocs] 请回填环境变量：')
  console.log('  TENCENT_DOCS_REFRESH_TOKEN =', j.refresh_token)
  console.log('  TENCENT_DOCS_OPEN_ID       =', j.user_id)
  return j
}

// ============================================================
// 2. 通用调用封装：action 派发 + 限频退避 + token 失效重试
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function callSmart(sheetKey, action, params) {
  const sheetId = TABLE[sheetKey]
  if (!sheetId) throw new Error(`未知表：${sheetKey}`)
  return callApi(`${CFG.BASE}/files/${CFG.FILE_ID}/sheets/${sheetId}`, action, params)
}

// 通用调用：官方 v2 契约 —— 头 Access-Token/Client-Id/Open-Id，体 { <action>: params }
async function callApi(url, action, params) {
  if (!CFG.FILE_ID) throw new Error('缺少 TENCENT_DOCS_FILE_ID 环境变量')
  if (!(_openId || CFG.OPEN_ID)) throw new Error('缺少 TENCENT_DOCS_OPEN_ID 环境变量（token 回包的 user_id）')
  let token = await getToken()

  let attempt = 0
  while (true) {
    const r = await rawRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': token,
        'Client-Id': CFG.CLIENT_ID,
        'Open-Id': _openId || CFG.OPEN_ID
      },
      body: JSON.stringify({ [action]: params || {} })
    })
    if (r.status === 429 && attempt < 4) {              // 限频（单文档 150 次/分钟）
      await sleep(Math.min(2000, 200 * Math.pow(2, attempt)))
      attempt++; continue
    }
    if (r.status === 401 && attempt === 0) {            // token 失效：清缓存刷新后重试一次
      _token = ''; token = await getToken(); attempt++; continue
    }
    if (!okStatus(r.status)) {
      throw new Error(`smartbook ${action} 失败 HTTP ${r.status} ${String(r.text).slice(0, 200)}`)
    }
    const j = parseJson(r.text, `smartbook ${action}`)
    if (j.ret !== undefined && j.ret !== 0) {
      if (j.ret === 37019 && attempt === 0) { _token = ''; token = await getToken(); attempt++; continue }
      throw new Error(`smartbook ${action} 失败 ret=${j.ret} ${j.msg || ''}`)
    }
    return (j.data && j.data[action]) || {}
  }
}

// ============================================================
// 3. 字段归一化：兼容不同返回结构的字段写法
// ============================================================
// 官方返回：{ recordID, values: { 列名: 值 } }。
// 同一文档不同字段的返回形态不一致：
//   • 文本/单选：[{type:'text',text}] 或 [{id,style,text}] 数组
//   • 日期：字符串时间戳 "1788224400000"
//   • 自动编号：{seq,text} 对象
// 这里统一归一化为纯字符串/数值供前端使用。
function unwrapValue(v) {
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && v[0] !== null && 'text' in v[0]) {
      return v.map(x => x.text).join('')          // 富文本/单选数组 → 纯字符串
    }
    return v
  }
  if (v && typeof v === 'object' && 'text' in v) return v.text   // 自动编号 {seq,text} → text
  return v
}

// 日期字段读回是时间戳字符串（如 "1792683028958"），转成 YYYY-MM-DD HH:mm 供前端直接展示。
function fmtTs(v) {
  if (v === '' || v == null) return ''
  const s = '' + v
  if (/^\d{10,}$/.test(s)) {
    const d = new Date(Number(s))
    if (isNaN(d.getTime())) return s
    const p = n => ('' + n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return s
}
function recToFields(rec) {
  const out = { recordId: rec.recordID || rec.recordId || rec.record_id, fields: {} }
  const values = rec.values || rec.fields || {}
  for (const title of Object.keys(values)) out.fields[title] = unwrapValue(values[title])
  return out
}

// 列名→fieldId 映射缓存（写记录需按 fieldId 定位列）
const _fieldMapCache = {}
// 返回 { 列名: { id, type } }；type: 1=文本 2=数字 3=复选框 4=日期 9=选项 ...
async function getFieldMap(sheetKey) {
  if (_fieldMapCache[sheetKey]) return _fieldMapCache[sheetKey]
  const map = {}
  let offset = 0
  while (true) {
    const page = await callSmart(sheetKey, CFG.ACT.getFields, { offset, limit: 100 })
    const fields = page.fields || []
    for (const f of fields) {
      const id = f.fieldID || f.fieldId
      const title = f.fieldTitle || f.fieldName
      if (id && title) map[title] = { id, type: f.fieldType }
    }
    if (!page.hasMore || !fields.length) break
    offset = page.next != null ? page.next : offset + fields.length
  }
  _fieldMapCache[sheetKey] = map
  return map
}

// 新增列后必须清掉该表字段映射缓存，否则 buildValues 仍按旧列集跳过新列
function clearFieldMapCache(sheetKey) { delete _fieldMapCache[sheetKey] }

// 预热所有表的字段映射（并行一次）：避免首条写请求串行逐个拉字段导致超时。
// 冷启动首请求付出 ~1-2s（并行）代价；之后命中缓存，近似 0 成本。
// 即便某表预热失败也不阻断业务（getFieldMap 会在真正读写时按需重试）。
async function warmFieldMaps() {
  await Promise.all(Object.keys(TABLE).map(k =>
    getFieldMap(k).then(() => k).catch(e => console.warn('[tencentdocs] 字段映射预热失败 ' + k + '：' + e.message))
  ))
}

// 把 {中文列名: 值} 转成官方 values。本仓库文档字段类型差异大，按 type 分支（格式经过实测）：
//   type=1  文本    → [{type:'text', text:'值'}]  ← 必须用此格式，纯字符串写会被静默丢弃
//   type=17 单选    → [{text:'选项'}]  ← 数组包裹，平台按文字匹配已有选项
//   type=2  数字    → 数值
//   type=3  勾选框  → 布尔
//   type=4  日期    → 时间戳字符串（读回也是 "1792683028958" 形态）
//   type=25 自动编号 → 跳过（平台生成，不写也读不回）
async function buildValues(sheetKey, fieldsMap) {
  const map = await getFieldMap(sheetKey)
  const values = {}
  for (const [title, value] of Object.entries(fieldsMap)) {
    const meta = map[title]
    if (!meta) { console.warn(`[tencentdocs] 表 ${sheetKey} 找不到列「${title}」，已跳过`); continue }
    if (meta.type === 25) continue                                       // 自动编号：平台生成，不写
    if (value === null || value === undefined) continue                  // 空值不写
    if (meta.type === 2) values[title] = Number(value) || 0
    else if (meta.type === 3) values[title] = !!value
    else if (meta.type === 4) values[title] = /^\d{10,}$/.test(String(value)) ? String(value) : String(Date.now())
    else if (meta.type === 17) values[title] = [{ text: String(value) }]
    else values[title] = [{ type: 'text', text: String(value) }]         // 文本：type+text 数组，否则存不进
  }
  return values
}

// ============================================================
// 4. 基础 CRUD（业务函数依赖这些原子操作）
// ============================================================
// 表数据缓存：腾讯文档「查询记录」限 150 次/分钟/fileID，且单表满 100 行/页。
// 高频读（工作台/库存/我的）反复拉同一批行会迅速吃满配额，这里做进程内短 TTL 缓存：
//   读请求命中缓存 → 0 次 API 调用；写操作后主动失效对应表 → 保证数据新鲜度。
const _cache = new Map()          // sheetKey -> { data, at }
const CACHE_TTL = 20000           // 20s：跨页面切换足够复用，又不至于让用户看到明显延迟的旧值
const CACHE_MAX_ROWS = 3000       // 超过此行数不缓存（缓存内存吃不消，且大表本就该走 DB）

async function getRecords(sheetKey, filterFn, opts) {
  const o = opts || {}
  const useCache = !o.noCache && !o.fieldTitles && !o.recordIDs
  const now = Date.now()

  // 命中缓存：直接过滤返回
  if (useCache) {
    const hit = _cache.get(sheetKey)
    if (hit && (now - hit.at) < CACHE_TTL) {
      _cacheStats.hit++
      return filterFn ? hit.data.filter(filterFn) : hit.data
    }
  }
  _cacheStats.miss++

  // 精确取行：用 recordIDs 直接定位，1 次请求代替全表扫描
  if (o.recordIDs && o.recordIDs.length) {
    const page = await callSmart(sheetKey, CFG.ACT.getRecords, { recordIDs: o.recordIDs })
    return (page.records || []).map(recToFields)
  }

  const all = []
  let offset = 0
  const params = { offset, limit: CFG.PAGE }
  // 只取需要的列：响应体大幅缩小，也减少服务端解析压力
  if (o.fieldTitles && o.fieldTitles.length) params.fieldTitles = o.fieldTitles
  while (true) {
    const page = await callSmart(sheetKey, CFG.ACT.getRecords, params)
    const raw = page.records || []
    if (!raw.length) break
    const norm = raw.map(recToFields)
    all.push(...norm)
    if (!page.hasMore) break
    offset = page.next != null ? page.next : offset + raw.length
    params.offset = offset
  }
  const result = filterFn ? all.filter(filterFn) : all
  // 缓存未过滤的全量，供后续不同 filter 复用
  if (useCache && all.length <= CACHE_MAX_ROWS) _cache.set(sheetKey, { data: all, at: now })
  return result
}

// 写操作后失效对应表的缓存（保证下次读到最新数据）
function invalidateCache(sheetKey) {
  if (sheetKey) _cache.delete(sheetKey)
  else _cache.clear()
}

// 缓存观测：命中/未命中计数，便于评估 API 配额压力
const _cacheStats = { hit: 0, miss: 0, apiCalls: 0 }
function cacheStats() {
  return Object.assign({}, _cacheStats, {
    cachedTables: Array.from(_cache.keys()),
    ttl: CACHE_TTL
  })
}

async function addRecord(sheetKey, fieldsMap) {
  const values = await buildValues(sheetKey, fieldsMap)
  const page = await callSmart(sheetKey, CFG.ACT.addRecords, { records: [{ values }] })
  const created = page.records || []
  invalidateCache(sheetKey)                 // 写后失效缓存，保证下次读到新行
  return created[0] ? recToFields(created[0]) : null
}

// 写串行化：所有写操作经同一 Promise 链互斥执行，避免并发读-算-写互相覆盖
let _writeChain = Promise.resolve()
function withWriteLock(fn) {
  const run = _writeChain.then(fn, fn)
  _writeChain = run.then(() => {}, () => {})
  return run
}

// 按 recordID 批量删除（用于清理写测试产生的脏数据：如申请人ID 为空的领用单）
// ⚠️ smartbook v2 的 deleteRecords 入参是 { recordIDs: [string,...] }（复数、字符串数组），
//    不是 { records: [{recordID}] }，后者服务端会 ret=0 但静默不删。
async function deleteRecordByIds(sheetKey, ids) {
  const list = (ids || []).filter(Boolean)
  if (!list.length) return 0
  await callSmart(sheetKey, CFG.ACT.deleteRecords, { recordIDs: list })
  invalidateCache(sheetKey)
  return list.length
}

async function updateRecord(sheetKey, recordId, fieldsMap) {
  const values = await buildValues(sheetKey, fieldsMap)
  const page = await callSmart(sheetKey, CFG.ACT.updateRecords, {
    records: [{ recordID: recordId, values }]
  })
  const updated = page.records || []
  invalidateCache(sheetKey)                 // 写后失效缓存
  return updated[0] ? recToFields(updated[0]) : null
}

// ============================================================
// 5. 读归一化（腾讯中文记录 → 前端英文契约）
// ============================================================
function normMaterial(f) {
  return {
    id: f[COL.materials.id], name: f[COL.materials.name], spec: f[COL.materials.spec] || '',
    cat: f[COL.materials.cat] || '', loc: f[COL.materials.loc] || '',
    stock: Number(f[COL.materials.stock]) || 0, unit: f[COL.materials.unit] || '',
    safe: Number(f[COL.materials.safe]) || 0, status: f[COL.materials.status] || ''
  }
}
function normTool(f) {
  // 序号列兼容：mock 种子里叫 sn，真实文档工具表的序号列叫「规格」（如 VC830L）。
  // 两条来源都兜底到 sn，保证详情页/库存页的「编号」都能显示。
  const sn = f['sn'] || f[COL.tools.spec] || ''
  return {
    id: f[COL.tools.id], name: f[COL.tools.name], spec: f[COL.tools.spec] || f['sn'] || '',
    sn, loc: f[COL.tools.loc] || '', status: f[COL.tools.status] || '',
    borrower: f[COL.tools.holder] || '', outTime: ''
  }
}
function normReq(f) {
  const type = f[COL.requisitions.type]
  const kind = ('' + (type || '')) === '借出' ? 'tool' : 'material'
  return {
    no: f[COL.requisitions.id], user: f[COL.requisitions.user],
    matId: f[COL.requisitions.item], toolId: f[COL.requisitions.item], kind,
    qty: Number(f[COL.requisitions.qty]) || 0,
    status: TR.reqRev[f[COL.requisitions.status]] || f[COL.requisitions.status] || '',
    time: fmtTs(f[COL.requisitions.time]) || ''
  }
}
function normBorrow(f) {
  return {
    id: f[COL.borrow.id], user: f[COL.borrow.user], toolId: f[COL.borrow.tool],
    out: fmtTs(f[COL.borrow.out]) || '', in: fmtTs(f[COL.borrow.in]) || '',
    status: TR.borrowRev[f[COL.borrow.status]] || f[COL.borrow.status] || ''
  }
}
function normUser(f) {
  return {
    id: f[COL.users.id], name: f[COL.users.name],
    role: TR.role[f[COL.users.role]] || f[COL.users.role] || 'student',
    cls: f[COL.users.cls] || '',
    status: f[COL.users.status] || '',
    openid: f[COL.users.openid] || ''
  }
}
function normStockIO(f) {
  return {
    no: f[COL.stock_io.id], matId: f[COL.stock_io.item],
    type: TR.ioRev[f[COL.stock_io.dir]] || 'in', qty: Number(f[COL.stock_io.qty]) || 0,
    operator: f[COL.stock_io.op] || '', time: fmtTs(f[COL.stock_io.time]) || '', note: f[COL.stock_io.note] || ''
  }
}
function normAccess(f) {
  return {
    time: f[COL.access.time] || '', actor: f[COL.access.user] || '',
    door: f[COL.access.point] || '', result: f[COL.access.result] || ''
  }
}
function normLog(f) {
  return {
    time: f[COL.logs.time] || '', actor: f[COL.logs.actor] || '',
    op: f[COL.logs.op] || '', target: f[COL.logs.target] || '', result: f[COL.logs.result] || ''
  }
}

// ============================================================
// 6. 业务函数（index.js 调用，字段契约与 mock.js 完全一致）
// ============================================================
function now() { return new Date().toISOString().slice(0, 19).replace('T', ' ') }
function genNo(p) {
  const d = new Date(); const q = n => ('' + n).padStart(2, '0')
  return `${p}${d.getFullYear()}${q(d.getMonth() + 1)}${q(d.getDate())}${q(d.getHours())}${q(d.getMinutes())}${Math.floor(Math.random() * 90 + 10)}`
}

// 查单个物品（耗材 M / 工具 T），返回 {type, item:{..., rid}}
async function getItem(id) {
  const key = ('' + id).toUpperCase()
  const isTool = key.startsWith('T')
  const col = isTool ? COL.tools : COL.materials
  // 缓存命中时 0 次 API；未命中时只取需要的列，减小响应体
  const list = await getRecords(isTool ? 'tools' : 'materials',
    r => ('' + r.fields[col.id]) === key)
  const rec = list[0]
  if (!rec) return null
  const base = isTool ? normTool(rec.fields) : normMaterial(rec.fields)
  return { type: isTool ? 'tool' : 'material', item: { ...base, rid: rec.recordId } }
}

async function listMaterials() {
  const list = await getRecords('materials')
  return list.map(r => normMaterial(r.fields))
}

async function listTools() {
  const list = await getRecords('tools')
  return list.map(r => normTool(r.fields))
}

async function listMine(user) {
  const u = '' + user
  const rs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.user]) === u)
  const bs = await getRecords('borrow', r => ('' + r.fields[COL.borrow.user]) === u)
  return { requisitions: rs.map(r => normReq(r.fields)), borrow: bs.map(r => normBorrow(r.fields)) }
}

async function listPending() {
  const list = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.status]) === '待审批')
  return list.map(r => normReq(r.fields))
}

// ============================================================
// 5.5 登录鉴权（身份来源 = 云端 users 表，不再用本地 mock）
//   - findUser(工号)：老师/学生用工号登录；未录入或停用 → null
//   - listUsers()：仅管理员可调用（prodHandler 已服务端拦截非管理员），登录页不再使用
//   - openid 绑定 + whoami(openid)：首次工号登录绑定微信 openid，之后免输工号自动登录
// ============================================================
// 只回前端安全字段，openid 等内部信息不下发
function publicUser(u) {
  return u ? { id: u.id, name: u.name, role: u.role, cls: u.cls } : null
}

// 账号可用：未填状态视为可用；填了则必须为「启用」
function userEnabled(u) {
  return !u.status || u.status === '启用'
}

async function findUser(id) {
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).toUpperCase() === key)
  const rec = list[0]
  if (!rec) return null
  const u = normUser(rec.fields)
  if (!userEnabled(u)) return null
  return { rid: rec.recordId, user: publicUser(u), openid: u.openid }
}

async function listUsers() {
  const list = await getRecords('users')
  return list.map(r => normUser(r.fields)).filter(userEnabled).map(publicUser)
}

// 确保 users 表有「微信OpenID」列（幂等）：没有则创建，并清字段缓存让后续写能识别新列
async function ensureOpenIdColumn() {
  const map = await getFieldMap('users')
  if (map[COL.users.openid]) return true
  await callSmart('users', CFG.ACT.addFields, {
    fields: [{ fieldTitle: COL.users.openid, fieldType: 1, propertyText: {} }]
  })
  clearFieldMapCache('users')
  return true
}

// 把微信 openid 写进某用户行（首登工号登录时调用，best-effort，失败不影响登录）
async function bindOpenId(rid, openid) {
  if (!rid || !openid) return
  await ensureOpenIdColumn()
  await updateRecord('users', rid, { [COL.users.openid]: openid })
}

// 按 openid 找已绑定用户（免输工号自动登录用）；未建 openid 列时直接返回 null
async function findUserByOpenId(openid) {
  if (!openid) return null
  const map = await getFieldMap('users')
  if (!map[COL.users.openid]) return null
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.openid] || '')) === openid)
  const rec = list[0]
  if (!rec) return null
  const u = normUser(rec.fields)
  return userEnabled(u) ? publicUser(u) : null
}

async function whoami(openid) {
  return openid ? await findUserByOpenId(openid) : null
}

// ============================================================
// 5.6 用户管理（仅管理员）：adminListUsers / adminUpsertUser / adminDeleteUser
//   - 列表返回 rid（腾讯文档行 ID）供前端定位；openid 等内部信息不下发，只回 bound 布尔。
//   - 以「工号」为业务主键，upsert 不改动工号本身，避免破坏领用/借还记录里的申请人引用。
//   - 删除不级联清理历史记录（保留工号引用便于审计溯源）。
// ============================================================
async function adminListUsers() {
  const list = await getRecords('users')
  return list
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id,
        name: u.name,
        role: u.role,
        cls: u.cls,
        status: u.status,
        bound: !!(u.openid && ('' + u.openid).trim())
      }
    })
    .filter(u => !!(u.id && ('' + u.id).trim())) // 跳过完全空白的行
}

async function adminUpsertUser(data) {
  data = data || {}
  const id = ('' + (data.id || '')).trim().toUpperCase()
  const name = ('' + (data.name || '')).trim()
  const role = ('' + (data.role || '')).trim().toLowerCase()
  const cls = ('' + (data.cls || '')).trim()
  const status = ('' + (data.status || '')).trim() || '启用'
  if (!id || !name) return { code: 400, data: { msg: '工号和姓名必填' } }
  const ROLES = ['student', 'teacher', 'admin']
  if (ROLES.indexOf(role) < 0) return { code: 400, data: { msg: '角色必须是 student / teacher / admin 之一' } }
  if (status !== '启用' && status !== '停用') return { code: 400, data: { msg: '状态必须是 启用 / 停用' } }
  // 防御性：确保 users 表 openid 列存在（登录绑定所需；已存在则 no-op）
  await ensureOpenIdColumn()

  const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
  const rec = list[0]
  const fields = {
    [COL.users.id]: id,
    [COL.users.name]: name,
    [COL.users.role]: TR.roleFwd[role] || role,
    [COL.users.cls]: cls,
    [COL.users.status]: status
  }
  if (rec) {
    await updateRecord('users', rec.recordId, fields)
    return { id, updated: true }
  }
  await addRecord('users', fields)
  return { id, created: true }
}

async function adminDeleteUser(data, meId) {
  const id = ('' + (data && data.id || '')).trim().toUpperCase()
  if (!id) return { code: 400, data: { msg: '工号必填' } }
  if (meId && id === ('' + meId).toUpperCase()) return { code: 400, data: { msg: '不能删除当前登录的管理员账号' } }
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
  const rec = list[0]
  if (!rec) return { code: 404, data: { msg: '该工号不存在' } }
  await deleteRecordByIds('users', [rec.recordId])
  return { id }
}

// 绑定登录：姓名 + 工号命中 users 表 → 把当前微信 openid 绑到该工号，之后可免输入自动登录。
// 约束（双向 1:1，避免数据叠加）：
//   ① 工号必须存在且启用，姓名须与表内一致；
//   ② 一个工号只能绑一个微信：已被别的 openid 占用 → 409；
//   ③ 一个微信只能绑一个工号：本 openid 已绑到别的工号 → 409；
//   ④ 已绑到本微信 → 直接登录（幂等）。
async function bindLogin(data, openid) {
  if (!openid) return { code: 400, data: { msg: '未获取到微信身份，请在微信中打开小程序' } }
  const id = ('' + (data && data.id || '')).trim().toUpperCase()
  const name = ('' + (data && data.name || '')).trim()
  if (!id || !name) return { code: 400, data: { msg: '请输入姓名和工号' } }
  await ensureOpenIdColumn()
  const byId = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).toUpperCase() === id)
  const rec = byId[0]
  if (!rec) return { code: 404, data: { msg: '工号不存在，请联系管理员先在用户表录入' } }
  const u = normUser(rec.fields)
  if (u.status && u.status !== '启用') return { code: 400, data: { msg: '该账号未启用，请联系管理员' } }
  if (name !== ('' + (u.name || '')).trim()) return { code: 400, data: { msg: '姓名与工号不匹配，请核对后重试' } }
  if (u.openid && u.openid === openid) return { code: 0, data: publicUser(u) }                 // 已绑本微信，幂等登录
  if (u.openid && u.openid !== openid) return { code: 409, data: { msg: '该工号已绑定其他微信，无法重复绑定；如需换绑请联系管理员清空该工号的绑定' } }
  const byOpen = await getRecords('users', r => ('' + (r.fields[COL.users.openid] || '')) === openid)
  if (byOpen.length) {
    const other = normUser(byOpen[0].fields)
    return { code: 409, data: { msg: '此微信已绑定工号 ' + (other.id || '?') + '，一个微信只能绑定一个工号' } }
  }
  await updateRecord('users', rec.recordId, { [COL.users.openid]: openid })
  return { code: 0, data: publicUser(u) }
}

// 申请ID 是自动编号列，创建响应不回显，需按 recordId 反查拿回业务单号。
async function readBackNo(rec, sheetKey, idCol) {
  if (!rec || !rec.recordId) return ''
  for (let i = 0; i < 3; i++) {
    const list = await getRecords(sheetKey, r => r.recordId === rec.recordId)
    if (list[0] && list[0].fields[idCol]) return list[0].fields[idCol]
    await new Promise(r => setTimeout(r, 300))
  }
  return ''
}

// 领用申请：写 requisitions（待审批）+ 写 logs。申请ID 由平台生成，反查后随 no 返回。
async function requisition(data) {
  return withWriteLock(async () => {
    const rec = await addRecord('requisitions', {
      [COL.requisitions.user]: data.user, [COL.requisitions.item]: data.matId,
      [COL.requisitions.type]: '领用', [COL.requisitions.qty]: data.qty, [COL.requisitions.reason]: '',
      [COL.requisitions.status]: '待审批', [COL.requisitions.time]: now(), [COL.requisitions.approver]: ''
    })
    await addRecord('logs', {
      [COL.logs.actor]: data.user, [COL.logs.op]: '提交领用申请', [COL.logs.target]: data.matId, [COL.logs.result]: '待审批'
    })
    return { no: await readBackNo(rec, 'requisitions', COL.requisitions.id) }
  })
}

// 工具借出申请：写 requisitions（类型=借出，待审批）+ 写 logs
async function toolRequisition(data) {
  return withWriteLock(async () => {
    const rec = await addRecord('requisitions', {
      [COL.requisitions.user]: data.user, [COL.requisitions.item]: data.toolId,
      [COL.requisitions.type]: '借出', [COL.requisitions.qty]: 1, [COL.requisitions.reason]: '',
      [COL.requisitions.status]: '待审批', [COL.requisitions.time]: now(), [COL.requisitions.approver]: ''
    })
    await addRecord('logs', {
      [COL.logs.actor]: data.user, [COL.logs.op]: '提交工具借出申请', [COL.logs.target]: data.toolId, [COL.logs.result]: '待审批'
    })
    return { no: await readBackNo(rec, 'requisitions', COL.requisitions.id) }
  })
}

// 审批：通过则扣库存/借出工具；拒绝只改状态。写串行化防并发覆盖。
// ⚠️ 脏数据防护：早期调试/e2e 残留单子可能缺「物品ID/物品类型/申请人ID」，
//    这类单子无法审批，返回 400 业务错误（不再抛 500 崩溃），应由 cleanup 脚本清理。
async function approve(data) {
  return withWriteLock(async () => {
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === ('' + data.no))
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + data.no } }
    if (('' + req.fields[COL.requisitions.status]) !== '待审批') return { code: 400, data: { msg: '该申请已处理' } }

    const isTool = ('' + (req.fields[COL.requisitions.type] || '')) === '借出'

    if (!data.ok) {
      await updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已拒绝', [COL.requisitions.approver]: data.actor })
      await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批拒绝', [COL.logs.target]: data.no, [COL.logs.result]: '已拒绝' })
      return {}
    }

    if (isTool) {
      const toolId = '' + (req.fields[COL.requisitions.item] == null ? '' : req.fields[COL.requisitions.item])
      if (!toolId) return { code: 400, data: { msg: '该申请缺少工具ID，疑似脏数据（' + ('' + (req.fields[COL.requisitions.id] || '?')) + '），无法审批' } }
      const applicant = data.user || req.fields[COL.requisitions.user]   // 借用人=申请人
      const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
      const tool = tools[0]
      if (!tool) return { code: 400, data: { msg: '工具不存在：' + toolId } }
      if (('' + tool.fields[COL.tools.status]) !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
      // 三条写互不依赖，并行提交，缩短审批耗时
      await Promise.all([
        updateRecord('tools', tool.recordId, { [COL.tools.status]: '借出', [COL.tools.holder]: applicant }),
        updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor }),
        addRecord('borrow', {
          [COL.borrow.id]: genNo('B'), [COL.borrow.user]: applicant, [COL.borrow.tool]: toolId,
          [COL.borrow.out]: now(), [COL.borrow.plan]: '', [COL.borrow.in]: '', [COL.borrow.status]: '借出中'
        }),
        addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批通过工具借出', [COL.logs.target]: toolId, [COL.logs.result]: '已通过' })
      ])
      return {}
    }

    const matId = '' + (req.fields[COL.requisitions.item] == null ? '' : req.fields[COL.requisitions.item])
    if (!matId) return { code: 400, data: { msg: '该申请缺少物品ID，疑似脏数据（' + ('' + (req.fields[COL.requisitions.id] || '?')) + '），无法审批，请在腾讯文档删除该记录' } }
    const qty = Number(req.fields[COL.requisitions.qty]) || 0
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '物品不存在：' + matId } }
    const cur = Number(mat.fields[COL.materials.stock]) || 0
    if (cur < qty) return { code: 400, data: { msg: `库存不足：当前 ${cur}，申请 ${qty}` } }
    await Promise.all([
      updateRecord('materials', mat.recordId, { [COL.materials.stock]: cur - qty }),
      updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor }),
      addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批通过', [COL.logs.target]: data.no, [COL.logs.result]: '已通过' })
    ])
    return {}
  })
}

// 新增耗材建档（老师首次入库一种全新物品时用）
// 自动分配 M+序号 形式的耗材ID：取现有最大序号 +1，避免与人工编号冲突
async function addMaterial(data) {
  return withWriteLock(async () => {
    const name = ('' + (data.name || '')).trim()
    if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
    const unit = ('' + (data.unit || '')).trim() || '个'
    const qty = Number(data.qty) || 0
    if (qty < 0) return { code: 400, data: { msg: '数量不能为负数' } }

    // 已有同名耗材 → 不重复建档，直接提示用已有 ID 入库
    const exists = await getRecords('materials', r => ('' + r.fields[COL.materials.name]).trim() === name)
    if (exists.length) {
      const ex = exists[0].fields
      return { code: 409, data: { msg: '该物品已存在：' + ex[COL.materials.id] + '，请直接在出入库登记中选择它', matId: ex[COL.materials.id] } }
    }

    // 生成新 ID：M + 3位序号（对齐现有 M001 风格）
    const all = await getRecords('materials')
    let max = 0
    for (const r of all) {
      const m = /^\s*[Mm](\d+)\s*$/.exec('' + r.fields[COL.materials.id])
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    }
    const newId = 'M' + String(max + 1).padStart(3, '0')

    await addRecord('materials', {
      [COL.materials.id]: newId,
      [COL.materials.name]: name,
      [COL.materials.spec]: ('' + (data.spec || '')).trim(),
      [COL.materials.cat]: ('' + (data.cat || '')).trim() || '电子元件',
      [COL.materials.loc]: ('' + (data.loc || '')).trim(),
      [COL.materials.stock]: qty,
      [COL.materials.unit]: unit,
      [COL.materials.safe]: Number(data.safe) || 0,
      [COL.materials.status]: '正常'
    })

    // 建档同时记一笔入库流水，保证「账实相符」
    if (qty > 0) {
      await Promise.all([
        addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: newId,
          [COL.stock_io.dir]: TR.ioFwd.in || '入库', [COL.stock_io.qty]: qty,
          [COL.stock_io.op]: data.actor || '', [COL.stock_io.time]: now(),
          [COL.stock_io.note]: '建档入库'
        }),
        addRecord('logs', {
          [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor || '',
          [COL.logs.op]: '新增耗材', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
        })
      ])
    }
    return { data: { id: newId, name, stock: qty, unit } }
  })
}

// 出入库登记：入库 + / 出库 -，更新库存 + 写 stock_io + logs
// 入库时若物品不存在，且带了 newItem 信息，则先建档再入库（老师无需先去文档手动加行）
async function io(data) {
  return withWriteLock(async () => {
    const matId = ('' + data.matId || '').trim()
    if (!matId) return { code: 400, data: { msg: '请选择耗材' } }
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '物品不存在：' + matId } }
    const delta = (data.type === 'in' ? 1 : -1) * (Number(data.qty) || 0)
    const cur = Number(mat.fields[COL.materials.stock]) || 0
    const next = cur + delta
    if (next < 0) return { code: 400, data: { msg: `库存不足：当前 ${cur}` } }
    // 库存更新与两条流水写入互不依赖，并行提交
    await Promise.all([
      updateRecord('materials', mat.recordId, { [COL.materials.stock]: next }),
      addRecord('stock_io', {
        [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
        [COL.stock_io.dir]: TR.ioFwd[data.type] || '入库', [COL.stock_io.qty]: data.qty,
        [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(), [COL.stock_io.note]: data.note || ''
      }),
      addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: data.type === 'in' ? '入库登记' : '出库登记', [COL.logs.target]: matId, [COL.logs.result]: '成功'
      })
    ])
    return {}
  })
}

// 出入库流水账（最近 N 条，倒序）
// ⚠️ 真实文档 stock_io 表里存在历史脏数据：早期版本列名不匹配时写入的行只有「数量=1」，
//    物品ID/方向/操作人全空。此处过滤掉，避免流水账里出现无法解释的空行。
async function listStockIO(data) {
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const recs = await getRecords('stock_io')
  const rows = []
  for (const r of recs) {
    const f = r.fields
    const item = f[COL.stock_io.item] || ''
    const dir = f[COL.stock_io.dir] || ''
    if (!item || !dir) continue                    // 跳过脏数据行
    rows.push({
      id: f[COL.stock_io.id] || '',
      item,
      dir,
      qty: Number(f[COL.stock_io.qty]) || 0,
      op: f[COL.stock_io.op] || '',
      time: f[COL.stock_io.time] || '',
      note: f[COL.stock_io.note] || ''
    })
  }
  rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
  // 附上物品名，便于列表直接显示
  const mats = await getRecords('materials')
  const nameMap = {}
  for (const r of mats) nameMap['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
  rows.forEach(r => { r.itemName = nameMap[r.item] || r.item })
  return { data: rows.slice(0, limit) }
}

// 借工具
async function borrow(data) {
  return withWriteLock(async () => {
    const no = genNo('B')
    await addRecord('borrow', {
      [COL.borrow.id]: no, [COL.borrow.user]: data.user, [COL.borrow.tool]: data.toolId,
      [COL.borrow.out]: now(), [COL.borrow.plan]: '', [COL.borrow.in]: '', [COL.borrow.status]: '借出中'
    })
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === ('' + data.toolId))
    if (tools[0]) await updateRecord('tools', tools[0].recordId, { [COL.tools.status]: '借出', [COL.tools.holder]: data.user })
    await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.user, [COL.logs.op]: '借出工具', [COL.logs.target]: data.toolId, [COL.logs.result]: '借出中' })
    return {}
  })
}

// 还工具
async function returnTool(data) {
  return withWriteLock(async () => {
    const list = await getRecords('borrow', r =>
      ('' + r.fields[COL.borrow.tool]) === ('' + data.toolId) && ('' + r.fields[COL.borrow.status]) === '借出中')
    const rec = list[0]
    if (!rec) throw new Error('借还记录不存在或已归还：' + data.toolId)
    await updateRecord('borrow', rec.recordId, { [COL.borrow.status]: '已归还', [COL.borrow.in]: now() })
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === ('' + data.toolId))
    if (tools[0]) await updateRecord('tools', tools[0].recordId, { [COL.tools.status]: '在库', [COL.tools.holder]: '' })
    await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '归还工具', [COL.logs.target]: data.toolId, [COL.logs.result]: '已归还' })
    return {}
  })
}

// 门禁记录（ESP32 阶段二调用）
async function access(data) {
  await addRecord('access', {
    [COL.access.id]: genNo('A'), [COL.access.user]: data.user || data.actor,
    [COL.access.point]: data.door || '实训室门', [COL.access.time]: now(),
    [COL.access.result]: data.result || '开门'
  })
  return {}
}

// 使用概况：聚合 logs / access，统计哪些老师用了、各角色活跃度
async function usage() {
  const logs = await getRecords('logs')
  const accesses = await getRecords('access')
  const users = (await getRecords('users')).map(r => normUser(r.fields))
  const userMap = {}
  users.forEach(u => { userMap[u.id] = u })

  const byUser = {}
  const bump = (uid, time) => {
    const k = '' + uid
    if (!byUser[k]) byUser[k] = { n: 0, last: time }
    byUser[k].n++
    if (time && (!byUser[k].last || time > byUser[k].last)) byUser[k].last = time
  }
  logs.forEach(l => bump(l.fields[COL.logs.actor], l.fields[COL.logs.time]))
  accesses.forEach(a => bump(a.fields[COL.access.user], a.fields[COL.access.time]))

  const rank = Object.keys(byUser).map(uid => ({
    user: userMap[uid] || { id: uid, name: uid, role: '?', cls: '' },
    n: byUser[uid].n, last: byUser[uid].last
  })).sort((a, b) => b.n - a.n)

  const teachers = users.filter(u => u.role === 'teacher')
  const teacherActive = teachers.filter(t => byUser[t.id]).length

  return {
    total: logs.length + accesses.length,
    activeUsers: Object.keys(byUser).length,
    teacherActive, teacherTotal: teachers.length,
    rank
  }
}

// 全量快照：H5 轻量页面用一条请求拉取所有表，再在本地渲染。
// 返回的字段形状与 H5 原型（前端视图）一致，避免前端做翻译。
async function snapshot() {
  const [users, materials, tools, requisitions, borrow, stock_io, access, logs] = await Promise.all([
    getRecords('users'), getRecords('materials'), getRecords('tools'),
    getRecords('requisitions'), getRecords('borrow'), getRecords('stock_io'),
    getRecords('access'), getRecords('logs')
  ])
  // 用户与角色：对齐 adminListUsers 的富形态（含 rid / bound，不下发 openid），并附角色汇总，
  // 使全量快照成为管理员的系统全景入口（与「用户与角色」管理页同源）。
  const userList = users
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id, name: u.name, role: u.role, cls: u.cls,
        status: u.status,
        bound: !!(u.openid && ('' + u.openid).trim())
      }
    })
    .filter(u => !!(u.id && ('' + u.id).trim())) // 跳过完全空白的行
  const usersByRole = userList.reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc }, {})
  return {
    users: userList,
    usersByRole,
    materials: materials.map(r => ({ ...normMaterial(r.fields), qr: r.fields[COL.materials.id] })),
    tools: tools.map(r => normTool(r.fields)),
    requisitions: requisitions.map(r => normReq(r.fields)),
    borrow: borrow.map(r => normBorrow(r.fields)),
    stock_io: stock_io.map(r => normStockIO(r.fields)),
    access: access.map(r => normAccess(r.fields)),
    logs: logs.map(r => normLog(r.fields))
  }
}

// ============================================================
// 导出
// ============================================================
module.exports = {
  TABLE, CFG, COL, TR, runtimeInfo, warmFieldMaps,
  getToken, authorizeWithCode, callSmart, callApi, getFieldMap, buildValues,
  getRecords, addRecord, updateRecord, deleteRecordByIds, getItem,
  invalidateCache, cacheStats,
  listMaterials, listTools, listMine, listPending,
  findUser, listUsers, ensureOpenIdColumn, bindOpenId, findUserByOpenId, whoami, bindLogin,
  adminListUsers, adminUpsertUser, adminDeleteUser,
  requisition, toolRequisition, approve, io, borrow, returnTool, access, usage, snapshot,
  addMaterial, listStockIO
}

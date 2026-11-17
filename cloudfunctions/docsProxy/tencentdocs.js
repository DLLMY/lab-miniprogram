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
  logs: 'tzomXO',
  // 以下三表为「实训室归属管理体系」新增的云库专属集合，腾讯文档无对应源表（已切云库，不会走腾讯文档路径）。
  // 占位 ID 仅为满足 TABLE 契约；若 DATA_BACKEND=tencent 时调用将因无对应 sheet 而报错，属预期（切云后不应回退到腾讯文档）。
  labs: 'labs',
  repairs: 'repairs',
  inspections: 'inspections'
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
// access_token 剩余天数（拿不到/解析失败返回 -1）。仅对「个人开发者凭证」模型有意义：
// 该模型 30 天到期后需到控制台点「重置」并把新值更新到 TENCENT_DOCS_ACCESS_TOKEN，无自动刷新；
// 走 REFRESH_TOKEN 模型时此环境变量为空，返回 -1（前端不告警）。
function tokenDaysLeft() {
  try {
    const p = String(process.env.TENCENT_DOCS_ACCESS_TOKEN || '').split('.')[1]
    if (!p) return -1
    const json = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    if (!json || !json.exp) return -1
    return Math.floor((json.exp * 1000 - Date.now()) / 86400000)
  } catch (e) { return -1 }
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
    tokenDaysLeft: tokenDaysLeft(),
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
// —— 数据域（班级）行级隔离引擎：与 clouddb.js 共用同一份裁决 ——
const ds = require('./data-scope.js')

const COL = {
  users: { id: '用户ID', name: '姓名', role: '角色', cls: '班级', status: '状态', openid: '微信OpenID', robotKeyHash: '机器人密钥哈希', managedClasses: '带班班级' },
  materials: { id: '耗材ID', name: '名称', spec: '规格', cat: '类别', loc: '存放位置', stock: '当前库存', unit: '单位', safe: '预警线', status: '状态', expire: '有效期' },
  tools: { id: '工具ID', name: '名称', spec: '规格', loc: '存放位置', status: '状态', holder: '当前持有人' },
  // 以下 7 张流水表带「归属班级」列，由 data-scope 在 addRecord 时自动继承发起人班级。
  // 注意：buildValues 对表里不存在的列会 warn 并跳过 → 腾讯文档未手工加列时自动退化为「不隔离」，
  // 不会破坏现有功能；加列后隔离即刻生效（见 docs/数据域隔离设计.md）。
  // 「借期天数」列需在腾讯文档申请表手工添加；未添加时 buildValues 跳过 → 借期回落默认 7 天
  // 「交付时间」列需在腾讯文档申请表手工添加；未添加时 buildValues 跳过该列 →
  // 交付状态记不住（其余功能不受影响，与「借期天数」同样的降级策略）。
  requisitions: { id: '申请ID', user: '申请人ID', item: '物品ID', type: '物品类型', qty: '数量', reason: '用途说明', status: '状态', time: '申请时间', approver: '审批人', reject: '驳回原因', days: '借期天数', cls: '归属班级', delivered: '交付时间' },
  // 「借出备注」「归还验收备注」两列需在腾讯文档借还表手工添加；未添加时 buildValues 会跳过该列，
  // 备注存不进去但不影响其他功能（与「归属班级」列同样的降级策略）。
  borrow: { id: '借还ID', user: '借用人ID', tool: '工具ID', out: '借出时间', plan: '计划归还', in: '实际归还', status: '状态', note: '借出备注', backNote: '归还验收备注', cls: '归属班级' },
  stock_io: { id: '流水ID', item: '物品ID', dir: '方向', qty: '数量', op: '操作人', time: '操作时间', note: '备注', src: '来源类型', cls: '归属班级' },
  access: { id: '记录ID', user: '用户ID', point: '门禁点', time: '刷卡时间', result: '结果', cls: '归属班级' },
  logs: { id: '日志ID', time: '时间', actor: '操作人', op: '操作类型', target: '对象', result: '结果', cls: '归属班级' },
  // 实训室归属管理体系（云库专属，字段用英文 key 与 clouddb 恒等映射；腾讯文档无对应中文列）
  labs: {
    id: 'id', name: 'name', campus: 'campus', building: 'building', floor: 'floor', roomNo: 'roomNo',
    address: 'address', lng: 'lng', lat: 'lat',
    managerId: 'managerId', managerName: 'managerName',
    status: 'status', note: 'note', createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  repairs: {
    id: 'id', labId: 'labId', labName: 'labName', title: 'title', category: 'category', desc: 'desc',
    reporterId: 'reporterId', reporterName: 'reporterName',
    status: 'status', priority: 'priority', handlerId: 'handlerId', handlerName: 'handlerName',
    resolvedNote: 'resolvedNote', createdAt: 'createdAt', updatedAt: 'updatedAt', cls: 'cls'
  },
  inspections: {
    id: 'id', labId: 'labId', labName: 'labName', title: 'title', planDate: 'planDate',
    executorId: 'executorId', executorName: 'executorName',
    status: 'status', result: 'result', createdAt: 'createdAt', doneAt: 'doneAt', cls: 'cls'
  }
}

// 角色契约：normUser/adminUpsertUser/identity.normalizeRole 共用，任何脏值回落 student
// 层级：super(超级管理员) > admin(管理员) > teacher(教师) > student(学生)
const ROLES = ['student', 'teacher', 'admin', 'super']
const SUPER = 'super'
const ADMIN = 'admin'
// 角色层级：super(3) > admin(2) > teacher(1) > student(0)
// 创建/管理/删除权限按「调用者层级」裁决：super 可操作任意角色，其余仅可操作「严格低于自身层级」的角色
//   → 管理员只能建 教师/学生；教师只能建 学生（详见 decideUserWrite / decideUserDelete）
const ROLE_LEVEL = { student: 0, teacher: 1, admin: 2, super: 3 }

// —— 数量解析：必须是范围内的整数 ——
// 为什么不再用 Math.floor(Number(x) || 0)：
//   ① 小数 2.5 被静默截断成 2 —— 账面按 2 记、实物给 2.5，账实差 0.5，
//      而提示文案写着「必须是整数」却放行了小数（校验与文案不符）；
//   ② 建档/导入原用 Number(x) || 0（完全不取整），小数直接进库存，
//      而演示 mock 会截断 → 生产与演示行为分叉（库存口径不一致）。
// 上限：误输 1e12 会把库存写成天文数字，导出 Excel（15 位有效数字）直接失真。
const MAX_QTY = 1000000
function parseQty(v, min) {
  const n = Number(v)
  const lo = (min === undefined) ? 1 : min
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n < lo || n > MAX_QTY) return null
  return n
}

// 中英状态翻译（腾讯文档存中文，前端用英文名；这里双向映射）
const TR = {
  reqFwd: { pending: '待审批', approved: '已通过', rejected: '已拒绝', canceled: '已撤销' },
  // 反向映射要容忍历史/手写数据的多种写法：表里同时存在「通过/已通过」「拒绝/已拒绝」
  reqRev: {
    '待审批': 'pending', '待审核': 'pending', '审批中': 'pending',
    '已通过': 'approved', '通过': 'approved', '同意': 'approved', '已同意': 'approved',
    '已拒绝': 'rejected', '拒绝': 'rejected', '不同意': 'rejected', '已驳回': 'rejected',
    // 已撤销：申请人主动撤回后进入此终态，不可再审批
    '已撤销': 'canceled', '撤销': 'canceled', '已撤回': 'canceled'
  },
  borrowFwd: { out: '借出中', returned: '已归还' },
  borrowRev: { '借出中': '借出', '已归还': '已还' },
  ioFwd: { in: '入库', out: '出库' },
  ioRev: { '入库': 'in', '出库': 'out' },
  role: { '学生': 'student', '教师': 'teacher', '管理员': 'admin', '超级管理员': 'super', 'student': 'student', 'teacher': 'teacher', 'admin': 'admin', 'super': 'super' },
  // 英文角色 → 中文存储（腾讯文档「角色」列存中文；normUser 反向读回英文）
  roleFwd: { student: '学生', teacher: '教师', admin: '管理员', super: '超级管理员' }
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
    // 生产云函数运行时（Node 18+）实际走这条，必须自带超时：
    // 下方 http.request 回退路径的 timeout 在这里不生效，弱网悬挂会把云函数耗到平台超时。
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20000)
    return fetch(url, Object.assign({}, opts, { signal: ac.signal })).then(async (res) => {
      clearTimeout(timer)
      return { status: res.status, text: await res.text() }
    }).catch((e) => {
      clearTimeout(timer)
      throw e && e.name === 'AbortError' ? new Error('请求超时：' + url) : e
    })
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
    if (r.status === 401) {
      // 重试后仍 401。个人开发者凭证模型下 access_token 30 天到期，刷新拿到的还是同一个
      // 静态值，必然再 401——此时一句「HTTP 401」会让人无从下手，直接给出可操作提示。
      const left = tokenDaysLeft()
      throw new Error(`smartbook ${action} 失败 HTTP 401：access_token 无效或已过期`
        + (left >= 0 ? `（当前 token 剩余 ${left} 天）` : '')
        + '。请到腾讯文档开放平台控制台重置 token，并更新云函数环境变量 TENCENT_DOCS_ACCESS_TOKEN')
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
// 必须按北京时间（UTC+8）格式化：容器 TZ=UTC，直接用 getFullYear/getHours 会让流水、借还、
// 申请时间一律比用户感知慢 8 小时（与 now() 同一偏移，保证写入-读回显示一致）。
function fmtTs(v) {
  if (v === '' || v == null) return ''
  const s = '' + v
  if (/^\d{10,}$/.test(s)) {
    const d = new Date(Number(s) + 8 * 3600 * 1000)
    if (isNaN(d.getTime())) return s
    const p = n => ('' + n).padStart(2, '0')
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
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
// 带 TTL：用户在腾讯文档里给表加/改列后，热容器原来要等重启才能识别新列（buildValues 会
// 静默跳过未知列 → 新列数据丢失）。10 分钟摊销一次 getFields 的成本，换取 schema 变更自动生效。
const _fieldMapCache = {}          // sheetKey -> { map, at }
const FIELD_MAP_TTL = 10 * 60 * 1000
// 返回 { 列名: { id, type } }；type: 1=文本 2=数字 3=复选框 4=日期 9=选项 ...
async function getFieldMap(sheetKey) {
  const c = _fieldMapCache[sheetKey]
  if (c && Date.now() - c.at < FIELD_MAP_TTL) return c.map
  const map = {}
  let offset = 0
  let guard = 0
  while (true) {
    if (++guard > 100) { console.warn('[tencentdocs] getFields 分页异常退出：' + sheetKey); break }
    const page = await callSmart(sheetKey, CFG.ACT.getFields, { offset, limit: 100 })
    const fields = page.fields || []
    for (const f of fields) {
      const id = f.fieldID || f.fieldId
      const title = f.fieldTitle || f.fieldName
      if (id && title) map[title] = { id, type: f.fieldType }
    }
    if (!page.hasMore || !fields.length) break
    offset = nextOffset(page, offset, fields.length)
  }
  _fieldMapCache[sheetKey] = { map, at: Date.now() }
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
    if (Array.isArray(value)) { values[title] = value; continue }        // 调用方给出最终 payload（清空字段等特殊写法直接透传）
    if (meta.type === 2) values[title] = Number(value) || 0
    else if (meta.type === 3) values[title] = !!value
    else if (meta.type === 4) {
      // 空日期必须跳过：否则下面会把「计划归还/实际归还」等空值填成当前时间戳，
      // 导致还没归还的借出记录在表里显示一个假的归还时间。
      const s = String(value).trim()
      if (!s) continue
      values[title] = /^\d{10,}$/.test(s) ? s : String(Date.now())
    }
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
// 全局写入序号：每次 invalidateCache 自增。读请求在拉取前后各取一次快照，若期间发生过写，
// 说明本次拉到的分页可能横跨写入前后（前面的页是写前状态、后面的页是写后状态）——这种
// 混合快照照常返回（等价于一次无锁直读），但绝不回填缓存，否则之后 TTL 内的读全拿到陈旧值。
let _writeSeq = 0
const CACHE_TTL = 10000           // 10s：跨页面切换仍可复用；宁可多花点 API 配额（限 150 次/分钟/fileID），
//                             也要压缩「A 设备刚写入、B 设备仍读到旧值」的窗口——用户两次报「没刷新」的体制性原因之一。
const CACHE_MAX_ROWS = 3000       // 超过此行数不缓存（缓存内存吃不消，且大表本就该走 DB）
const _oversizeWarned = {}        // 超限告警去重：每表每进程只警告一次

// 分页游标推进：next 为 0 / 回退 / 非数字时按「已取行数」推进。
// 防止平台返回 next=0 时 offset 不增长 → 同一页反复请求 → 死循环吃满配额。
function nextOffset(page, cur, count) {
  const n = page && page.next
  if (typeof n === 'number' && n > cur) return n
  return cur + count
}

// 数据域读过滤：缓存里永远存「全量」，按当前请求 scope 在返回时过滤。
// opts.noScope=true 供跨班写守卫读取原始记录，避免把「无权」误报成「记录不存在」。
function applyScope(sheetKey, o, rows) {
  const scope = ds.currentScope()
  if (o && o.noScope) return rows
  if (!ds.needGuard(scope) || !ds.isScopedTable(sheetKey)) return rows
  return rows.filter(r => ds.rowVisible(scope, sheetKey, r.fields || r))
}

async function getRecords(sheetKey, filterFn, opts) {
  const o = opts || {}
  const useCache = !o.noCache && !o.fieldTitles && !o.recordIDs
  const now = Date.now()

  // 命中缓存：直接过滤返回
  if (useCache) {
    const hit = _cache.get(sheetKey)
    if (hit && (now - hit.at) < CACHE_TTL) {
      _cacheStats.hit++
      return applyScope(sheetKey, o, filterFn ? hit.data.filter(filterFn) : hit.data)
    }
  }
  _cacheStats.miss++

  // 精确取行：用 recordIDs 直接定位，1 次请求代替全表扫描
  if (o.recordIDs && o.recordIDs.length) {
    const page = await callSmart(sheetKey, CFG.ACT.getRecords, { recordIDs: o.recordIDs })
    return applyScope(sheetKey, o, (page.records || []).map(recToFields))
  }

  const all = []
  let offset = 0
  let guard = 0
  // 拉取前的写入序号：拉取过程中若有写入（invalidate 会自增），分页可能横跨写前/写后，
  // 结束时比对，不一致则放弃回填缓存（见 _writeSeq 注释）
  const seqAtStart = _writeSeq
  const params = { offset, limit: CFG.PAGE }
  // 只取需要的列：响应体大幅缩小，也减少服务端解析压力
  if (o.fieldTitles && o.fieldTitles.length) params.fieldTitles = o.fieldTitles
  while (true) {
    if (++guard > 500) { console.warn('[tencentdocs] getRecords 分页异常退出：' + sheetKey); break }
    const page = await callSmart(sheetKey, CFG.ACT.getRecords, params)
    const raw = page.records || []
    if (!raw.length) break
    const norm = raw.map(recToFields)
    all.push(...norm)
    if (!page.hasMore) break
    offset = nextOffset(page, offset, raw.length)
    params.offset = offset
  }
  const result = filterFn ? all.filter(filterFn) : all
  // 缓存未过滤的全量，供后续不同 filter 复用。
  // 写入序号在拉取期间变过 → 混合快照，不缓存（宁可下次重拉，也不把陈旧数据续命一个 TTL）。
  if (useCache && all.length <= CACHE_MAX_ROWS && _writeSeq === seqAtStart) _cache.set(sheetKey, { data: all, at: now })
  else if (useCache && all.length <= CACHE_MAX_ROWS) _cacheStats.skippedStale++
  // 超大表不缓存：每次都全表分页扫描（100 行/页）。日志表增长最快，超限时告警一次，
  // 提醒运维归档历史数据，而不是让 API 配额在无声中被吃满。
  else if (all.length > CACHE_MAX_ROWS && !_oversizeWarned[sheetKey]) {
    _oversizeWarned[sheetKey] = true
    console.warn(`[tencentdocs] 表 ${sheetKey} 已 ${all.length} 行（>${CACHE_MAX_ROWS}），不缓存：后续每次读都会全表分页扫描，建议归档历史数据`)
  }
  return applyScope(sheetKey, o, result)
}

// 写操作后失效对应表的缓存（保证下次读到最新数据）
function invalidateCache(sheetKey) {
  _writeSeq++
  if (sheetKey) _cache.delete(sheetKey)
  else _cache.clear()
}

// 缓存观测：命中/未命中计数，便于评估 API 配额压力
const _cacheStats = { hit: 0, miss: 0, apiCalls: 0, skippedStale: 0 }
function cacheStats() {
  return Object.assign({}, _cacheStats, {
    cachedTables: Array.from(_cache.keys()),
    ttl: CACHE_TTL
  })
}

// 跨班写守卫：读原始（未过滤）记录判断，避免把「无权」误报成「记录不存在」。
async function __assertWritable(sheetKey, ids) {
  const scope = ds.currentScope()
  if (!ds.needGuard(scope) || !ds.isScopedTable(sheetKey)) return
  let all = []
  try { all = await getRecords(sheetKey, null, { noCache: true, noScope: true }) } catch (e) { return }
  for (const id of ids) {
    const row = all.find(r => r.recordId === id)
    if (row && !ds.canWriteRow(scope, sheetKey, row.fields || row)) {
      throw new ds.ScopeDeniedError('无权操作其他班级的数据')
    }
  }
}

async function addRecord(sheetKey, fieldsMap) {
  const scope = ds.currentScope()
  // 流水表自动继承发起人归属班级（buildValues 对不存在的列自动跳过，旧表结构不受影响）
  if (ds.shouldStampCls(scope, sheetKey) && COL[sheetKey] && COL[sheetKey].cls) {
    const k = COL[sheetKey].cls
    if (fieldsMap[k] === undefined || fieldsMap[k] === null || fieldsMap[k] === '') {
      fieldsMap[k] = scope.ownerCls || ''
    }
  }
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

// 写操作幂等窗口：同一操作人在窗口期内对同一目标的同参数写入只执行第一笔，
// 后续重复提交 await 第一笔的 Promise 并原样返回其结果（成功即成功、失败即失败）。
// 场景：前端 busy 守卫失效时服务端兜底——旧版本包、个别机型 setData 竞态、
// 弱网下用户反复点提交，都会让同一笔业务被发往云函数两次。库存/流水这类
// 「无状态机屏障」的数值写，双发即双倍扣减（2026-10-24 真机曾出现 6 笔成对写入）。
// 说明：
//   1) 第一笔业务失败（抛错或返回 code≠0）立即释放窗口——用户修正参数重试不受影响；
//   2) 窗口期内重复提交复用首次结果：io 得到与首次一致的成功响应，
//      addMaterial 得到首次的 { id, ... }，前端提示与单次提交完全一致；
//   3) Map 惰性清理，条目数有上限，不会随运行时间无限增长；
//   4) 腾讯文档侧多实例并发时本 Map 是实例级内存态，存在极小跨实例漏网概率——
//      正常业务量下单实例即可覆盖，属可接受的兜底而非硬保证。
// ⚠ 窗口长度要覆盖「用户看到失败提示 → 反应过来 → 再点一次」的间隔：
//   弱网/超时后请求其实已到达服务器并执行了，用户看不到结果会再点一次 → 重复执行。
//   5 秒太短（人反应不过来），30 秒能覆盖绝大多数重试。
//   命中时会给结果挂 idem 标记，前端明确提示「重复提交已忽略」，不会假装做了两次。
const IDEM_WINDOW_MS = 30000
const _recentWrites = new Map()
async function withWriteIdem(key, fn) {
  const now = Date.now()
  const hit = _recentWrites.get(key)
  if (hit && now - hit.t < IDEM_WINDOW_MS) {
    // ⚠ 命中幂等窗口时不能原样返回上次的"成功"结果 ——
    //   老师会看到"入库成功"两次，实际只入了一次（静默丢库存，且毫无提示）。
    //   这里挂上 idem/deduped 标记 + 明确文案，由前端提示"重复提交已忽略"。
    //   注意：这正是防"双击/弱网重试"的设计本意（那种情况返回同一结果是对的），
    //   关键是不能假装"做了两次"。
    const p = hit.p.then(r => {
      // 注意：适配器内部的返回值有两种形态 —— 业务失败是 {code:400,data:{msg}}，
      // 成功则是【裸载荷】（如 {} 或 {no,id}，没有 code 字段），code:0 是外层包装时才加的。
      // 所以这里不能用 r.code === 0 判定成功，否则永远不成立、标记永远挂不上。
      const bizFail = !!(r && typeof r === 'object' && r.code && r.code >= 400)
      if (r && typeof r === 'object' && !bizFail) {
        // 标记同时放在顶层与 data 里：各 action 的载荷位置不统一
        // （有的直接是业务对象，有的包在 data 里），只放一处会读不到。
        const mark = {
          idem: true, deduped: true,
          warn: '检测到重复提交（相同内容），本次未重复执行'
        }
        const out = Object.assign({}, r, mark)
        if (r.data && typeof r.data === 'object') out.data = Object.assign({}, r.data, mark)
        return out
      }
      return r
    })
    p.catch(() => {})
    return p
  }
  if (_recentWrites.size > 500) {
    for (const [k, v] of _recentWrites) if (now - v.t >= IDEM_WINDOW_MS) _recentWrites.delete(k)
  }
  const entry = { t: now, p: null }
  entry.p = (async () => {
    const r = await fn()
    if (r && r.code) _recentWrites.delete(key)
    return r
  })().catch(e => { _recentWrites.delete(key); throw e })
  _recentWrites.set(key, entry)
  entry.p.catch(() => {})
  return entry.p
}

// 按 recordID 批量删除（用于清理写测试产生的脏数据：如申请人ID 为空的领用单）
// ⚠️ smartbook v2 的 deleteRecords 入参是 { recordIDs: [string,...] }（复数、字符串数组），
//    不是 { records: [{recordID}] }，后者服务端会 ret=0 但静默不删。
// —— 原子条件更新（CAS·降级版）——
// 腾讯文档的表格 API 只能「整行读改写」，没有 where 条件更新 → 做不了真正的原子 CAS。
// 这里退化为「条件校验 + 写入」：单实例内靠 withWriteLock 串行，跨实例仍可能丢更新
//   （这是平台限制，不是本项目的实现问题）。
// ⚠ 生产主后端是【云数据库】，那里的 casUpdate 是真 CAS（where 条件更新 + 原子自增）；
//   腾讯文档只是回退兜底。这里保留同名同签名的函数，是为了让两套适配器的业务代码保持同构。
async function casUpdate(sheetKey, recordId, condition, fieldsMap) {
  const list = await getRecords(sheetKey, r => r.recordId === recordId)
  const rec = list[0]
  if (!rec) return { ok: false, updated: 0 }
  // 条件校验：condition 的键是英文字段名，需翻译成腾讯文档的中文列名
  const colMap = COL[sheetKey] || {}
  const match = Object.keys(condition || {}).every(k => {
    const cnKey = colMap[k] || k
    const got = rec.fields[cnKey]
    return ('' + (got === undefined || got === null ? '' : got)) === ('' + condition[k])
  })
  if (!match) return { ok: false, updated: 0 }
  await updateRecord(sheetKey, recordId, fieldsMap)
  return { ok: true, updated: 1 }
}

// 原子增减库存（降级版）：读 → 算 → 条件写入，条件不匹配则重读重试
async function atomicAdjustStock(recordId, delta, tries) {
  const maxTry = tries || 4
  for (let i = 0; i < maxTry; i++) {
    const list = await getRecords('materials', r => r.recordId === recordId)
    const rec = list[0]
    if (!rec) return { ok: false, reason: 'missing' }
    const cur = Number(rec.fields[COL.materials.stock]) || 0
    const next = cur + delta
    if (next < 0) return { ok: false, reason: 'insufficient', stock: cur }
    const r = await casUpdate('materials', recordId, { stock: cur }, { [COL.materials.stock]: next })
    if (r.ok) return { ok: true, stock: next }
  }
  return { ok: false, reason: 'conflict' }
}

// 原子切换工具状态（降级版）：状态仍等于期望值才改
async function atomicSwitchToolStatus(recordId, fromStatus, toStatus, extraFields) {
  const fields = Object.assign({ [COL.tools.status]: toStatus }, extraFields || {})
  // 平台差异：腾讯文档清空一个文本列必须写 [{type:'text',text:''}]，写空字符串等于"不修改"
  if (fields[COL.tools.holder] === '') fields[COL.tools.holder] = [{ type: 'text', text: '' }]
  const r = await casUpdate('tools', recordId, { status: fromStatus }, fields)
  return r.ok
}

async function deleteRecordByIds(sheetKey, ids) {
  const list = (ids || []).filter(Boolean)
  if (!list.length) return 0
  await __assertWritable(sheetKey, list)
  await callSmart(sheetKey, CFG.ACT.deleteRecords, { recordIDs: list })
  invalidateCache(sheetKey)
  // 删后回读确认（平台存在 ret=0 但静默不删的行为，见上方注释）：行还在就重删一次，
  // 仍不过抛错——避免「提示删除成功，用户与角色页刷新后行还在」。
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rows = await getRecords(sheetKey, r => list.indexOf(r.recordId) >= 0, { noCache: true })
    if (!rows.length) return list.length
    if (attempt === 1) {
      try { await callSmart(sheetKey, CFG.ACT.deleteRecords, { recordIDs: list }) } catch (e) { /* 下一轮再验 */ }
      invalidateCache(sheetKey)
    }
  }
  throw new Error('删除未生效（' + sheetKey + ' × ' + list.length + ' 行）。请到腾讯文档手动删除对应行')
}

async function updateRecord(sheetKey, recordId, fieldsMap) {
  await __assertWritable(sheetKey, [recordId])
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
// 效期（有效期）转换：'YYYY-MM-DD' → 该日 23:59:59（北京时间）的 epoch 毫秒。
// 统一放在服务端：前端传本地时区字符串会差一天；到期日当天仍算有效，次日才算过期。
// 效期解析：支持 YYYY-MM-DD / YYYY/M/D / YYYY年M月D日 / YYYYMMDD，
// 并校验「真实日期」——2026-02-30 这种会被 Date.UTC 自动进位到 3-02，
// 看起来像设了一个月后的效期，实际比用户填的晚了 2 天。
// 返回 { ts }（空值=无限制）或 null（格式非法，调用方必须明确报错，不能静默丢弃）。
function expireTs(v) {
  const s = ('' + (v || '')).trim()
  if (!s) return { ts: 0 }
  const mk = (y, mo, d) => {
    if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate()   // 该月实际天数
    if (d > dim) return null
    return { ts: Date.UTC(y, mo - 1, d, 15, 59, 59) }      // 15:59:59 UTC == 23:59:59 +08:00
  }
  // 纯数字 8 位：YYYYMMDD（Excel 里最常见的日期形态）
  if (/^\d{8}$/.test(s)) return mk(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8))
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) return mk(+m[1], +m[2], +m[3])
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return { ts: n }
  return null
}

function normMaterial(f) {
  const expTs = Number(f[COL.materials.expire]) || 0
  const ms = expTs ? (expTs - Date.now()) : null
  // 近效期阈值 30 天：过期/临期在服务端算好下发，前端直接渲染，避免各页各算一套时区口径
  const DAYS = 86400000
  return {
    id: f[COL.materials.id], name: f[COL.materials.name], spec: f[COL.materials.spec] || '',
    cat: f[COL.materials.cat] || '', loc: f[COL.materials.loc] || '',
    stock: Number(f[COL.materials.stock]) || 0, unit: f[COL.materials.unit] || '',
    safe: Number(f[COL.materials.safe]) || 0, status: f[COL.materials.status] || '',
    // 有效期（P3-㉕）：电池、焊锡丝、化学试剂这类有明确保质期的耗材，
    // 没有效期字段就只能靠人记住"这批快过期了"。
    expire: expTs ? fmtTs(f[COL.materials.expire]) : '',
    expired: !!(expTs && ms < 0),
    expiring: !!(expTs && ms >= 0 && ms <= 30 * DAYS)
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
    // 借期：老单没有这一列时为空，前端显示"默认 7 天"
    days: Number(f[COL.requisitions.days]) || 0,
    // 用途与驳回原因：审批页据此展示"为什么领"，我的申请据此展示"为什么被拒"
    reason: f[COL.requisitions.reason] || '', reject: f[COL.requisitions.reject] || '',
    status: TR.reqRev[f[COL.requisitions.status]] || f[COL.requisitions.status] || '',
    time: fmtTs(f[COL.requisitions.time]) || '',
    cls: ds.readCls(f)
  }
}
function normBorrow(f) {
  const status = TR.borrowRev[f[COL.borrow.status]] || f[COL.borrow.status] || ''
  const planTs = Number(f[COL.borrow.plan]) || 0
  return {
    id: f[COL.borrow.id], user: f[COL.borrow.user], toolId: f[COL.borrow.tool],
    out: fmtTs(f[COL.borrow.out]) || '',
    // 计划归还：此前该列恒为空（没有借期概念），借用可以无限期拖着无人催。
    // 现在借出即写应还时间，列表/我的申请据此标"已逾期"。
    plan: fmtTs(f[COL.borrow.plan]) || '', in: fmtTs(f[COL.borrow.in]) || '',
    status,
    // 借出备注（用途/临时说明）与归还验收备注：老数据没有这两列时为空，不影响既有渲染
    note: f[COL.borrow.note] || '',
    backNote: f[COL.borrow.backNote] || '',
    // 逾期判定统一在服务端做（避免各端各算一套时区口径）：仅在"仍借出中且已过应还时间"成立
    overdue: status === '借出' && planTs > 0 && Date.now() > planTs,
    cls: ds.readCls(f)
  }
}
function normUser(f) {
  // id/name 在源头 trim：users 表是手工维护的，工号带空格会让 whoami 下发的身份与
  // adminUpsertUser（trim 后写入）不一致，进而 listMine/usage 按工号比对时历史记录"消失"。
  // 角色强制收敛到三值契约：表里出现脏值（如"校长"）时回落 student，与前端 normalizeRole 一致，
  // 绝不下发契约外的角色字符串（前端角色判断/标签都按三值设计）。
  const role = TR.role[f[COL.users.role]]
  return {
    id: ('' + (f[COL.users.id] || '')).trim(),
    name: ('' + (f[COL.users.name] || '')).trim(),
    role: (ROLES.indexOf(role) >= 0 ? role : 'student'),
    cls: ('' + (f[COL.users.cls] || '')).trim(),
    // 老师带班列表（腾讯文档文本列可能是数组，统一用 readText 归一化）
    managedClasses: ds.sanitizeManagedClasses(ds.readText(f, COL.users.managedClasses)),
    status: ('' + (f[COL.users.status] || '')).trim(),
    openid: ('' + (f[COL.users.openid] || '')).trim(),
    robotKeyHash: ('' + (f[COL.users.robotKeyHash] || '')).trim()
  }
}
// 冲销产生的反向流水（src=冲销 / note=冲销流水…）本身不可再冲销，
// 否则会无限反向回滚库存；报表同样已排除这两类流水。
function isSettledFlow(f) {
  const note = '' + (f[COL.stock_io.note] || '')
  const src = '' + (f[COL.stock_io.src] || '')
  // ⚠ 判定必须精确，不能用「备注里含'冲销流水'」这种宽匹配：
  //   老师随手写一句「与张老师冲销流水核对无误」，这条流水就会被误判成已冲销 →
  //   ① 此后再也冲销不了 ② 被报表排除在库存统计之外 → 账实不符。
  // 锚点：src === '冲销'（反向流水，最可靠）；note 前缀 '[已冲销]'（原流水已被冲销）；
  //   反向流水的 note 形如「冲销流水 S2026...」→ 用正则精确匹配（不误伤普通备注）。
  //   src 是兜底之外的第二道保险：腾讯文档未手工加「来源类型」列时 src 恒空，
  //   这时只能靠 note 判定，所以 note 这条不能去掉，只能收紧。
  return src === '冲销'
    || /^\[已冲销\]/.test(note)
    || /^冲销流水\s+\S+$/.test(note)
}
function normStockIO(f) {
  return {
    no: f[COL.stock_io.id], matId: f[COL.stock_io.item],
    type: TR.ioRev[f[COL.stock_io.dir]] || 'in', qty: Number(f[COL.stock_io.qty]) || 0,
    operator: f[COL.stock_io.op] || '', time: fmtTs(f[COL.stock_io.time]) || '', note: f[COL.stock_io.note] || '',
    cls: ds.readCls(f), reversed: isSettledFlow(f)
  }
}
function normAccess(f) {
  return {
    // 时间列是日期类型，读回为时间戳字符串——必须过 fmtTs，否则前端直接渲染 "1792683028958"
    time: fmtTs(f[COL.access.time]) || '', actor: f[COL.access.user] || '',
    door: f[COL.access.point] || '', result: f[COL.access.result] || '',
    cls: ds.readCls(f)
  }
}
function normLog(f) {
  return {
    time: fmtTs(f[COL.logs.time]) || '', actor: f[COL.logs.actor] || '',
    op: f[COL.logs.op] || '', target: f[COL.logs.target] || '', result: f[COL.logs.result] || '',
    cls: ds.readCls(f)
  }
}

// ============================================================
// 6. 业务函数（index.js 调用，字段契约与 mock.js 完全一致）
// ============================================================
// 统一按北京时间（UTC+8）取时刻：云函数容器 TZ=UTC，直接用本地时间会让单据时间比用户
// 感知慢 8 小时（跨 0 点时 genNo 的日期段也会错一天）。当前时间列都是「日期」类型，
// buildValues 会把非时间戳值替换成 Date.now()，本函数主要兜底文本型时间列与 genNo。
// 用固定偏移而非 toLocaleString：容器可能没有 TZ 数据库，local 格式会漂移。
// 默认借期（天）：工具借出即按此推算「计划归还」，逾期判定据此进行。
// 允许调用方按场景覆写（长期外借等），但收敛在 1–90 天——防止传错参数造成"永远逾期"或"瞬间逾期"。
const DEFAULT_LOAN_DAYS = 7
function planDue(days) {
  const d = Math.min(90, Math.max(1, parseInt(days, 10) || DEFAULT_LOAN_DAYS))
  // ⚠️ 之前误写成 now() + d*86400000：now() 返回的是北京时间「字符串」，字符串+数字=拼接，
  //   得到 "2026-10-25 13:03604800000" 这种垃圾值；buildValues 写日期列时会把它替换成 Date.now()，
  //   于是「计划归还」被写成借出时刻本身 → 借出即逾期，7 天借期彻底失效。这里必须返回 epoch 毫秒。
  return Date.now() + d * 86400000
}

function nowParts() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
}
// 单号唯一性：分钟级+2位随机（90种）时，同一分钟 ~12 笔即 50% 撞号，冲销按单号查会命中错行。
// 改为「秒 + 进程内单调序号 + 2位随机」，同实例内几乎不可能撞；跨实例另有毫秒时间戳前缀。
let _genSeq = 0
function now() {
  const t = nowParts(); const q = n => ('' + n).padStart(2, '0')
  return `${t.y}-${q(t.mo)}-${q(t.d)} ${q(t.h)}:${q(t.mi)}`
}
function genNo(p) {
  const t = nowParts(); const q = n => ('' + n).padStart(2, '0')
  _genSeq = (_genSeq + 1) % 1000
  return `${p}${t.y}${q(t.mo)}${q(t.d)}${q(t.h)}${q(t.mi)}${q(t.s)}${String(_genSeq).padStart(3, '0')}${Math.floor(Math.random() * 90 + 10)}`
}

// 查单个物品（耗材 M / 工具 T），返回 {type, item:{..., rid}}
async function getItem(id, type) {
  // trim + 大写归一：扫码/手输可能带空格或小写（' t001'），不归一会掉到耗材分支查空
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const pick = async (t) => {
    const isTool = t === 'tool'
    const col = isTool ? COL.tools : COL.materials
    // 缓存命中时 0 次 API；未命中时只取需要的列，减小响应体
    const list = await getRecords(isTool ? 'tools' : 'materials',
      r => ('' + r.fields[col.id]) === key)
    const rec = list[0]
    if (!rec) return null
    const base = isTool ? normTool(rec.fields) : normMaterial(rec.fields)
    return { type: isTool ? 'tool' : 'material', item: { ...base, rid: rec.recordId } }
  }
  // 显式类型优先：搜索结果跳转时会带上 type（search 已返回 type，不必再靠猜）
  if (type === 'tool' || type === 'material') return await pick(type)
  // 未指定类型：先按「ID 首字母」猜（保持原有行为），猜不到再查另一张表。
  // ⚠ 旧实现只猜一次 → 批量建档允许自定义编号，只要编号不以 M/T 开头
  //   （如「WM-001」「仪器01」）就查不到；编号以 T 开头却不是工具的还会查到错的那张表。
  const guess = key.startsWith('T') ? 'tool' : 'material'
  return (await pick(guess)) || (await pick(guess === 'tool' ? 'material' : 'tool'))
}

async function listMaterials() {
  const list = await getRecords('materials')
  return list.map(r => normMaterial(r.fields))
}

async function listTools() {
  const list = await getRecords('tools')
  return list.map(r => normTool(r.fields))
}

// 模糊搜索：跨 materials / tools 两张表，按 id / 名称 / 规格 / 编号 / 位置做「部分匹配 + 容错」。
// 设计目标：用户输入片段（如「电阻」「M00」「10k」）即可召回候选，无需精确逐字对应；
// 对漏字、顺序错、拼音/汉字混输等常见手误也给出合理召回。返回带 score 的候选，前端按 score 降序展示。
async function search(kw) {
  const q = ('' + (kw || '')).trim().toLowerCase()
  if (!q) return []
  const [mats, tools] = await Promise.all([getRecords('materials'), getRecords('tools')])
  const out = []
  for (const r of mats) {
    const m = normMaterial(r.fields)
    const score = fuzzyScore(q, [m.id, m.name, m.spec, m.cat, m.loc, m.unit])
    if (score > 0) {
      const sub = [m.spec, m.unit, m.loc].filter(Boolean).join(' · ') || '耗材'
      out.push({ type: 'material', id: m.id, name: m.name, sub, stock: m.stock, score })
    }
  }
  for (const r of tools) {
    const t = normTool(r.fields)
    const score = fuzzyScore(q, [t.id, t.name, t.spec, t.sn, t.loc])
    if (score > 0) {
      const sub = [t.spec, t.loc].filter(Boolean).join(' · ') || '工具'
      out.push({ type: 'tool', id: t.id, name: t.name, sub, status: t.status, score })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 12)
}

// 模糊打分：综合「精确=子串=子序列=字符覆盖」四档，返回 0（不命中）或正数（越大越相关）。
function fuzzyScore(q, fields) {
  let best = 0
  for (const f of fields) {
    const s = scoreOne(q, ('' + (f || '')).trim().toLowerCase())
    if (s > best) best = s
  }
  return best
}
function scoreOne(q, t) {
  const tk = t.replace(/\s+/g, '')
  if (!tk) return 0
  if (tk === q) return 1000
  if (tk.includes(q)) return 600 - Math.min(200, Math.abs(tk.length - q.length) * 10)
  // 子序列（保留顺序、允许缺字）→ 容错漏打 / 插字
  let i = 0
  for (let j = 0; j < tk.length && i < q.length; j++) if (tk[j] === q[i]) i++
  if (i === q.length) return 300 - Math.min(200, tk.length)
  // 字符覆盖率 → 容错拼音/汉字混输、缺字（如输入「阻」即可命中「电阻器」；多数汉字正确即召回）。
  // 阈值 0.6：单字错一半（如「电租」对「电阻」）不强行命中，避免下拉出现大量无关候选项。
  let present = 0
  for (const ch of q) if (tk.indexOf(ch) >= 0) present++
  if (q.length > 1 && present >= Math.ceil(q.length * 0.6)) return 100 + present * 2
  return 0
}

async function listMine(user) {
  const u = ('' + (user || '')).trim()
  if (!u) return { requisitions: [], borrow: [] }
  // 行值也 trim：历史行可能是旧版/手工录入带空格的工号，只 trim 查询值仍匹配不上
  const rs = await getRecords('requisitions', r => ('' + (r.fields[COL.requisitions.user] || '')).trim() === u)
  const bs = await getRecords('borrow', r => ('' + (r.fields[COL.borrow.user] || '')).trim() === u)
  return { requisitions: rs.map(r => normReq(r.fields)), borrow: bs.map(r => normBorrow(r.fields)) }
}

async function listPending() {
  const list = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.status]) === '待审批')
  if (!list.length) return []
  // 名称映射：审批是老师最关键的操作界面，却只显示工号与物品ID
  // （「申请人 S001」「M001 × 2」——老师得自己查台账才知道批的是谁、领什么）。
  // 领用记录页 listClaims 早已做同样映射，两页口径必须一致；
  // 前端 approve.js 也早就写了 `item.userName || item.user` 的兼容读取，只是后端一直没给这两个字段。
  const mats = await getRecords('materials')
  const tools = await getRecords('tools')
  const users = await getRecords('users')
  const nameOf = {}
  for (const r of mats) nameOf['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
  for (const r of tools) nameOf['' + r.fields[COL.tools.id]] = r.fields[COL.tools.name] || ''
  const userOf = {}
  for (const r of users) {
    const f = r.fields
    userOf['' + (f[COL.users.id] || '')] = { name: f[COL.users.name] || '', cls: ('' + (f[COL.users.cls] || '')).trim() }
  }
  return list.map(r => {
    const q = normReq(r.fields)
    const itemId = '' + (r.fields[COL.requisitions.item] || '')
    const u = userOf['' + (r.fields[COL.requisitions.user] || '')] || {}
    return Object.assign(q, {
      itemName: nameOf[itemId] || '',
      userName: u.name || '',
      userCls: u.cls || ''
    })
  })
}

// ============================================================
// 5.5 登录鉴权（身份来源 = 云端 users 表，不再用本地 mock）
//   - findUser(工号)：老师/学生用工号登录；未录入或停用 → null
//   - listUsers()：仅管理员可调用（prodHandler 已服务端拦截非管理员），登录页不再使用
//   - openid 绑定 + whoami(openid)：首次工号登录绑定微信 openid，之后免输工号自动登录
// ============================================================
// 只回前端安全字段，openid 等内部信息不下发
function publicUser(u) {
  // managedClasses 必须透出：prodHandler 的 me 由此构造，数据域裁决依赖它
  return u ? { id: u.id, name: u.name, role: u.role, cls: u.cls, managedClasses: u.managedClasses || '' } : null
}

// 账号可用：未填状态视为可用；填了则必须为「启用」
function userEnabled(u) {
  return !u.status || u.status === '启用'
}

async function findUser(id) {
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === key)
  const rec = list[0]
  if (!rec) return null
  const u = normUser(rec.fields)
  if (!userEnabled(u)) return null
  return { rid: rec.recordId, user: publicUser(u), openid: u.openid, robotKeyHash: u.robotKeyHash }
}

// 按机器人密钥哈希反查用户（可信机器通道用）。robotKeyHash 不存在/为空的用户一律不匹配。
async function findUserByRobotKey(hash) {
  if (!hash) return null
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.robotKeyHash] || '')).trim() === ('' + hash).trim())
  const rec = list[0]
  if (!rec) return null
  const u = normUser(rec.fields)
  if (!userEnabled(u)) return null
  return { rid: rec.recordId, user: publicUser(u), openid: u.openid, robotKeyHash: u.robotKeyHash }
}

// 写入/清空某用户的机器人密钥哈希（hash 为空串表示吊销）。
// 与 bindOpenId 同理：首次写入时确保「机器人密钥哈希」列存在（幂等）。
async function setRobotKey(id, hash) {
  const fu = await findUser(id)
  if (!fu) return { code: 404, data: { msg: '用户不存在' } }
  const map = await getFieldMap('users')
  if (!map[COL.users.robotKeyHash]) {
    await callSmart('users', CFG.ACT.addFields, {
      fields: [{ fieldTitle: COL.users.robotKeyHash, fieldType: 1, propertyText: {} }]
    })
    clearFieldMapCache('users')
  }
  await updateRecord('users', fu.rid, { [COL.users.robotKeyHash]: ('' + (hash || '')).trim() })
  return { ok: true }
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
  // 行值 trim 后再比：表里 openid 单元格带空格（手工粘贴常见）时，原样比对会漏配
  const list = await getRecords('users', r => ('' + (r.fields[COL.users.openid] || '')).trim() === ('' + openid).trim())
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
// 教职工名册（指派执行人/处理人用）。
// 刻意不走 ds.userVisible：那个函数按班级过滤，教师看不到任何同事（教师自身 cls 为空），
// 导致"把任务派给某位老师"永远做不了。这里只暴露工号/姓名/角色三项最小信息，
// 且过滤掉已停用账号——工号姓名本就是同事之间互相知道的公开信息。
async function listStaff() {
  const list = await getRecords('users')
  return list
    .map(r => normUser(r.fields))
    .filter(u => u.role === 'teacher' || u.role === 'admin' || u.role === 'super')
    .filter(u => u.status !== '停用')
    .filter(u => !!(u.id && u.id.trim()))
    .map(u => ({ id: u.id, name: u.name, role: u.role }))
}

// 账号配置体检用：返回全部账号的最小字段（不做行级过滤，仅供管理员自检）。
// 与 adminListUsers 的区别：那个按调用者层级过滤，这个给管理员做全库配置核对。
async function listAllUsersForAudit() {
  const list = await getRecords('users')
  return list
    .map(r => normUser(r.fields))
    .filter(u => !!(u.id && u.id.trim()))
    .map(u => ({ id: u.id, name: u.name, role: u.role, cls: u.cls, managedClasses: u.managedClasses, status: u.status }))
}

async function adminListUsers(me) {
  const list = await getRecords('users')
  const callerLevel = me ? (ROLE_LEVEL[me.role] != null ? ROLE_LEVEL[me.role] : 0) : 0
  return list
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id,
        name: u.name,
        role: u.role,
        cls: u.cls,
        managedClasses: u.managedClasses,
        status: u.status,
        bound: !!(u.openid && ('' + u.openid).trim())
      }
    })
    .filter(u => !!(u.id && ('' + u.id).trim())) // 跳过完全空白的行
    // 服务端按调用者层级过滤：超级管理员看全部；其余仅看「严格低于自身层级」的账号（admin 看教师/学生，teacher 看学生）
    .filter(u => callerLevel >= ROLE_LEVEL.super ? true : (ROLE_LEVEL[u.role] != null ? ROLE_LEVEL[u.role] : 0) < callerLevel)
    // 数据域过滤：老师只能看到自己带班的学生（super/admin 全通，不受影响）
    .filter(u => ds.userVisible(ds.currentScope(), u))
}

// 写锁：两个管理员同时新建同一工号时，都会走过「查重→不存在→插行」→ 出现重复行；
// ============================================================
// 5.7 用户写操作权限裁决（纯函数，无网络依赖，便于单元测试）
// 层级：super(3) > admin(2) > teacher(1) > student(0)
//   • super：可创建/管理/删除 任意角色（含授予/撤销超级管理员、管理其它管理员、改自己身份）。
//   • admin：仅可创建/管理/删除 「严格低于自身层级」的角色 —— 即 教师、学生（不可创建/管理 管理员、超级管理员）。
//   • teacher：仅可创建/管理/删除 学生（不可创建/管理 教师、管理员、超级管理员）。
// 返回 null 表示放行；否则返回 { code, data:{msg} }（直接作为云函数响应体）。
// ============================================================
function decideUserWrite(me, target) {
  const callerRole = me ? me.role : null
  const callerLevel = ROLE_LEVEL[callerRole] != null ? ROLE_LEVEL[callerRole] : -1
  const callerSuper = callerRole === SUPER
  // 至少教师及以上才能操作用户
  if (callerLevel < ROLE_LEVEL.teacher) return { code: 403, data: { msg: '仅教师及以上可操作用户' } }
  const newRole = ('' + (target.role || '')).trim().toLowerCase()
  const newLevel = ROLE_LEVEL[newRole] != null ? ROLE_LEVEL[newRole] : -1
  // 超级管理员可创建/管理任何角色；其余仅可创建/管理「严格低于自身层级」的角色
  //   —— 即：管理员只能建 教师/学生；教师只能建 学生
  if (!callerSuper && newLevel >= callerLevel) {
    const allow = callerLevel === ROLE_LEVEL.admin ? '教师、学生' : '学生'
    return { code: 403, data: { msg: '权限不足：' + (callerRole === ADMIN ? '管理员' : '教师') + '仅可创建/管理 ' + allow + ' 角色' } }
  }
  // 自锁：非超级管理员不能改自己的角色/状态（防把自己锁在管理功能外）
  if (me && target.id && ('' + target.id).toUpperCase() === ('' + me.id).toUpperCase() && !callerSuper) {
    const existing = target.existingRole || 'student'
    if (newRole && newRole !== existing) return { code: 400, data: { msg: '不能修改自己的角色（防止把自己锁在管理功能外）' } }
    if (target.statusChanging) return { code: 400, data: { msg: '不能修改自己的账号状态' } }
  }
  return null
}

function decideUserDelete(me, existingRole, id) {
  const callerRole = me ? me.role : null
  const callerLevel = ROLE_LEVEL[callerRole] != null ? ROLE_LEVEL[callerRole] : -1
  const callerSuper = callerRole === SUPER
  if (callerLevel < ROLE_LEVEL.teacher) return { code: 403, data: { msg: '仅教师及以上可操作用户' } }
  const targetLevel = ROLE_LEVEL[existingRole] != null ? ROLE_LEVEL[existingRole] : -1
  // 超级管理员可删除任何角色；其余仅可删除「严格低于自身层级」的角色
  //   —— 即：管理员只能删 教师/学生；教师只能删 学生
  if (!callerSuper && targetLevel >= callerLevel) {
    const allow = callerLevel === ROLE_LEVEL.admin ? '教师、学生' : '学生'
    return { code: 403, data: { msg: '权限不足：' + (callerRole === ADMIN ? '管理员' : '教师') + '仅可删除 ' + allow + ' 账号' } }
  }
  if (me && id && ('' + id).toUpperCase() === ('' + me.id).toUpperCase())
    return { code: 400, data: { msg: '不能删除当前登录的账号' } }
  return null
}

// 绑定登录同理，两台设备同时绑同一工号时后写覆盖前写，双向 1:1 约束被击穿。
// me：当前登录用户（index.js 传入的 {id,name,role,cls}）——用于权限裁决与禁止改自己的角色/状态。
// users 是全局表（getRecords 不按班级过滤），教师层级上虽可建/改学生，
// 但必须限制在本人带班范围，否则知道工号即可跨班改删（IDOR）。
function userScopeErr(scope, data, existing) {
  if (!ds.needGuard(scope) || scope.role !== 'teacher') return null
  if (existing) {
    const u = normUser(existing.fields)
    if (!ds.userVisible(scope, { id: u.id, cls: u.cls })) {
      return { code: 403, data: { msg: '只能管理本人带班的学生账号' } }
    }
  }
  const cls = String((data && data.cls) || '').trim()
  // 新增必须有本班归属；编辑时若改班级，目标班级也必须在带班范围内
  if (!cls && !existing) return { code: 403, data: { msg: '新增学生必须属于本人带班（归属班级须与带班一致）' } }
  if (cls && scope.classes.indexOf(cls) < 0) {
    return { code: 403, data: { msg: '不能把学生改到本人带班之外' } }
  }
  return null
}

// 保护：系统必须保留至少一名【启用中的超级管理员】。
// 背景：decideUserWrite 对 super 豁免了"不能改自己"的限制（否则超管改不了自己的姓名），
//   但也留下了自毁口子——唯一一名超管把自己降级/停用/删除后，全校再无管理入口：
//   清库、迁移、日志、门禁、创建管理员全部失效，只能进数据库手工改回。
//   这里在写入前做一次兜底裁决，任何人都无法绕过。
function lastSuperGuard(userObjs, targetId, nextRole, nextStatus) {
  const tid = ('' + (targetId || '')).trim().toUpperCase()
  const cur = (userObjs || []).find(u => ('' + (u.id || '')).trim().toUpperCase() === tid)
  if (!cur || cur.role !== SUPER || (cur.status || '启用') !== '启用') return null
  // 目标操作后仍是"启用中的 super" → 放行
  if (nextRole === SUPER && (nextStatus || '启用') === '启用') return null
  const others = (userObjs || []).filter(u =>
    ('' + (u.id || '')).trim().toUpperCase() !== tid &&
    u.role === SUPER && (u.status || '启用') === '启用')
  if (others.length) return null
  return { code: 400, data: { msg: '系统必须保留至少一名启用中的超级管理员，不能降级/停用/删除最后一个超管' } }
}

async function adminUpsertUser(data, me) {
  return withWriteLock(async () => {
    data = data || {}
    const id = ('' + (data.id || '')).trim().toUpperCase()
    const name = ('' + (data.name || '')).trim()
    const role = ('' + (data.role || '')).trim().toLowerCase()
    const cls = ('' + (data.cls || '')).trim()
    const status = ('' + (data.status || '')).trim() || '启用'
    const rid = ('' + (data.rid || '')).trim()   // 编辑时前端传入的行 ID（腾讯文档 recordId）
    if (!id || !name) return { code: 400, data: { msg: '工号和姓名必填' } }
    if (ROLES.indexOf(role) < 0) return { code: 400, data: { msg: '角色必须是 student / teacher / admin / super 之一' } }
    if (status !== '启用' && status !== '停用') return { code: 400, data: { msg: '状态必须是 启用 / 停用' } }
    // 防御性：确保 users 表 openid 列存在（登录绑定所需；已存在则 no-op）
    await ensureOpenIdColumn()

    // 全量取一次 users（命中进程内缓存时 0 次 API）：工号定位 + rid 定位都在内存里完成。
    // 不走 getRecords 的 recordIDs 参数——该参数未经真实 API 验证，不能用来承载编辑主路径。
    const allUsers = await getRecords('users')
    const byId = allUsers.filter(r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    // 同工号多行 = 历史脏数据：此时按工号定位会改错行，明确报错让人先合并
    if (byId.length > 1) return { code: 409, data: { msg: '工号 ' + id + ' 在表中存在多行（历史脏数据），请先到腾讯文档合并后再操作' } }
    let rec = byId[0]
    if (rid) {
      // 带 rid：按行精确定位（支持改工号的场景）。rid 行不存在 / 与工号命中的不是同一行
      // （说明目标工号已被其他行占用）→ 明确报错，避免制造重复工号（bindLogin 会匹配歧义）。
      const byRid = allUsers.find(r => r.recordId === rid)
      if (!byRid) return { code: 404, data: { msg: '要编辑的行不存在（可能已被删除），请刷新列表重试' } }
      if (rec && rec.recordId !== rid) return { code: 409, data: { msg: '工号 ' + id + ' 已被其他行占用，不能重复' } }
      rec = byRid
    }
    // 新增（无 rid）且工号已存在 → 明确报错，避免把已有账号的姓名/角色静默覆盖掉
    if (!rid && rec) return { code: 409, data: { msg: '工号 ' + id + ' 已存在，请直接编辑该账号或换用工号' } }

    // 权限裁决（纯函数）：admin 不可管 管理员/超级管理员、不可授 super、不可改自己；super 拥有全部权限。
    const su = rec ? normUser(rec.fields) : null
    const decision = decideUserWrite(me, {
      id,
      role,
      existingRole: su ? su.role : null,
      statusChanging: su ? (status !== (su.status || '启用')) : false
    })
    if (decision) return decision
    // 最后一个启用超管的保护（降级/停用自己）
    const superGuard = lastSuperGuard(allUsers.map(r => normUser(r.fields)), id, role, status)
    if (superGuard) return superGuard
    const scopeErr = userScopeErr(ds.currentScope(), data, rec)
    if (scopeErr) return scopeErr

    // 老师带班列表：仅 super / admin 可设置，且仅 teacher 角色有效；
    // 未显式提交时保留原值，避免编辑姓名/状态时把带班信息清空。
    const canSetScope = !!(me && (me.role === SUPER || me.role === ADMIN))
    const hasMC = Object.prototype.hasOwnProperty.call(data, 'managedClasses')
    const managedClasses = role === 'teacher'
      ? (canSetScope && hasMC ? ds.sanitizeManagedClasses(data.managedClasses) : (su ? su.managedClasses : ''))
      : ''
    // 教师必须配带班班级：漏配的后果是「静默失效」——
    // 行级隔离按 managedClasses 过滤，没配的老师看不到本班任何申请与流水，
    // 但账号在用户列表里看起来完全正常，现场只会表现为"老师反映看不到数据"，极难排查。
    // 这里直接拒绝建档/改档，逼着配置完整。
    if (role === 'teacher' && !managedClasses) {
      return { code: 400, data: { msg: '教师账号必须配置带班班级，否则看不到本班任何申请与流水' } }
    }
    const fields = {
      [COL.users.id]: id,
      [COL.users.name]: name,
      [COL.users.role]: TR.roleFwd[role] || role,
      [COL.users.cls]: cls,
      [COL.users.managedClasses]: managedClasses,
      [COL.users.status]: status
    }
    if (rec) {
      await updateRecord('users', rec.recordId, fields)
      return { id, updated: true }
    }
    await addRecord('users', fields)
    return { id, created: true }
  })
}

async function adminDeleteUser(data, me) {
  return withWriteLock(async () => {
    const id = ('' + (data && data.id || '')).trim().toUpperCase()
    if (!id) return { code: 400, data: { msg: '工号必填' } }
    const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    const rec = list[0]
    if (!rec) return { code: 404, data: { msg: '该工号不存在' } }
    const su = normUser(rec.fields)
    const scopeErr = userScopeErr(ds.currentScope(), null, rec)
    if (scopeErr) return scopeErr
    const decision = decideUserDelete(me, su.role, id)
    if (decision) return decision
    // 最后一个启用超管的保护（删除自己）
    const superGuard = lastSuperGuard(list.map(r => normUser(r.fields)), id, null, null)
    if (superGuard) return superGuard
    // ⚠ 已绑定微信的账号禁止物理删除：
    //   删除会让 openid 随行一起消失 → 同一工号若被重建（错录账号清理后重建、或换人接手），
    //   新行处于「未绑定」状态，「一个工号被绑定后他人不可再绑」这条保护随之失效，
    //   任何人都能抢绑该工号（实测复现：删除→同名重建→另一微信绑定成功）。
    //   正确处理：停用（保留档案与绑定），确需删除则先「解绑」再删。
    if (su.openid) {
      return { code: 409, data: { msg: '该账号已绑定微信，不能直接删除：请改用「停用」（保留档案与绑定），或先「解绑」再删除' } }
    }
    await deleteRecordByIds('users', [rec.recordId])
    return { id }
  })
}

// 解除微信绑定（管理员）：清空该账号行的 openid，使该工号可以重新绑定。
//
// 为什么必须有它：bindLogin 在「该工号已绑定其他微信」时提示"请联系管理员清空该工号的绑定"，
//   但此前管理员根本没有清空绑定的入口（adminUpsertUser 不写 openid、前端也没有按钮）→ 换绑是死路：
//   本人换了微信号想重新登录、或管理员发现绑定录错，都只能进数据库手改。
// 解绑后该工号即可被重新绑定 —— 这正是"工号↔openid 一对一"能被管理员纠错的前提。
async function adminUnbindUser(data, me) {
  return withWriteLock(async () => {
    const id = ('' + (data && data.id || '')).trim().toUpperCase()
    if (!id) return { code: 400, data: { msg: '工号必填' } }
    const list = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    const rec = list[0]
    if (!rec) return { code: 404, data: { msg: '该工号不存在' } }
    const su = normUser(rec.fields)
    const scopeErr = userScopeErr(ds.currentScope(), null, rec)
    if (scopeErr) return scopeErr
    // 层级裁决与删除一致：super 任意；admin 仅教师/学生；teacher 仅学生
    const callerRole = me ? me.role : null
    const callerLevel = ROLE_LEVEL[callerRole] != null ? ROLE_LEVEL[callerRole] : -1
    const targetLevel = ROLE_LEVEL[su.role] != null ? ROLE_LEVEL[su.role] : -1
    if (callerLevel < ROLE_LEVEL.teacher) return { code: 403, data: { msg: '仅教师及以上可解绑账号' } }
    if (callerRole !== SUPER && targetLevel >= callerLevel) {
      const allow = callerLevel === ROLE_LEVEL.admin ? '教师、学生' : '学生'
      return { code: 403, data: { msg: '权限不足：' + (callerRole === ADMIN ? '管理员' : '教师') + '仅可解绑 ' + allow + ' 账号' } }
    }
    if (!su.openid) return { code: 400, data: { msg: '该账号尚未绑定微信，无需解绑' } }
    await updateRecord('users', rec.recordId, { [COL.users.openid]: '' })
    // 解绑是安全敏感操作，必须留痕（谁、何时、解了谁）
    ds.overrideOwnerCls(ds.readCls(rec.fields))
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: (me && me.id) || '',
      [COL.logs.op]: '解除微信绑定', [COL.logs.target]: id, [COL.logs.result]: '已解绑，该工号可重新绑定'
    })
    return { id, unbound: true }
  })
}

// 绑定登录：姓名 + 工号命中 users 表 → 把当前微信 openid 绑到该工号，之后可免输入自动登录。
// 约束（双向 1:1，避免数据叠加）：
//   ① 工号必须存在且启用，姓名须与表内一致；
//   ② 一个工号只能绑一个微信：已被别的 openid 占用 → 409；
//   ③ 一个微信只能绑一个工号：本 openid 已绑到别的工号 → 409；
//   ④ 已绑到本微信 → 直接登录（幂等）。
async function bindLogin(data, openid) {
  // 写锁：两台设备同时绑同一工号时，两个 openid 都能通过上方的 1:1 校验，后写覆盖前写。
  // 串行化后第二个请求会看到已被绑定的 openid，正确返回 409。
  return withWriteLock(async () => {
    if (!openid) return { code: 400, data: { msg: '未获取到微信身份，请在微信中打开小程序' } }
    const id = ('' + (data && data.id || '')).trim().toUpperCase()
    const name = ('' + (data && data.name || '')).trim()
    if (!id || !name) return { code: 400, data: { msg: '请输入姓名和工号' } }
    await ensureOpenIdColumn()
    const byId = await getRecords('users', r => ('' + (r.fields[COL.users.id] || '')).trim().toUpperCase() === id)
    const rec = byId[0]
    if (!rec) return { code: 404, data: { msg: '工号不存在，请联系管理员先在用户表录入' } }
    const u = normUser(rec.fields)
    if (u.status && u.status !== '启用') return { code: 400, data: { msg: '该账号未启用，请联系管理员' } }
    if (name !== ('' + (u.name || '')).trim()) return { code: 400, data: { msg: '姓名与工号不匹配，请核对后重试' } }
    if (u.openid && u.openid === openid) return { code: 0, data: publicUser(u) }                 // 已绑本微信，幂等登录
    if (u.openid && u.openid !== openid) return { code: 409, data: { msg: '该工号已绑定其他微信，无法重复绑定；如需换绑请联系管理员清空该工号的绑定' } }
    const byOpen = await getRecords('users', r => ('' + (r.fields[COL.users.openid] || '')).trim() === ('' + openid).trim())
    if (byOpen.length) {
      const other = normUser(byOpen[0].fields)
      return { code: 409, data: { msg: '此微信已绑定工号 ' + (other.id || '?') + '，一个微信只能绑定一个工号' } }
    }
    await updateRecord('users', rec.recordId, { [COL.users.openid]: openid })
    return { code: 0, data: publicUser(u) }
  })
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
// 输入校验（服务端兜底，不信前端）：物品ID 必填且必须存在、数量必须为正整数。
// 缺校验时负数量会穿过 approve 的 `cur < qty` 判断 → 库存被反向加增，账实不符。
async function requisition(data) {
  // —— 参数预校验（无副作用；失败不进幂等窗口）——
  const matId = ('' + (data.matId || '')).trim()
  if (!matId) return { code: 400, data: { msg: '缺少物品ID，无法提交申请' } }
  const qty = parseQty(data.qty)
  if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
  // 用途说明（P1-⑦）：出库必须能追溯到"用到哪去了"。服务端截断到 60 字，
  // 既防止超长塞爆单元格，也避免有人把整篇说明粘进来。
  const reason = ('' + (data.reason || '')).trim().slice(0, 60)
  if (!reason) return { code: 400, data: { msg: '请填写用途说明' } }
  // —— 幂等 + 写锁：窗口内同一用户对同一物品同数量的申领只提交一单 ——
  // 幂等键要能区分"不同的操作"：用途不同就是两次不同的申请，
  // 键里少了用途说明 → 5 秒内两次不同用途的申请，第二次会拿到第一次的单号，用途被吞。
  const idemKey = ['req', data.user || '', matId, qty, reason].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    if (!mats[0]) return { code: 400, data: { msg: '物品不存在：' + matId } }
    const rec = await addRecord('requisitions', {
      [COL.requisitions.user]: data.user, [COL.requisitions.item]: matId,
      [COL.requisitions.type]: '领用', [COL.requisitions.qty]: qty, [COL.requisitions.reason]: reason,
      [COL.requisitions.status]: '待审批', [COL.requisitions.time]: now(), [COL.requisitions.approver]: ''
    })
    await addRecord('logs', {
      [COL.logs.actor]: data.user, [COL.logs.op]: '提交领用申请', [COL.logs.target]: matId, [COL.logs.result]: '待审批'
    })
    return { no: await readBackNo(rec, 'requisitions', COL.requisitions.id) }
  }))
}

// 撤销申请（P1-⑨）：OA 惯例允许申请人撤回待审批单据。此前提交后只能干等审批，
// 或找管理员到腾讯文档手工改。"写错了想收回"没有自助通道，学生会用重复提交来"纠错"。
// 边界：
//   1) 仅「待审批」可撤——已通过/已拒绝的单据已成事实，撤回会让账目凭空消失；
//   2) 仅本人可撤——data.user 由中继层用 openid 推导覆盖，客户端伪造无效；
//   3) 写后回读校验，避免"提示已撤销但列表里还在"。
async function cancelReq(data) {
  return withWriteLock(async () => {
    const no = '' + (data.no || '')
    if (!no) return { code: 400, data: { msg: '缺少申请单号' } }
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + no } }
    const status = '' + (req.fields[COL.requisitions.status] || '')
    if (status !== '待审批') {
      return { code: 400, data: { msg: '仅待审批的申请可撤销（当前：' + (status || '未知') + '）' } }
    }
    const owner = ('' + (req.fields[COL.requisitions.user] || '')).trim().toUpperCase()
    const me = ('' + (data.user || '')).trim().toUpperCase()
    if (!owner || owner !== me) return { code: 403, data: { msg: '只能撤销本人提交的申请' } }
    await updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已撤销' })
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: me,
      [COL.logs.op]: '撤销申请', [COL.logs.target]: no, [COL.logs.result]: '已撤销'
    })
    const nowRows = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no, { noCache: true })
    if (('' + ((nowRows[0] && nowRows[0].fields[COL.requisitions.status]) || '')) !== '已撤销') {
      throw new Error('撤销未生效（申请 ' + no + '）。请刷新后重试；若反复失败请到腾讯文档手动修改状态')
    }
    return {}
  })
}

// 工具借出申请：写 requisitions（类型=借出，待审批）+ 写 logs。工具ID 必填且必须存在。
async function toolRequisition(data) {
  // —— 参数预校验（无副作用；失败不进幂等窗口）——
  const toolId = ('' + (data.toolId || '')).trim()
  if (!toolId) return { code: 400, data: { msg: '缺少工具ID，无法提交申请' } }
  const reason = ('' + (data.reason || '')).trim().slice(0, 60)
  if (!reason) return { code: 400, data: { msg: '请填写用途说明' } }
  // —— 幂等 + 写锁：窗口内同一用户对同一工具的借出申请只提交一单 ——
  // 键里必须带用途与借期：同一学生同一工具但借期不同（比赛/实训周期不同）是两次不同申请
  const idemKey = ['treq', data.user || '', toolId, reason, data.days || ''].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
    if (!tools[0]) return { code: 400, data: { msg: '工具不存在：' + toolId } }
    const rec = await addRecord('requisitions', {
      [COL.requisitions.user]: data.user, [COL.requisitions.item]: toolId,
      [COL.requisitions.type]: '借出', [COL.requisitions.qty]: 1, [COL.requisitions.reason]: reason,
      // 借期：学生申请时填的天数（1~90），审批通过后按它算应还日期
      [COL.requisitions.days]: Math.min(90, Math.max(1, parseInt(data.days, 10) || DEFAULT_LOAN_DAYS)),
      [COL.requisitions.status]: '待审批', [COL.requisitions.time]: now(), [COL.requisitions.approver]: ''
    })
    await addRecord('logs', {
      [COL.logs.actor]: data.user, [COL.logs.op]: '提交工具借出申请', [COL.logs.target]: toolId, [COL.logs.result]: '待审批'
    })
    return { no: await readBackNo(rec, 'requisitions', COL.requisitions.id) }
  }))
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
    // 审批产生的借还/流水/日志统一继承「申请单」的班级（申请人所属班），
    // 不再让 addRecord 自动打上审批老师的第一带班（scope.ownerCls）：多班老师
    // 审批别班学生时，否则会把记录错标到本班，班级汇总与行级隔离同时失真。
    ds.overrideOwnerCls(ds.readCls(req.fields))

    if (!data.ok) {
      // 驳回必须写明原因（P1-⑧）：否则申请人只知道"被拒了"却不知道错在哪，
      // 只能反复重提或直接找老师当面问。服务端强制，不是前端可做可不做。
      const why = ('' + (data.reason || '')).trim().slice(0, 60)
      if (!why) return { code: 400, data: { msg: '请填写驳回原因，便于申请人改正后重新提交' } }
      await updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已拒绝', [COL.requisitions.approver]: data.actor, [COL.requisitions.reject]: why
      })
      await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批拒绝', [COL.logs.target]: data.no, [COL.logs.result]: '已拒绝' })
      return {}
    }

    if (isTool) {
      const toolId = '' + (req.fields[COL.requisitions.item] == null ? '' : req.fields[COL.requisitions.item])
      if (!toolId) return { code: 400, data: { msg: '该申请缺少工具ID，疑似脏数据（' + ('' + (req.fields[COL.requisitions.id] || '?')) + '），无法审批' } }
      // 借用人一律取申请单上的申请人（服务端数据），不回退客户端传入的 data.user，
      // 防止调用方伪造他人名义借出；缺申请人ID 视为脏数据，明确拒绝而非静默写一条无主借还记录。
      const applicant = ('' + (req.fields[COL.requisitions.user] == null ? '' : req.fields[COL.requisitions.user])).trim()
      if (!applicant) return { code: 400, data: { msg: '该申请缺少申请人ID，疑似脏数据（' + ('' + (req.fields[COL.requisitions.id] || '?')) + '），无法审批' } }
      const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
      const tool = tools[0]
      if (!tool) return { code: 400, data: { msg: '工具不存在：' + toolId } }
      if (('' + tool.fields[COL.tools.status]) !== '在库') return { code: 400, data: { msg: '该工具不在库' } }
      // 三条写互不依赖，并行提交，缩短审批耗时
      const borrowPayload = () => ({
        [COL.borrow.id]: genNo('B'), [COL.borrow.user]: applicant, [COL.borrow.tool]: toolId,
        // 应还日期：审批人指定的借期 > 申请单里学生填的借期 > 默认 7 天
        [COL.borrow.out]: now(),
        [COL.borrow.plan]: planDue(data.days || req.fields[COL.requisitions.days]),
        [COL.borrow.in]: '', [COL.borrow.status]: '借出中',
        // 申请单里学生填的「用途说明」天然就是借出备注，直接带过来，无需再问一遍
        [COL.borrow.note]: ('' + (req.fields[COL.requisitions.reason] || '')).trim().slice(0, 120)
      })
      // 原子切换工具状态（CAS）：状态仍是「在库」才借出 → 同一件工具不会被借两次
      const toolSw = await atomicSwitchToolStatus(tool.recordId, '在库', '借出', { [COL.tools.holder]: applicant })
      // CAS 未命中 = 工具已被别人借走 → 与串行路径同口径回 400（不是 500 服务器故障）
      if (!toolSw) return { code: 400, data: { msg: '该工具不在库（已被他人借走）：' + toolId } }
      await Promise.all([
        updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor }),
        addRecord('borrow', borrowPayload()),
        addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批通过工具借出', [COL.logs.target]: toolId, [COL.logs.result]: '已通过' })
      ])
      // 并行写无事务：最坏「工具已借出但申请单仍待审批」→ 前端仍显示可审批，重复点击会二次借出/重复建借还记录。
      // 回读校验三项（申请单=已通过、工具=借出、存在该工具「借出中」借还记录），缺项补写重试一次，仍不过抛可读错误。
      if (!(await verifyToolBorrow(req, toolId, tool, applicant, borrowPayload))) {
        throw new Error('审批未完全生效（申请 ' + data.no + ' / 工具 ' + toolId + '）：申请单、工具或借还记录有写入失败。请刷新后重试；若仍失败，请到腾讯文档核对后手动修正')
      }
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
    // 数量必须是正整数：提交端已拦 qty<1，但有人直接改腾讯文档造成脏数据时，
    // qty=0 会通过上面的 `cur < qty` 判断，审批通过后写出一条「数量=0」的出库流水——
    // 库存没动却多一笔流水，账实再次对不上（与 P0 账务修复同类的账务污染）。
    if (qty < 1) return { code: 400, data: { msg: '该申请的数量异常（' + qty + '），疑似脏数据，无法审批，请在腾讯文档删除该记录' } }
    // 领用人一律取申请单上的申请人，不回退 data.actor（审批人），保证流水上的经手人是谁领的
    const applicant = ('' + (req.fields[COL.requisitions.user] == null ? '' : req.fields[COL.requisitions.user])).trim() || data.actor
    const note = '领用申请 ' + ('' + (req.fields[COL.requisitions.id] || data.no))
    // 归属班级继承「申请单」上的班级（= 申请人学生本人的班级），而不是 scope.ownerCls
    // （审批人是老师，ownerCls 是老师的班级）。否则学生领用流水不带班级，
    // 老师按班级查不到学生领用了什么，且行级隔离下会退化成"公共资源"对所有老师可见。
    const reqCls = ds.readCls(req.fields)
    const outFlow = {
      [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
      [COL.stock_io.dir]: '出库', [COL.stock_io.qty]: qty,
      [COL.stock_io.op]: applicant, [COL.stock_io.time]: now(), [COL.stock_io.note]: note, [COL.stock_io.src]: '领用出库'
    }
    if (reqCls) outFlow[COL.stock_io.cls] = reqCls

    // ===== 幂等闸门：检测本单此前是否已产生出库流水 =====
    // 审批是一次「扣库存 + 写出库流水 + 改申请单状态 + 写日志」的多步写。
    // 正常情况下步骤内的部分失败已被 verifyStock / verifyReqOutFlow / verifyReqApproved
    // 的「回读校验 + 补写重试」自愈；这里堵的是自愈也失败时抛错、老师按提示重试的那个窗口：
    //   上一次可能已经把库存扣了、却没把申请单状态改成「已通过」→ 状态检查放行 → 重试【再扣一次】，
    //   账面比流水多扣一份，而页面仍显示「已通过」，无人察觉。
    // 锚点用审批必写的 note（'领用申请 <单号>'）：不依赖可能缺列的 src
    //   （腾讯文档未手工加「来源类型」列时 buildValues 会跳过该列，src 恒空）。
    // 反向冲销流水的 note 是「冲销流水 …」，与本锚点不同，不会误命中。
    const priorOut = await getRecords('stock_io', r => ('' + (r.fields[COL.stock_io.note] || '')) === note)
    if (priorOut.length) {
      // 已经出库过 → 绝不二次扣减；只补齐申请单状态并留痕
      await updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor
      })
      await addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '审批通过（幂等补齐）', [COL.logs.target]: data.no,
        [COL.logs.result]: '已补齐审批状态，库存未重复扣减'
      }, reqCls ? { [COL.logs.cls]: reqCls } : {}))
      return {
        idempotent: true, no: data.no,
        warn: '该申请此前已出库，本次未重复扣减库存；若账面与流水不符，请在库存页执行盘点核对'
      }
    }
    // 原子扣减（CAS）：期望值进条件 → 两个老师同时审批同一单也不会双扣库存
    const adj = await atomicAdjustStock(mat.recordId, -qty)
    if (!adj.ok) {
      if (adj.reason === 'insufficient') return { code: 400, data: { msg: `库存不足：当前 ${adj.stock}，申请 ${qty}` } }
      if (adj.reason === 'missing') return { code: 400, data: { msg: '物品不存在：' + matId } }
      throw new Error('审批未完全生效（申请 ' + data.no + '）：库存并发冲突，重试后仍未成功。请刷新后重试')
    }
    await Promise.all([
      updateRecord('requisitions', req.recordId, { [COL.requisitions.status]: '已通过', [COL.requisitions.approver]: data.actor }),
      // 【P0 账务修复】领用出库必须留痕。此前只扣库存不写流水，导致出入库流水缺失最主要的
      // 出库方式，库存与流水必然对不上，也无法做消耗统计与审计。按 io 同款格式补一条出库流水，
      // 备注挂申请单号以便双向追溯（流水↔申请单）。
      addRecord('stock_io', outFlow),
      addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '审批通过', [COL.logs.target]: data.no, [COL.logs.result]: '已通过' })
    ])
    // 并行写无事务：最坏「库存扣了、申请单仍待审批」→ 再次审批会二次扣减。回读校验并自愈重试，仍不过抛错。
    if (!(await verifyStock(matId, adj.stock))) {
      throw new Error('审批未完全生效（申请 ' + data.no + '）：库存可能未扣减。请刷新后重试；若仍失败，请到腾讯文档核对「当前库存」后手动修正')
    }
    if (!(await verifyReqApproved(req))) {
      throw new Error('审批未完全生效（申请 ' + data.no + '）：申请单状态可能未更新。请刷新审批列表后重试')
    }
    // 流水同样可能静默失败：缺失则该笔出库在账上"凭空消失"，正是本次要修的老问题。缺失补写真实流水一次再验。
    if (!(await verifyReqOutFlow(outFlow, matId))) {
      throw new Error('审批已生效但出库流水写入失败（申请 ' + data.no + ' / 物品 ' + matId + '）。请重试以补记流水；若反复失败请到腾讯文档手工补一条出库流水')
    }
    return {}
  })
}

// 审批撤销：只撤销「已通过」的申请，并回滚其账务影响。
// 耗材单：把审批产生的出库流水冲销（库存回补 + 写反向入库流水 + 原流水打 [已冲销]）。
// 工具单：把已生成的借还记录结清、工具回在库。
// 约束：① 仅「已通过」可撤，撤后状态=已撤销，二次撤销被拒；② 归属班级跟随申请单；
//       ③ 冲销/结清在本函数内内联完成——writeLock 不可重入，不能调用 reverseIO/returnTool；
//       ④ 若对应流水已冲销（历史手工冲销过），跳过重复回补，只改状态，避免二次加库存。
async function revokeApprove(data) {
  const no = '' + (data.no || '')
  if (!no) return { code: 400, data: { msg: '缺少申请单号' } }
  const why = ('' + (data.reason || '')).trim().slice(0, 60)
  return withWriteLock(async () => {
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + no } }
    const curStatus = '' + (req.fields[COL.requisitions.status] || '')
    if (curStatus !== '已通过') {
      return { code: 400, data: { msg: curStatus === '已撤销' ? '该申请已撤销，不可重复撤销' : '只有「已通过」的申请可以撤销（当前：' + (curStatus || '未知') + '）' } }
    }
    const f = req.fields
    ds.overrideOwnerCls(ds.readCls(f))
    const isTool = ('' + (f[COL.requisitions.type] || '')) === '借出'
    const info = { no, kind: isTool ? 'tool' : 'material', rolledBack: false }
    const cls = ds.readCls(f)

    if (isTool) {
      const toolId = '' + (f[COL.requisitions.item] == null ? '' : f[COL.requisitions.item])
      const applicant = '' + (f[COL.requisitions.user] == null ? '' : f[COL.requisitions.user])
      const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
      const borrows = await getRecords('borrow', r =>
        ('' + r.fields[COL.borrow.tool]) === toolId && ('' + r.fields[COL.borrow.user]) === applicant &&
        ('' + r.fields[COL.borrow.status]) === '借出中')
      const writes = []
      if (tools[0] && ('' + tools[0].fields[COL.tools.holder]) === applicant) {
        // 原子回库（CAS）：状态仍是「借出」才置在库 → 不覆盖并发发生的新借出
        const backSw = await atomicSwitchToolStatus(tools[0].recordId, '借出', '在库', { [COL.tools.holder]: '' })
        if (!backSw) writes.push(updateRecord('tools', tools[0].recordId, { [COL.tools.status]: '在库', [COL.tools.holder]: '' }))
        info.rolledBack = true
      }
      for (const b of borrows) {
        writes.push(updateRecord('borrow', b.recordId, { [COL.borrow.status]: '已归还', [COL.borrow.in]: now() }))
        info.rolledBack = true
      }
      writes.push(updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已撤销', [COL.requisitions.approver]: data.actor,
        [COL.requisitions.reject]: why || '审批撤销'
      }))
      writes.push(addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '审批撤销', [COL.logs.target]: no, [COL.logs.result]: info.rolledBack ? '已撤销并回滚' : '已撤销（无需回滚）'
      }, cls ? { [COL.logs.cls]: cls } : {})))
      await Promise.all(writes)
      // 工具路径：借还记录找不到「借出中」且工具已不在借用人名下 → 说明学生已自行归还，
      // 本来就没有可回滚的账务影响，属正常情况，不算异常。
      info.impact = info.rolledBack ? 'rolledBack' : 'none'
      return info
    }

    // 耗材：找到审批生成的出库流水（note='领用申请 <no>'，src='领用出库'）
    const matId = '' + (f[COL.requisitions.item] == null ? '' : f[COL.requisitions.item])
    const note = '领用申请 ' + no
    const flows = await getRecords('stock_io', r => {
      const fn = '' + (r.fields[COL.stock_io.note] || '')
      if (fn !== note) return false
      const src = '' + (r.fields[COL.stock_io.src] || '')
      // 「来源类型」列可能没在腾讯文档手工添加（buildValues 对不存在的列会 warn 并跳过），
      // src 恒空时不能据此判定「不是领用出库」——note 由审批写入，是可靠锚点。
      if (src && src !== '领用出库') return false
      return true
    })
    const out = flows.find(x => !isSettledFlow(x.fields))
    if (!out) {
      // 找不到账务影响：可能是这单本来就没产生出库流水，也可能是流水被删/被改过。
      // 绝不能静默当成「无需回滚」——否则库存没回来却看不出问题，账实不符。
      info.impact = 'missing'
      info.warn = '未找到该申请对应的出库流水，库存可能未回补，请人工核对库存'
    } else {
      const qty = Number(out.fields[COL.stock_io.qty]) || 0
      const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
      if (!mats[0]) return { code: 404, data: { msg: '关联物品不存在：' + matId } }
      const stock = Number(mats[0].fields[COL.materials.stock]) || 0
      const next = stock + qty
      const backCls = ds.readCls(out.fields) || cls
      await Promise.all([
        updateRecord('materials', mats[0].recordId, { [COL.materials.stock]: next }),
        updateRecord('stock_io', out.recordId, { [COL.stock_io.note]: '[已冲销] ' + (out.fields[COL.stock_io.note] || '') }),
        addRecord('stock_io', Object.assign({
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId, [COL.stock_io.dir]: '入库', [COL.stock_io.qty]: qty,
          [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(),
          [COL.stock_io.note]: '冲销流水 ' + ('' + out.fields[COL.stock_io.id]), [COL.stock_io.src]: '冲销'
        }, backCls ? { [COL.stock_io.cls]: backCls } : {}))
      ])
      if (!(await verifyStock(matId, next))) {
        throw new Error('撤销未完全生效：库存 ' + matId + ' 未回补，请刷新后重试')
      }
      info.rolledBack = true
      info.impact = 'rolledBack'
      info.stock = next
    }
    await updateRecord('requisitions', req.recordId, {
      [COL.requisitions.status]: '已撤销', [COL.requisitions.approver]: data.actor,
      [COL.requisitions.reject]: why || '审批撤销'
    })
    await addRecord('logs', Object.assign({
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
      [COL.logs.op]: '审批撤销', [COL.logs.target]: no,
      [COL.logs.result]: info.rolledBack ? '已撤销并回滚'
        : (info.impact === 'missing' ? '已撤销（未找到出库流水，库存未回补）' : '已撤销（无需回滚）')
    }, cls ? { [COL.logs.cls]: cls } : {}))
    return info
  })
}

// 批量驳回：一次写锁内驳回多条「待审批」申请，统一驳回原因，返回成功/跳过明细。
// 仅供已有 approve 权限调用；单条失败（状态已变/记录被删）不阻断其余条目。
async function batchReject(data) {
  const nos = Array.isArray(data.nos) ? data.nos.map(x => '' + x).filter(Boolean) : []
  if (!nos.length) return { code: 400, data: { msg: '请先选择要驳回的申请' } }
  const why = ('' + (data.reason || '')).trim().slice(0, 60)
  if (!why) return { code: 400, data: { msg: '请填写驳回原因' } }
  return withWriteLock(async () => {
    const okNos = [], skipped = []
    for (const no of nos) {
      const rows = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
      const req = rows[0]
      if (!req || ('' + req.fields[COL.requisitions.status]) !== '待审批') {
        skipped.push({ no, reason: req ? '该申请已处理' : '申请不存在' })
        continue
      }
      ds.overrideOwnerCls(ds.readCls(req.fields))
      await updateRecord('requisitions', req.recordId, {
        [COL.requisitions.status]: '已拒绝', [COL.requisitions.approver]: data.actor, [COL.requisitions.reject]: why
      })
      await addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '审批拒绝', [COL.logs.target]: no, [COL.logs.result]: '已拒绝：' + why
      }, ds.readCls(req.fields) ? { [COL.logs.cls]: ds.readCls(req.fields) } : {}))
      okNos.push(no)
    }
    return { ok: okNos.length, skipped, nos: okNos }
  })
}

// 新增耗材建档（老师首次入库一种全新物品时用）
// 自动分配 M+序号 形式的耗材ID：取现有最大序号 +1，避免与人工编号冲突
async function addMaterial(data) {
  // —— 参数预校验（无副作用；失败不进幂等窗口）——
  const name = ('' + (data.name || '')).trim()
  if (!name) return { code: 400, data: { msg: '请填写物品名称' } }
  const unit = ('' + (data.unit || '')).trim() || '个'
  const qty = parseQty(data.qty, 0)
  if (qty === null) return { code: 400, data: { msg: '数量必须是 0 ~ 1000000 之间的整数' } }
  // 效期：填了就必须是能解析的日期，不能静默丢弃（丢了用户以为设了效期、实际没有 → 临期提醒不触发）
  const expParsed = expireTs(data.expire)
  if (expParsed === null) return { code: 400, data: { msg: '有效期格式不正确，请用日期选择器或 YYYY-MM-DD' } }
  const expTs = expParsed.ts
  // —— 幂等 + 写锁：窗口内同一操作人同名同量建档只执行第一笔，
  //    重复提交复用第一笔的 { id, ... }（前端提示与单次提交一致）——
  const idemKey = ['addMat', data.actor || '', name, qty, data.spec || '', data.expire || ''].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
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
      [COL.materials.status]: '正常',
      // 效期：此前只有读取与展示、全库无任何写入 → 库存页的「已过期/临期」提示永远不显示
      [COL.materials.expire]: expTs
    })

    // 建档同时记一笔入库流水，保证「账实相符」
    if (qty > 0) {
      await Promise.all([
        addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: newId,
          [COL.stock_io.dir]: TR.ioFwd.in || '入库', [COL.stock_io.qty]: qty,
          [COL.stock_io.op]: data.actor || '', [COL.stock_io.time]: now(),
          [COL.stock_io.note]: '建档入库', [COL.stock_io.src]: '建档入库'
        }),
        addRecord('logs', {
          [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor || '',
          [COL.logs.op]: '新增耗材', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
        })
      ])
    }
    // 注意：返回裸数据，由外层 run()→ok() 统一包成 {code:0,data}。
    // 此前写成 { data: {...} } 会被重复包裹，前端 callFull 拿到 r.data={data:{...}}，r.data.id 为 undefined（提示"已入库 undefined"）。
    return { id: newId, name, stock: qty, unit }
  }))
}

// 批量导入耗材清单（设备清单 → materials 集合）：建或更新。
// 与 clouddb.importMaterials 行为完全同构（build 双后端一致性要求）。
async function importMaterials(data) {
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
  const actor = data.actor || ''
  const all = await getRecords('materials')
  let max = 0
  const byId = new Map(), byName = new Map()
  for (const r of all) {
    const f = r.fields
    const id = '' + (f[COL.materials.id] || '')
    const name = ('' + (f[COL.materials.name] || '')).trim()
    const m = /^\s*[Mm](\d+)\s*$/.exec(id)
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    if (id) byId.set(id, r)
    if (name) byName.set(name, r)
  }
  const created = [], updated = [], skipped = []
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {}
    const name = ('' + (raw.name || '')).trim()
    if (!name) { skipped.push({ idx: i + 1, reason: '缺名称，跳过' }); continue }
    const id = ('' + (raw.id || '')).trim()
    const spec = ('' + (raw.spec || '')).trim()
    const cat = ('' + (raw.cat || '')).trim() || '电子元件'
    const loc = ('' + (raw.loc || '')).trim()
    const unit = ('' + (raw.unit || '')).trim() || '个'
    const safe = Number(raw.safe) || 0
    const setStock = ('' + (raw.stock ?? '')).trim() !== ''
    const stockNum = setStock ? parseQty(raw.stock, 0) : 0
    if (setStock && stockNum === null) { skipped.push({ idx: i + 1, reason: '库存数量不是 0 ~ 1000000 的整数，跳过' }); continue }
    // 效期：Excel 里常见 2026/3/5、20260305 等形态 → 一并接受；实在认不出的才跳过该行
    const expParsed = expireTs(raw.expire)
    if (expParsed === null) { skipped.push({ idx: i + 1, reason: '有效期格式无法识别，跳过' }); continue }
    const expTs = expParsed.ts
    const existing = (id && byId.get(id)) || byName.get(name)
    if (existing) {
      const f = existing.fields
      const oldStock = Number(f[COL.materials.stock]) || 0
      const patch = {
        [COL.materials.spec]: spec, [COL.materials.cat]: cat, [COL.materials.loc]: loc,
        [COL.materials.unit]: unit, [COL.materials.safe]: safe
      }
      // 效期：清单里给了才覆盖（留空表示"不改动"，避免误清已录的效期）
      // 注意用外层已解析好的 expTs（数字）：此前内层又取一次，会把整个对象写进 expire 列
      if (expTs) patch[COL.materials.expire] = expTs
      if (setStock) patch[COL.materials.stock] = stockNum
      await updateRecord('materials', existing.recordId, patch)
      if (setStock && stockNum !== oldStock) {
        const diff = stockNum - oldStock
        await addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: f[COL.materials.id],
          [COL.stock_io.dir]: diff > 0 ? (TR.ioFwd.in || '入库') : (TR.ioFwd.out || '出库'),
          [COL.stock_io.qty]: Math.abs(diff), [COL.stock_io.op]: actor,
          [COL.stock_io.time]: now(), [COL.stock_io.note]: '清单导入·期初校准', [COL.stock_io.src]: '清单导入'
        })
      }
      updated.push({ id: f[COL.materials.id], name })
    } else {
      max += 1
      const newId = id || ('M' + String(max).padStart(3, '0'))
      await addRecord('materials', {
        [COL.materials.id]: newId, [COL.materials.name]: name, [COL.materials.spec]: spec,
        [COL.materials.cat]: cat, [COL.materials.loc]: loc, [COL.materials.stock]: stockNum,
        [COL.materials.unit]: unit, [COL.materials.safe]: safe, [COL.materials.status]: '正常',
        [COL.materials.expire]: expTs
      })
      if (stockNum > 0) {
        await addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: newId,
          [COL.stock_io.dir]: TR.ioFwd.in || '入库', [COL.stock_io.qty]: stockNum,
          [COL.stock_io.op]: actor, [COL.stock_io.time]: now(),
          [COL.stock_io.note]: '清单导入·建档入库', [COL.stock_io.src]: '清单导入'
        })
        await addRecord('logs', {
          [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
          [COL.logs.op]: '清单导入耗材', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
        })
      }
      created.push({ id: newId, name, stock: stockNum })
    }
  }
  return { created: created.length, updated: updated.length, skipped: skipped.length }
}

// 工具批量导入：与 importMaterials 同构。工具无库存概念（不写 stock_io），
// 按 id（→Txxx）→ name 匹配；命中则更新描述字段并记日志，未命中则新建（自动 Txxx 编号）。
async function importTools(data) {
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (!rows.length) return { code: 400, data: { msg: '清单为空（rows 为空）' } }
  const actor = data.actor || ''
  const all = await getRecords('tools')
  let max = 0
  const byId = new Map(), byName = new Map()
  for (const r of all) {
    const f = r.fields
    const id = '' + (f[COL.tools.id] || '')
    const name = ('' + (f[COL.tools.name] || '')).trim()
    const m = /^\s*[Tt](\d+)\s*$/.exec(id)
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    if (id) byId.set(id, r)
    if (name) byName.set(name, r)
  }
  const created = [], updated = [], skipped = []
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {}
    const name = ('' + (raw.name || '')).trim()
    if (!name) { skipped.push({ idx: i + 1, reason: '缺名称，跳过' }); continue }
    const id = ('' + (raw.id || '')).trim()
    const spec = ('' + (raw.spec || '')).trim()
    const loc = ('' + (raw.loc || '')).trim()
    // 默认是「在库」而非「正常」：工具以「正常」入库后 borrow/approve 会判定「不在库」无法借出
    const status = ('' + (raw.status || '')).trim() || '在库'
    const holder = ('' + (raw.holder || '')).trim()
    const existing = (id && byId.get(id)) || byName.get(name)
    if (existing) {
      const f = existing.fields
      const patch = {
        [COL.tools.spec]: spec, [COL.tools.loc]: loc,
        [COL.tools.status]: status, [COL.tools.holder]: holder
      }
      await updateRecord('tools', existing.recordId, patch)
      await addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
        [COL.logs.op]: '清单导入工具', [COL.logs.target]: f[COL.tools.id], [COL.logs.result]: '更新成功'
      })
      updated.push({ id: f[COL.tools.id], name })
    } else {
      max += 1
      const newId = id || ('T' + String(max).padStart(3, '0'))
      await addRecord('tools', {
        [COL.tools.id]: newId, [COL.tools.name]: name, [COL.tools.spec]: spec,
        [COL.tools.loc]: loc, [COL.tools.status]: status, [COL.tools.holder]: holder
      })
      await addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
        [COL.logs.op]: '清单导入工具', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
      })
      created.push({ id: newId, name })
    }
  }
  return { created: created.length, updated: updated.length, skipped: skipped.length }
}

// 出入库登记：入库 + / 出库 -，更新库存 + 写 stock_io + logs
// 入库时若物品不存在，且带了 newItem 信息，则先建档再入库（老师无需先去文档手动加行）
async function io(data) {
  // —— 参数预校验（无副作用；失败不进幂等窗口，修正后重试不受影响）——
  const matId = ('' + data.matId || '').trim()
  if (!matId) return { code: 400, data: { msg: '请选择耗材' } }
  if (data.type !== 'in' && data.type !== 'out') return { code: 400, data: { msg: '登记方向必须是 in / out' } }
  // 数量服务端兜底：负数量会让「入库」变成变相出库（next<0 校验拦不住正库存下的负入库）
  const qty = parseQty(data.qty)
  if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数' } }
  // —— 幂等 + 写锁：窗口内同一操作人对同一耗材同方向同数量的登记只执行第一笔，
  //    重复提交复用第一笔结果（前端 busy 守卫失效时服务端兜底，防双倍扣减）——
  // 键里必须带备注：同物品同方向同数量但备注不同（例如分两批到货），
  // 少了备注 → 5 秒内第二笔会被静默吞掉，库存少加且用户毫无察觉。
  const idemKey = ['io', data.actor || '', matId, data.type, qty, data.note || ''].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '物品不存在：' + matId } }
    const delta = (data.type === 'in' ? 1 : -1) * qty
    // 原子增减（CAS）：把读到的期望值写进条件 → 条件不匹配说明期间被并发改动，重读重试
    const adj = await atomicAdjustStock(mat.recordId, delta)
    if (!adj.ok) {
      if (adj.reason === 'insufficient') return { code: 400, data: { msg: `库存不足：当前 ${adj.stock}` } }
      if (adj.reason === 'missing') return { code: 400, data: { msg: '物品不存在：' + matId } }
      throw new Error('库存更新未生效（并发冲突，重试后仍未成功）。请刷新后重试')
    }
    const next = adj.stock
    // 两条流水写入互不依赖，并行提交
    await Promise.all([
      addRecord('stock_io', {
        [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
        [COL.stock_io.dir]: TR.ioFwd[data.type] || '入库', [COL.stock_io.qty]: qty,
        [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(), [COL.stock_io.note]: data.note || '',
        [COL.stock_io.src]: data.src || (data.type === 'in' ? '手动入库' : '手动出库')
      }),
      addRecord('logs', {
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: data.type === 'in' ? '入库登记' : '出库登记', [COL.logs.target]: matId, [COL.logs.result]: '成功'
      })
    ])
    // 回读校验库存（与 repairToolRow 同思路）：三条写并行提交，若库存更新静默失败会账实不符。
    // 校验不过重试一次，仍不过抛可读错误——避免"提示登记成功但库存根本没变"。
    if (!(await verifyStock(matId, next))) {
      throw new Error('库存更新未生效（期望 ' + next + '）。请到腾讯文档核对「当前库存」列后重试')
    }
    return {}
  }))
}

// 回读校验「某张领用申请单对应的出库流水」是否存在；缺失则补写一次再验。
// 出库流水回读校验：审批已扣库存但真实流水可能静默失败（腾讯文档偶有 ret=0 不报错），
// 缺失时按【真实流水】补记一次（带入正确数量、方向、来源，与原流水完全一致），再回读确认。
// 早期版本此处补记的是 qty=0 的占位流水——库存已扣、流水却记成 0，真实出库量在台账里「消失」，
// 对账会出现"库存减了、流水却是 0"的失真。现改为重发真实流水，自愈后账实一致。
// 入参 outFlow 为已生成好的流水对象（含 note 锚点）；调用方只生成一次，自愈失败时复用同一对象补记。
async function verifyReqOutFlow(outFlow, matId) {
  const note = '' + (outFlow[COL.stock_io.note] || '')
  const exists = async () => {
    const rows = await getRecords('stock_io', null, { noCache: true })
    return rows.some(r => ('' + (r.fields[COL.stock_io.note] || '')) === note)
  }
  if (await exists()) return true
  try {
    await addRecord('stock_io', outFlow)
  } catch (e) { /* 下一轮再验 */ }
  return exists()
}

// 回读校验耗材库存是否等于期望值；不等则重写一次再验（写后静默失败会让账实不符）
async function verifyStock(matId, expect) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rows = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId, { noCache: true })
    const rec = rows[0]
    const cur = Number(rec && rec.fields[COL.materials.stock]) || 0
    if (cur === expect) return true
    if (attempt === 1 && rec) {
      try { await updateRecord('materials', rec.recordId, { [COL.materials.stock]: expect }) } catch (e) { /* 下一轮再验 */ }
    }
  }
  return false
}

// 申请单状态回读校验：并行写无事务，单独核对申请单是否真的改成「已通过」。
// 不一致时重写一次再验，仍不过返回 false（由调用方抛可读错误）。
async function verifyReqApproved(req) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rows = await getRecords('requisitions', r => r.recordId === req.recordId, { noCache: true })
    const rec = rows[0]
    if (rec && ('' + rec.fields[COL.requisitions.status]) === '已通过') return true
    if (attempt === 1 && rec) {
      try { await updateRecord('requisitions', rec.recordId, { [COL.requisitions.status]: '已通过' }) } catch (e) { /* 下一轮再验 */ }
    }
  }
  return false
}

// 工具行 + 借还记录的写后校验（approve 工具分支与 borrow 共用）：
// 工具=借出、存在该工具的「借出中」借还记录。缺项补写重试一次，仍不过返回 false。
async function verifyToolOut(toolId, tool, holder, makeBorrow) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId, { noCache: true })
    const okTool = tools[0] && ('' + tools[0].fields[COL.tools.status]) === '借出'
    const borrows = await getRecords('borrow', r => ('' + r.fields[COL.borrow.tool]) === toolId && ('' + r.fields[COL.borrow.status]) === '借出中')
    const okBorrow = borrows.length > 0
    if (okTool && okBorrow) return true
    if (attempt === 1) {
      try {
        if (!okTool) await updateRecord('tools', tool.recordId, { [COL.tools.status]: '借出', [COL.tools.holder]: holder })
        if (!okBorrow) {
          console.warn('[tencentdocs] verifyToolOut 补写借还记录：' + toolId)
          await addRecord('borrow', makeBorrow())
        }
      } catch (e) { /* 下一轮再验 */ }
    }
  }
  return false
}

// 工具借出审批的写后校验 = 申请单已通过 + 工具/借还记录就位（verifyToolOut）。
async function verifyToolBorrow(req, toolId, tool, applicant, makeBorrow) {
  if (!(await verifyReqApproved(req))) return false
  return verifyToolOut(toolId, tool, applicant, makeBorrow)
}

// ============================================================
// 批量入库（P2-⑬）
// 连续扫码到货时一件件登记不现实：扫 20 件要点 20 次"选择耗材→填数量→提交"。
// 这里一次请求处理多件，服务端逐项扣减/累加并各自记流水，账目粒度与逐笔登记完全一致。
// 与 io 的区别：不走单笔幂等窗口（批量本就是明确的多笔意图，同物同量重复出现是正常业务）。
// ============================================================
async function batchIo(data) {
  const actor = '' + (data.actor || '')
  const type = data.type === 'out' ? 'out' : 'in'
  const items = Array.isArray(data.items) ? data.items : []
  if (!items.length) return { code: 400, data: { msg: '没有需要登记的物品' } }
  // 汇总同物品（扫码时同一件被扫多次应累加，而不是写两条流水）
  const merged = new Map()
  for (const it of items) {
    const matId = ('' + (it.matId || '')).trim()
    if (!matId) continue
    const qty = parseQty(it.qty)
    if (qty === null) return { code: 400, data: { msg: '数量必须是 1 ~ 1000000 之间的整数：' + matId } }
    merged.set(matId, (merged.get(matId) || 0) + qty)
  }
  if (!merged.size) return { code: 400, data: { msg: '没有有效的登记数据' } }
  // 幂等键必须带备注与来源：同一物品、同一数量但备注不同（分两批到货）是两次不同的入库。
  // 键里少了备注 → 5 秒内第二笔被幂等窗口静默吞掉，库存少加，而返回值仍是第一笔的
  // 「成功」副本（已实测复现：库存 10→15，第二笔 5 卷凭空消失，流水只有 1 条）。
  const idemKey = ['batchIo', actor, type, data.note || '', data.src || ''].concat([...merged.entries()].map(([k, v]) => k + ':' + v)).join('|')

  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const details = []
    let done = 0
    for (const [matId, qty] of merged) {
      const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
      const mat = mats[0]
      if (!mat) { details.push({ matId, qty, err: '物品不存在' }); continue }
      const delta = (type === 'in' ? 1 : -1) * qty
      // 原子增减（CAS）：并发批量补货时不会丢更新，也不会把库存扣成负
      const adj = await atomicAdjustStock(mat.recordId, delta)
      if (!adj.ok) {
        if (adj.reason === 'insufficient') { details.push({ matId, qty, err: '库存不足（当前 ' + adj.stock + '）' }); continue }
        if (adj.reason === 'missing') { details.push({ matId, qty, err: '物品不存在' }); continue }
        details.push({ matId, qty, err: '并发冲突，重试后仍未成功' }); continue
      }
      const next = adj.stock
      await Promise.all([
        addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
          [COL.stock_io.dir]: type === 'in' ? '入库' : '出库', [COL.stock_io.qty]: qty,
          [COL.stock_io.op]: actor, [COL.stock_io.time]: now(), [COL.stock_io.note]: data.note || '',
          [COL.stock_io.src]: data.src || '批量入库'
        })
      ])
      if (!(await verifyStock(matId, next))) {
        details.push({ matId, qty, err: '库存回读失败' }); continue
      }
      done++
      details.push({ matId, name: mat.fields[COL.materials.name] || '', qty, stock: next })
    }
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
      [COL.logs.op]: type === 'in' ? '批量入库' : '批量出库',
      [COL.logs.target]: merged.size + ' 项', [COL.logs.result]: '成功 ' + done + ' 项'
    })
    return { type, done, failed: details.filter(d => d.err).length, details }
  }))
}

// 出入库流水账（最近 N 条，倒序）
// ⚠️ 真实文档 stock_io 表里存在历史脏数据：早期版本列名不匹配时写入的行只有「数量=1」，
//    物品ID/方向/操作人全空。此处过滤掉，避免流水账里出现无法解释的空行。
async function listStockIO(data) {
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const recs = await getRecords('stock_io')
  // 先过滤脏行、按原始时间戳倒序，再格式化时间：
  // ① 日期列读回是 13 位时间戳字符串，不过 fmtTs 前端会直接渲染 "1792830637038"（真实出现过）；
  // ② 排序必须在格式化前做——历史脏行的时间列可能是空值或其他格式，混排会乱。
  const valid = recs.filter(r => {
    const f = r.fields
    return (f[COL.stock_io.item] || '') && (f[COL.stock_io.dir] || '')
  })
  // —— 筛选（P2-⑮）：时间区间 / 物品 / 方向 / 操作人。
  // 只对账场景常用；此前只能"最近 30 条"，想查某件东西某段时间出了多少必须自己翻。
  const kw = ('' + (data.op || '')).trim().toUpperCase()
  const item = ('' + (data.item || '')).trim().toUpperCase()
  const dir = ('' + (data.dir || '')).trim()
  const from = Number(data.from) || 0          // 毫秒时间戳（含当天 00:00）
  const to = Number(data.to) || 0
  const filtered = valid.filter(r => {
    const f = r.fields
    if (item && ('' + f[COL.stock_io.item]).trim().toUpperCase().indexOf(item) < 0) return false
    if (dir && ('' + f[COL.stock_io.dir]) !== dir) return false
    if (kw && (('' + (f[COL.stock_io.op] || '')).trim().toUpperCase().indexOf(kw) < 0)) return false
    const t = Number(f[COL.stock_io.time]) || 0
    if (from && t && t < from) return false
    // to 传当天 24:00 的时间戳；时间为空的历史脏行不参与区间判断（t=0 时跳过）
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => ('' + (b.fields[COL.stock_io.time] || '')).localeCompare('' + (a.fields[COL.stock_io.time] || '')))
  // —— 分页（P2-⑭）：返回 total/hasMore，前端据此上拉加载，不再一次性拉全表
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const pageRows = filtered.slice(offset, offset + limit)
  const rows = pageRows.map(r => {
    const f = r.fields
    return {
      id: f[COL.stock_io.id] || '',
      item: f[COL.stock_io.item] || '',
      dir: f[COL.stock_io.dir] || '',
      qty: Number(f[COL.stock_io.qty]) || 0,
      op: f[COL.stock_io.op] || '',
      time: fmtTs(f[COL.stock_io.time]) || '',
      note: f[COL.stock_io.note] || '',
      // 来源类型（P3-㉖）：采购/捐赠/调拨/盘盈/期初/领用出库…让每笔变动都答得出"为什么动"
      src: f[COL.stock_io.src] || '',
      // 已冲销标记：原流水被打前缀，反向流水本身也已结清，两者都不再显示「冲销」按钮
      reversed: isSettledFlow(f),
      cls: ds.readCls(f)
    }
  })
  // 附上物品名，便于列表直接显示
  const mats = await getRecords('materials')
  const nameMap = {}
  for (const r of mats) nameMap['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
  rows.forEach(r => { r.itemName = nameMap[r.item] || r.item })
  // 兼容旧前端：此前返回裸数组，部分调用方直接 .map。现带上分页元信息后必须改对象，
  // 两个版本的调用方都要能工作，故这里统一返回对象（前端已按对象优先、数组兜底两种都兼容）。
  return {
    rows,
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    // 汇总：筛选区间内的入/出库总量，对账时不用再自己加一遍
    inQty: filtered.reduce((s, r) => s + (('' + r.fields[COL.stock_io.dir]) === '入库' ? (Number(r.fields[COL.stock_io.qty]) || 0) : 0), 0),
    outQty: filtered.reduce((s, r) => s + (('' + r.fields[COL.stock_io.dir]) === '出库' ? (Number(r.fields[COL.stock_io.qty]) || 0) : 0), 0)
  }
}

// ============================================================
// 操作日志查询（P2-㉑）
// logs 表全程写入已久，但只能到腾讯文档里看。管理员想要"谁在哪天做了什么"，
// 在系统内没有入口。这里提供带筛选与分页的查询。
// ============================================================
// ===== 教师端「领用记录」查询 =====
// 老师此前无法查看「学生领取使用了什么耗材」：
//   · io 页是出入库操作台，不是查询台；
//   · approve 页只看待审批，审批完就没了；
//   · usage 页是聚合统计，看不到逐条明细。
// 本接口以「申请单」为主表（它带申请人/班级/用途/审批人），联查物品名，
// 支持按班级/物品/领用人/状态/时间筛选，并受行级隔离约束（老师只看本班+公共）。
// 待交付清单：审批已通过、但实物还没确认交到学生手里的单子。
// 审批通过时库存已扣；这里只做「实物发料」的现场确认，不再动账（避免二次扣减）。
// 默认只看近 30 天的单：上线瞬间历史已通过单会一次性涌出来，30 天窗口可避开。
async function listDeliveries(data) {
  const d0 = data || {}
  const days = Math.max(0, Number(d0.days) || 30)   // 0 = 不限时间窗
  const showDelivered = !!d0.showDelivered
  const reqs = await getRecords('requisitions')
  const mats = await getRecords('materials')
  const tools = await getRecords('tools')
  const users = await getRecords('users')
  const nameOf = {}
  for (const r of mats) nameOf['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
  for (const r of tools) nameOf['' + r.fields[COL.tools.id]] = r.fields[COL.tools.name] || ''
  const userOf = {}
  for (const r of users) {
    const f = r.fields
    userOf['' + (f[COL.users.id] || '')] = { name: f[COL.users.name] || '', cls: ('' + (f[COL.users.cls] || '')).trim() }
  }
  const dayMs = 86400000
  const nowMs = Date.now()
  const p2 = n => ('' + n).padStart(2, '0')
  const cut = new Date(nowMs - days * dayMs + 8 * 3600 * 1000)
  const cutStr = `${cut.getUTCFullYear()}-${p2(cut.getUTCMonth() + 1)}-${p2(cut.getUTCDate())} ${p2(cut.getUTCHours())}:${p2(cut.getUTCMinutes())}`
  const rows = []
  for (const r of reqs) {
    const f = r.fields
    if (('' + (f[COL.requisitions.status] || '')) !== '已通过') continue
    const delivered = f[COL.requisitions.delivered] || ''
    if (delivered ? !showDelivered : showDelivered) continue
    const timeVal = f[COL.requisitions.time]
    const ts = Number(timeVal) || 0
    const timeStr = '' + (timeVal || '')
    if (days > 0) {
      if (ts) { if (nowMs - ts > days * dayMs) continue }
      else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(timeStr)) { if (timeStr < cutStr) continue }
    }
    const q = normReq(f)
    const itemId = '' + (f[COL.requisitions.item] || '')
    const u = userOf['' + (f[COL.requisitions.user] || '')] || {}
    rows.push(Object.assign(q, {
      itemName: nameOf[itemId] || '',
      userName: u.name || '',
      userCls: u.cls || '',
      delivered: delivered ? fmtTs(delivered) : ''
    }))
  }
  rows.sort((a, b) => ('' + b.time).localeCompare('' + a.time))
  return { rows, total: rows.length }
}

// 确认交付：把「审批通过但东西还没交」的申请标记为已交付，只留痕「实物已发出」，不再动库存。
async function confirmDelivery(data) {
  const no = '' + (data.no || '')
  if (!no) return { code: 400, data: { msg: '缺少申请单号' } }
  return withWriteLock(async () => {
    const reqs = await getRecords('requisitions', r => ('' + r.fields[COL.requisitions.id]) === no)
    const req = reqs[0]
    if (!req) return { code: 404, data: { msg: '申请不存在：' + no } }
    const status = '' + (req.fields[COL.requisitions.status] || '')
    if (status !== '已通过') {
      return { code: 400, data: { msg: '只有「已通过」的申请可以确认交付（当前：' + (status || '未知') + '）' } }
    }
    if (req.fields[COL.requisitions.delivered]) {
      return { code: 400, data: { msg: '该单已确认交付，请勿重复操作' } }
    }
    // 日志继承申请单班级（申请人是学生，管理员/教师只是代为发料）
    ds.overrideOwnerCls(ds.readCls(req.fields))
    const ts = now()
    await updateRecord('requisitions', req.recordId, { [COL.requisitions.delivered]: ts })
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: ts, [COL.logs.actor]: data.actor || '',
      [COL.logs.op]: '确认交付', [COL.logs.target]: no, [COL.logs.result]: '已交付'
    })
    return {}
  })
}

// 单件工具建档（教师及以上，与耗材建档权限对齐）：
//   批量导入 importTools 是管理员专属（可按编号/名称覆盖更新台账），
//   而现场登记一件工具不该有「覆盖」语义，也不该只有管理员能做 → 独立动作。
async function addTool(data) {
  const name = ('' + (data.name || '')).trim()
  if (!name) return { code: 400, data: { msg: '请填写工具名称' } }
  const spec = ('' + (data.spec || '')).trim()
  const loc = ('' + (data.loc || '')).trim()
  const wantId = ('' + (data.id || '')).trim()
  const idemKey = ['addTool', data.actor || '', name, wantId].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const all = await getRecords('tools')
    const byName = all.find(r => ('' + (r.fields[COL.tools.name] || '')).trim() === name)
    if (byName) {
      return { code: 409, data: { msg: '已有同名工具（' + ('' + byName.fields[COL.tools.id]) + '），请直接给它贴标签，或在批量建档里更新规格' } }
    }
    if (wantId) {
      const byId = all.find(r => ('' + (r.fields[COL.tools.id] || '')).trim().toUpperCase() === wantId.toUpperCase())
      if (byId) return { code: 409, data: { msg: '该编号已被占用：' + wantId } }
    }
    let max = 0
    for (const r of all) {
      const m = /^\s*[Tt](\d+)\s*$/.exec('' + r.fields[COL.tools.id])
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
    }
    const newId = wantId || ('T' + String(max + 1).padStart(3, '0'))
    const ts = now()
    await addRecord('tools', {
      [COL.tools.id]: newId, [COL.tools.name]: name, [COL.tools.spec]: spec,
      [COL.tools.loc]: loc, [COL.tools.status]: '在库', [COL.tools.holder]: ''
    })
    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: ts, [COL.logs.actor]: data.actor || '',
      [COL.logs.op]: '新增工具', [COL.logs.target]: newId, [COL.logs.result]: '建档成功'
    })
    return { id: newId, name, status: '在库' }
  }))
}

async function listClaims(data) {
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const offset = Math.max(0, Number(data.offset) || 0)
  const clsFilter = ('' + (data.cls || '')).trim()
  const itemKw = ('' + (data.item || '')).trim().toUpperCase()
  const userKw = ('' + (data.user || '')).trim().toUpperCase()
  const status = ('' + (data.status || '')).trim()
  const from = Number(data.from) || 0
  const to = Number(data.to) || 0

  const reqs = await getRecords('requisitions')
  const mats = await getRecords('materials')
  const nameMap = {}
  const unitMap = {}
  for (const r of mats) {
    const id = '' + r.fields[COL.materials.id]
    nameMap[id] = r.fields[COL.materials.name] || ''
    unitMap[id] = r.fields[COL.materials.unit] || ''
  }
  // 领用人 → 姓名/班级（申请单里存的是工号，展示要换成姓名）
  const users = await getRecords('users')
  const userMap = {}
  for (const r of users) {
    const f = r.fields
    userMap['' + (f[COL.users.id] || '')] = {
      name: f[COL.users.name] || '',
      cls: ('' + (f[COL.users.cls] || '')).trim()
    }
  }

  const filtered = reqs.filter(r => {
    const f = r.fields
    const item = ('' + (f[COL.requisitions.item] || '')).trim()
    const user = ('' + (f[COL.requisitions.user] || '')).trim()
    const rc = ds.readCls(f)
    if (clsFilter && rc !== clsFilter) return false
    if (itemKw && item.toUpperCase().indexOf(itemKw) < 0) {
      // 允许按物品名称搜（工号搜不到时用名称）
      const nm = ('' + (nameMap[item] || '')).toUpperCase()
      if (nm.indexOf(itemKw) < 0) return false
    }
    if (userKw && user.toUpperCase().indexOf(userKw) < 0) {
      const nm = ('' + ((userMap[user] || {}).name || '')).toUpperCase()
      if (nm.indexOf(userKw) < 0) return false
    }
    if (status && ('' + (f[COL.requisitions.status] || '')).trim() !== status) return false
    const t = Number(f[COL.requisitions.time]) || 0
    if (from && t && t < from) return false
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => (Number(b.fields[COL.requisitions.time]) || 0) - (Number(a.fields[COL.requisitions.time]) || 0))

  const total = filtered.length
  const pageRows = filtered.slice(offset, offset + limit)
  const rows = pageRows.map(r => {
    const f = r.fields
    const item = ('' + (f[COL.requisitions.item] || '')).trim()
    const user = ('' + (f[COL.requisitions.user] || '')).trim()
    const u = userMap[user] || {}
    return {
      no: f[COL.requisitions.id] || '',
      item,
      itemName: nameMap[item] || item,
      unit: unitMap[item] || '',
      qty: Number(f[COL.requisitions.qty]) || 0,
      user,
      userName: u.name || user,
      // 流水上的班级优先（领用出库流水继承自申请单），否则回退用户档案班级
      cls: ds.readCls(f) || u.cls || '',
      reason: f[COL.requisitions.reason] || '',
      reject: f[COL.requisitions.reject] || '',
      approver: f[COL.requisitions.approver] || '',
      status: TR.reqRev[f[COL.requisitions.status]] || f[COL.requisitions.status] || '',
      time: fmtTs(f[COL.requisitions.time]) || ''
    }
  })
  // 汇总：按班级统计领用数量（老师最关心"哪个班领了多少"）
  const byCls = {}
  filtered.forEach(r => {
    const f = r.fields
    const user = ('' + (f[COL.requisitions.user] || '')).trim()
    const rc = ds.readCls(f) || ((userMap[user] || {}).cls) || ''
    const key = rc || '未标注班级'
    if (!byCls[key]) byCls[key] = { cls: key, qty: 0, count: 0 }
    byCls[key].qty += (Number(f[COL.requisitions.qty]) || 0)
    byCls[key].count += 1
  })
  return {
    rows,
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    byCls: Object.values(byCls).sort((a, b) => b.qty - a.qty),
    classOptions: Array.from(new Set(
      filtered.map(r => {
        const f = r.fields
        const user = ('' + (f[COL.requisitions.user] || '')).trim()
        return ds.readCls(f) || ((userMap[user] || {}).cls) || ''
      }).filter(Boolean)
    )).sort()
  }
}

async function listLogs(data) {
  const recs = await getRecords('logs')
  const actor = ('' + (data.actor || '')).trim().toUpperCase()
  const op = ('' + (data.op || '')).trim()
  const target = ('' + (data.target || '')).trim().toUpperCase()
  const from = Number(data.from) || 0
  const to = Number(data.to) || 0
  const filtered = recs.filter(r => {
    const f = r.fields
    if (actor && ('' + (f[COL.logs.actor] || '')).trim().toUpperCase().indexOf(actor) < 0) return false
    if (op && ('' + (f[COL.logs.op] || '')) !== op) return false
    if (target && ('' + (f[COL.logs.target] || '')).trim().toUpperCase().indexOf(target) < 0) return false
    const t = Number(f[COL.logs.time]) || 0
    if (from && t && t < from) return false
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => ('' + (b.fields[COL.logs.time] || '')).localeCompare('' + (a.fields[COL.logs.time] || '')))
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const rows = filtered.slice(offset, offset + limit).map(r => {
    const f = r.fields
    return {
      id: f[COL.logs.id] || '', time: fmtTs(f[COL.logs.time]) || '',
      actor: f[COL.logs.actor] || '', op: f[COL.logs.op] || '',
      target: f[COL.logs.target] || '', result: f[COL.logs.result] || '',
      cls: ds.readCls(f)
    }
  })
  return { rows, total, offset, limit, hasMore: offset + rows.length < total }
}

// ============================================================
// 门禁记录查询（P3-㉑）
// access 表此前"有表、有写入 action、无页面"：数据一直在记，却没人看得到，
// 等于半个功能。这里提供与管理日志同构的查询，管理员可查谁在何时刷了哪道门。
// ============================================================
async function listAccess(data) {
  const recs = await getRecords('access')
  const user = ('' + (data.user || '')).trim().toUpperCase()
  const point = ('' + (data.point || '')).trim()
  const from = Number(data.from) || 0
  const to = Number(data.to) || 0
  const filtered = recs.filter(r => {
    const f = r.fields
    if (user && ('' + (f[COL.access.user] || '')).trim().toUpperCase().indexOf(user) < 0) return false
    if (point && ('' + (f[COL.access.point] || '')) !== point) return false
    const t = Number(f[COL.access.time]) || 0
    if (from && t && t < from) return false
    if (to && t && t > to) return false
    return true
  })
  filtered.sort((a, b) => ('' + (b.fields[COL.access.time] || '')).localeCompare('' + (a.fields[COL.access.time] || '')))
  const total = filtered.length
  const offset = Math.max(0, Number(data.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
  const rows = filtered.slice(offset, offset + limit).map(r => {
    const f = r.fields
    return {
      id: f[COL.access.id] || '', time: fmtTs(f[COL.access.time]) || '',
      user: f[COL.access.user] || '', point: f[COL.access.point] || '',
      result: f[COL.access.result] || '',
      cls: ds.readCls(f)
    }
  })
  return { rows, total, offset, limit, hasMore: offset + rows.length < total }
}

// ============================================================
// 冲销（P2-㉒）
// WMS/财务惯例：错误单据用"红字冲销单"更正，而不是把原记录删掉——
// 删了就没有痕迹，事后无法回答"这笔为什么少了"。
// 做法：写一笔方向相反的流水把库存抵回去，并在原流水备注上加 [已冲销] 标记。
// ============================================================
async function reverseIO(data) {
  const no = '' + (data.no || '')
  if (!no) return { code: 400, data: { msg: '缺少流水号' } }
  return withWriteLock(async () => {
    const list = await getRecords('stock_io', r => ('' + r.fields[COL.stock_io.id]) === no)
    const rec = list[0]
    if (!rec) return { code: 404, data: { msg: '流水不存在：' + no } }
    const f = rec.fields
    if (isSettledFlow(f)) {
      return { code: 400, data: { msg: '该流水已冲销或本身就是冲销产生的反向流水，不可再次冲销' } }
    }
    const matId = '' + (f[COL.stock_io.item] || '')
    const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === matId)
    const mat = mats[0]
    if (!mat) return { code: 400, data: { msg: '关联物品不存在：' + matId } }
    const qty = Number(f[COL.stock_io.qty]) || 0
    const dir = '' + (f[COL.stock_io.dir] || '')
    if (dir !== '入库' && dir !== '出库') return { code: 400, data: { msg: '该流水方向异常，无法冲销：' + (dir || '空') } }
    const backDir = dir === '入库' ? '出库' : '入库'
    const stock = Number(mat.fields[COL.materials.stock]) || 0
    const next = dir === '入库' ? stock - qty : stock + qty
    if (next < 0) return { code: 400, data: { msg: '冲销后库存为负（当前 ' + stock + '，需退回 ' + qty + '）' } }
    // 反向流水与冲销日志必须跟随原流水的班级，否则按班级对账时「原单一笔、冲销单看不到」，
    // 且管理员（ownerCls 多为空）操作后会退化成公共资源，对所有老师可见。
    const reverseCls = ds.readCls(f)
    // 原子回滚（CAS）：期望值进条件 → 并发冲销/领用不会把库存改错
    const adj = await atomicAdjustStock(mat.recordId, dir === '入库' ? -qty : qty)
    if (!adj.ok) {
      if (adj.reason === 'insufficient') return { code: 400, data: { msg: '冲销后库存为负（当前 ' + adj.stock + '，需退回 ' + qty + '）' } }
      if (adj.reason === 'missing') return { code: 400, data: { msg: '关联物品不存在：' + matId } }
      throw new Error('冲销未完全生效（流水 ' + no + '）：库存并发冲突，重试后仍未成功。请刷新后重试')
    }
    await Promise.all([
      updateRecord('stock_io', rec.recordId, { [COL.stock_io.note]: '[已冲销] ' + (f[COL.stock_io.note] || '') }),
      addRecord('stock_io', Object.assign({
        [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: matId,
        [COL.stock_io.dir]: backDir, [COL.stock_io.qty]: qty,
        [COL.stock_io.op]: data.actor, [COL.stock_io.time]: now(),
        [COL.stock_io.note]: '冲销流水 ' + no, [COL.stock_io.src]: '冲销'
      }, reverseCls ? { [COL.stock_io.cls]: reverseCls } : {})),
      addRecord('logs', Object.assign({
        [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor,
        [COL.logs.op]: '冲销出入库流水', [COL.logs.target]: no, [COL.logs.result]: '已冲销'
      }, reverseCls ? { [COL.logs.cls]: reverseCls } : {}))
    ])
    if (!(await verifyStock(matId, next))) {
      throw new Error('冲销未完全生效（流水 ' + no + '）：库存可能未回滚。请刷新后重试')
    }
    return { no, item: matId, dir: backDir, qty, stock: next }
  })
}

// 借工具
// 直接借出（教师代借 / 后续 ESP32 场景）。
// 2026-10-24 加固：旧实现不校验工具状态就写借还记录 → 可对「已借出/不存在」的工具重复借出，
//   产生多条「借出中」记录互相覆盖；且写完无回读校验，失败即静默。
// 现与 approve 工具分支同构：先校验在库 → 并行写 → verifyToolOut 回读校验，不过抛可读错误。
async function borrow(data) {
  return withWriteLock(async () => {
    const toolId = ('' + (data.toolId || '')).trim()
    if (!toolId) return { code: 400, data: { msg: '缺少工具ID' } }
    const user = ('' + (data.user || '')).trim()
    if (!user) return { code: 400, data: { msg: '缺少借用人' } }
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
    const tool = tools[0]
    if (!tool) return { code: 400, data: { msg: '工具不存在：' + toolId } }
    if (('' + tool.fields[COL.tools.status]) !== '在库') {
      return { code: 400, data: { msg: '该工具不在库（当前：' + (tool.fields[COL.tools.status] || '未知') + '）' } }
    }
    const borrowPayload = () => ({
      [COL.borrow.id]: genNo('B'), [COL.borrow.user]: user, [COL.borrow.tool]: toolId,
      [COL.borrow.out]: now(), [COL.borrow.plan]: planDue(data.days), [COL.borrow.in]: '', [COL.borrow.status]: '借出中',
      // 借出备注：用途、临时借用说明等（教师直接借出与审批通过两条路径共用）
      [COL.borrow.note]: ('' + (data.note || '')).trim().slice(0, 120)
    })
    // 原子切换工具状态（CAS）：状态仍是「在库」才借出 → 同一件工具不会被并发借出两次
    const toolSw = await atomicSwitchToolStatus(tool.recordId, '在库', '借出', { [COL.tools.holder]: user })
    // CAS 未命中 = 工具已被别人借走 → 与串行路径同口径回 400（不是 500 服务器故障）
    if (!toolSw) return { code: 400, data: { msg: '该工具不在库（已被他人借走）：' + toolId } }
    await Promise.all([
      addRecord('borrow', borrowPayload()),
      // actor=操作人（教师直接借出时是老师），user=实际借用人；自借时两者相同
      addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor || user, [COL.logs.op]: '借出工具', [COL.logs.target]: toolId, [COL.logs.result]: '借出中' })
    ])
    if (!(await verifyToolOut(toolId, tool, user, borrowPayload))) {
      throw new Error('借出未完全生效（工具 ' + toolId + '）。请刷新后重试；若仍失败，请到腾讯文档核对')
    }
    return {}
  })
}

// 教师直接借出：不必等学生申请，登记「某工具现在借给了某人」。
// 归属班级跟随【借用人】而非操作老师，确保流水落在借用人本班、任课教师可见、按班对账正确。
async function directBorrow(data) {
  const borrowerId = ('' + (data.borrower || '')).trim().toUpperCase()
  if (!borrowerId) return { code: 400, data: { msg: '请填写借用工号' } }
  const fu = await findUser(borrowerId)
  if (!fu || !fu.user) return { code: 404, data: { msg: '借用人不存在或已停用：' + borrowerId } }
  ds.overrideOwnerCls(fu.user.cls || '')
  return borrow({
    toolId: data.toolId, user: fu.user.id, actor: data.actor,
    days: data.days, reason: data.reason, note: data.note
  })
}

// 还工具
// 2026-10-24 加固（修复实测「点了归还，列表里还是不对 / 工具卡在借出」）：
//   ① 顺序改为「先修工具行、后结清借还记录」。旧顺序先写 borrow 再写 tools，
//      一旦 tools 写失败，borrow 已是「已归还」→ 再也找不到「借出中」记录 → 工具永久卡在「借出」且每次点归还都报错。
//   ② 工具行写完必须回读校验（状态=在库 且 持有人已清空）。文本列清空值在平台上的行为不一致
//      （纯字符串会被静默丢弃），校验不过就换写法重试，仍不过则抛可读错误，绝不静默失败。
//   ③ 自愈：找不到「借出中」记录但工具行仍是「借出」（历史部分写失败残留），直接修复工具行。
async function returnTool(data) {
  return withWriteLock(async () => {
    const toolId = '' + (data.toolId || '')
    const list = await getRecords('borrow', r =>
      ('' + r.fields[COL.borrow.tool]) === toolId && ('' + r.fields[COL.borrow.status]) === '借出中')
    const rec = list[0]
    const tools = await getRecords('tools', r => ('' + r.fields[COL.tools.id]) === toolId)
    const tool = tools[0]
    const toolStatus = tool ? ('' + (tool.fields[COL.tools.status] || '')) : ''
    const backNote = ('' + (data.note || '')).trim().slice(0, 120)
    const needRepair = !!tool && toolStatus === '借出'
    if (!rec && !needRepair) {
      // 这是用户操作问题（重复归还 / 工具从未借出），不是服务器故障 →
      // 必须回 400 业务错误；用 throw 会被当成 500，前端只能显示"操作失败"，
      // 老师看不出到底是自己重复归还了还是系统坏了。
      return { code: 400, data: { msg: '没有可归还的记录：' + toolId +
        (tool ? '（当前状态：' + (toolStatus || '未知') + '）' : '（工具不存在）') } }
    }
    // ① 先修工具行（带校验；失败会抛错，此时 borrow 未动，重试可收敛）
    if (needRepair) await repairToolRow('tools', tool.recordId)
    // ② 再结清借还记录
    if (rec) {
      await updateRecord('borrow', rec.recordId, {
        [COL.borrow.status]: '已归还', [COL.borrow.in]: now(),
        // 归还入库时的验收备注（完好/缺件/需维修）
        [COL.borrow.backNote]: backNote
      })
    } else {
      console.warn('[tencentdocs] returnTool 自愈：' + toolId + ' 无「借出中」借还记录，已直接修复工具行')
    }
    await addRecord('logs', { [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: data.actor, [COL.logs.op]: '归还工具', [COL.logs.target]: toolId,
      [COL.logs.result]: '已归还' + (backNote ? '：' + backNote : '') })
    return { healed: !rec }
  })
}

// 字段是否为空：兼容平台返回的多种空值形态（'' / null / [] / [{text:''}] / {text:''}）
function isBlank(v) {
  if (v === '' || v === null || v === undefined) return true
  if (Array.isArray(v)) return !v.length || v.every(x => !x || x.text === '' || x.text == null)
  if (typeof v === 'object' && 'text' in v) return !v.text
  return false
}

// 把工具行修回「在库」并清空「当前持有人」：写完回读校验，不过则换写法重试，仍不过抛可读错误
async function repairToolRow(sheetKey, recordId) {
  let lastErr = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (sheetKey === 'tools') {
        // 原子切换（CAS）：状态仍是「借出」才置为在库 → 不会覆盖并发发生的新借出
        const sw = await atomicSwitchToolStatus(recordId, '借出', '在库', { [COL.tools.holder]: '' })
        if (sw) return true
      }
      // CAS 未命中（状态本就不是「借出」，属于状态异常）：走无条件修复 + 回读校验
      await updateRecord(sheetKey, recordId, {
        [COL.tools.status]: '在库',
        [COL.tools.holder]: attempt === 1 ? [{ type: 'text', text: '' }] : []
      })
    } catch (e) { lastErr = e && e.message }
    const rows = await getRecords(sheetKey, r => r.recordId === recordId, { noCache: true })
    const f = rows[0] ? rows[0].fields : {}
    if (('' + (f[COL.tools.status] || '')) === '在库' && isBlank(f[COL.tools.holder])) return true
    if (!lastErr) lastErr = '状态=' + (f[COL.tools.status] || '(空)') + ' 持有人=' + JSON.stringify(f[COL.tools.holder])
  }
  throw new Error('工具行更新未生效（' + lastErr + '）。请到腾讯文档把该行「状态」改为在库、「当前持有人」清空')
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

// ============================================================
// 导出（P1-⑩）
// 此前所有数据只能在小程序里看，上报/教务核对时要对着手机手工抄，这是实训室管理的高频痛点。
// 腾讯文档 API 不提供"导出表格"，所以在云函数侧拼 CSV 文本返回，前端负责复制/落盘。
// ============================================================
// CSV 转义：值里有分隔符/引号/换行时必须加引号并把内部引号翻倍，否则整行错位
function csvCell(v) {
  let s = (v === null || v === undefined) ? '' : '' + v
  // CSV 公式注入防护：以 = + - @ 开头（含前导空白）的单元格会被 Excel/WPS 当成公式执行，
  //   清单里若被塞进 =HYPERLINK(...) 之类，打开导出的 CSV 就会触发钓鱼；
  //   同时合法值（「+5V模块」「-40℃环境」）也会被 Excel 显示成 #NAME?。
  // 前置单引号 → Excel 按文本处理，粘贴后仍显示原值；导入侧 unguardFormula 会还原。
  if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function csvLines(header, rows) {
  return [header.map(csvCell).join(',')].concat(rows.map(r => r.map(csvCell).join(','))).join('\r\n')
}
// 北京时区的「今天」→ YYYYMMDD。用于导出文件名与盘点单据上的日期戳。
// 不能写 csvDate(new Date(now()))：now() 返回的已是北京墙钟字符串，
// new Date('2026-10-25 00:30') 会被当成本地时间解析，再取 UTC 日期就退回了前一天——
// 容器 TZ=Asia/Shanghai 时，北京时间 00:00–08:00 导出的文件名和单据日期都会错一天。
// 直接从北京墙钟字符串切出日期，零时区依赖。
function csvToday() {
  return ('' + now()).slice(0, 10).replace(/-/g, '')
}

async function exportData(data) {
  const kind = ('' + (data.kind || 'materials')).trim()
  const today = csvToday()
  const bj = (t) => fmtTs(t) || ''
  let header = [], rows = [], name = kind

  if (kind === 'materials') {
    const list = await getRecords('materials')
    // 列序必须与「批量建档导入」的解析顺序一致（名称在前、编号在后）：
    //   此前导出是「耗材ID,名称,…,当前库存,单位,…」而导入按「名称,编号,…,单位,期初库存,…」解析，
    //   导致用户「导出→改→再导入」会把 ID 当成名称、单位当库存数，把台账写坏。
    //   导出再带上「有效期」，否则往返一次效期就没了。
    header = ['名称', '耗材ID', '规格', '类别', '存放位置', '单位', '当前库存', '预警线', '有效期']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.materials.name], f[COL.materials.id], f[COL.materials.spec] || '', f[COL.materials.cat] || '',
      f[COL.materials.loc] || '', f[COL.materials.unit] || '', Number(f[COL.materials.stock]) || 0,
      Number(f[COL.materials.safe]) || 0,
      f[COL.materials.expire] ? fmtTs(f[COL.materials.expire]) : ''
    ] })
    name = '耗材库存清单'
  } else if (kind === 'tools') {
    const list = await getRecords('tools')
    // 列序与「批量建档导入」一致（名称在前、编号在后），否则导出再导入会写坏
    header = ['名称', '工具ID', '规格', '存放位置', '状态', '当前持有人']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.tools.name], f[COL.tools.id], f[COL.tools.spec] || '', f[COL.tools.loc] || '',
      f[COL.tools.status] || '', f[COL.tools.holder] || ''
    ] })
    name = '工具台账'
  } else if (kind === 'stock_io') {
    const list = await getRecords('stock_io')
    const mats = await getRecords('materials')
    const nm = {}
    for (const r of mats) nm['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
    header = ['流水ID', '物品ID', '物品名称', '方向', '数量', '操作人', '操作时间', '来源类型', '备注']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.stock_io.id], f[COL.stock_io.item], nm['' + f[COL.stock_io.item]] || '',
      f[COL.stock_io.dir] || '', Number(f[COL.stock_io.qty]) || 0, f[COL.stock_io.op] || '',
      bj(f[COL.stock_io.time]), f[COL.stock_io.src] || '', f[COL.stock_io.note] || ''
    ] })
    name = '出入库流水'
  } else if (kind === 'requisitions') {
    const list = await getRecords('requisitions')
    header = ['申请ID', '申请人ID', '物品ID', '类型', '数量', '用途说明', '状态', '申请时间', '审批人', '驳回原因']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.requisitions.id], f[COL.requisitions.user], f[COL.requisitions.item], f[COL.requisitions.type] || '',
      Number(f[COL.requisitions.qty]) || 0, f[COL.requisitions.reason] || '', f[COL.requisitions.status] || '',
      bj(f[COL.requisitions.time]), f[COL.requisitions.approver] || '', f[COL.requisitions.reject] || ''
    ] })
    name = '领用申请单'
  } else if (kind === 'borrow') {
    const list = await getRecords('borrow')
    header = ['借还ID', '借用人ID', '工具ID', '借出时间', '计划归还', '实际归还', '状态']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.borrow.id], f[COL.borrow.user], f[COL.borrow.tool], bj(f[COL.borrow.out]),
      bj(f[COL.borrow.plan]), bj(f[COL.borrow.in]), f[COL.borrow.status] || ''
    ] })
    name = '工具借用记录'
  } else if (kind === 'access') {
    const list = await getRecords('access')
    header = ['记录ID', '用户ID', '门禁点', '刷卡时间', '结果']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.access.id], f[COL.access.user], f[COL.access.point] || '', bj(f[COL.access.time]), f[COL.access.result] || ''
    ] })
    name = '门禁记录'
  } else if (kind === 'logs') {
    const list = await getRecords('logs')
    header = ['日志ID', '时间', '操作人', '操作类型', '对象', '结果']
    rows = list.map(r => { const f = r.fields; return [
      f[COL.logs.id], bj(f[COL.logs.time]), f[COL.logs.actor] || '', f[COL.logs.op] || '',
      f[COL.logs.target] || '', f[COL.logs.result] || ''
    ] })
    name = '操作日志'
  } else {
    return { code: 400, data: { msg: '不支持的导出类型：' + kind } }
  }

  return {
    filename: name + '_' + today + '.csv',
    count: rows.length,
    // \\uFEFF：BOM。没有它 Excel 打开 UTF-8 中文会乱码（Windows 默认按本地编码解析）。
    csv: '\uFEFF' + csvLines(header, rows)
  }
}

// ============================================================
// 盘点 / 期初建账（P1-⑪⑫）
// ============================================================
// 盘点：账面 vs 实盘 → 差异调整。此前库存只能靠流水累加，账面与实物长期偏离也无从校正，
//   这是实训室资产管理的硬伤（评估报告 A3）。差异必须以"流水"形式留痕，账才有据可查。
// 期初：系统启用时录入期初库存。与盘点的区别在于——期初不看账面，直接把实盘数定为基线，
//   并写一笔「期初入库」流水，代表一切账目的起点（评估报告 A4）。
// mode='opening' 走期初分支，其余（含空）走盘点分支。
async function stocktake(data) {
  const mode = ('' + (data.mode || 'stocktake')) === 'opening' ? 'opening' : 'stocktake'
  const actor = '' + (data.actor || '')
  const items = Array.isArray(data.items) ? data.items : []
  if (!items.length) return { code: 400, data: { msg: '没有需要处理的物品' } }
  // 实盘数量必须是非负整数；负数量会让"调整"变成凭空出库
  const clean = []
  for (const it of items) {
    const matId = ('' + (it.matId || '')).trim()
    if (!matId) continue
    const real = parseQty(it.real, 0)
    if (real === null) {
      return { code: 400, data: { msg: '实盘数量必须是 0 ~ 1000000 之间的整数：' + matId } }
    }
    clean.push({ matId, real })
  }
  if (!clean.length) return { code: 400, data: { msg: '没有有效的实盘数据' } }

  const idemKey = ['stocktake', mode, actor].concat(clean.map(i => i.matId + ':' + i.real)).join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const stamp = csvToday()
    const note = (id) => mode === 'opening'
      ? '期初建账 ' + stamp + '（' + id + '）'
      : '盘点调整 ' + stamp + '（' + id + '）'
    const details = []
    let adjusted = 0, unchanged = 0

    for (const it of clean) {
      const mats = await getRecords('materials', r => ('' + r.fields[COL.materials.id]) === it.matId)
      const mat = mats[0]
      if (!mat) { details.push({ matId: it.matId, err: '物品不存在' }); continue }
      const book = Number(mat.fields[COL.materials.stock]) || 0
      // 期初与盘点统一按「实盘 − 账面」算差异：期初只是把实盘直接定为库存基线，
      // 并非「账面 + 实盘」——若账本非空时跑期初（如先有历史流水），旧写法 next=book+real
      // 会把库存翻倍（实测 102+80=182）。两种模式最终都收敛到实盘数（book+diff ≡ real）。
      const diff = it.real - book
      if (diff === 0) { unchanged++; details.push({ matId: it.matId, book, real: it.real, diff: 0 }); continue }
      const next = it.real
      if (next < 0) { details.push({ matId: it.matId, err: '调整后为负，已跳过' }); continue }
      // 原子写实盘（CAS）：条件是读到的账面值 → 盘点与领用并发时不会互相覆盖
      const adj = await casUpdate('materials', mat.recordId,
        { [COL.materials.stock]: book }, { [COL.materials.stock]: next })
      if (!adj.ok) { details.push({ matId: it.matId, name: mat.fields[COL.materials.name] || '', book, real: it.real, diff, err: '库存已被并发改动，请重新盘点' }); continue }
      await Promise.all([
        addRecord('stock_io', {
          [COL.stock_io.id]: genNo('S'), [COL.stock_io.item]: it.matId,
          [COL.stock_io.dir]: diff > 0 ? '入库' : '出库', [COL.stock_io.qty]: Math.abs(diff),
          [COL.stock_io.op]: actor, [COL.stock_io.time]: now(), [COL.stock_io.note]: note(it.matId),
          [COL.stock_io.src]: mode === 'opening' ? '期初建账' : '盘点调整'
        })
      ])
      // 回读校验：库存没落成会导致"调了跟没调一样"，而此时流水已写进去——账比调整前更乱
      if (!(await verifyStock(it.matId, next))) {
        details.push({ matId: it.matId, book, real: it.real, diff, err: '库存回读失败' }); continue
      }
      adjusted++
      details.push({ matId: it.matId, name: mat.fields[COL.materials.name] || '', book, real: it.real, diff })
    }

    await addRecord('logs', {
      [COL.logs.id]: genNo('L'), [COL.logs.time]: now(), [COL.logs.actor]: actor,
      [COL.logs.op]: mode === 'opening' ? '期初建账' : '库存盘点',
      [COL.logs.target]: clean.length + ' 项', [COL.logs.result]: '调整 ' + adjusted + ' 项'
    })
    return { mode, adjusted, unchanged, details }
  }))
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
    const k = ('' + (uid || '')).trim()   // 行值可能带空格（手工录入），与 normUser 的 trim 对齐
    if (!k) return
    if (!byUser[k]) byUser[k] = { n: 0, last: time }
    byUser[k].n++
    if (time && (!byUser[k].last || time > byUser[k].last)) byUser[k].last = time
  }
  // 时间列必须过 fmtTs：logs/access 的「时间/刷卡时间」是日期类型，读回为 13 位时间戳字符串，
  // 不过格式化前端「最近活跃」会直接显示 1792721445205（真实数据验证过这个缺陷）。
  // fmtTs 输出零填充的 'YYYY-MM-DD HH:mm'，字典序即时间序，下面的 last 比较不受影响。
  logs.forEach(l => bump(l.fields[COL.logs.actor], fmtTs(l.fields[COL.logs.time])))
  accesses.forEach(a => bump(a.fields[COL.access.user], fmtTs(a.fields[COL.access.time])))

  const rank = Object.keys(byUser).map(uid => ({
    user: userMap[uid] || { id: uid, name: uid, role: '?', cls: '' },
    n: byUser[uid].n, last: byUser[uid].last
  })).sort((a, b) => b.n - a.n)

  const teachers = users.filter(u => u.role === 'teacher')
  const teacherActive = teachers.filter(t => byUser[t.id]).length

  // ============ 业务报表（P2-㉓）============
  // 原有的 rank 只回答"谁操作得多"，不回答"领用了什么、什么时候消耗最多、工具周转如何"——
  // 后者才是实训室管理者真正要看的。以下三张表全部在服务端算好，前端不做聚合。
  const ioList = await getRecords('stock_io')
  const reqRows = await getRecords('requisitions')
  const mats = await getRecords('materials')
  const tools = await getRecords('tools')
  const borrowRows = await getRecords('borrow')
  const matName = {}
  const matUnit = {}
  for (const r of mats) {
    matName['' + r.fields[COL.materials.id]] = r.fields[COL.materials.name] || ''
    matUnit['' + r.fields[COL.materials.id]] = r.fields[COL.materials.unit] || ''
  }
  const toolName = {}
  for (const r of tools) toolName['' + r.fields[COL.tools.id]] = r.fields[COL.tools.name] || ''

  // ① 近 6 个月消耗趋势：按流水时间分月统计出库数量
  // 月份键统一用「北京时间」口径：存进腾讯文档的时间列经 buildValues 落库为 epoch 毫秒，
  // 读取后 +8h 取 UTC 月即北京月。注意 months 数组也必须用同一口径，否则在每天 16:00–23:59
  // （北京月比 UTC 月进一位）期间，当月流水会被 monthKey 分到北京的下一月而 months 里只有 UTC 当月，
  // 导致这部分流水在趋势图里「丢失」。冲销产生的两类流水都不计入消耗趋势：
  // ① 原流水（备注加前缀 [已冲销]）；② 冲销反向流水（备注为「冲销流水 …」，本身不带 [已冲销]）。
  // 只排除 ① 会漏算 ②，导致趋势图出现一笔虚假的入库/出库。
  const isReversed = (f) => {
    const n = '' + (f[COL.stock_io.note] || '')
    const s = '' + (f[COL.stock_io.src] || '')
    // src='冲销' 是系统写的反向流水（最精准）；备注文本匹配用于兼容早期 src 为空的历史数据。
    return n.indexOf('[已冲销]') >= 0 || s === '冲销' || n.indexOf('冲销流水') >= 0
  }
  const bjMonthKey = (ts) => {
    if (!ts) return ''
    const d = new Date(Number(ts) + 8 * 3600 * 1000)
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
  }
  const months = []
  const base = new Date(Date.now() + 8 * 3600 * 1000)
  base.setUTCDate(1); base.setUTCHours(0, 0, 0, 0)
  for (let i = 5; i >= 0; i--) {
    const d = new Date(base)
    d.setUTCMonth(d.getUTCMonth() - i)
    months.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'))
  }
  const trendMap = {}
  months.forEach(m => { trendMap[m] = { m, out: 0, in: 0 } })
  for (const r of ioList) {
    const f = r.fields
    if (isReversed(f)) continue
    const k = bjMonthKey(f[COL.stock_io.time])
    if (!k || !trendMap[k]) continue
    const q = Number(f[COL.stock_io.qty]) || 0
    if (('' + f[COL.stock_io.dir]) === '出库') trendMap[k].out += q
    else trendMap[k].in += q
  }
  const trend = months.map(m => trendMap[m])
  const trendMax = Math.max(1, ...trend.map(x => Math.max(x.in, x.out)))

  // ② 耗材领用 Top10：已通过的领用申请 + 手动出库流水，按累计出库量排序
  const topMap = {}
  const addOut = (matId, qty) => {
    const k = '' + (matId || '')
    if (!k || !matName[k]) return
    if (!topMap[k]) topMap[k] = { id: k, name: matName[k], unit: matUnit[k] || '', qty: 0, times: 0 }
    topMap[k].qty += qty
    topMap[k].times++
  }
  for (const r of ioList) {
    const f = r.fields
    if (isReversed(f)) continue
    if (('' + f[COL.stock_io.dir]) === '出库') addOut(f[COL.stock_io.item], Number(f[COL.stock_io.qty]) || 0)
  }
  const topMaterials = Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 10)

  // ③ 工具周转：借用次数、当前在外数量、已归还率
  const turnMap = {}
  for (const r of borrowRows) {
    const f = r.fields
    const k = '' + (f[COL.borrow.tool] || '')
    if (!k) continue
    if (!turnMap[k]) turnMap[k] = { id: k, name: toolName[k] || k, times: 0, returned: 0, out: 0 }
    turnMap[k].times++
    const st = '' + (f[COL.borrow.status] || '')
    if (st === '已归还') turnMap[k].returned++
    else turnMap[k].out++
  }
  const toolTurnover = Object.values(turnMap).sort((a, b) => b.times - a.times).slice(0, 10)
  const borrowTotal = borrowRows.length
  const borrowOpen = borrowRows.filter(r => ('' + r.fields[COL.borrow.status]) !== '已归还').length
  // 逾期借用清单（P1-⑥ 的报表侧）：给管理者一个"该催了"的清单
  const overdue = await (async () => {
    const rows = borrowRows
      .filter(r => ('' + r.fields[COL.borrow.status]) === '借出中')
      .map(r => normBorrow(r.fields))
      .filter(b => b.overdue)
    return rows.sort((a, b) => ('' + (b.plan || '')).localeCompare('' + (a.plan || '')))
  })()
  // 低库存预警清单（P2-⑳ 的数据源）：把"有几条低于安全线"变成"是哪几条"
  const lowStock = mats
    .map(r => normMaterial(r.fields))
    // 低库存阈值口径必须与前端一致（前端 4 处均为 stock < safe）：库存恰好等于安全线视为「已达标」
    // 不预警。后端曾用 <= → 统计页「低库存物品数」与库存页/补货列表对不上（老师按简报去补货却找不到该项）。
    .filter(m => m.safe > 0 && m.stock < m.safe)
    .sort((a, b) => (a.stock / Math.max(1, a.safe)) - (b.stock / Math.max(1, b.safe)))

  return {
    total: logs.length + accesses.length,
    activeUsers: Object.keys(byUser).length,
    teacherActive, teacherTotal: teachers.length,
    rank,
    // —— 报表数据 ——
    trend, trendMax,
    topMaterials,
    toolTurnover,
    borrow: { total: borrowTotal, open: borrowOpen, returned: borrowTotal - borrowOpen },
    overdue,
    lowStock,
    // 申请单构成：待办/通过/拒绝的分布，便于判断积压情况
    reqStat: (() => {
      const map = { pending: 0, approved: 0, rejected: 0, canceled: 0, other: 0 }
      for (const r of reqRows) {
        const s = TR.reqRev['' + r.fields[COL.requisitions.status]] || 'other'
        map[s] = (map[s] || 0) + 1
      }
      return map
    })()
  }
}

// 全量快照：H5 轻量页面用一条请求拉取所有表，再在本地渲染。
// 返回的字段形状与 H5 原型（前端视图）一致，避免前端做翻译。
async function snapshot() {
  // 局部名避开与导出函数 access/borrow 同名（原实现用 access/borrow 作数组名，遮蔽同名函数，
  // 可读性差且未来在函数体内调用 borrow()/access() 会直接拿到数组而崩溃）。
  // labs/repairs/inspections 是云库专属集合，腾讯文档侧只有占位 ID。
  // 若误在 DATA_BACKEND=tencent 下备份，这三表读不到属预期，返回空数组而不是让整份备份崩溃。
  const safeGet = async (key) => {
    try { return await getRecords(key) } catch (e) { console.warn('[snapshot] 跳过不可用表 ' + key + '：' + (e && e.message)); return [] }
  }
  const [userRows, materialRows, toolRows, reqRows, borrowRows, ioRows, accessRows, logRows,
    labRows, repairRows, inspectionRows] = await Promise.all([
    getRecords('users'), getRecords('materials'), getRecords('tools'),
    getRecords('requisitions'), getRecords('borrow'), getRecords('stock_io'),
    getRecords('access'), getRecords('logs'),
    safeGet('labs'), safeGet('repairs'), safeGet('inspections')
  ])
  // 用户与角色：对齐 adminListUsers 的富形态（含 rid / bound，不下发 openid），并附角色汇总，
  // 使全量快照成为管理员的系统全景入口（与「用户与角色」管理页同源）。
  const userList = userRows
    .map(r => {
      const u = normUser(r.fields)
      return {
        rid: r.recordId,
        id: u.id, name: u.name, role: u.role, cls: u.cls,
        managedClasses: u.managedClasses || '',
        status: u.status,
        bound: !!(u.openid && ('' + u.openid).trim())
      }
    })
    .filter(u => !!(u.id && ('' + u.id).trim())) // 跳过完全空白的行
  const usersByRole = userList.reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc }, {})
  return {
    users: userList,
    usersByRole,
    materials: materialRows.map(r => ({ ...normMaterial(r.fields), qr: r.fields[COL.materials.id] })),
    tools: toolRows.map(r => normTool(r.fields)),
    requisitions: reqRows.map(r => normReq(r.fields)),
    borrow: borrowRows.map(r => normBorrow(r.fields)),
    stock_io: ioRows.map(r => normStockIO(r.fields)),
    access: accessRows.map(r => normAccess(r.fields)),
    logs: logRows.map(r => normLog(r.fields)),
    // 备份必须覆盖全部 11 张表：此前漏掉实训室/报修/巡检，恢复后这三块业务数据会永久丢失。
    labs: labRows.map(r => normLab(r.fields)),
    repairs: repairRows.map(r => normRepair(r.fields)),
    inspections: inspectionRows.map(r => normInspection(r.fields)),
    generatedAt: now(),
    version: 1
  }
}

// ============================================================
// 导出
// ============================================================
// ============================================================
// 4. 实训室归属管理体系（labs / repairs / inspections）
//    与 clouddb.js 同形镜像（恒等映射 + 相同业务函数体）。
//    注：此三表为云库专属，腾讯文档无对应 sheet；DATA_BACKEND=cloud 时本模块不会被调用。
// ============================================================
function normLab(f) {
  return {
    id: f[COL.labs.id], name: f[COL.labs.name] || '',
    campus: f[COL.labs.campus] || '', building: f[COL.labs.building] || '',
    floor: f[COL.labs.floor] || '', roomNo: f[COL.labs.roomNo] || '',
    address: f[COL.labs.address] || '',
    lng: Number(f[COL.labs.lng]) || 0, lat: Number(f[COL.labs.lat]) || 0,
    managerId: f[COL.labs.managerId] || '', managerName: f[COL.labs.managerName] || '',
    status: f[COL.labs.status] || '启用', note: f[COL.labs.note] || '',
    createdAt: fmtTs(f[COL.labs.createdAt]), updatedAt: fmtTs(f[COL.labs.updatedAt])
  }
}
function normRepair(f) {
  return {
    id: f[COL.repairs.id], labId: f[COL.repairs.labId], labName: f[COL.repairs.labName] || '',
    title: f[COL.repairs.title] || '', category: f[COL.repairs.category] || '', desc: f[COL.repairs.desc] || '',
    reporterId: f[COL.repairs.reporterId] || '', reporterName: f[COL.repairs.reporterName] || '',
    status: f[COL.repairs.status] || '待处理', priority: f[COL.repairs.priority] || '一般',
    handlerId: f[COL.repairs.handlerId] || '', handlerName: f[COL.repairs.handlerName] || '',
    resolvedNote: f[COL.repairs.resolvedNote] || '',
    createdAt: fmtTs(f[COL.repairs.createdAt]), updatedAt: fmtTs(f[COL.repairs.updatedAt]),
    cls: ds.readCls(f)
  }
}
// 计划日期当日 23:59:59（+08:00）时间戳，用于"逾期"判定（与 io.js dayEnd 同口径）
function planEndTs(s) {
  if (!s) return 0
  const t = new Date('' + s + 'T23:59:59+08:00').getTime()
  return isNaN(t) ? 0 : t
}
function normInspection(f) {
  const status = f[COL.inspections.status] || '待巡检'
  const planDate = f[COL.inspections.planDate] || ''
  const overdue = status === '待巡检' && !!planDate && Date.now() > planEndTs(planDate)
  return {
    id: f[COL.inspections.id], labId: f[COL.inspections.labId], labName: f[COL.inspections.labName] || '',
    title: f[COL.inspections.title] || '', planDate,
    executorId: f[COL.inspections.executorId] || '', executorName: f[COL.inspections.executorName] || '',
    status, result: f[COL.inspections.result] || '', overdue,
    createdAt: fmtTs(f[COL.inspections.createdAt]), doneAt: fmtTs(f[COL.inspections.doneAt]),
    cls: ds.readCls(f)
  }
}

// —— 实训室（核心归属实体）——
async function listLabs() {
  const list = await getRecords('labs')
  return list.map(r => normLab(r.fields))
}
async function getLab(id) {
  const key = ('' + (id || '')).trim().toUpperCase()
  if (!key) return null
  const list = await getRecords('labs', r => ('' + r.fields[COL.labs.id]).trim().toUpperCase() === key)
  const rec = list[0]
  return rec ? { ...normLab(rec.fields), rid: rec.recordId } : null
}
async function addLab(data) {
  const name = ('' + (data.name || '')).trim()
  if (!name) return { code: 400, data: { msg: '请填写实训室名称' } }
  const idemKey = ['addLab', data.actor || '', name].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const exists = await getRecords('labs', r => ('' + r.fields[COL.labs.name]).trim() === name)
    if (exists.length) return { code: 409, data: { msg: '该实训室已存在：' + exists[0].fields[COL.labs.id] } }
    const all = await getRecords('labs')
    let max = 0
    for (const r of all) { const m = /^\s*[Ll](\d+)\s*$/.exec('' + r.fields[COL.labs.id]); if (m) max = Math.max(max, parseInt(m[1], 10) || 0) }
    const newId = 'L' + String(max + 1).padStart(3, '0')
    const ts = now()
    await addRecord('labs', {
      [COL.labs.id]: newId, [COL.labs.name]: name,
      [COL.labs.campus]: ('' + (data.campus || '')).trim(),
      [COL.labs.building]: ('' + (data.building || '')).trim(),
      [COL.labs.floor]: ('' + (data.floor || '')).trim(),
      [COL.labs.roomNo]: ('' + (data.roomNo || '')).trim(),
      [COL.labs.address]: ('' + (data.address || '')).trim(),
      [COL.labs.lng]: Number(data.lng) || 0, [COL.labs.lat]: Number(data.lat) || 0,
      [COL.labs.managerId]: ('' + (data.managerId || '')).trim(),
      [COL.labs.managerName]: ('' + (data.managerName || '')).trim(),
      [COL.labs.status]: ('' + (data.status || '启用')).trim(),
      [COL.labs.note]: ('' + (data.note || '')).trim(),
      [COL.labs.createdAt]: ts, [COL.labs.updatedAt]: ts
    })
    return { id: newId, name }
  }))
}
async function updateLab(data) {
  const id = ('' + (data.id || '')).trim().toUpperCase()
  if (!id) return { code: 400, data: { msg: '缺少实训室ID' } }
  const list = await getRecords('labs', r => ('' + r.fields[COL.labs.id]).trim().toUpperCase() === id)
  const rec = list[0]
  if (!rec) return { code: 404, data: { msg: '未找到该实训室' } }
  const f = {}
  const set = (k, v) => { if (v !== undefined && v !== null) f[COL.labs[k]] = ('' + v).trim() }
  set('name', data.name); set('campus', data.campus); set('building', data.building)
  set('floor', data.floor); set('roomNo', data.roomNo); set('address', data.address)
  if (data.lng !== undefined) f[COL.labs.lng] = Number(data.lng) || 0
  if (data.lat !== undefined) f[COL.labs.lat] = Number(data.lat) || 0
  set('managerId', data.managerId); set('managerName', data.managerName)
  set('status', data.status); set('note', data.note)
  f[COL.labs.updatedAt] = now()
  await updateRecord('labs', rec.recordId, f)
  return { id, updated: true }
}
async function deleteLab(data) {
  const id = ('' + (data.id || '')).trim().toUpperCase()
  if (!id) return { code: 400, data: { msg: '缺少实训室ID' } }
  const list = await getRecords('labs', r => ('' + r.fields[COL.labs.id]).trim().toUpperCase() === id)
  if (!list.length) return { code: 404, data: { msg: '未找到该实训室' } }
  await deleteRecordByIds('labs', list.map(r => r.recordId))
  return { id, deleted: true }
}

// —— 报修（归属实训室，教师发起与处理）——
async function listRepairs(filter) {
  const f = filter || {}
  const list = await getRecords('repairs', r => {
    const ff = r.fields
    if (f.labId && ('' + ff[COL.repairs.labId]).trim().toUpperCase() !== ('' + f.labId).trim().toUpperCase()) return false
    if (f.status && ('' + ff[COL.repairs.status]) !== ('' + f.status)) return false
    return true
  })
  const sorted = list.slice().sort((a, b) => (Number(b.fields[COL.repairs.createdAt]) || 0) - (Number(a.fields[COL.repairs.createdAt]) || 0))
  return sorted.map(r => normRepair(r.fields))
}
async function addRepair(data) {
  const title = ('' + (data.title || '')).trim()
  const labId = ('' + (data.labId || '')).trim().toUpperCase()
  if (!title) return { code: 400, data: { msg: '请填写报修内容' } }
  if (!labId) return { code: 400, data: { msg: '请选择归属实训室' } }
  // 幂等键要能区分两次不同的报修：同一教师对同一实训室报两条同名故障（如两盏灯都坏，
  // 都写「灯管坏」）是两次独立报修 → 键里少了区分字段时第二单被幂等窗口吞掉，
  // 返回第一条的单号、库里只剩一条，故障记录凭空消失（已实测复现）。
  const idemKey = ['addRepair', data.actor || '', labId, title, (data.category || ''), (data.desc || ''), (data.priority || '')].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const lab = await getLab(labId)
    if (!lab) return { code: 404, data: { msg: '归属实训室不存在' } }
    const ts = now()
    const newId = 'R' + ('' + ts).slice(-10) + Math.floor(Math.random() * 90 + 10)
    await addRecord('repairs', {
      [COL.repairs.id]: newId, [COL.repairs.labId]: labId, [COL.repairs.labName]: lab.name,
      [COL.repairs.title]: title, [COL.repairs.category]: ('' + (data.category || '设备故障')).trim(),
      [COL.repairs.desc]: ('' + (data.desc || '')).trim(),
      [COL.repairs.reporterId]: ('' + (data.actor || '')).trim(),
      [COL.repairs.reporterName]: ('' + (data.reporterName || data.actor || '')).trim(),
      [COL.repairs.status]: '待处理', [COL.repairs.priority]: ('' + (data.priority || '一般')).trim(),
      [COL.repairs.handlerId]: '', [COL.repairs.handlerName]: '',
      [COL.repairs.resolvedNote]: '', [COL.repairs.createdAt]: ts, [COL.repairs.updatedAt]: ts
    })
    return { id: newId, labId, labName: lab.name, title }
  }))
}
async function updateRepair(data) {
  const id = ('' + (data.id || '')).trim()
  if (!id) return { code: 400, data: { msg: '缺少报修单ID' } }
  const list = await getRecords('repairs', r => ('' + r.fields[COL.repairs.id]).trim() === id)
  const rec = list[0]
  if (!rec) return { code: 404, data: { msg: '未找到该报修单' } }
  const f = {}
  const set = (k, v) => { if (v !== undefined) f[COL.repairs[k]] = ('' + v).trim() }
  set('status', data.status); set('handlerId', data.handlerId); set('handlerName', data.handlerName)
  set('priority', data.priority); set('resolvedNote', data.resolvedNote)
  f[COL.repairs.updatedAt] = now()
  await updateRecord('repairs', rec.recordId, f)
  return { id, updated: true }
}

// —— 巡检（归属实训室，教师执行）——
async function listInspections(filter) {
  const f = filter || {}
  const list = await getRecords('inspections')
  // 归一化后 createdAt 已是展示字符串，必须在此之前按原始时间戳排序
  list.sort((a, b) => (Number(b.fields[COL.inspections.createdAt]) || 0) - (Number(a.fields[COL.inspections.createdAt]) || 0))
  let arr = list.map(r => normInspection(r.fields))
  if (f.labId) arr = arr.filter(x => ('' + x.labId).trim().toUpperCase() === ('' + f.labId).trim().toUpperCase())
  if (f.status) {
    if (f.status === '已逾期') arr = arr.filter(x => x.status === '待巡检' && x.overdue)
    else arr = arr.filter(x => x.status === f.status)
  }
  return arr
}
async function addInspection(data) {
  const title = ('' + (data.title || '')).trim()
  const labId = ('' + (data.labId || '')).trim().toUpperCase()
  if (!title) return { code: 400, data: { msg: '请填写巡检任务名称' } }
  if (!labId) return { code: 400, data: { msg: '请选择归属实训室' } }
  // 同理：同名同实训室的巡检任务是两次独立任务，计划日期/执行人都不同则不能被判为重复
  const idemKey = ['addInsp', data.actor || '', labId, title, (data.planDate || ''), (data.executorId || '')].join('|')
  return withWriteIdem(idemKey, () => withWriteLock(async () => {
    const lab = await getLab(labId)
    if (!lab) return { code: 404, data: { msg: '归属实训室不存在' } }
    const ts = now()
    const newId = 'I' + ('' + ts).slice(-10) + Math.floor(Math.random() * 90 + 10)
    await addRecord('inspections', {
      [COL.inspections.id]: newId, [COL.inspections.labId]: labId, [COL.inspections.labName]: lab.name,
      [COL.inspections.title]: title, [COL.inspections.planDate]: ('' + (data.planDate || '')).trim(),
      // 执行人可指派：executorId 为空时默认创建人；有值时按指派写入（建单即派活）
      [COL.inspections.executorId]: ('' + (data.executorId || data.actor || '')).trim(),
      [COL.inspections.executorName]: ('' + (data.executorName || data.executorId || data.actor || '')).trim(),
      [COL.inspections.status]: '待巡检', [COL.inspections.result]: '',
      [COL.inspections.createdAt]: ts, [COL.inspections.doneAt]: ''
    })
    return { id: newId, labId, labName: lab.name, title }
  }))
}
async function updateInspection(data) {
  const id = ('' + (data.id || '')).trim()
  if (!id) return { code: 400, data: { msg: '缺少巡检单ID' } }
  const list = await getRecords('inspections', r => ('' + r.fields[COL.inspections.id]).trim() === id)
  const rec = list[0]
  if (!rec) return { code: 404, data: { msg: '未找到该巡检单' } }
  const f = {}
  const set = (k, v) => { if (v !== undefined) f[COL.inspections[k]] = ('' + v).trim() }
  set('status', data.status); set('result', data.result); set('planDate', data.planDate)
  set('executorId', data.executorId); set('executorName', data.executorName)
  if (data.status === '已完成') f[COL.inspections.doneAt] = now()
  f[COL.inspections.updatedAt] = now()
  await updateRecord('inspections', rec.recordId, f)
  return { id, updated: true }
}

// 按实训室维度统一查询：实训室本体 + 其报修 + 其巡检
async function labOverview(labId) {
  const lab = await getLab(labId)
  if (!lab) return { code: 404, data: { msg: '未找到该实训室' } }
  const [reps, insps] = await Promise.all([listRepairs({ labId }), listInspections({ labId })])
  return { lab, repairs: reps, inspections: insps }
}

// 清空全库数据（super 专属，须二次确认；见 index.js case 'clearAllData'）。
// 默认保留 users 表——否则把执行清库的 super 账号自身也删掉，会导致无人可登录的鸡生蛋死锁。
// opts.includeUsers === true 时显式连用户表一起清（调用方需自担"清完无法登录"后果）。
// 逐表 getRecords → deleteRecordByIds，逐表计数；单表失败不影响其余表，结果里如实回报。
async function clearAllData(opts) {
  const o = opts || {}
  const includeUsers = o.includeUsers === true
  const allTables = ['requisitions', 'borrow', 'stock_io', 'access', 'logs', 'repairs', 'inspections', 'labs', 'tools', 'materials', 'users']
  const targets = allTables.filter(t => includeUsers || t !== 'users')
  const result = { cleared: {}, skipped: [], errors: [], total: 0, includeUsers }
  for (const t of targets) {
    if (t === 'users' && !includeUsers) { result.skipped.push(t); continue }
    try {
      const rows = await getRecords(t, null, { noCache: true })
      const ids = rows.map(r => r.recordId).filter(Boolean)
      const n = ids.length ? await deleteRecordByIds(t, ids) : 0
      result.cleared[t] = n
      result.total += n
    } catch (e) {
      result.errors.push({ table: t, msg: (e && e.message) || String(e) })
      result.cleared[t] = 0
    }
  }
  return result
}

module.exports = {
  TABLE, CFG, COL, TR, runtimeInfo, warmFieldMaps,
  getToken, authorizeWithCode, callSmart, callApi, getFieldMap, buildValues,
  getRecords, addRecord, updateRecord, deleteRecordByIds, getItem,
  casUpdate, atomicAdjustStock, atomicSwitchToolStatus,
  invalidateCache, cacheStats, clearFieldMapCache,
  listMaterials, listTools, listMine, listPending, search,
  findUser, listUsers, ensureOpenIdColumn, bindOpenId, findUserByOpenId, findUserByRobotKey, setRobotKey, whoami, bindLogin,
  adminListUsers, listAllUsersForAudit, listStaff, adminUpsertUser, adminDeleteUser, adminUnbindUser, decideUserWrite, decideUserDelete,
  requisition, toolRequisition, approve, revokeApprove, batchReject, cancelReq, io, borrow, directBorrow, returnTool, access, usage, snapshot,
  addMaterial, addTool, listStockIO, listClaims, listDeliveries, confirmDelivery, exportData, stocktake, listLogs, reverseIO, batchIo, listAccess, importMaterials, importTools,
  // 实训室归属管理体系（labs / repairs / inspections）
  listLabs, getLab, addLab, updateLab, deleteLab,
  listRepairs, addRepair, updateRepair,
  listInspections, addInspection, updateInspection, labOverview,
  // 清库（super 专属，二次确认；默认保留 users）
  clearAllData
}

'use strict'
// ============================================================================
// lab-docs-proxy —— 实训室管理系统 · WorkBuddy 自然语言操作 MCP 连接器
// ----------------------------------------------------------------------------
// 作用：把「万州职教中心·实训室管理系统」云函数 docsProxy 暴露为 MCP 工具，
//       让 WorkBuddy 用自然语言（如"查一下 A 柜有哪些物料"）调用只读查询。
//
// 身份：走云函数「可信机器通道」(robot 模式)。连接器在每次请求体里携带
//       robotKey。robotKey 有两种：
//         • 全局超级钥匙（云函数环境变量 ROBOT_KEY 的值）→ 以 ROBOT_ACTOR_ID(super) 身份执行，
//           仅管理员应急用，不应分发给普通教师。
//         • 教师个人机器人密钥（小程序的「我的 → 个人机器人密钥」生成）→ 云函数按哈希反查该教师
//           工号，以该教师本人身份执行，权限与其微信端完全一致。每位教师独立密钥、可独立吊销。
//       写操作（lab_write）经此通道时，后端先返回操作摘要+确认令牌，不真正执行；用户确认后
//       调用 lab_confirm 携令牌二次调用才写入（L1 二次确认门，防误改）。
//
// 多轮记忆编排（Phase 4）：连接器在进程生命周期内维护轻量会话上下文（lab_context / lab_forget），
//       记录最近查询解析出的锚点实体（实训室/物料/报修单号），供 LLM 消解模糊追问。
//       语音输入直接复用 WorkBuddy 自带语音能力，无需改后端。
//
// 传输（两种，自动择优）：
//   ① HTTP 触发：DOCS_PROXY_HTTP_URL 指向 CloudBase HTTP 访问服务地址，POST JSON。
//   ② SDK 直连：配置 TCB_SECRET_ID/TCB_SECRET_KEY/TCB_ENV，用 @cloudbase/node-sdk
//      callFunction 直接调云函数，无需公网 HTTP 入口、无需升级付费环境（更安全）。
//   本机未配 SDK 凭据时回退 HTTP；两者皆缺则报错提示。两条路云函数端零改动。
//
// 依赖：SDK 模式需安装 @cloudbase/node-sdk（npm install）；HTTP 模式仅用 Node 内置模块。
// 注意：stdout 只输出合法 JSON-RPC 消息；调试信息一律写 stderr。
// ============================================================================

const http = require('http')
const https = require('https')
const { URL } = require('url')
const fs = require('fs')

const HTTP_URL = (process.env.DOCS_PROXY_HTTP_URL || '').trim()
const ROBOT_KEY = (process.env.DOCS_PROXY_ROBOT_KEY || '').trim()
// 方案 B：CloudBase Node SDK 直连（无需公网 HTTP 入口、无需升级付费环境）
const TCB_SECRET_ID = (process.env.TCB_SECRET_ID || '').trim()
const TCB_SECRET_KEY = (process.env.TCB_SECRET_KEY || '').trim()
const TCB_ENV = (process.env.TCB_ENV || '').trim()
// 显式覆盖传输方式（用于测试或强制）：http | sdk | stub
const TRANSPORT = (process.env.LAB_MCP_TRANSPORT || '').trim().toLowerCase()

// —— 设备/工具清单（Excel）解析：把任意表头映射为字段 ——
// resourceType: 'material'（默认，耗材）或 'tool'（工具）。列名容错：中文表头按别名模糊匹配，
// 用户无需严格命名。未识别的列会被忽略并提示。
const FIELD_ALIASES = {
  material: {
    id: ['id', '编号', '物料编码', '物料号', '物料id', '耗材id', '设备编号', '编码', '货号'],
    name: ['名称', '物品名称', '物料名称', '品名', '设备名称', '耗材名称', '物料'],
    spec: ['规格', '型号', '参数', '规格型号'],
    cat: ['类别', '分类', '类型', '种类', '物品类别'],
    loc: ['存放位置', '位置', '库位', '货架', '存放地点', '仓位', '地点'],
    stock: ['当前库存', '库存', '数量', '期初库存', '结存', '现存', '余量', '库存数量'],
    unit: ['单位', '计量单位', '单位名称'],
    safe: ['预警线', '安全库存', '最低库存', '警戒线', '预警库存', '预警']
  },
  tool: {
    id: ['id', '编号', '工具编号', '设备编号', '编码', '货号', '资产编号'],
    name: ['名称', '物品名称', '工具名称', '设备名称', '器具名称', '品名'],
    spec: ['规格', '型号', '参数', '规格型号'],
    loc: ['存放位置', '位置', '库位', '货架', '存放地点', '仓位', '地点'],
    status: ['状态', '当前状态', '使用情况'],
    holder: ['持有人', '保管人', '当前持有人', '责任人', '使用人', '领用人']
  }
}
function _normHeader(h) {
  return ('' + (h == null ? '' : h)).trim().toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '')
}
function _buildAliasIndex(aliases) {
  const idx = []
  for (const field of Object.keys(aliases)) {
    for (const a of aliases[field]) idx.push({ field, norm: _normHeader(a) })
  }
  return idx
}
function _matchField(headerRaw, aliasIndex) {
  const h = _normHeader(headerRaw)
  if (!h) return null
  let best = null
  for (const e of aliasIndex) {
    if (!e.norm) continue
    if (h === e.norm || h.indexOf(e.norm) >= 0 || e.norm.indexOf(h) >= 0) {
      if (!best || e.norm.length > best.norm.length) best = e
    }
  }
  return best ? best.field : null
}

// 读 Excel：返回 { ok, rows, headers, unmapped, errors, resourceType }
function parseDeviceListFile(filePath, sheetName, resourceType) {
  const rt = resourceType === 'tool' ? 'tool' : 'material'
  const aliasIndex = _buildAliasIndex(FIELD_ALIASES[rt])
  const nameHint = rt === 'tool' ? '名称/工具名称/设备名称/品名' : '名称/物品名称/物料名称/品名'
  let X
  try { X = require('xlsx') } catch (e) { return { ok: false, errors: ['未安装 xlsx：请在 mcp/ 目录执行 `npm install xlsx`。'] } }
  if (!fs.existsSync(filePath)) return { ok: false, errors: ['文件不存在：' + filePath] }
  let wb
  try { wb = X.readFile(filePath) } catch (e) { return { ok: false, errors: ['Excel 解析失败：' + e.message] } }
  if (!wb.SheetNames.length) return { ok: false, errors: ['工作簿没有任何工作表'] }
  const sheet = sheetName && wb.SheetNames.indexOf(sheetName) >= 0 ? sheetName : wb.SheetNames[0]
  const ws = wb.Sheets[sheet]
  const data = X.utils.sheet_to_json(ws, { defval: '' })
  if (!data.length) return { ok: false, errors: ['工作表[' + sheet + ']没有数据行（请确保首行为表头）'] }
  const headers = Object.keys(data[0])
  const colMap = {}
  const unmapped = []
  for (const h of headers) {
    const f = _matchField(h, aliasIndex)
    if (f && !colMap[f]) colMap[f] = h
    else if (!f) unmapped.push(h)
  }
  if (!colMap.name) return { ok: false, errors: ['未识别到「名称」列，无法导入。请将名称所在列命名为：' + nameHint + '。'] }
  const rows = data.map((r) => {
    const get = (f) => (colMap[f] != null ? r[colMap[f]] : '')
    const base = {
      id: ('' + (get('id') || '')).trim(),
      name: ('' + (get('name') || '')).trim(),
      spec: ('' + (get('spec') || '')).trim(),
      loc: ('' + (get('loc') || '')).trim()
    }
    if (rt === 'tool') {
      base.status = ('' + (get('status') || '')).trim() || '正常'
      base.holder = ('' + (get('holder') || '')).trim()
    } else {
      base.cat = ('' + (get('cat') || '')).trim()
      base.stock = ('' + (get('stock') || '')).trim()
      base.unit = ('' + (get('unit') || '')).trim()
      base.safe = ('' + (get('safe') || '')).trim()
    }
    return base
  }).filter(r => r.name)
  return { ok: true, rows, sheet, headers, colMap, unmapped, total: data.length, resourceType: rt }
}

// 只读查询白名单（fail-closed，未列出的 action 一律拒绝）。
const READ_ACTIONS = [
  'getItem',        // 单物料详情
  'listMaterials',  // 物料列表（支持 keyword/status 过滤）
  'listTools',      // 工具列表
  'pending',        // 待审批列表
  'usage',          // 报表/统计
  'listLabs',       // 实训室列表
  'listRepairs',    // 报修列表
  'listInspections',// 巡检列表
  'alerts'          // 预警聚合（低库存 + 逾期巡检 + 待审批），供每日推送使用
]

// 写操作白名单（L1 二次确认门）：经可信机器通道的写操作先返回操作摘要+确认令牌，
// 不真正执行；用户确认后携令牌二次调用才写入（防误改）。后端按角色再校验权限。
// 仅放教师常用动作；管理员专属动作（用户管理/迁移/实训室 CRUD）暂不开放给通用连接器。
const WRITE_ACTIONS = [
  'requisition',     // 物料领用申请
  'toolRequisition', // 工具借用申请
  'cancelReq',       // 撤回本人申请
  'io',              // 库存出入库
  'borrow',          // 工具借出登记
  'returnTool',      // 工具归还
  'approve',         // 审批单据
  'addMaterial',     // 新增物料
  'stocktake',       // 库存盘点/期初建账
  'addRepair',       // 提交报修
  'updateRepair',    // 更新报修
  'addInspection',   // 提交巡检
  'updateInspection',// 更新巡检
  'importMaterials', // 批量导入耗材清单（Excel 解析后的多行，管理员专属）
  'importTools'      // 批量导入工具清单（Excel 解析后的多行，管理员专属）
]

// —— 工具定义（MCP tools/list 返回）——
const TOOLS = [
  {
    name: 'lab_query',
    description: '对实训室管理系统发起只读查询。自然语言如"查一下 A 柜有哪些物料""列出待审批""显示实训室列表"都会映射到本工具。' +
      'action 必须为只读白名单之一；params 为查询参数对象（可选）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: READ_ACTIONS, description: '只读查询动作名' },
        params: { type: 'object', description: '查询参数（可选，如 {keyword:"电阻"} / {labId:"L001"} / {status:"待审批"}）' }
      },
      required: ['action']
    }
  },
  {
    name: 'lab_diag',
    description: '返回云函数运行态诊断信息：当前数据后端(cloud/tencent/mock)、回退链、物料条数等。用于确认连通性，不涉及业务数据。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'lab_overview',
    description: '按实训室维度汇总：该实训室的报修与巡检概况。需传 labId。',
    inputSchema: {
      type: 'object',
      properties: { labId: { type: 'string', description: '实训室 ID，如 L001' } },
      required: ['labId']
    }
  },
  {
    name: 'lab_write',
    description: '对实训室管理系统发起写操作（需二次确认）。自然语言如"帮我提交一个报修""审批单号 Rxxx 通过"会映射到本工具。' +
      'action 必须为写操作白名单之一；params 为写操作参数对象。首次调用仅返回操作摘要与确认码，不会真正写入；' +
      '确认后调用 lab_confirm 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: WRITE_ACTIONS, description: '写操作动作名' },
        params: { type: 'object', description: '写操作参数（可选，如 {labId:"L001",title:"示波器故障",desc:"CH1 无波形"} / {no:"Rxxx",decision:"approve"}）' }
      },
      required: ['action']
    }
  },
  {
    name: 'lab_confirm',
    description: '确认执行上次 lab_write 返回的待确认写操作。可传 id（确认码，如 "Cxxx"）指定某条；不传则确认最近一条。调用后真正写入系统。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '可选：lab_write 返回的确认码' } }
    }
  },
  {
    name: 'lab_context',
    description: '读取当前会话记忆：最近查询解析出的锚点实体（如实训室 ID、物料关键词、报修单号）。用于消解模糊追问（如"那它的报修呢？"）。只读，不触碰业务数据。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '可选：会话标识，默认当前会话' } }
    }
  },
  {
    name: 'lab_forget',
    description: '清除当前（或指定）会话记忆。涉及隐私或话题切换时调用，确保后续不沿用旧锚点。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '可选：会话标识，默认当前会话' } }
    }
  },
  {
    name: 'lab_import',
    description: '把本地 Excel 清单批量导入实训室管理系统。' +
      'resourceType="material"（默认）导入「耗材」集合（materials，字段：名称/规格/类别/存放位置/当前库存/单位/预警线/编号）；' +
      'resourceType="tool" 导入「工具」集合（tools，字段：名称/规格/存放位置/状态/持有人/编号）。' +
      '自动按列名模糊映射字段，无需严格表头。' +
      '默认先解析并预览（dryRun），确认字段映射无误后再正式调用 lab_import（设 dryRun:false）触发二次确认写入。',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '本地 Excel 清单的绝对路径，如 D:/清单/设备清单.xlsx' },
        sheet: { type: 'string', description: '可选：工作表名，默认取第一张表' },
        resourceType: { type: 'string', enum: ['material', 'tool'], description: '导入目标：material=耗材（默认），tool=工具' },
        dryRun: { type: 'boolean', description: '为 true 时只解析预览、不写库（默认 true，安全）；设为 false 才发起写入确认' }
      },
      required: ['filePath']
    }
  }
]

// —— stdout 只写 JSON-RPC 消息 ——
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }
function log() { process.stderr.write('[lab-docs-proxy] ' + Array.from(arguments).join(' ') + '\n') }

// —— HTTP(S) POST JSON ——
function postJson(url, bodyObj) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('HTTP_URL 非法: ' + url)) }
    const data = JSON.stringify(bodyObj)
    const lib = u.protocol === 'https:' ? https : http
    const port = u.port || (u.protocol === 'https:' ? 443 : 80)
    const req = lib.request({
      hostname: u.hostname,
      port,
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
    req.write(data)
    req.end()
  })
}

// —— 统一调用层：把一次 docsProxy 调用归一为 {code,data,...} 信封（或 {error}）——
// 支持三种传输：stub（测试）/ sdk（CloudBase Node SDK 直连，无需公网）/ http（HTTP 触发）。
async function invokeHttp(payload) {
  if (!HTTP_URL) return { error: '未配置 DOCS_PROXY_HTTP_URL（HTTP 触发地址）。' }
  try {
    const resp = await postJson(HTTP_URL, payload)
    return resp.body || {}
  } catch (e) { return { error: e.message } }
}

let _tcbApp = null
function getTcbApp() {
  if (_tcbApp) return _tcbApp
  let init
  try { init = require('@cloudbase/node-sdk') }
  catch (e) { throw new Error('未安装 @cloudbase/node-sdk：请在 mcp/ 目录执行 `npm install @cloudbase/node-sdk` 后再用 SDK 直连模式。') }
  _tcbApp = init({ secretId: TCB_SECRET_ID, secretKey: TCB_SECRET_KEY, env: TCB_ENV })
  return _tcbApp
}
async function invokeSdk(payload) {
  if (!TCB_SECRET_ID || !TCB_SECRET_KEY || !TCB_ENV) {
    return { error: 'SDK 直连缺少必要配置：TCB_SECRET_ID / TCB_SECRET_KEY / TCB_ENV 三项需同时设置。' }
  }
  try {
    const app = getTcbApp()
    const res = await app.callFunction({ name: 'docsProxy', data: payload })
    // SDK 返回 { result, requestId }，result 即云函数 main 的返回值（{code,data,...} 信封）
    if (res && Object.prototype.hasOwnProperty.call(res, 'result')) {
      return (res.result && typeof res.result === 'object') ? res.result : { code: 0, data: res.result }
    }
    if (res && res.code) return { error: 'TCB 调用失败 code=' + res.code + ' ' + (res.message || JSON.stringify(res)) }
    return { error: 'TCB 返回结构异常：' + JSON.stringify(res).slice(0, 200) }
  } catch (e) { return { error: 'TCB SDK 调用异常：' + e.message } }
}

async function invokeProxy(payload) {
  if (TRANSPORT === 'stub') {
    let raw = process.env.LAB_MCP_STUB
    if (process.env.LAB_MCP_STUB_FILE) {
      try { raw = fs.readFileSync(process.env.LAB_MCP_STUB_FILE, 'utf8') } catch (e) { return { error: 'stub 文件读取失败: ' + e.message } }
    }
    if (!raw) return { code: 0, data: 'stub ok' }
    try { return JSON.parse(raw) } catch (e) { return { error: 'stub JSON 解析失败：' + e.message } }
  }
  if (TRANSPORT === 'sdk' || (!TRANSPORT && TCB_SECRET_ID && TCB_SECRET_KEY && TCB_ENV)) {
    return invokeSdk(payload)
  }
  if (TRANSPORT === 'http' || (!TRANSPORT && HTTP_URL)) {
    return invokeHttp(payload)
  }
  return { error: '未配置传输方式：请设置 TCB_SECRET_ID/TCB_SECRET_KEY/TCB_ENV（SDK 直连，无需公网）或 DOCS_PROXY_HTTP_URL（HTTP 触发）。' }
}

async function doCall(action, params, confirmToken) {
  if (!ROBOT_KEY) return { error: '未配置 DOCS_PROXY_ROBOT_KEY：需与用户个人机器人密钥一致。' }
  const payload = Object.assign({}, (params || {}), { action, robotKey: ROBOT_KEY })
  if (confirmToken) payload.__confirm = confirmToken
  const body = await invokeProxy(payload)
  if (body.error) return body
  if (body.code === 0) {
    const text = (typeof body.data === 'string') ? body.data : JSON.stringify(body.data, null, 2)
    return { text }
  }
  return { error: '操作返回非零状态 code=' + body.code + '：' + JSON.stringify(body.data || {}) }
}

// 写操作确认门（L1）：后端首次返回 {confirm:true, token, summary} 时不执行，
// 由本连接器暂存 token，待用户确认后携 token 二次调用才真正写入。
const _pending = new Map()
function genPendingId() { return 'C' + Date.now().toString(36) + Math.floor(Math.random() * 1000) }

async function doWrite(action, params) {
  const raw = await doCallRaw(action, params)
  if (!raw) return { error: '云函数无响应' }
  // 后端写操作确认态：{code:0, confirm:true, token, summary}，不真正执行
  if (raw.code === 0 && raw.confirm) {
    const pid = genPendingId()
    _pending.set(pid, { token: raw.token, action, params: params || {} })
    const summary = (raw.summary || ('执行 ' + action)) + '\n[确认码 ' + pid + '] 请回复「确认执行」或调用 lab_confirm 完成。'
    return { text: summary }
  }
  if (raw.code === 0) {
    const text = (typeof raw.data === 'string') ? raw.data : JSON.stringify(raw.data, null, 2)
    return { text }
  }
  return { error: 'code=' + raw.code + '：' + JSON.stringify(raw.data || {}) }
}

// 读取云函数原始返回（用于判断 confirm 态）
async function doCallRaw(action, params) {
  if (!ROBOT_KEY) return null
  const r = await invokeProxy(Object.assign({}, (params || {}), { action, robotKey: ROBOT_KEY }))
  return r.error ? null : r
}

async function doConfirm(idArg, sessionId) {
  let key = null
  if (idArg && _pending.has(idArg)) key = idArg
  else { const keys = Array.from(_pending.keys()); if (keys.length) key = keys[keys.length - 1] }
  if (!key) return { error: '没有待确认的写操作（可能已过期或已完成）。' }
  const entry = _pending.get(key)
  const r = await doCall(entry.action, entry.params, entry.token)
  _pending.delete(key)
  if (r.error) return r
  recordContext(getSession(sessionId), entry.action, entry.params, r.text || '操作完成。')
  return { text: r.text || '操作完成。' }
}

// —— 多轮记忆编排（Phase 4）——
// 连接器在进程生命周期内维护轻量会话上下文：记录最近查询解析出的「锚点实体」
// （实训室/物料/报修单号等），供 WorkBuddy LLM 消解模糊追问（如"那它的报修呢？"）。
// 隐私红线：只缓存业务实体 id/名称（来自查询参数与结果摘要），绝不缓存密钥/明文 robotKey。
const sessions = new Map()
const DEFAULT_SESSION = process.env.LAB_SESSION_ID || 'default'
function getSession(id) {
  const key = (id && String(id).trim()) || DEFAULT_SESSION
  if (!sessions.has(key)) sessions.set(key, { anchors: {}, last: null, history: [] })
  return sessions.get(key)
}
function recordContext(session, action, params, resultText) {
  const p = params || {}
  const a = session.anchors
  if (p.labId) a.labId = p.labId
  if (p.labName) a.labName = p.labName
  if (p.matId || p.materialId) a.materialId = p.matId || p.materialId
  if (p.keyword) a.materialKeyword = p.keyword
  if (p.repairId || p.no) a.repairId = p.repairId || p.no
  if (p.toolId) a.toolId = p.toolId
  if (p.cls) a.cls = p.cls
  session.last = { action, params: p, summary: (typeof resultText === 'string' ? resultText : '').slice(0, 240) }
  session.history.push({ action, at: Date.now() })
  if (session.history.length > 12) session.history.shift()
}
function summarizeContext(session) {
  const a = session.anchors
  const parts = []
  if (a.labId) parts.push('实训室=' + a.labId + (a.labName ? '(' + a.labName + ')' : ''))
  if (a.materialId) parts.push('物料=' + a.materialId)
  if (a.materialKeyword) parts.push('物料关键词=' + a.materialKeyword)
  if (a.repairId) parts.push('报修/单号=' + a.repairId)
  if (a.toolId) parts.push('工具=' + a.toolId)
  if (a.cls) parts.push('班级=' + a.cls)
  const last = session.last ? ('上次操作=' + session.last.action) : '无'
  return '当前会话上下文：' + (parts.length ? parts.join('；') + '。' : '（暂无锚点实体）。') + last +
    '。\n如需消解模糊追问（如"它的报修呢"），请据此补全参数后调用对应工具（例如用 labId 调 listRepairs）。'
}

async function handleToolCall(id, params) {
  const name = params.name
  const args = params.arguments || {}
  let out
  if (name === 'lab_diag') out = await doCall('diag', {})
  else if (name === 'lab_overview') {
    if (!args.labId) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'lab_overview 需要 labId 参数' } })
    out = await doCall('labOverview', { labId: args.labId })
    if (!out.error) recordContext(getSession(args.sessionId), 'labOverview', { labId: args.labId }, out.text)
  }
  else if (name === 'lab_query') {
    const action = args.action
    if (!action || READ_ACTIONS.indexOf(action) < 0) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'action 不在只读白名单: ' + action + '。可选: ' + READ_ACTIONS.join(', ') } })
    }
    out = await doCall(action, args.params || {})
    if (!out.error) recordContext(getSession(args.sessionId), action, args.params || {}, out.text)
  }
  else if (name === 'lab_write') {
    const action = args.action
    if (!action || WRITE_ACTIONS.indexOf(action) < 0) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'action 不在写操作白名单: ' + action + '。可选: ' + WRITE_ACTIONS.join(', ') } })
    }
    out = await doWrite(action, args.params || {})
  }
  else if (name === 'lab_confirm') out = await doConfirm(args.id, args.sessionId)
  else if (name === 'lab_import') {
    const fp = (args.filePath || '').trim()
    if (!fp) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'lab_import 需要 filePath 参数（本地 Excel 绝对路径）' } })
    const rt = args.resourceType === 'tool' ? 'tool' : 'material'
    const parsed = parseDeviceListFile(fp, args.sheet, rt)
    if (!parsed.ok) return send({ jsonrpc: '2.0', id, error: { code: -32000, message: '清单解析失败：' + (parsed.errors || []).join('；') } })
    const rtName = rt === 'tool' ? '工具(tools)' : '耗材(materials)'
    let preview = '【' + rtName + '】解析成功：共 ' + parsed.rows.length + ' 条有效行（工作表[' + parsed.sheet + ']）。'
    if (parsed.unmapped.length) preview += '\n⚠ 未识别列（已忽略）：' + parsed.unmapped.join('、')
    preview += '\n前 5 条预览：\n' + parsed.rows.slice(0, 5).map((r, i) => {
      if (rt === 'tool') {
        return '  ' + (i + 1) + '. ' + (r.id || '新') + ' ' + r.name + ' / ' + (r.spec || '-') + ' / ' + (r.status || '正常') + ' / 保管:' + (r.holder || '-')
      }
      return '  ' + (i + 1) + '. ' + (r.id || '新') + ' ' + r.name + ' / ' + (r.spec || '-') + ' / 库存' + (r.stock || '0') + ' ' + (r.unit || '')
    }).join('\n')
    const dryRun = args.dryRun !== false  // 默认安全：仅预览
    if (dryRun) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: preview + '\n\n（仅预览，未写入。确认无误后再次调用 lab_import 并设 dryRun:false 发起写入确认。）' }] } })
    }
    // 正式写入：经 L1 二次确认门（先返回确认码，lab_confirm 执行）
    out = await doWrite(rt === 'tool' ? 'importTools' : 'importMaterials', { rows: parsed.rows })
  }
  else if (name === 'lab_context') {
    const s = getSession(args.sessionId)
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: summarizeContext(s) }] } })
  }
  else if (name === 'lab_forget') {
    const key = (args.sessionId && String(args.sessionId).trim()) || DEFAULT_SESSION
    sessions.delete(key)
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '已清除会话[' + key + ']记忆。' }] } })
  }
  else return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } })

  if (out.error) return send({ jsonrpc: '2.0', id, error: { code: -32000, message: out.error } })
  const text = out.text || ''
  return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
}

function handleLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch (e) { return }
  if (!msg || msg.jsonrpc !== '2.0') return
  const id = msg.id
  const method = msg.method
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'lab-docs-proxy', version: '1.0.0' }
      }
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized' || method === 'ping') {
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'tools/call') return handleToolCall(id, msg.params || {})
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
}

function main() {
  if (!ROBOT_KEY) {
    log('警告: DOCS_PROXY_ROBOT_KEY 未设置，所有工具调用将返回错误提示（不影响 MCP 握手）。')
  }
  const mode = TRANSPORT || (TCB_SECRET_ID && TCB_SECRET_KEY && TCB_ENV ? 'sdk(自动择优)' : (HTTP_URL ? 'http(自动择优)' : '未配置'))
  log('传输模式: ' + mode + (String(mode).indexOf('sdk') >= 0 ? '（@cloudbase/node-sdk 直连，无需公网 HTTP 入口）' : ''))
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) handleLine(line)
    }
  })
  process.stdin.on('end', () => process.exit(0))
  log('lab-docs-proxy MCP server started (read-only batch).')
}

// 仅当以 `node docs-proxy-server.js` 直接运行时启动 MCP 循环；
// 被 require 时（如单元测试）不自动启动，便于直接调用内部函数。
if (require.main === module) main()

module.exports = { parseDeviceListFile, _matchField: typeof _matchField !== 'undefined' ? _matchField : null }


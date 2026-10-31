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
// 传输：通过 CloudBase HTTP 触发地址 POST JSON。云函数 index.js 已兼容
//       event.body 为 JSON 字符串（H5 页同一条路）。
//
// 依赖：Node 内置 http/https，无第三方依赖，任意 Node ≥ 16 可直接跑。
// 注意：stdout 只输出合法 JSON-RPC 消息；调试信息一律写 stderr。
// ============================================================================

const http = require('http')
const https = require('https')
const { URL } = require('url')

const HTTP_URL = (process.env.DOCS_PROXY_HTTP_URL || '').trim()
const ROBOT_KEY = (process.env.DOCS_PROXY_ROBOT_KEY || '').trim()

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
  'updateInspection' // 更新巡检
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

async function doCall(action, params, confirmToken) {
  if (!HTTP_URL) return { error: '未配置 DOCS_PROXY_HTTP_URL：请在环境变量设置 docsProxy 的 CloudBase HTTP 触发地址。' }
  if (!ROBOT_KEY) return { error: '未配置 DOCS_PROXY_ROBOT_KEY：需与用户个人机器人密钥一致。' }
  try {
    const payload = Object.assign({}, (params || {}), { action, robotKey: ROBOT_KEY })
    if (confirmToken) payload.__confirm = confirmToken
    const resp = await postJson(HTTP_URL, payload)
    const body = resp.body || {}
    if (body.code === 0) {
      const text = (typeof body.data === 'string') ? body.data : JSON.stringify(body.data, null, 2)
      return { text }
    }
    return { error: '操作返回非零状态 code=' + body.code + '：' + JSON.stringify(body.data || {}) }
  } catch (e) {
    return { error: e.message }
  }
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
  if (!HTTP_URL || !ROBOT_KEY) return null
  try {
    const resp = await postJson(HTTP_URL, Object.assign({}, (params || {}), { action, robotKey: ROBOT_KEY }))
    return resp.body || {}
  } catch (e) { return null }
}

async function doConfirm(idArg) {
  let key = null
  if (idArg && _pending.has(idArg)) key = idArg
  else { const keys = Array.from(_pending.keys()); if (keys.length) key = keys[keys.length - 1] }
  if (!key) return { error: '没有待确认的写操作（可能已过期或已完成）。' }
  const entry = _pending.get(key)
  const r = await doCall(entry.action, entry.params, entry.token)
  _pending.delete(key)
  if (r.error) return r
  return { text: r.text || '操作完成。' }
}

async function handleToolCall(id, params) {
  const name = params.name
  const args = params.arguments || {}
  let out
  if (name === 'lab_diag') out = await doCall('diag', {})
  else if (name === 'lab_overview') {
    if (!args.labId) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'lab_overview 需要 labId 参数' } })
    out = await doCall('labOverview', { labId: args.labId })
  }
  else if (name === 'lab_query') {
    const action = args.action
    if (!action || READ_ACTIONS.indexOf(action) < 0) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'action 不在只读白名单: ' + action + '。可选: ' + READ_ACTIONS.join(', ') } })
    }
    out = await doCall(action, args.params || {})
  }
  else if (name === 'lab_write') {
    const action = args.action
    if (!action || WRITE_ACTIONS.indexOf(action) < 0) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'action 不在写操作白名单: ' + action + '。可选: ' + WRITE_ACTIONS.join(', ') } })
    }
    out = await doWrite(action, args.params || {})
  }
  else if (name === 'lab_confirm') out = await doConfirm(args.id)
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
  if (!HTTP_URL || !ROBOT_KEY) {
    log('警告: DOCS_PROXY_HTTP_URL / DOCS_PROXY_ROBOT_KEY 未设置，工具调用将返回错误提示（不影响 MCP 握手）。')
  }
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

main()

// 注：原 shebang 已移除 —— 小程序编译器会把项目内 .js 当小程序源码扫，shebang 会报 SyntaxError
//     Windows 下用 `node xxx.js` 运行，无需 shebang。
// tools/bootstrap-schema.js
// ============================================================
// 用途：在你自己的腾讯文档账号下，为一个【新建的空智能表格】自动创建
//       8 张子表 + 全部字段 + 演示种子数据，并打印可直接粘进 tencentdocs.js 的 TABLE。
//
// ⚠️ 历史教训（2026-10 修复）：本脚本曾经的字段名是手抄的，与 tencentdocs.js 的 COL
//    悄悄漂移了 14 处（如「位置」vs「存放位置」、「借出」vs「借出时间」），users 表还少了
//    「状态 / 微信OpenID」两列。用旧脚本建出的新文档，写入会被 buildValues 静默跳过
//    （找不到列 → 跳过且只 warn），表现为「功能莫名其妙不全」而不报错。
//    现在：所有列名从 tencentdocs.js 的 COL 单一来源派生，永远不可能再漂移；
//    字段类型 / 单选项 / 自动编号规则按 2026-10-24 线上 8 表真实定义逐字校准。
//
// 前置：
//   1) 在 docs.qq.com 新建一个空白「智能表格」（会自动带一个默认子表，跑完手动删掉即可）
//   2) 从它的 URL 取 file_id：https://docs.qq.com/smartsheet/<FILE_ID>
//   3) 完成 OAuth 授权，拿到 access_token / open_id(Open ID) / client_id
//
// 运行（PowerShell 或 bash 均可）：
//   TD_ACCESS_TOKEN=xxx TD_OPEN_ID=xxx TD_CLIENT_ID=xxx TD_FILE_ID=xxx \
//     node tools/bootstrap-schema.js
//
// 可选：TD_NO_SEED=1 只建表结构、不写种子数据
// ============================================================

const path = require('path')
// COL 是列名的唯一事实来源（tencentdocs.js 顶部），从这里派生，杜绝手抄漂移
const td = require(path.join(__dirname, '..', 'cloudfunctions', 'docsProxy', 'tencentdocs.js'))
const COL = td.COL

const BASE = 'https://docs.qq.com/openapi/smartbook/v2'

const TOKEN = process.env.TD_ACCESS_TOKEN || ''
const OPEN_ID = process.env.TD_OPEN_ID || ''
const CLIENT_ID = process.env.TD_CLIENT_ID || ''
const FILE_ID = process.env.TD_FILE_ID || ''
const SEED = process.env.TD_NO_SEED !== '1'

if (!TOKEN || !OPEN_ID || !CLIENT_ID || !FILE_ID) {
  console.error('❌ 缺少环境变量：需要 TD_ACCESS_TOKEN / TD_OPEN_ID / TD_CLIENT_ID / TD_FILE_ID')
  process.exit(1)
}

// ---- 字段类型常量（与线上 getFields 返回的 fieldType 一致）----
const T_TEXT = 1
const T_NUM = 2
const T_DATE = 4
const T_SELECT = 17
const T_AUTONO = 25

// ---- 各表字段清单：列键 → [类型, 单选项, 自动编号前缀] ----
// 类型与选项按 2026-10-24 对线上《实训室管理系统数据底座》8 张表的真实定义校准。
// 列名一律通过 COL 取，不在此处出现任何手写中文列名。
const SCHEMA = [
  {
    key: 'users', title: '用户表',
    fields: [
      ['id', T_TEXT], ['name', T_TEXT], ['role', T_SELECT, ['学生', '教师', '管理员']],
      ['cls', T_TEXT], ['status', T_SELECT, ['启用', '停用']], ['openid', T_TEXT]
    ],
    seed: [
      { id: 'S001', name: '张三', role: '学生', cls: '电子1班', status: '启用', openid: '' },
      { id: 'S002', name: '李四', role: '学生', cls: '电子1班', status: '启用', openid: '' },
      { id: 'T001', name: '邓老师', role: '教师', cls: '', status: '启用', openid: '' },
      { id: 'A001', name: '王管理员', role: '管理员', cls: '', status: '启用', openid: '' }
    ]
  },
  {
    key: 'materials', title: '耗材表',
    fields: [
      ['id', T_TEXT], ['name', T_TEXT], ['spec', T_TEXT], ['cat', T_SELECT, ['电子元件', '机械配件', '工具耗材', '办公耗材']],
      ['loc', T_TEXT], ['stock', T_NUM], ['unit', T_TEXT], ['safe', T_NUM], ['status', T_SELECT, ['正常', '紧缺', '停用']]
    ],
    seed: [
      { id: 'M001', name: '电阻包(1kΩ)', spec: '1kΩ 100只/包', cat: '电子元件', loc: 'A柜1层', stock: 25, unit: '包', safe: 10, status: '正常' },
      { id: 'M002', name: '面包板', spec: '830孔', cat: '电子元件', loc: 'A柜2层', stock: 3, unit: '块', safe: 5, status: '紧缺' },
      { id: 'M003', name: '杜邦线(公对母)', spec: '20cm 40根/扎', cat: '电子元件', loc: 'B柜1层', stock: 40, unit: '扎', safe: 20, status: '正常' },
      { id: 'M004', name: '焊锡丝', spec: '0.8mm 100g', cat: '电子元件', loc: 'C柜', stock: 1, unit: '卷', safe: 3, status: '紧缺' }
    ]
  },
  {
    key: 'tools', title: '工具表',
    fields: [
      ['id', T_TEXT], ['name', T_TEXT], ['spec', T_TEXT], ['loc', T_TEXT],
      ['status', T_SELECT, ['在库', '借出', '维修', '报废']], ['holder', T_TEXT]
    ],
    seed: [
      { id: 'T001', name: '万用表 FLUKE-17', spec: 'FL-17001', loc: 'A柜', status: '在库', holder: '' },
      { id: 'T002', name: '电烙铁 60W', spec: 'LT-2002', loc: 'C柜', status: '借出', holder: 'S002' },
      { id: 'T003', name: '示波器 SDS1104', spec: 'OS-1104', loc: 'B柜', status: '在库', holder: '' }
    ]
  },
  {
    key: 'requisitions', title: '领用申请表',
    fields: [
      ['id', T_AUTONO, 'RQ-'], ['user', T_TEXT], ['item', T_TEXT],
      ['type', T_SELECT, ['耗材', '工具', '领用', '借出']], ['qty', T_NUM], ['reason', T_TEXT],
      ['status', T_SELECT, ['待审批', '通过', '拒绝', '已通过']], ['time', T_DATE], ['approver', T_TEXT]
    ],
    seed: [
      { user: 'S002', item: 'M003', type: '领用', qty: 2, reason: '课堂实训', status: '待审批', approver: '', time: '2026-10-22 09:30' }
    ]
  },
  {
    key: 'borrow', title: '借还记录表',
    fields: [
      ['id', T_AUTONO, 'BR-'], ['user', T_TEXT], ['tool', T_TEXT],
      ['out', T_DATE], ['plan', T_DATE], ['in', T_DATE], ['status', T_SELECT, ['借出中', '已归还', '逾期']]
    ],
    seed: []
  },
  {
    key: 'stock_io', title: '出入库流水表',
    fields: [
      ['id', T_AUTONO, 'IO-'], ['item', T_TEXT], ['dir', T_SELECT, ['入库', '出库']],
      ['qty', T_NUM], ['op', T_TEXT], ['time', T_DATE], ['note', T_TEXT]
    ],
    seed: []
  },
  {
    key: 'access', title: '门禁记录表',
    fields: [
      ['id', T_AUTONO, 'AC-'], ['user', T_TEXT], ['point', T_TEXT], ['time', T_DATE],
      ['result', T_SELECT, ['成功', '拒绝']]
    ],
    seed: []
  },
  {
    key: 'logs', title: '操作日志表',
    fields: [
      ['id', T_AUTONO, 'LG-'], ['time', T_DATE], ['actor', T_TEXT], ['op', T_TEXT],
      ['target', T_TEXT], ['result', T_TEXT]
    ],
    seed: []
  }
]

async function call(action, params, sheetId) {
  const url = sheetId
    ? `${BASE}/files/${FILE_ID}/sheets/${sheetId}`
    : `${BASE}/files/${FILE_ID}/sheets`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': TOKEN,
      'Client-Id': CLIENT_ID,
      'Open-Id': OPEN_ID
    },
    body: JSON.stringify({ [action]: params || {} })
  })
  const text = await res.text()
  let j
  try { j = JSON.parse(text) } catch (_) {
    throw new Error(`${action} 返回非 JSON：HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  if (!res.ok) throw new Error(`${action} HTTP ${res.status}：${text.slice(0, 300)}`)
  if (j.ret !== undefined && j.ret !== 0) throw new Error(`${action} ret=${j.ret} ${j.msg || ''}`)
  return (j.data && j.data[action]) || {}
}

// ---- 构造 addFields 的字段定义（property* 载荷与线上 getFields 返回逐字同构）----
// entry 形如 ['role', T_SELECT, ['学生','教师','管理员']] 或 ['id', T_AUTONO, 'RQ-']
function buildFieldPayload(tableKey, entry) {
  const [colKey, type, opts, prefix] = entry
  const title = COL[tableKey][colKey]
  if (!title) throw new Error(`COL.${tableKey} 不存在列键 ${colKey}——脚本与生产代码已漂移，请检查`)
  const base = { fieldTitle: title, fieldType: type }
  if (type === T_TEXT) base.propertyText = { defaultCellValue: null }
  else if (type === T_NUM) base.propertyNumber = { decimalPlaces: 0, defaultCellValue: null, useDefaultDecimal: false, useSeparate: false }
  else if (type === T_DATE) base.propertyDateTime = { autoFill: false, defaultCellValue: null, format: 'yyyy-mm-dd' }
  else if (type === T_SELECT) base.propertySingleSelect = {
    defaultCellValue: null, isMultiple: false, isQuickAdd: true,
    options: (opts || []).map((text, i) => ({ text, style: i + 1 }))
  }
  else if (type === T_AUTONO) base.propertyAutoNumber = {
    defaultCellValue: null, initialViewId: null, reformatExistingRecord: true, type: 2,
    rules: [
      // 自动编号前缀：T_AUTONO 条目把前缀放在第 3 位（['id', T_AUTONO, 'IO-']）
      { type: 2, value: prefix || opts || 'NO-' },
      { type: 3, value: 'YYYYMMDD' },
      { type: 2, value: '-' },
      { type: 1, value: '4' }
    ]
  }
  else throw new Error(`未知字段类型 ${type}（${tableKey}.${colKey}）`)
  return base
}

// ---- 种子数据转 values：与 tencentdocs.js buildValues 的转换规则保持一致 ----
//  文本 → [{type:'text',text}]；数字 → Number；日期 → 时间戳字符串；单选 → [{text}]
//  自动编号列（type 25）不写，由平台生成。
function seedValues(tableKey, row) {
  const values = {}
  for (const [colKey, v] of Object.entries(row)) {
    const entry = SCHEMA_BY_KEY[tableKey].fieldSpec[colKey]
    if (!entry) throw new Error(`种子数据含 SCHEMA 未定义的列键 ${tableKey}.${colKey}`)
    const type = entry[1]
    if (type === T_AUTONO) continue
    if (v === '' || v == null) continue
    if (type === T_NUM) values[COL[tableKey][colKey]] = Number(v) || 0
    else if (type === T_DATE) {
      const s = String(v).trim()
      values[COL[tableKey][colKey]] = /^\d{10,}$/.test(s) ? s : String(Date.parse(s.replace(/-/g, '/')))
    }
    else if (type === T_SELECT) values[COL[tableKey][colKey]] = [{ text: String(v) }]
    else values[COL[tableKey][colKey]] = [{ type: 'text', text: String(v) }]
  }
  return values
}

const SCHEMA_BY_KEY = {}
SCHEMA.forEach(s => {
  SCHEMA_BY_KEY[s.key] = s
  s.fieldSpec = {}
  s.fields.forEach(f => { s.fieldSpec[f[0]] = f })
})

async function main() {
  console.log('⚠️ 本脚本会在file_id=' + FILE_ID + ' 指向的文档里创建 8 张子表并写入种子数据。')
  console.log('   请确认这是一个【新建的空文档】——切勿对生产文档运行！\n')

  const out = {}
  for (let i = 0; i < SCHEMA.length; i++) {
    const s = SCHEMA[i]

    process.stdout.write(`创建子表「${s.title}」... `)
    const r = await call('addSheet', { properties: { title: s.title, index: i } })
    const sheetID = r.properties && r.properties.sheetID
    if (!sheetID) throw new Error(`addSheet 未返回 sheetID：${JSON.stringify(r)}`)
    out[s.key] = sheetID
    console.log(sheetID)

    const payloads = s.fields.map(f => buildFieldPayload(s.key, f))
    process.stdout.write(`  添加字段 ${payloads.length} 个... `)
    await call('addFields', { fields: payloads }, sheetID)
    console.log('ok')

    if (SEED && s.seed && s.seed.length) {
      process.stdout.write(`  写入种子 ${s.seed.length} 条... `)
      const records = s.seed.map(row => ({ values: seedValues(s.key, row) }))
      await call('addRecords', { records }, sheetID)
      console.log('ok')
    }
  }

  // ---- 建后自检：回读字段清单，逐字核对 COL 的每一列都存在 ----
  // 防「addFields 静默成功但列没建全」——那正是当年 22015 类故障的温床
  console.log('\n建后自检（回读字段清单 vs COL）：')
  let bad = 0
  for (const s of SCHEMA) {
    const page = await call('getFields', { offset: 0, limit: 100 }, out[s.key])
    const titles = (page.fields || []).map(f => f.fieldTitle || f.fieldName)
    for (const colKey of Object.keys(COL[s.key])) {
      const title = COL[s.key][colKey]
      if (!titles.includes(title)) { console.log(`  ❌ ${s.key} 缺列「${title}」`); bad++ }
    }
    if (!bad) console.log(`  ✅ ${s.key}（${titles.length} 列）`)
  }
  if (bad) {
    console.error('\n❌ 自检未通过：新文档与 COL 不一致，请把上面输出反馈给开发者。')
    process.exit(1)
  }

  console.log('\n=== 把下面这段覆盖到 tencentdocs.js 的 TABLE ===\n')
  console.log('const TABLE = {')
  SCHEMA.forEach(s => console.log(`  ${s.key}: '${out[s.key]}',`))
  console.log('}')
  console.log('\n云函数环境变量请设：TENCENT_DOCS_FILE_ID = ' + FILE_ID)
  console.log('提示：新建文档自带的默认子表（工作表1）可手动删除。')
}

if (require.main === module) {
  main().catch(e => { console.error('\n❌ 失败：', e.message); process.exit(1) })
} else {
  // 被 require 时（单测）导出纯函数，不触发任何网络调用
  module.exports = { SCHEMA, buildFieldPayload, seedValues, COL }
}

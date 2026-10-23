// tools/diag-write.js —— 诊断 stock_io 写入 22015：逐步加字段定位；并查看日期字段真实格式。
const fs = require('fs')
const path = require('path')
;(function loadEnv() {
  const f = path.join(__dirname, '.env.local')
  if (!fs.existsSync(f)) return
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const k = m[1], v = m[2].replace(/^["']|["']$/g, '')
    if (process.env[k] === undefined) process.env[k] = v
  }
})()
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

// 直接调用底层 callSmart 逐字段构造，定位 22015
async function tryAdd(label, fields) {
  try {
    const r = await td.callSmart('stock_io', 'addRecords', { records: [{ values: fields }] })
    console.log(`[OK] ${label} → 创建 ${r.records ? r.records.length : 0} 条`)
    return true
  } catch (e) {
    console.log(`[FAIL] ${label} → ${e.message}`)
    return false
  }
}

;(async () => {
  // 1) 看 borrow 日期字段真实格式
  const b = await td.getRecords('borrow')
  if (b[0]) console.log('borrow 首行原始 values:', JSON.stringify(b[0].fields, null, 0))

  // 2) stock_io 逐步加字段
  const base = { '物品ID': [{ text: 'M001' }], '数量': 1, '操作人': [{ text: '诊断' }], '备注': [{ text: 'x' }] }
  await tryAdd('仅基础字段(物品ID/数量/操作人/备注)', base)
  await tryAdd('+方向(单选 [{text:入库}])', { ...base, '方向': [{ text: '入库' }] })
  await tryAdd('+操作时间(日期 [{text:now}])', { ...base, '方向': [{ text: '入库' }], '操作时间': [{ text: '2026-10-22 23:04:10' }] })
  await tryAdd('方向改用 [{id,text}] 风格', { ...base, '方向': [{ id: '', text: '入库' }] })
  // 日期尝试时间戳
  await tryAdd('操作时间=时间戳数字', { ...base, '方向': [{ text: '入库' }], '操作时间': Date.now() })
})()

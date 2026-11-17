// utils/importer.js —— 批量建档清单解析（耗材 / 工具）
//
// 为什么要独立成文件：
//   1) 页面要用它，回归测试也要用它 —— 同一份解析逻辑才能真正验证
//      「导出 → 改 → 再导入」的往返不会写坏台账；
//   2) 解析规则里有一堆坑（表头识别、别名、列序），内联在页面里既没法单测也没法复用。
//
// 核心规则：**带表头就按表头名取列，没表头才按位置顺序取**。
//   动机：系统自己导出的 CSV 列序改过版（早期是「耗材ID,名称,…」，后来改为「名称,耗材ID,…」
//   以对齐导入）。若一律按位置解析，用户拿旧导出文件回来导入就会把 ID 当名称、
//   单位当库存数，把整份台账写坏 —— 这是最典型的"导出备份后回灌"场景。
const FIELD_ALIAS = {
  name: ['名称', '品名', '物料名称', '耗材名称', '工具名称', 'name'],
  id: ['耗材id', '工具id', '编号', '编码', 'id', 'code'],
  spec: ['规格', '型号', 'spec'],
  cat: ['类别', '分类', 'cat', 'category'],
  loc: ['存放位置', '位置', '库位', 'loc', 'location'],
  unit: ['单位', '计量单位', 'unit'],
  stock: ['当前库存', '期初库存', '库存', '数量', 'stock', 'qty'],
  safe: ['预警线', '安全库存', '安全下限', '下限', 'safe'],
  expire: ['有效期', '效期', '到期日', 'expire', 'expiry'],
  status: ['状态', 'status'],
  holder: ['当前持有人', '持有人', 'holder']
}

// 位置顺序（无表头时的兜底）
const POS = {
  material: { name: 0, id: 1, spec: 2, cat: 3, loc: 4, unit: 5, stock: 6, safe: 7, expire: 8 },
  tool: { name: 0, id: 1, spec: 2, loc: 3, status: 4, holder: 5 }
}

// CSV 解析（RFC 4180 风格，引号感知）
//
// 为什么不能用 split(/[\t,]/) 裸切：
//   导出时凡含逗号/引号/换行的字段都会被加引号（如 "焊锡丝, 无铅环保型"），
//   裸切会把一个字段切成多列 → 整行列序错位 → 「导出→改→导入」直接写坏台账：
//   编号变成名称的一部分、单位变成存放位置、库存变成单位。实测复现过。
//   另外「按行切分」也会把引号内的换行截断成两行。
// 这里改为整体扫描：引号内的逗号/换行不算分隔符，双引号用 "" 表示一个引号。
function parseCsvRows(text) {
  const rows = []
  const s = ('' + (text || '')).replace(/^\uFEFF/, '')
  let row = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuote) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++ }
        else inQuote = false
      } else cur += ch
      continue
    }
    if (ch === '"' && cur.trim() === '') { inQuote = true; cur = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(cur.trim()); cur = ''; rows.push(row); row = []; continue }
    if (ch === '\t' || ch === ',') { row.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row) }
  return rows.filter(r => r.some(c => c !== ''))
}

// 去掉导出时加的「公式防护单引号」：
//   只在去掉后首字符仍是公式触发符（= + - @）时才去，避免把用户真写的 "'名字" 误改。
function unguardFormula(v) {
  const t = ('' + (v || ''))
  if (t.charAt(0) === "'" && /^[\s]*[=+\-@]/.test(t.slice(1))) return t.slice(1)
  return t
}

function isHeaderRow(cells) {
  const hasName = cells.some(c => /名称|品名/.test(c))
  const hasId = cells.some(c => /编号|编码|\bid\b/i.test(c))
  return hasName && hasId
}

function buildHeaderMap(cells) {
  const map = {}
  cells.forEach((c, idx) => {
    const key = ('' + c).toLowerCase()
    for (const f in FIELD_ALIAS) {
      if (map[f] !== undefined) continue
      if (FIELD_ALIAS[f].some(a => a.toLowerCase() === key)) { map[f] = idx; break }
    }
  })
  return map
}

// text: 多行清单；kind: 'material' | 'tool'
// 返回 { rows, hasHeader, skipped }
function parseImport(text, kind) {
  const tool = kind === 'tool'
  const pos = tool ? POS.tool : POS.material
  const lines = parseCsvRows(text)
  const rows = []
  let headerMap = null
  let startAt = 0
  if (lines.length) {
    const first = lines[0].map(c => c.replace(/^\uFEFF/, ''))
    if (isHeaderRow(first)) {
      headerMap = buildHeaderMap(first)
      startAt = 1
    }
  }
  const pick = (cells, field) => {
    const raw = (headerMap && headerMap[field] !== undefined) ? cells[headerMap[field]] : cells[pos[field]]
    return unguardFormula(raw || '')
  }
  for (let i = startAt; i < lines.length; i++) {
    const c = lines[i]
    if (!c[0]) continue
    // 无表头时，若首列就是「名称」字样仍视为表头残留，跳过
    if (!headerMap && /^(名称|name)$/i.test(c[0])) continue
    if (tool) {
      rows.push({
        name: pick(c, 'name'), id: pick(c, 'id'), spec: pick(c, 'spec'),
        loc: pick(c, 'loc'), status: pick(c, 'status') || '在库', holder: pick(c, 'holder')
      })
    } else {
      rows.push({
        name: pick(c, 'name'), id: pick(c, 'id'), spec: pick(c, 'spec'), cat: pick(c, 'cat'),
        loc: pick(c, 'loc'), unit: pick(c, 'unit') || '个', stock: pick(c, 'stock'),
        safe: pick(c, 'safe'), expire: pick(c, 'expire')
      })
    }
  }
  return { rows, hasHeader: !!headerMap, skipped: startAt }
}

module.exports = { parseImport, FIELD_ALIAS, POS, parseCsvRows, unguardFormula }

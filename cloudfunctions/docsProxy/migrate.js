// migrate.js —— 腾讯文档 → 云数据库 一次性迁移（纯逻辑，可注入，便于单测）
// ============================================================
// 设计（与《数据层迁移方案-腾讯文档到云数据库.md》方案 C 一致）：
//   • 源 srcTd = tencentdocs 适配器，调用 getRecords 读出 8 表全量，fields 是「中文列名」做 key。
//   • 目的 dstTd = clouddb 适配器，调用 addRecord 写入对应集合，字段是「英文 key」。
//   • 映射规则：逐表按 COL 把中文列名重命名为英文 key；值原样搬。
//       - 日期列在腾讯文档已落库为 13 位时间戳字符串 → 转成数字（与 clouddb now()/fmtTs 同口径）。
//       - 状态/角色/方向等枚举在云库存的是与腾讯文档同构的中文值（待审批/借出中/入库…），
//         业务函数读出后 TR.xxx 再翻英文下发前端，因此这里值原样搬、不做翻译。
//   • 幂等：写入前先清空目的集合（按 recordId 删除）。保留源（腾讯文档）数据不删，可回滚
//     —— 只需把 DATA_BACKEND 切回 tencent，业务/前端零改动。
// ============================================================
const TABLES = ['users', 'materials', 'tools', 'requisitions', 'borrow', 'stock_io', 'access', 'logs']

// 构建一个「中文列名 → 英文 key」反查表（同一 logicalKey 在 src.COL / dst.COL 上同名）。
function buildZhToEn(sheetKey, srcCOL, dstCOL) {
  const map = {}
  const s = (srcCOL && srcCOL[sheetKey]) || {}
  const d = (dstCOL && dstCOL[sheetKey]) || {}
  for (const logicalKey of Object.keys(s)) {
    const zh = s[logicalKey]          // 中文列名
    const en = d[logicalKey]          // 英文 key（clouddb 恒等映射即英文本身）
    if (en) map[zh] = en
  }
  return map
}

// 归一化单值：
//   • 空文本数组 []（腾讯文档空单元格读回形态）→ 空串
//   • 13 位时间戳字符串 → 数字（便于排序/报表，与 clouddb 时间口径一致）
//   其余原样返回（中文枚举、普通文本、数字等）。
function coerce(v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return ''
    // 兜底：极少数未解包形态 [{type:'text',text}]
    if (v[0] && typeof v[0] === 'object' && 'text' in v[0]) return v.map(x => x.text).join('')
    return ''
  }
  if (typeof v === 'string' && /^\d{10,}$/.test(v)) return Number(v)
  return v
}

async function clearTable(dstTd, sheetKey) {
  const existing = await dstTd.getRecords(sheetKey)
  if (existing.length) {
    await dstTd.deleteRecordByIds(sheetKey, existing.map(r => r.recordId))
  }
}

// 迁移单表：读出源全量 → 列名重命名 → 清空目的 → 逐条写入。返回本表统计。
async function migrateTable(srcTd, dstTd, sheetKey, zhToEn, clearFirst) {
  const src = await srcTd.getRecords(sheetKey)        // 全量，{recordId, fields:中文key}
  if (clearFirst) await clearTable(dstTd, sheetKey)
  let written = 0, skipped = 0, dropUnknown = 0
  for (const rec of src) {
    const f = rec.fields || {}
    const out = {}
    for (const zh of Object.keys(f)) {
      const en = zhToEn[zh]
      if (!en) { dropUnknown++; continue }            // 不在契约内的列忽略（保持云库 schema 干净）
      out[en] = coerce(f[zh])
    }
    if (!Object.keys(out).length) { skipped++; continue }
    await dstTd.addRecord(sheetKey, out)
    written++
  }
  return { table: sheetKey, srcTotal: src.length, written, skipped, dropUnknown }
}

// 主入口：腾讯文档 8 表 → 云数据库。srcTd/dstTd 均可注入（单测用伪库）。
// opts.clearFirst 默认 true（幂等、可重复执行）；offlineSafe 仅占位，保持接口稳定。
async function migrateTencentToCloud(srcTd, dstTd, opts) {
  const o = opts || {}
  const clearFirst = o.clearFirst !== false
  const reports = []
  for (const t of TABLES) {
    const zhToEn = buildZhToEn(t, srcTd.COL, dstTd.COL)
    reports.push(await migrateTable(srcTd, dstTd, t, zhToEn, clearFirst))
  }
  return { ok: true, cleared: clearFirst, tables: reports, at: Date.now() }
}

module.exports = { migrateTencentToCloud, buildZhToEn, coerce, TABLES, clearTable }

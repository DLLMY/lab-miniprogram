// tools/dump-field-types.js
// 拉取 8 张子表的真实字段名 + 类型（只读），用于：
//   ① 回归核对 tencentdocs.js 的 COL 是否与线上逐字一致；
//   ② 作为 bootstrap-schema.js 建表字段类型的地面真值。
// 用法：node tools/dump-field-types.js
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  let bad = 0
  for (const key of Object.keys(td.TABLE)) {
    const map = await td.getFieldMap(key)
    const colNames = Object.values(td.COL[key])
    console.log('\n==== ' + key + ' (' + td.TABLE[key] + ') ====')
    for (const [title, meta] of Object.entries(map)) {
      const inCol = colNames.includes(title)
      console.log('  ' + title.padEnd(12) + ' type=' + String(meta.type).padEnd(3) + (inCol ? '' : '  ← COL 未覆盖'))
    }
    // COL 里声明但线上不存在的列（写入会被静默跳过 → 数据丢失）
    for (const n of colNames) {
      if (!map[n]) { console.log('  ❌ COL 声明但线上缺失：' + n); bad++ }
    }
  }
  console.log('\n' + (bad ? '❌ COL 与线上不一致的列数：' + bad : '✅ COL 与线上 8 张表完全一致'))
})().catch(e => { console.error('ERR', e.message); process.exit(1) })

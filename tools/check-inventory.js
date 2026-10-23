// tools/check-inventory.js
// 直接复用云函数适配器，连真实腾讯文档，验证「库存一览」页要读的两张表是否可正常返回。
// 与 pages/inventory/inventory.js 调用的 listMaterials / listTools 是同一份代码、同一份凭证。
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  console.log('env.local.js 兜底凭证已加载 → fileId=' + td.CFG.FILE_ID)
  console.log('--- 耗材 materials ---')
  const mats = await td.listMaterials()
  console.log('  条数 =', mats.length)
  mats.slice(0, 5).forEach(m => console.log('   ', m.id, m.name, '库存 ' + m.stock + m.unit, '安全 ' + m.safe, '[' + m.cat + ']'))

  console.log('--- 工具 tools ---')
  const tools = await td.listTools()
  console.log('  条数 =', tools.length)
  tools.slice(0, 5).forEach(t => console.log('   ', t.id, t.name, '编号 ' + t.sn, '状态 ' + t.status, t.borrower ? '借用人 ' + t.borrower : ''))

  console.log('\n结论：库存页在真实腾讯文档下可正常加载（耗材 ' + mats.length + ' / 工具 ' + tools.length + ' 条）。')
})().catch(e => { console.error('❌ 失败：', e.message); process.exit(1) })

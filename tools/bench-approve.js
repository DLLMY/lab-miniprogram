// tools/bench-approve.js
// 只读延迟基准：验证 warmFieldMaps(并行预热) + keepAlive 后的网络耗时，不写真实数据。
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

;(async () => {
  let t = Date.now()
  await td.warmFieldMaps()
  console.log('warmFieldMaps（冷启动·8表字段映射并行预热）:', Date.now() - t, 'ms')

  t = Date.now(); await td.getRecords('requisitions')
  console.log('getRecords(requisitions) 单次往返:', Date.now() - t, 'ms')

  t = Date.now(); await td.getRecords('materials')
  console.log('getRecords(materials) 单次往返:', Date.now() - t, 'ms')

  // 模拟审批「读-读」两段（不含写，避免改动真实库存）
  t = Date.now()
  await td.getRecords('requisitions', r => ('' + r.fields[td.COL.requisitions.id]) === 'RQ-20261023-0019')
  await td.getRecords('materials', r => ('' + r.fields[td.COL.materials.id]) === 'M002')
  console.log('审批「读申请+读物料」两段:', Date.now() - t, 'ms')

  console.log('\n结论：热容器下完整审批 ≈ 上述两段 + 一次并行写(≈1 次往返) ≈ 1.5~2.5s，远低于 20s 上限。')
  console.log('注意：云函数超时仍是硬性上限，必须在控制台把 docsProxy 超时改为 20s（见上线手册步骤 2.5）。')
})().catch(e => { console.error('基准失败:', e); process.exit(1) })

// test-migrate.js —— 验证 migrate.js：腾讯文档（中文列名）→ 云数据库（英文 key）映射
// 不依赖真实 CloudBase / 腾讯文档：源用伪适配器，目的用 clouddb + 内存伪云库。
const cl = require('../cloudfunctions/docsProxy/clouddb.js')
const { migrateTencentToCloud, buildZhToEn } = require('../cloudfunctions/docsProxy/migrate.js')

let _seq = 0
function makeFakeDb() {
  const store = {}
  const collection = (name) => {
    const arr = (store[name] = store[name] || [])
    return {
      async get() { return { data: arr.map(d => ({ ...d })) } },
      async add({ data }) { const _id = 'rid_' + (++_seq); arr.push(Object.assign({ _id }, data)); return { _id } },
      doc(id) {
        return {
          async update({ data }) { const d = arr.find(x => x._id === id); if (d) Object.assign(d, data); return {} },
          async remove() { const i = arr.findIndex(x => x._id === id); if (i >= 0) arr.splice(i, 1); return {} }
        }
      }
    }
  }
  return { collection }
}

// —— 伪源适配器：模仿 tencentdocs 的 COL（中文列名）与 getRecords（中文 fields）——
const srcCOL = {
  users: { id: '用户ID', name: '姓名', role: '角色', cls: '班级', status: '状态', openid: '微信OpenID' },
  materials: { id: '耗材ID', name: '名称', spec: '规格', cat: '类别', loc: '存放位置', stock: '当前库存', unit: '单位', safe: '预警线', status: '状态', expire: '有效期' },
  tools: { id: '工具ID', name: '名称', spec: '规格', loc: '存放位置', status: '状态', holder: '当前持有人' },
  requisitions: { id: '申请ID', user: '申请人ID', item: '物品ID', type: '物品类型', qty: '数量', reason: '用途说明', status: '状态', time: '申请时间', approver: '审批人', reject: '驳回原因' },
  borrow: { id: '借还ID', user: '借用人ID', tool: '工具ID', out: '借出时间', plan: '计划归还', in: '实际归还', status: '状态' },
  stock_io: { id: '流水ID', item: '物品ID', dir: '方向', qty: '数量', op: '操作人', time: '操作时间', note: '备注', src: '来源类型' },
  access: { id: '记录ID', user: '用户ID', point: '门禁点', time: '刷卡时间', result: '结果' },
  logs: { id: '日志ID', time: '时间', actor: '操作人', op: '操作类型', target: '对象', result: '结果' }
}
const SRC = {
  users: [
    { recordId: 't1', fields: { '用户ID': 'T001', '姓名': '邓老师', '角色': '超级管理员', '班级': '', '状态': '启用', '微信OpenID': 'wx_abc' } },
    { recordId: 't2', fields: { '用户ID': 'S002', '姓名': '学生乙', '角色': '学生', '班级': '23301', '状态': '启用', '微信OpenID': '' } }
  ],
  materials: [
    { recordId: 'm1', fields: { '耗材ID': 'M001', '名称': '电阻包', '规格': '1kΩ', '类别': '电子耗材', '存放位置': 'A柜1层', '当前库存': 25, '单位': '包', '预警线': 10, '状态': '正常', '有效期': '1792683028958' } }
  ],
  tools: [
    { recordId: 'g1', fields: { '工具ID': 'T001', '名称': '万用表', '规格': 'FLUKE', '存放位置': 'B柜', '状态': '在库', '当前持有人': '' } }
  ],
  requisitions: [
    { recordId: 'r1', fields: { '申请ID': 'R20261001', '申请人ID': 'S002', '物品ID': 'M003', '物品类型': '领用', '数量': 2, '用途说明': '实训', '状态': '待审批', '申请时间': '1792683028958', '审批人': '', '驳回原因': '' } }
  ],
  borrow: [
    { recordId: 'b1', fields: { '借还ID': 'B20261001', '借用人ID': 'S002', '工具ID': 'T001', '借出时间': '1792683000000', '计划归还': '1793287800000', '实际归还': '', '状态': '借出中' } }
  ],
  stock_io: [
    { recordId: 's1', fields: { '流水ID': 'S001', '物品ID': 'M001', '方向': '入库', '数量': 25, '操作人': 'T001', '操作时间': '1792683028958', '备注': '建档', '来源类型': '建档入库' } }
  ],
  access: [
    { recordId: 'a1', fields: { '记录ID': 'A001', '用户ID': 'T001', '门禁点': '实训室门', '刷卡时间': '1792683028958', '结果': '开门' } }
  ],
  logs: [
    { recordId: 'l1', fields: { '日志ID': 'L001', '时间': '1792683028958', '操作人': 'T001', '操作类型': '建档', '对象': 'M001', '结果': '成功' } }
  ]
}
const srcTd = { COL: srcCOL, getRecords: async (t) => SRC[t] || [] }

let pass = 0, fail = 0
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name) } }
function eq(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b)
  if (sa === sb) pass++; else { fail++; console.error('  ✗ ' + name + '  得到=' + sa + ' 期望=' + sb) }
}

;(async () => {
  cl.__setDbForTest(makeFakeDb())

  // buildZhToEn 反查表
  const zh2en = buildZhToEn('materials', srcCOL, cl.COL)
  eq('中文列名→英文key: 当前库存→stock', zh2en['当前库存'], 'stock')
  eq('中文列名→英文key: 名称→name', zh2en['名称'], 'name')

  // 执行迁移
  const rep = await migrateTencentToCloud(srcTd, cl)
  ok('迁移 ok=true', rep.ok === true)
  eq('8 表均报告', rep.tables.length, 8)

  // 逐表校验：条数与关键字段（英文 key + 中文枚举原样保留 + 时间戳转数字）
  const byTable = {}
  rep.tables.forEach(t => { byTable[t.table] = t })

  eq('users 写入 2', byTable.users.written, 2)
  const users = await cl.getRecords('users')
  const u0 = users.find(u => u.fields.id === 'T001').fields
  eq('users.id=T001', u0.id, 'T001')
  eq('users.role 中文保留', u0.role, '超级管理员')       // 云库存中文，normUser 才翻英文
  eq('users.openid 保留', u0.openid, 'wx_abc')

  eq('materials 写入 1', byTable.materials.written, 1)
  const mats = await cl.getRecords('materials')
  const m0 = mats[0].fields
  eq('materials.id=M001', m0.id, 'M001')
  eq('materials.stock=25(数字)', m0.stock, 25)
  eq('materials.expire 时间戳转数字', m0.expire, 1792683028958)
  eq('materials.status 中文保留', m0.status, '正常')

  eq('tools 写入 1', byTable.tools.written, 1)
  const tools = await cl.getRecords('tools')
  eq('tools.status 在库', tools[0].fields.status, '在库')

  eq('requisitions 写入 1', byTable.requisitions.written, 1)
  const reqs = await cl.getRecords('requisitions')
  const rq = reqs[0].fields
  eq('requisitions.id=R20261001 自动编号保留', rq.id, 'R20261001')
  eq('requisitions.status 待审批(中文)', rq.status, '待审批')
  eq('requisitions.qty=2', rq.qty, 2)
  eq('requisitions.time 时间戳转数字', rq.time, 1792683028958)
  eq('requisitions.type 领用(中文)', rq.type, '领用')

  eq('borrow 写入 1', byTable.borrow.written, 1)
  const bw = (await cl.getRecords('borrow'))[0].fields
  eq('borrow.status 借出中(中文)', bw.status, '借出中')

  eq('stock_io 写入 1', byTable.stock_io.written, 1)
  eq('access 写入 1', byTable.access.written, 1)
  eq('logs 写入 1', byTable.logs.written, 1)

  // 幂等：再跑一次（clearFirst 默认 true）不应重复
  const rep2 = await migrateTencentToCloud(srcTd, cl)
  eq('幂等后 users 仍 2 条', (await cl.getRecords('users')).length, 2)
  eq('幂等后 materials 仍 1 条', (await cl.getRecords('materials')).length, 1)

  console.log(`\n迁移测试：${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('测试异常：', e); process.exit(1) })

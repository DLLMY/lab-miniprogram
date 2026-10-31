// test-clouddb-adapter.js —— 用内存伪云库验证 clouddb.js 的存储契约与业务函数
// 不依赖真实 CloudBase 环境：通过 clouddb.__setDbForTest 注入最小内存数据库。
const cl = require('../cloudfunctions/docsProxy/clouddb.js')

let _seq = 0
function makeFakeDb() {
  const store = {}
  const collection = (name) => {
    const arr = (store[name] = store[name] || [])
    return {
      async get() { return { data: arr.map(d => ({ ...d })) } },
      async add({ data }) {
        const _id = 'rid_' + (++_seq)
        arr.push(Object.assign({ _id }, data))
        return { _id }
      },
      doc(id) {
        return {
          async update({ data }) {
            const d = arr.find(x => x._id === id)
            if (d) Object.assign(d, data)
            return {}
          },
          async remove() {
            const i = arr.findIndex(x => x._id === id)
            if (i >= 0) arr.splice(i, 1)
            return {}
          }
        }
      }
    }
  }
  return { collection }
}

let pass = 0, fail = 0
function ok(name, cond) { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + name) } }
function eq(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b)
  if (sa === sb) { pass++ } else { fail++; console.error('  ✗ ' + name + '  得到=' + sa + ' 期望=' + sb) }
}

;(async () => {
  cl.__setDbForTest(makeFakeDb())

  // 1. addRecord 返回 recordId
  const r1 = await cl.addRecord('materials', { id: 'M001', name: '电阻', stock: 100, unit: '个' })
  ok('addRecord 返回 recordId', !!r1.recordId)

  // 2. getRecords 形状 {recordId, fields}
  const list = await cl.getRecords('materials')
  eq('getRecords 读到 1 条', list.length, 1)
  eq('fields.id 正确', list[0].fields.id, 'M001')
  eq('fields.stock 是数字', list[0].fields.stock, 100)

  // 3. updateRecord
  await cl.updateRecord('materials', r1.recordId, { stock: 88 })
  const list2 = await cl.getRecords('materials')
  eq('update 后 stock=88', list2[0].fields.stock, 88)

  // 4. normMaterial（经 listMaterials）
  const mats = await cl.listMaterials()
  eq('listMaterials norm name', mats[0].name, '电阻')
  eq('listMaterials norm stock', mats[0].stock, 88)

  // 5. deleteRecordByIds
  const n = await cl.deleteRecordByIds('materials', [r1.recordId])
  eq('delete 返回 1', n, 1)
  eq('delete 后为空', (await cl.getRecords('materials')).length, 0)

  // 6. requisition 业务函数（云库无自动编号列 → 本地 genNo；存中文状态值）
  await cl.addRecord('materials', { id: 'M002', name: '电容', stock: 50, unit: '个' })
  const req = await cl.requisition({ matId: 'M002', qty: 3, reason: '测试领用', user: 'T001' })
  ok('requisition 返回 no', !!req.no && /^R\d{12,}$/.test(req.no))
  const reqs = await cl.getRecords('requisitions')
  eq('requisitions 1 条', reqs.length, 1)
  eq('状态=待审批(中文)', reqs[0].fields.status, '待审批')
  eq('类型=领用(中文)', reqs[0].fields.type, '领用')
  eq('申请人ID=T001', reqs[0].fields.user, 'T001')
  eq('logs 1 条', (await cl.getRecords('logs')).length, 1)

  // 7. users + whoami 链路（中文角色 → 英文下发）
  await cl.addRecord('users', { id: 'T001', name: '邓老师', role: '超级管理员', cls: '', status: '启用', openid: 'wx_abc' })
  const me = await cl.whoami('wx_abc')
  ok('whoami 命中', !!me)
  eq('whoami role→super', me.role, 'super')
  eq('whoami name', me.name, '邓老师')

  // 8. adminUpsertUser 新增 + findUser
  const up = await cl.adminUpsertUser({ id: 'S002', name: '学生乙', role: 'student', cls: '23301', status: '启用' }, me)
  ok('adminUpsertUser created', up.created === true)
  const fu = await cl.findUser('S002')
  ok('findUser S002', fu && fu.user.id === 'S002')

  // 9. 实训室归属管理体系（labs / repairs / inspections）
  // 9.1 新增实训室（自动编号 L001）+ 负责人绑定
  const lab = await cl.addLab({ name: '智能制造实训室', campus: '本部', building: 'A栋', floor: '3', roomNo: '301', address: 'A301', managerId: 'T001', managerName: '邓老师', status: '启用', actor: 'T001' })
  eq('addLab 返回 L001', lab.id, 'L001')
  const labs = await cl.listLabs()
  eq('listLabs 1 条', labs.length, 1)
  eq('listLabs name', labs[0].name, '智能制造实训室')
  eq('listLabs managerId', labs[0].managerId, 'T001')
  eq('listLabs status=启用', labs[0].status, '启用')

  // 9.2 重名冲突 → 409（同一 [actor,name] 会被幂等缓存重放成功，故换一个发起人触发唯一性校验）
  const dup = await cl.addLab({ name: '智能制造实训室', actor: 'T002' })
  eq('addLab 重名 409', dup.code, 409)

  // 9.3 getLab / updateLab / deleteLab
  const got = await cl.getLab('L001')
  ok('getLab 命中', got && got.id === 'L001')
  const upLab = await cl.updateLab({ id: 'L001', status: '停用', managerName: '李老师' })
  eq('updateLab updated', upLab.updated, true)
  const labs2 = await cl.listLabs()
  eq('updateLab 后 status=停用', labs2[0].status, '停用')
  eq('updateLab 后 managerName', labs2[0].managerName, '李老师')
  const del = await cl.deleteLab({ id: 'L001' })
  eq('deleteLab deleted', del.deleted, true)
  eq('deleteLab 后为空', (await cl.listLabs()).length, 0)

  // 9.4 报修归属实训室（教师发起）
  const labB = await cl.addLab({ name: 'PLC实训室', managerId: 'T001', managerName: '邓老师', actor: 'T001' })
  ok('addLab 返回新编号', !!labB.id)
  const rep = await cl.addRepair({ labId: labB.id, title: '万用表损坏', category: '设备故障', desc: '读数不准', priority: '紧急', actor: 'T001', reporterName: '邓老师' })
  eq('addRepair 返回 R 前缀 id', ('' + rep.id).indexOf('R') === 0, true)
  const reps = await cl.listRepairs({ labId: labB.id })
  eq('listRepairs 1 条', reps.length, 1)
  eq('repair 归属 labId', reps[0].labId, labB.id)
  eq('repair labName 同步', reps[0].labName, 'PLC实训室')
  eq('repair status=待处理', reps[0].status, '待处理')
  eq('repair priority=紧急', reps[0].priority, '紧急')
  eq('reporterId=T001', reps[0].reporterId, 'T001')
  // 9.5 处理 / 关闭
  const repUp = await cl.updateRepair({ id: rep.id, status: '已完成', handlerId: 'T001', handlerName: '邓老师', resolvedNote: '已更换' })
  eq('updateRepair updated', repUp.updated, true)
  const reps2 = await cl.listRepairs({ labId: labB.id, status: '已完成' })
  eq('updateRepair 后状态过滤', reps2.length, 1)
  eq('resolvedNote 写入', reps2[0].resolvedNote, '已更换')

  // 9.6 巡检归属实训室（教师执行）
  const ins = await cl.addInspection({ labId: labB.id, title: '月度安全巡检', planDate: '2026-11-01', actor: 'T001', executorName: '邓老师' })
  eq('addInspection 返回 I 前缀 id', ('' + ins.id).indexOf('I') === 0, true)
  const insps = await cl.listInspections({ labId: labB.id })
  eq('listInspections 1 条', insps.length, 1)
  eq('insp 归属 labId', insps[0].labId, labB.id)
  eq('insp status=待巡检', insps[0].status, '待巡检')
  const insUp = await cl.updateInspection({ id: ins.id, status: '已完成', result: '正常' })
  eq('updateInspection updated', insUp.updated, true)
  const insps2 = await cl.listInspections({ labId: labB.id })
  eq('insp 完成结果写入', insps2[0].result, '正常')
  eq('insp 完成状态', insps2[0].status, '已完成')

  // 9.7 按实训室维度统一查询 labOverview
  const ov = await cl.labOverview(labB.id)
  eq('labOverview lab 命中', ov.lab.id, labB.id)
  eq('labOverview repairs 数量', ov.repairs.length, 1)
  eq('labOverview inspections 数量', ov.inspections.length, 1)

  // 9.8 跨实训室隔离：另一实训室的报修不应出现在 labB 的 overview
  const labC = await cl.addLab({ name: '电子实训室', actor: 'T001' })
  await cl.addRepair({ labId: labC.id, title: '灯不亮', actor: 'T001', reporterName: '邓老师' })
  const ovB2 = await cl.labOverview(labB.id)
  eq('labOverview 隔离：labB.repairs 仍=1', ovB2.repairs.length, 1)

  console.log(`\nclouddb 适配器测试：${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('测试异常：', e); process.exit(1) })

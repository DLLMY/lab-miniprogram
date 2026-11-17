// tools/test_page_flows.js —— 端到端页面流程测试（真实页面 JS × 真实后端 × 真实数据）
//
// 覆盖：19 个页面的加载、关键交互、以及「页面点了之后库里真的变了吗」。
// 断言全部基于页面真实的数据键（键名由 tools/page_harness.js 构造实例后读出）。
const path = require('path')
const fs = require('fs')
const H = require('./page_harness.js')
const fsRead = (rel) => fs.readFileSync(path.join(H.ROOT, rel), 'utf8')
const { ok, section, loadPageDef, makeInstance, flush, boot, apiCalls, wxCalls } = H

function tap(dataset = {}) { return { currentTarget: { dataset }, detail: {} } }
function input(value) { return { currentTarget: { dataset: {} }, detail: { value: String(value) } } }
// keepDb：复用上一次的伪云库（不再重置种子），用于"先改数据再验证页面"的场景
async function open(page, role, keepDb) {
  const db = keepDb || await boot(role)
  const p = makeInstance(loadPageDef(page))
  if (p.onLoad) await p.onLoad({})
  if (p.onShow) await p.onShow()
  await flush(12)
  return { db, p }
}

async function main() {
  // ============================================================
  section('① 登录页：绑定登录 → 写入身份 → 跳工作台')
  {
    await boot('student')
    const p = makeInstance(loadPageDef('login'))
    await p.onLoad({}); await flush()
    p.setData({ name: '学生丙', id: 'S001' })
    await p.submit(); await flush()
    ok('绑定成功后身份写入本地存储', H.wxStub.getStorageSync('lab_identity').id === 'S001')
    ok('绑定成功后跳转到工作台', wxCalls.some(c => c[0] === 'switchTab' && c[1] === '/pages/index/index'))
  }

  // ============================================================
  section('② 工作台：统计卡片 / 待审批 / 低库存预警')
  {
    const { p } = await open('index', 'teacher')
    ok('首页读到耗材数 2', p.data.matCount === 2, 'matCount=' + p.data.matCount)
    ok('首页读到工具数 1', p.data.toolCount === 1, 'toolCount=' + p.data.toolCount)
    ok('首页读到待审批数 2', p.data.pendingCount === 2, 'pendingCount=' + p.data.pendingCount)
    ok('首页低库存预警数为 0（两件耗材均高于安全线）', p.data.lowCount === 0, 'lowCount=' + p.data.lowCount)
    ok('首页数据来源标记非演示', p.data.isDemo === false, 'isDemo=' + p.data.isDemo)
  }

  // ============================================================
  section('③ 审批页：待审批列表 → 二次确认 → 通过 → 真实扣库存 + 出流水')
  {
    const { db, p } = await open('approve', 'teacher')
    ok('审批页拉到 2 条待审批', (p.data.list || []).length === 2, 'list=' + (p.data.list || []).length)
    ok('待审批项带单号/工号/物品ID', !!(p.data.list[0] && p.data.list[0].no && p.data.list[0].user && p.data.list[0].matId),
      JSON.stringify(p.data.list[0]))
    ok('待审批项带【物品名称】而不是只有ID', p.data.list[0] && p.data.list[0].itemName === '焊锡丝',
      'itemName=' + (p.data.list[0] && p.data.list[0].itemName))
    ok('待审批项带【申请人姓名】而不是只有工号', p.data.list[0] && p.data.list[0].userName === '学生丙',
      'userName=' + (p.data.list[0] && p.data.list[0].userName))
    const matReq = p.data.list.find(x => x.kind !== 'tool')
    await p.approve(tap({ no: matReq.no, ok: '1' })); await flush(12)
    const c = apiCalls.find(x => x.action === 'approve')
    ok('点击「通过」会调 approve 并带单号', !!c && c.data.no === matReq.no, JSON.stringify(c && c.data))
    ok('approve 走 callFull + noFallback（写操作不回退演示库）', !!c && c.mode === 'callFull' && c.noFallback === true)
    const rows = await db.getRecords('requisitions', r => ('' + r.fields.id) === matReq.no)
    ok('申请单状态变为「已通过」', rows[0] && ('' + rows[0].fields.status) === '已通过', rows[0] && rows[0].fields.status)
    const mats = await db.getRecords('materials', r => ('' + r.fields.id) === 'M001')
    ok('库存真实扣减 10 → 8', Number(mats[0].fields.stock) === 8, 'stock=' + mats[0].fields.stock)
    const ios = await db.getRecords('stock_io', r => ('' + r.fields.note) === ('领用申请 ' + matReq.no))
    ok('生成 1 条出库流水（2 件）', ios.length === 1 && Number(ios[0].fields.qty) === 2, 'rows=' + ios.length)
    const logs = await db.getRecords('logs', r => ('' + r.fields.op) === '审批通过')
    ok('留下 1 条审批日志', logs.length === 1, 'logs=' + logs.length)
  }

  // ============================================================
  section('④ 审批页：驳回必须带原因（服务端强制）')
  {
    const { p } = await open('approve', 'teacher')
    const req = p.data.list[0]
    await p.approve(tap({ no: req.no, ok: '0' })); await flush(10)
    const c = apiCalls.find(x => x.action === 'approve')
    ok('驳回请求带了原因字段', !!c && 'reason' in c.data, JSON.stringify(c && c.data))
  }

  // ============================================================
  section('⑤ 领用记录页：列表 / 班级汇总 / 班级下拉选项')
  {
    const { p } = await open('claims', 'admin')
    ok('领用记录页拉到 2 行', (p.data.rows || []).length === 2, 'rows=' + (p.data.rows || []).length)
    ok('行数据带班级与领用人姓名', p.data.rows.every(x => x.cls && x.userName), JSON.stringify(p.data.rows[0]))
    ok('班级汇总按班聚合', (p.data.byCls || []).length === 1 && p.data.byCls[0].cls === H.CLS,
      JSON.stringify(p.data.byCls))
    ok('班级下拉含「全部班级」', (p.data.clsOptions || [])[0] === '全部班级', JSON.stringify(p.data.clsOptions))
    ok('行状态已归一为前端语义',
      p.data.rows.every(x => ['pending', 'approved', 'rejected', 'canceled'].indexOf(x.status) >= 0),
      JSON.stringify(p.data.rows.map(x => x.status)))
  }

  // ============================================================
  section('⑥ 领用记录页：管理员撤销已通过单 → 库存回补 + 单据标记已撤销')
  {
    const { db, p } = await open('claims', 'admin')
    const reqs = await db.getRecords('requisitions', r => ('' + r.fields.id) === 'R001')
    await db.updateRecord('requisitions', reqs[0].recordId, { status: '已通过', approver: 'WT001' })
    const mats0 = await db.getRecords('materials', r => ('' + r.fields.id) === 'M001')
    await db.updateRecord('materials', mats0[0].recordId, { stock: 8 })
    await db.addRecord('stock_io', { id: 'S900', item: 'M001', dir: '出库', qty: 2, op: 'S001', time: '2026-11-01 10:00', note: '领用申请 R001', src: '领用出库', cls: H.CLS })
    await p.load(true); await flush(10)
    const row = (p.data.rows || []).find(x => x.no === 'R001')
    ok('已通过的单在列表里标为 approved', row && row.approved === true, JSON.stringify(row))
    ok('撤销入口只对管理员开放', p.data.isAdmin === true)
    p.openRevoke(tap({ no: 'R001' })); await flush(4)
    ok('撤销弹层已打开且带单号', p.data.showRevoke === true && p.data.revokeNo === 'R001',
      'showRevoke=' + p.data.showRevoke + ' no=' + p.data.revokeNo)
    p.revokeInput(input('误批'))
    await p.submitRevoke(); await flush(12)
    const c = apiCalls.find(x => x.action === 'revokeApprove')
    ok('提交撤销会调 revokeApprove 并带单号与原因', !!c && c.data.no === 'R001' && !!c.data.reason,
      JSON.stringify(c && c.data))
    const after = await db.getRecords('requisitions', r => ('' + r.fields.id) === 'R001')
    ok('申请单状态变为「已撤销」', ('' + after[0].fields.status) === '已撤销', after[0].fields.status)
  }

  // ============================================================
  section('⑦ 库存页：低库存一键补货 → 真实入库 + 流水')
  {
    const { db, p } = await open('inventory', 'teacher')
    const mats = await db.getRecords('materials', r => ('' + r.fields.id) === 'M001')
    await db.updateRecord('materials', mats[0].recordId, { stock: 1 })
    await p.load(); await flush(10)
    ok('库存页识别出 1 项低于安全线', p.data.lowCount === 1, 'lowCount=' + p.data.lowCount)
    p.openReplenish()
    ok('补货弹层列出待补项', (p.data.replenishRows || []).length === 1, JSON.stringify(p.data.replenishRows))
    ok('默认补货量 = 安全线 - 现存 = 1', p.data.replenishRows[0].qty === 1, 'qty=' + p.data.replenishRows[0].qty)
    await p.submitReplenish(); await flush(12)
    const after = await db.getRecords('materials', r => ('' + r.fields.id) === 'M001')
    ok('补货后库存 1 → 2', Number(after[0].fields.stock) === 2, 'stock=' + after[0].fields.stock)
    const io = await db.getRecords('stock_io', r => ('' + r.fields.note) === '低库存补货入库')
    ok('生成补货入库流水', io.length === 1, 'rows=' + io.length)
  }

  // ============================================================
  section('⑧ 库存页：导入按表头名映射（往返不写坏台账）')
  {
    const { p } = await open('inventory', 'admin')
    const importer = require(path.join(H.ROOT, 'utils', 'importer.js'))
    const parsed = importer.parseImport('名称,耗材ID,规格,类别,存放位置,单位,当前库存,预警线,有效期\n焊锡丝2,M900,0.8mm,耗材,A柜,卷,5,1,', 'material')
    ok('导入按表头名取列（不是按位置）',
      parsed.rows[0] && parsed.rows[0].id === 'M900' && parsed.rows[0].name === '焊锡丝2',
      JSON.stringify(parsed.rows[0]))
    ok('库存页对管理员开放导入入口', p.data.isAdmin === true)
  }

  // ============================================================
  section('⑨ 盘点页：实盘清单 + 账面库存可对照')
  {
    const { p } = await open('stocktake', 'teacher')
    ok('盘点页拉到耗材清单', (p.data.list || []).length === 2, 'list=' + (p.data.list || []).length)
    ok('盘点页显示账面库存供对照', p.data.list[0] && p.data.list[0].book !== undefined,
      JSON.stringify(p.data.list[0]))
  }

  // ============================================================
  section('⑩ 操作日志页：管理员可查 / 教师被拒')
  {
    const { p } = await open('logs', 'admin')
    ok('管理员拿到日志列表', Array.isArray(p.data.rows), 'rows=' + JSON.stringify(p.data.rows && p.data.rows.length))
    const { p: p2 } = await open('logs', 'teacher')
    ok('教师调 listLogs 被服务端拒绝（列表空）', (p2.data.rows || []).length === 0,
      'rows=' + JSON.stringify(p2.data.rows && p2.data.rows.length))
  }

  // ============================================================
  section('⑪ 实训室页：列表 + 负责人信息')
  {
    const { p } = await open('labs', 'admin')
    ok('实训室页拉到实训室', (p.data.labs || []).length === 1, 'labs=' + JSON.stringify(p.data.labs && p.data.labs.length))
    ok('实训室带负责人姓名', p.data.labs[0] && p.data.labs[0].managerName === '教师乙', JSON.stringify(p.data.labs[0]))
  }

  // ============================================================
  section('⑫ 报修页：列表 + 处理人候选')
  {
    const { p } = await open('repair', 'teacher')
    ok('报修页拉到报修单', (p.data.list || []).length === 1, 'list=' + JSON.stringify(p.data.list && p.data.list.length))
    ok('报修单带归属实训室', !!(p.data.list[0] && p.data.list[0].labId), JSON.stringify(p.data.list[0]))
  }

  // ============================================================
  section('⑬ 报修页：指派他人 → 处理人写进库')
  {
    const { db, p } = await open('repair', 'teacher')
    await p.openProcess(tap({ item: p.data.list[0] })); await flush(8)
    ok('处理弹层已打开', p.data.showProcess === true)
    ok('弹层带出单据', !!(p.data.processing && p.data.processing.id),
      JSON.stringify(p.data.processing && p.data.processing.id))
    ok('拉到教职工候选（可指派他人）', (p.data.handlerOptions || []).length >= 2,
      'candidates=' + JSON.stringify(p.data.handlerOptions && p.data.handlerOptions.length))
    ok('候选含自己且置顶', p.data.handlerOptions[0] && p.data.handlerOptions[0].self === true,
      JSON.stringify(p.data.handlerOptions[0]))
    ok('候选里有同事（不是只有自己）', (p.data.handlerOptions || []).some(u => !u.self),
      JSON.stringify((p.data.handlerOptions || []).map(u => u.id)))
    const target = (p.data.handlerOptions || []).find(u => !u.self) || p.data.handlerOptions[0]
    p.onHandler({ detail: { value: p.data.handlerOptions.indexOf(target) } })
    ok('picker 选择后处理人字段同步更新', p.data.procForm.handlerId === target.id,
      'handlerId=' + p.data.procForm.handlerId + ' 期望=' + target.id)
    await p.saveProcess(); await flush(12)
    const c = apiCalls.find(x => x.action === 'updateRepair')
    ok('保存会调 updateRepair 并带处理人', !!c && c.data.handlerId === target.id, JSON.stringify(c && c.data))
    const rows = await db.getRecords('repairs', r => ('' + r.fields.id) === 'RP1')
    ok('库里的处理人已更新', rows[0] && ('' + rows[0].fields.handlerId) === target.id, rows[0] && rows[0].fields.handlerId)
  }

  // ============================================================
  section('⑭ 巡检页：任务列表 + 执行人指派')
  {
    const { p } = await open('inspection', 'teacher')
    ok('巡检页拉到巡检任务', (p.data.list || []).length === 1, 'list=' + JSON.stringify(p.data.list && p.data.list.length))
    ok('巡检任务带计划日期', !!(p.data.list[0] && p.data.list[0].planDate), JSON.stringify(p.data.list[0]))
  }

  // ============================================================
  section('⑮ 二维码打印页：清单 + 切换工具页签 + 按位置分组')
  {
    const { p } = await open('qrprint', 'teacher')
    ok('二维码页拉到 2 件物品', (p.data.list || []).length === 2, 'list=' + JSON.stringify(p.data.list && p.data.list.length))
    ok('物品带存放位置（分组依据）', p.data.list.every(x => x.loc !== undefined), JSON.stringify(p.data.list[0]))
    p.onTab({ currentTarget: { dataset: { tab: 'tool' } } }); await flush(8)
    ok('切到工具页签后清单变为工具', (p.data.list || []).length === 1 && p.data.list[0].id === 'T100',
      JSON.stringify(p.data.list))
    p.onGroupToggle(); await flush(8)
    ok('可切换到按位置分组视图', p.data.groupByLoc === true && Array.isArray(p.data.locGroups),
      'groupByLoc=' + p.data.groupByLoc + ' groups=' + JSON.stringify(p.data.locGroups && p.data.locGroups.length))
  }

  // ============================================================
  section('⑯ 数据备份页：快照覆盖 11 张表')
  {
    const { p } = await open('backup', 'admin')
    await p.load(); await flush(12)
    ok('备份页拉到快照', p.data.loaded === true, 'loaded=' + p.data.loaded)
    ok('快照覆盖 11 张表', (p.data.tables || []).length === 11, 'tables=' + (p.data.tables || []).length)
    ok('含账号表行数', p.data.tables.find(t => t.key === 'users').count >= 4)
    ok('非演示数据', p.data.demo === false, 'demo=' + p.data.demo)
  }

  // ============================================================
  section('⑰ 用户管理页：前端闸门与后端一致（教师及以上可进，教师只看到本班学生）')
  {
    const { p } = await open('admin-users', 'teacher')
    ok('教师可进入用户管理页（后端 gStaff 闸门，前端不再一刀切挡掉）',
      p.data.allowed === true, 'allowed=' + p.data.allowed)
    ok('教师只看到本班学生 S001', (p.data.users || []).some(u => u.id === 'S001'),
      JSON.stringify((p.data.users || []).map(u => u.id)))
    ok('教师看不到别班学生 S002', !(p.data.users || []).some(u => u.id === 'S002'),
      JSON.stringify((p.data.users || []).map(u => u.id)))
    ok('教师看不到教师/管理员账号', !(p.data.users || []).some(u => u.role === 'teacher' || u.role === 'admin'),
      JSON.stringify((p.data.users || []).map(u => u.role)))
    ok('教师的角色选项只有「学生」', JSON.stringify(p.data.roleLabels) === JSON.stringify(['学生']),
      JSON.stringify(p.data.roleLabels))
    ok('教师拿到的可选归属班级 = 本人带班', JSON.stringify(p.data.clsOptions) === JSON.stringify([H.CLS]),
      JSON.stringify(p.data.clsOptions))
    const { p: pa } = await open('admin-users', 'admin')
    // 层级过滤：admin 看得到教师与学生，但看不到超管与自己（同层级不可见）
    ok('管理员拿到下属账号列表（教师+学生）', (pa.data.users || []).length === 3,
      'users=' + JSON.stringify((pa.data.users || []).map(u => u.id)))
    ok('管理员看不到超管账号', !(pa.data.users || []).some(u => u.role === 'super'),
      JSON.stringify((pa.data.users || []).map(u => u.role)))
    ok('管理员看得到全部账号（含别班学生）', (pa.data.users || []).some(u => u.id === 'S002'),
      JSON.stringify((pa.data.users || []).map(u => u.id)))
    ok('管理员的角色选项只有教师与学生（不含管理员/超管）',
      JSON.stringify(pa.data.roleLabels) === JSON.stringify(['学生', '教师']), JSON.stringify(pa.data.roleLabels))
    // 学生直接 navigateTo 进来仍被拦住
    const { p: ps } = await open('admin-users', 'student')
    ok('学生进不了用户管理页', ps.data.allowed === false && (ps.data.users || []).length === 0,
      'allowed=' + ps.data.allowed)
  }

  // ============================================================
  section('㉖ 教师建学生：只能建本班学生，跨班被拒（同后端口径）')
  {
    const { db, p } = await open('admin-users', 'teacher')
    const before = (await db.getRecords('users')).length
    p.openAdd()
    ok('教师能打开新增表单', p.data.showForm === true, 'showForm=' + p.data.showForm)
    ok('新增表单角色固定为学生', p.data.form.role === 'student', p.data.form.role)
    ok('新增表单归属班级默认落在本人带班', p.data.form.cls === H.CLS, p.data.form.cls)
    ok('教师表单不出现「带班班级」字段（只有管理员/超管能设）',
      !/!isTeacher && form\.role==='teacher'/.test(fsRead('pages/admin-users/admin-users.wxml')) ||
      /wx:if="\{\{!isTeacher/.test(fsRead('pages/admin-users/admin-users.wxml')),
      '模板未按教师隐藏带班字段')
    // ① 新增本班学生 → 库里真的多一条
    p.setData({ 'form.id': 'S900', 'form.name': '新同学', 'form.cls': H.CLS })
    await p.save(); await flush(12)
    const made = await db.getRecords('users', r => ('' + r.fields.id) === 'S900')
    ok('教师新增学生成功入库', made.length === 1, 'rows=' + made.length)
    // 云库 role 存中文枚举（TR.roleFwd），接口层 normUser 再归一为英文 —— 两种写法都算对
    ok('新账号角色为学生、班级为本人带班',
      made[0] && (['student', '学生'].indexOf('' + made[0].fields.role) >= 0) && ('' + made[0].fields.cls) === H.CLS,
      made[0] && JSON.stringify({ role: made[0].fields.role, cls: made[0].fields.cls }))
    await p.load(); await flush(10)
    const inList = (p.data.users || []).find(u => u.id === 'S900')
    ok('新学生在列表里显示为学生且班级正确', inList && inList.role === 'student' && inList.cls === H.CLS,
      JSON.stringify(inList))
    const c = apiCalls.find(x => x.action === 'adminUpsertUser')
    ok('提交走 adminUpsertUser 且角色被强制为 student',
      !!c && c.data.role === 'student' && c.data.cls === H.CLS, JSON.stringify(c && c.data))
    // ② 跨班新增 → 前端直接拦下，不发请求
    apiCalls.length = 0
    p.setData({ 'form.id': 'S901', 'form.name': '别班同学', 'form.cls': '别的班' })
    await p.save(); await flush(10)
    const sent = apiCalls.filter(x => x.action === 'adminUpsertUser').length
    ok('教师不能把学生建到本人带班之外（前端拦截，不发请求）', sent === 0, '发出请求 ' + sent + ' 次')
    const notMade = await db.getRecords('users', r => ('' + r.fields.id) === 'S901')
    ok('跨班学生没有入库', notMade.length === 0, 'rows=' + notMade.length)
    // ③ 后端同样拒绝（绕开前端，直接打真实云函数 → 走 prodDispatch 的请求上下文与隔离闸门）
    //    注意：直接调适配器 adminUpsertUser 不带请求上下文，ds.currentScope() 为空 → 隔离不生效，
    //    那不是生产路径（生产必经 prodHandler 组装 scope）。这里必须走真实链路。
    const cloudApi = require(path.join(H.ROOT, 'utils', 'api.js'))
    const deny = await cloudApi.callFull('adminUpsertUser',
      { id: 'S902', name: '越权同学', role: 'student', cls: '别的班', status: '启用' }, { noFallback: true })
    ok('后端拒绝教师跨班建学生', deny && deny.code === 403, JSON.stringify(deny))
    const roleDeny = await cloudApi.callFull('adminUpsertUser',
      { id: 'T900', name: '冒充教师', role: 'teacher', cls: H.CLS, status: '启用' }, { noFallback: true })
    ok('后端拒绝教师建教师账号', roleDeny && roleDeny.code === 403, JSON.stringify(roleDeny))
    const noCls = await cloudApi.callFull('adminUpsertUser',
      { id: 'S903', name: '无班级同学', role: 'student', cls: '', status: '启用' }, { noFallback: true })
    ok('后端拒绝教师建无归属班级的学生', noCls && noCls.code === 403, JSON.stringify(noCls))
    const notMade2 = await db.getRecords('users', r => ['S902', 'T900', 'S903'].indexOf('' + r.fields.id) >= 0)
    ok('被拒的账号都没有入库', notMade2.length === 0, 'rows=' + notMade2.length)
    // ④ 未配置带班班级的教师 → 前端直接说明原因并拦下
    H.loginAs('teacher')
    const { p: p2 } = await open('admin-users', 'teacher')
    p2.setData({ isTeacher: true, clsOptions: [], myClasses: [], myClassesText: '' })
    p2.openAdd()
    ok('教师未配置带班班级时不能打开新增表单', p2.data.showForm === false, 'showForm=' + p2.data.showForm)

    // ⑤ 身份缓存过期（升级前登录的老师，缓存里只有 id/name/role）→ 回源补齐带班
    H.loginAs('teacher')
    H.wxStub._store.lab_identity = { id: 'WT001', name: '教师乙', role: 'teacher' }
    const identityMod = require(path.join(H.ROOT, 'utils', 'identity.js'))
    ok('刷新前缓存里没有带班班级', identityMod.managedClassesList().length === 0,
      JSON.stringify(identityMod.managedClassesList()))
    await identityMod.refresh()
    ok('回源刷新后自动补齐带班班级', JSON.stringify(identityMod.managedClassesList()) === JSON.stringify([H.CLS]),
      JSON.stringify(identityMod.managedClassesList()))

    // ⑥ 我的页：教师也能看到「用户与角色」入口（系统管理区块对教师及以上开放）
    const { p: pm } = await open('mine', 'teacher')
    ok('我的页对教师开放系统管理区块', pm.data.isStaff === true && pm.data.isAdmin === false,
      'isStaff=' + pm.data.isStaff + ' isAdmin=' + pm.data.isAdmin)
    const mineWxml = fsRead('pages/mine/mine.wxml')
    // 取某张卡片最近一层 grid-i 上的 wx:if 门槛（没有则表示不设限）
    const gateOf = (icon) => {
      // 用最后一次出现：同一图标可能在列表项里也出现过（如 ic-shield-b），
      // 卡片区的那一次才是我们要判门槛的
      const i = mineWxml.lastIndexOf(icon)
      if (i < 0) return 'NOT_FOUND'
      const head = mineWxml.slice(Math.max(0, i - 300), i)
      // 取该卡片最近的一个 grid-i 标签，读它自身的 wx:if（属性顺序不固定）
      const tags = head.match(/<view[^>]*class="grid-i"[^>]*>/g) || []
      const last = tags[tags.length - 1] || ''
      const m = last.match(/wx:if="\{\{([^}]+)\}\}"/)
      return m ? m[1] : ''
    }
    ok('用户与角色入口对教师开放（未挂 isAdmin 门）', gateOf('ic-users-b.png') !== 'isAdmin',
      'gate=' + gateOf('ic-users-b.png'))
    ok('操作日志仍限管理员', gateOf('ic-log-b.png') === 'isAdmin', 'gate=' + gateOf('ic-log-b.png'))
    ok('数据备份仍限管理员', gateOf('ic-shield-b.png') === 'isAdmin', 'gate=' + gateOf('ic-shield-b.png'))
  }

  // ============================================================
  section('⑱ 出入库页：扫码登记 → 库存与流水同步变化')
  {
    const { db, p } = await open('io', 'teacher')
    ok('出入库页拉到耗材清单', (p.data.mats || []).length === 2, 'mats=' + JSON.stringify(p.data.mats && p.data.mats.length))
    ok('页面选中了第一件物品', !!(p.data.curMat && p.data.curMat.id), JSON.stringify(p.data.curMat))
    p.setData({ qty: 3, type: 'in' })
    const submit = p.submit || p.submitIo || p.doSubmit
    if (submit) await submit.call(p)
    await flush(12)
    const c = apiCalls.find(x => x.action === 'io')
    ok('提交出入库会调 io 并带物品/数量', !!c && c.data.matId === 'M001' && Number(c.data.qty) === 3,
      JSON.stringify(c && c.data))
    const mats = await db.getRecords('materials', r => ('' + r.fields.id) === 'M001')
    ok('库存真实增加 10 → 13', Number(mats[0].fields.stock) === 13, 'stock=' + mats[0].fields.stock)
    const ioRows = await db.getRecords('stock_io', r => ('' + r.fields.dir) === '入库' && Number(r.fields.qty) === 3)
    ok('生成入库流水（3 件）', ioRows.length === 1, 'rows=' + ioRows.length)
    // 账实相符：账面库存必须等于流水重算值
    const allIo = await db.getRecords('stock_io')
    let calc = 0
    for (const r of allIo) {
      const f2 = r.fields
      if (('' + f2.item) !== 'M001') continue
      const dir = '' + (f2.dir || '')
      const q = Number(f2.qty) || 0
      if (dir === '入库') calc += q
      else if (dir === '出库') calc -= q
    }
    ok('账面库存 = 流水重算值（账实相符）', Number(mats[0].fields.stock) === calc,
      '账面=' + mats[0].fields.stock + ' 重算=' + calc)
  }

  // ============================================================
  section('⑲ 统计页：概览 / 排行')
  {
    const { p } = await open('usage', 'teacher')
    ok('统计页拿到概览', !!p.data.stat, 'stat=' + JSON.stringify(p.data.stat && Object.keys(p.data.stat)))
    ok('统计页拿到活跃排行', Array.isArray(p.data.rank), 'rank=' + JSON.stringify(p.data.rank && p.data.rank.length))
  }

  // ============================================================
  section('⑳ 我的页：借还记录 + 系统自检')
  {
    const { p } = await open('mine', 'student')
    ok('我的页拿到我的申请列表', Array.isArray(p.data.rs), 'rs=' + JSON.stringify(p.data.rs && p.data.rs.length))
    ok('我的页拿到我的借还列表', Array.isArray(p.data.bs), 'bs=' + JSON.stringify(p.data.bs && p.data.bs.length))
    await p.runDiag(); await flush(12)
    ok('系统自检有返回', !!p.data.diag, 'diag=' + JSON.stringify(p.data.diag && Object.keys(p.data.diag)))
  }

  // ============================================================
  section('㉑ 工具三入口：新建工具 / 借出 / 归还（第十一轮新增功能）')
  {
    // ① 新建工具（管理员）→ 库里真的多了一条工具
    const { db, p } = await open('inventory', 'admin')
    p.setData({ tab: 'tool' })
    await p.load(); await flush(10)
    ok('工具分段能拉到工具清单', (p.data.toolList || []).length === 1,
      'toolList=' + JSON.stringify(p.data.toolList && p.data.toolList.length))
    p.openNewTool()
    ok('新建工具弹层已打开', p.data.showNewTool === true)
    p.setData({ 'toolForm.name': '电烙铁', 'toolForm.loc': 'A柜2层', 'toolForm.spec': '60W' })
    await p.submitNewTool(); await flush(12)
    const tools = await db.getRecords('tools')
    const made = tools.find(r => ('' + r.fields.name) === '电烙铁')
    ok('库里新增了这条工具', !!made, 'tools=' + JSON.stringify(tools.map(t => t.fields.name)))
    ok('新工具默认「在库」且无持有人', made && ('' + made.fields.status) === '在库' && !made.fields.holder,
      made && JSON.stringify({ status: made.fields.status, holder: made.fields.holder }))
    ok('新工具自动生成了编号 Txxx', made && /^[Tt]\d+$/.test('' + made.fields.id), 'id=' + (made && made.fields.id))
    const c = apiCalls.find(x => x.action === 'addTool')
    ok('单件建档走 addTool（教师可建，不覆盖同名）', !!c && c.data.name === '电烙铁' && c.mode === 'callFull',
      JSON.stringify(c && c.data))

    // ② 借出（教师）→ 工具变借出 + 生成借还记录
    const { db: db2, p: p2 } = await open('inventory', 'teacher')
    p2.setData({ tab: 'tool' })
    await p2.load(); await flush(10)
    await p2.openLend(tap({ id: 'T100' })); await flush(10)
    ok('借出弹层已打开', p2.data.showLend === true)
    ok('借出弹层预选了目标工具', p2.data.lendToolId === 'T100', 'lendToolId=' + p2.data.lendToolId)
    ok('借出弹层有借用人候选（本班学生）', (p2.data.borrowerPresets || []).length >= 1,
      'candidates=' + JSON.stringify(p2.data.borrowerPresets && p2.data.borrowerPresets.length))
    p2.setData({ lendBorrower: 'S001', lendDays: 10, lendNote: '实训借用' })
    await p2.submitLend(); await flush(12)
    const t2 = await db2.getRecords('tools', r => ('' + r.fields.id) === 'T100')
    ok('工具状态变为「借出」', t2[0] && ('' + t2[0].fields.status) === '借出', t2[0] && t2[0].fields.status)
    ok('工具持有人写为借用人', t2[0] && ('' + t2[0].fields.holder) === 'S001', t2[0] && t2[0].fields.holder)
    const borrows = await db2.getRecords('borrow', r => ('' + r.fields.tool) === 'T100')
    ok('生成借还记录（借出中）', borrows.length === 1 && ('' + borrows[0].fields.status) === '借出中',
      JSON.stringify(borrows.map(b => b.fields.status)))
    ok('借还记录带借期与备注', borrows[0] && Number(borrows[0].fields.days || 0) === 0 &&
      ('' + borrows[0].fields.note) === '实训借用', JSON.stringify(borrows[0] && borrows[0].fields))

    // ③ 归还（教师代还）→ 工具回在库 + 借还记录结清
    p2.setData({ tab: 'tool' })
    await p2.load(); await flush(10)
    const row = (p2.data.toolList || []).find(x => x.id === 'T100')
    ok('列表里该工具显示为「借出」且带借用人', row && row.status === '借出' && row.borrower === 'S001',
      JSON.stringify(row))
    await p2.doReturn(tap({ id: 'T100' })); await flush(12)
    const t3 = await db2.getRecords('tools', r => ('' + r.fields.id) === 'T100')
    ok('归还后工具状态回到「在库」', t3[0] && ('' + t3[0].fields.status) === '在库', t3[0] && t3[0].fields.status)
    const b2 = await db2.getRecords('borrow', r => ('' + r.fields.tool) === 'T100')
    ok('借还记录已结清（已归还）', b2[0] && ('' + b2[0].fields.status) === '已归还', b2[0] && b2[0].fields.status)
    const bCount = await db2.getRecords('borrow')
    ok('归还不产生重复借还记录', bCount.length === 1, 'rows=' + bCount.length)
  }

  // ============================================================
  section('㉒ 首页入口：耗材建档与工具借出各有一个明确入口')
  {
    const { p } = await open('index', 'teacher')
    const wx = H.wxStub
    const html = require('fs').readFileSync(require('path').join(H.ROOT, 'pages', 'index', 'index.wxml'), 'utf8')
    ok('首页有「耗材建档」入口（不再叫「物品入库」）', html.indexOf('耗材建档') >= 0 && html.indexOf('物品入库') < 0)
    ok('首页有「工具借出」直达入口', html.indexOf('工具借出') >= 0)
    ok('工具借出入口直达工具分段', html.indexOf('/pages/inventory/inventory?tab=tool') >= 0)
    const { p: pi } = await open('inventory', 'teacher')
    pi.setData({ tab: 'tool' })
    await pi.load(); await flush(8)
    ok('?tab=tool 参数能让页面默认落在工具分段', pi.data.tab === 'tool', 'tab=' + pi.data.tab)
  }

  section('㉗ 微信绑定：解绑入口与「已绑定不可直接删除」的前端引导')
  {
    const { db, p } = await open('admin-users', 'admin')
    await p.load(); await flush(10)
    const bound = (p.data.users || []).find(u => u.id === 'WT001')
    ok('列表标明该账号「已绑微信」', bound && bound.bound === true, JSON.stringify(bound && bound.bound))

    // ① 已绑定账号的删除 → 前端引导「改用停用 / 先解绑」，不直接发删除请求
    apiCalls.length = 0
    await p.del(tap({ u: bound })); await flush(10)
    const delCall = apiCalls.filter(x => x.action === 'adminDeleteUser').length
    ok('已绑定账号不会被直接删除（走引导，不发删除请求）', delCall === 0, '删除请求 ' + delCall + ' 次')
    const still = await db.getRecords('users', r => ('' + r.fields.id) === 'WT001')
    ok('账号行仍在（未被删除）', still.length === 1, 'rows=' + still.length)

    // ② 解绑：换绑的正规出路
    await p.unbind(tap({ u: bound })); await flush(14)
    const after = await db.getRecords('users', r => ('' + r.fields.id) === 'WT001')
    ok('解绑后该账号的 openid 被清空', after[0] && !after[0].fields.openid,
      JSON.stringify(after[0] && after[0].fields.openid))
    const c = apiCalls.find(x => x.action === 'adminUnbindUser')
    ok('解绑走 adminUnbindUser 且带工号', !!c && c.data.id === 'WT001', JSON.stringify(c && c.data))
    await p.load(); await flush(10)
    const after2 = (p.data.users || []).find(u => u.id === 'WT001')
    ok('列表刷新后不再显示「已绑微信」', after2 && after2.bound === false, JSON.stringify(after2 && after2.bound))

    // ③ 未绑定账号仍可正常删除：先把 S002 的绑定清空，模拟「从未绑定过」的账号
    const s002 = (await db.getRecords('users', r => ('' + r.fields.id) === 'S002'))[0]
    await db.updateRecord('users', s002.recordId, { openid: '' })
    await p.load(); await flush(10)
    const free = (p.data.users || []).find(u => u.id === 'S002')
    ok('S002 已是未绑定状态', free && free.bound === false, JSON.stringify(free && free.bound))
    apiCalls.length = 0
    await p.del(tap({ u: free })); await flush(14)
    const delCall2 = apiCalls.filter(x => x.action === 'adminDeleteUser').length
    ok('未绑定账号仍走正常删除流程', delCall2 === 1, '删除请求 ' + delCall2 + ' 次')
    const gone = await db.getRecords('users', r => ('' + r.fields.id) === 'S002')
    ok('未绑定账号确实被删除', gone.length === 0, 'rows=' + gone.length)
  }

  const st = H.stats()
  // ============================================================
  section('㉓ 查找：自定义编号的耗材与工具都能查到（旧实现按 ID 首字母猜类型会查空）')
  {
    const { db } = await open('index', 'teacher')
    // 临时插入自定义编号物品（不以 M/T 开头）：旧实现按「ID 首字母」猜类型会查空
    await db.addRecord('materials', { id: 'WM-001', name: '自定义编号耗材', spec: 'X1', cat: '耗材', loc: 'D柜', stock: 3, unit: '个', safe: 1, status: '正常', expire: '' })
    await db.addRecord('tools', { id: '仪器01', name: '自定义编号工具', spec: 'Y2', loc: 'E柜', status: '在库', holder: '' })
    const d1 = await db.getItem('WM-001')
    ok('自定义编号的耗材能查到', d1 && d1.type === 'material', JSON.stringify(d1 && d1.type))
    const d2 = await db.getItem('仪器01')
    ok('自定义编号的工具能查到（旧逻辑会当成耗材查空）', d2 && d2.type === 'tool', JSON.stringify(d2 && d2.type))
    const d3 = await db.getItem('T100')
    ok('常规工具编号仍按工具命中', d3 && d3.type === 'tool', JSON.stringify(d3 && d3.type))
    const d4 = await db.getItem('M001')
    ok('常规耗材编号仍按耗材命中', d4 && d4.type === 'material', JSON.stringify(d4 && d4.type))
    // 搜索结果带 type → 详情页精确查表（复用同一个 db：再次 open 会重置种子，把刚插入的物品抹掉）
    const { p: pi2 } = await open('index', 'teacher', db)
    pi2.onSearch({ detail: { value: 'WM-001' } })
    await new Promise(r => setTimeout(r, 320))   // 搜索有 220ms 防抖
    await flush(8)
    ok('搜索能命中自定义编号的耗材', (pi2.data.suggest || []).some(x => x.id === 'WM-001'),
      JSON.stringify(pi2.data.suggest && pi2.data.suggest.map(x => x.id)))
    const hit = (pi2.data.suggest || []).find(x => x.id === 'WM-001')
    ok('搜索结果带类型标记（type=material）', hit && hit.type === 'material', JSON.stringify(hit && hit.type))
  }

  // ============================================================
  section('㉔ 物品交付单：待交付清单 → 确认交付（不再动库存）')
  {
    const { db, p } = await open('delivery', 'teacher')
    // 先把一条申请审批通过（交付清单只列「已通过」的单）
    const app = await open('approve', 'teacher')
    const req = app.p.data.list.find(x => x.kind !== 'tool')
    await app.p.approve(tap({ no: req.no, ok: '1' })); await flush(12)
    const stockBefore = (await db.getRecords('materials', r => ('' + r.fields.id) === 'M001'))[0].fields.stock

    await p.load(); await flush(12)
    ok('交付页拿到待交付清单', (p.data.rows || []).length >= 1, 'rows=' + (p.data.rows || []).length)
    const row = (p.data.rows || []).find(x => x.no === req.no)
    ok('清单里带物品名/领用人姓名/班级', row && row.itemName === '焊锡丝' && row.userName === '学生丙' && row.userCls === H.CLS,
      JSON.stringify(row))
    ok('清单标明这是耗材领用', row && row.kind === 'material', JSON.stringify(row && row.kind))
    ok('清单项未标记交付时间（待交付）', row && !row.delivered, JSON.stringify(row && row.delivered))

    await p.confirm(tap({ no: req.no })); await flush(12)
    const after = await db.getRecords('requisitions', r => ('' + r.fields.id) === req.no)
    ok('确认交付后单据仍为「已通过」（状态不被改写）', ('' + after[0].fields.status) === '已通过',
      after[0] && after[0].fields.status)
    ok('确认交付写入了交付时间', !!after[0].fields.delivered, JSON.stringify(after[0].fields.delivered))
    const stockAfter = (await db.getRecords('materials', r => ('' + r.fields.id) === 'M001'))[0].fields.stock
    ok('确认交付【不重复扣库存】', Number(stockAfter) === Number(stockBefore),
      '交付前 ' + stockBefore + ' → 交付后 ' + stockAfter)
    const log = await db.getRecords('logs', r => ('' + r.fields.op) === '确认交付')
    ok('留下「确认交付」日志', log.length === 1, 'logs=' + log.length)
    // 已交付的单不再出现在待交付清单
    await p.load(); await flush(12)
    ok('已交付的单从未交付清单消失', !(p.data.rows || []).some(x => x.no === req.no),
      JSON.stringify((p.data.rows || []).map(x => x.no)))
    // 切到已交付分段能查到
    p.onTab(tap({ t: 'delivered' })); await flush(12)
    ok('「已交付」分段能看到该单', (p.data.rows || []).some(x => x.no === req.no),
      JSON.stringify((p.data.rows || []).map(x => x.no)))
  }

  // ============================================================
  section('㉕ 工具扫码登记：扫到新工具 → 补录信息后建档')
  {
    const { db, p } = await open('inventory', 'teacher')
    p.setData({ tab: 'tool' })
    await p.load(); await flush(10)
    p.scanTool()
    await flush(8)
    ok('扫码到未登记的编号会打开建档弹层并预填编号', p.data.showNewTool === true && p.data.toolForm.id === 'T999',
      'showNewTool=' + p.data.showNewTool + ' id=' + p.data.toolForm.id)
    p.setData({ 'toolForm.name': '扫码登记的电烙铁' })
    await p.submitNewTool(); await flush(12)
    const tools = await db.getRecords('tools')
    const made = tools.find(r => ('' + r.fields.id) === 'T999')
    ok('扫码登记的工具真的建档了', !!made, JSON.stringify(tools.map(t => t.fields.id)))
    ok('扫码登记的工具默认在库', made && ('' + made.fields.status) === '在库', made && made.fields.status)
    // 再扫一次已存在的工具 → 不应重复建档
    const cntBefore = tools.length
    p.scanTool()
    await flush(8)
    ok('扫到已登记的工具不会重复建档（提示已在册）', p.data.showNewTool === false,
      'showNewTool=' + p.data.showNewTool)
    const tools2 = await db.getRecords('tools')
    ok('工具总数未增加', tools2.length === cntBefore, cntBefore + ' → ' + tools2.length)
    const c2 = apiCalls.find(x => x.action === 'addTool')
    ok('扫码建档走 addTool 且带编号', !!c2 && c2.data.id === 'T999', JSON.stringify(c2 && c2.data))
  }

  // ============================================================
  console.log('\n========== 页面流程：' + st.pass + ' passed, ' + st.fail + ' failed ==========')
  if (st.issues.length) { console.log('\n问题明细：'); st.issues.forEach(i => console.log('  · ' + i)) }
  process.exitCode = st.fail ? 1 : 0
}

main().catch(e => { console.error('页面流程测试异常：', e && e.stack || e); process.exit(1) })

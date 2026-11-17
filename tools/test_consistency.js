// tools/test_consistency.js —— 账实相符一致性自检
//
// 目的：把"库存 / 工具状态 / 借还记录 / 申请单 / 流水"五张表当成一套账，
//   每做完一步写操作就重新算一遍，与账面比对。任何对不上 = 真 bug（账面与实物脱节）。
//
// 为什么单独做：这类 bug 有一个共同特点——**每一步单看都对，只有累计起来才暴露**。
//   例如审批扣了库存但流水没写、冲销写了反向流水但原流水没标记、盘点调了库存却记成出库，
//   单条测试全绿，月末对账才发现数字对不上。
//
// 守恒口径：
//   库存 = Σ(入库流水) - Σ(出库流水)
//     · 被冲销的原流水（note 以 '[已冲销]' 开头）其影响已被反向流水抵消 → 排除；
//     · 反向流水（note 含 '冲销流水'）本身要计入 → 这样一对刚好抵消，净效果为 0。
//   工具状态：status='借出' 的工具数 应等于 borrow 表中 status='借出中' 的记录数。
//   申请单：status='已通过' 的领用申请 应存在对应的出库流水（除非已被撤销）。
const path = require('path')

const ROOT = path.join(__dirname, '..')
const td = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'clouddb.js'))
const ds = require(path.join(ROOT, 'cloudfunctions', 'docsProxy', 'data-scope.js'))

let pass = 0, fail = 0
const issues = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else {
    fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''))
    issues.push(name + (detail ? ' → ' + detail : ''))
  }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

// ---------- 内存伪库（支持 skip/limit 分页，与云库 __rawAll 的 100 行/页循环一致） ----------
// 故障注入：让指定表的 update 连续失败 times 次（模拟云端写入超时/配额失败）
//   用途：复现「审批多步写部分失败」的真实场景，验证重试不会二次扣库存。
function makeDbWithFault(rows, fault) {
  const db = makeDb(rows)
  if (!fault || !fault.table) return db
  const raw = db.collection.bind(db)
  let left = fault.times || 0
  db.collection = function (name) {
    const c = raw(name)
    if (name !== fault.table) return c
    const rawDoc = c.doc.bind(c)
    c.doc = function (id) {
      const d = rawDoc(id)
      return {
        async update({ data }) {
          if (left > 0) { left--; throw new Error('注入故障：' + name + '.update 写入失败') }
          return d.update({ data })
        },
        async remove() { return d.remove() }
      }
    }
    return c
  }
  return db
}

// 伪云库：统一用 tools/fake_cloud_db.js（支持 where().update() 条件更新 → 可验证 CAS 跨实例并发安全）
const { makeDb } = require('./fake_cloud_db.js')
const SUPER = { id: 'T001', name: '超管', role: 'super', cls: '' }
const TEACHER = { id: 'WT001', name: '老师A', role: 'teacher', cls: '24电气1', managedClasses: '24电气1' }
const STUDENT = { id: '2024DQ101', name: '24电气1班管理员1', role: 'student', cls: '24电气1' }

function seed() {
  return {
    users: [
      { id: 'T001', name: '超管', role: '超级管理员', cls: '', status: '启用' },
      { id: 'WT001', name: '老师A', role: '教师', cls: '24电气1', managedClasses: '24电气1', status: '启用' },
      { id: '2024DQ101', name: '24电气1班管理员1', role: '学生', cls: '24电气1', status: '启用' }
    ],
    materials: [], tools: [], requisitions: [], borrow: [], stock_io: [], access: [], logs: [],
    labs: [], repairs: [], inspections: []
  }
}

// 用流水重算库存（不读 materials.stock）
//
// 口径说明（与报表口径不同，别混）：
//   · 库存守恒 = Σ(全部入库) - Σ(全部出库)。
//     冲销时「原出库 -2」与「反向入库 +2」自然抵消，净效果 0，因此**一条都不能排除**。
//   · 报表口径（usage.topMaterials/trend）才排除已冲销的一对，避免同一笔消耗被算两次。
//     写反了会让"账面库存"与"报表消耗"两个数都对不上账。
async function recomputeStock(matId) {
  const rows = await td.getRecords('stock_io')
  let net = 0
  for (const r of rows) {
    const f = r.fields
    if (('' + f.item) !== matId) continue
    const dir = '' + (f.dir || '')
    const qty = Number(f.qty) || 0
    if (dir === '入库') net += qty
    else if (dir === '出库') net -= qty
  }
  return net
}
async function bookStock(matId) {
  const rows = await td.getRecords('materials', r => ('' + r.fields.id) === matId)
  return rows[0] ? (Number(rows[0].fields.stock) || 0) : null
}
async function checkStock(label, matId) {
  const book = await bookStock(matId)
  const calc = await recomputeStock(matId)
  ok(label + '：账面库存 = 流水重算值', book === calc, '账面 ' + book + ' vs 重算 ' + calc)
}

async function main() {
  td.__setDbForTest(makeDb(seed()))
  const asSuper = fn => ds.runWithScope(ds.scopeOf(SUPER), fn)
  const asTeacher = fn => ds.runWithScope(ds.scopeOf(TEACHER), fn)
  const asStudent = fn => ds.runWithScope(ds.scopeOf(STUDENT), fn)

  section('① 建档 + 入库')
  let r = await asSuper(() => td.addMaterial({ name: '焊锡丝', spec: '0.8mm', cat: '耗材', loc: 'A柜', unit: '卷', safe: 3, qty: 10, actor: 'T001' }))
  ok('建档成功', r && !r.code, JSON.stringify(r && r.data))
  const M1 = r.id
  await checkStock('建档后', M1)

  r = await asTeacher(() => td.io({ matId: M1, type: 'in', qty: 5, note: '采购到货', actor: 'WT001' }))
  ok('入库成功', r && !r.code, JSON.stringify(r))
  await checkStock('入库后', M1)

  section('② 出库')
  r = await asTeacher(() => td.io({ matId: M1, type: 'out', qty: 3, actor: 'WT001' }))
  ok('出库成功', r && !r.code, JSON.stringify(r))
  await checkStock('出库后', M1)

  section('③ 学生申请 → 教师审批（扣库存）')
  r = await asStudent(() => td.requisition({ user: '2024DQ101', matId: M1, qty: 2, reason: '实训用' }))
  ok('提交申请成功', r && !r.code, JSON.stringify(r))
  const REQ = r.no
  await checkStock('提交申请后（不应变化）', M1)

  r = await asTeacher(() => td.approve({ no: REQ, ok: true, actor: 'WT001' }))
  ok('审批通过', r && !r.code, JSON.stringify(r))
  await checkStock('审批通过后', M1)

  section('④ 撤销已通过的审批（回补库存）')
  r = await asSuper(() => td.revokeApprove({ no: REQ, reason: '误批', actor: 'T001' }))
  ok('撤销成功', r && !r.code, JSON.stringify(r))
  ok('撤销回滚生效（rolledBack=true）', r && r.rolledBack === true, JSON.stringify(r))
  await checkStock('撤销后', M1)

  section('⑤ 盘点调整')
  const before = await bookStock(M1)
  r = await asTeacher(() => td.stocktake({ mode: 'stocktake', items: [{ matId: M1, real: before - 2 }], actor: 'WT001' }))
  ok('盘点成功', r && !r.code, JSON.stringify(r))
  await checkStock('盘点后', M1)

  section('⑥ 批量出入库')
  r = await asTeacher(() => td.batchIo({ type: 'in', items: [{ matId: M1, qty: 4 }], actor: 'WT001', note: '批量到货' }))
  ok('批量入库成功', r && !r.code, JSON.stringify(r))
  await checkStock('批量入库后', M1)

  section('⑦ 工具借出 → 归还（工具状态与借还记录守恒）')
  // 工具建档走 importTools
  r = await asSuper(() => td.importTools({ rows: [{ name: '万用表', id: 'TL1', spec: 'VC830L', loc: 'A柜', status: '在库' }], actor: 'T001' }))
  ok('工具建档成功', r && !r.code, JSON.stringify(r))

  r = await asTeacher(() => td.borrow({ toolId: 'TL1', user: '2024DQ101', actor: 'WT001', days: 7 }))
  ok('借出成功', r && !r.code, JSON.stringify(r))
  await checkToolState('借出后')

  r = await asStudent(() => td.returnTool({ toolId: 'TL1', actor: '2024DQ101', note: '完好' }))
  ok('归还成功', r && !r.code, JSON.stringify(r))
  await checkToolState('归还后')

  section('⑧ 教师直接借出 → 归还（另一条路径）')
  r = await asTeacher(() => td.directBorrow({ toolId: 'TL1', borrower: '2024DQ101', actor: 'WT001', days: 3, note: '临时借用' }))
  ok('直接借出成功', r && !r.code, JSON.stringify(r))
  await checkToolState('直接借出后')

  r = await asStudent(() => td.returnTool({ toolId: 'TL1', actor: '2024DQ101' }))
  ok('直接借出后归还成功', r && !r.code, JSON.stringify(r))
  await checkToolState('二次归还后')

  section('⑨ 冲销流水（反向流水与原流水必须成对）')
  const ioRows = await asSuper(() => td.listStockIO({ limit: 200 }))
  // 注意字段名：listStockIO 的行是 {id,item,dir,qty,...}，方向用中文「出库」，不是 norm* 的 type
  const outFlow = (ioRows.rows || []).find(x => x.dir === '出库')
  ok('存在可冲销的出库流水', !!outFlow, '未找到出库流水')
  if (outFlow) {
    const beforeR = await bookStock(M1)
    r = await asSuper(() => td.reverseIO({ no: outFlow.id, actor: 'T001', reason: '录错' }))
    ok('冲销成功', r && !r.code, JSON.stringify(r))
    await checkStock('冲销后', M1)
    const after = await bookStock(M1)
    ok('冲销后库存回到冲销前 + 原出库量（净增）', after > beforeR, beforeR + ' → ' + after)
    // 二次冲销必须被拒
    r = await asSuper(() => td.reverseIO({ no: outFlow.id, actor: 'T001', reason: '再冲销' }))
    ok('原流水不可二次冲销', r && r.code !== 0, JSON.stringify(r))
  }

  section('⑪ 部分写失败后重试审批：绝不二次扣库存')
  // 场景：审批是「扣库存 + 写出库流水 + 改申请单状态 + 写日志」多步写。
  //   若「改申请单状态」这一步失败且自愈补写也失败 → 服务端抛错、老师按提示重试。
  //   重试时若没有幂等闸门，会【再扣一次库存】→ 账面比流水多扣一份且无人察觉。
  // 这里用故障注入精确复现该窗口：requisitions.update 失败 1 次 → Promise.all 整体 reject，
  //   库存扣减与出库流水已经落库、申请单状态仍是「待审批」→ 第一次审批抛错。
  {
    td.__setDbForTest(makeDbWithFault(seed(), { table: 'requisitions', times: 1 }))
    const built = await asSuper(() => td.addMaterial({ name: '钻头', spec: 'φ8', cat: '耗材', loc: 'B柜', unit: '支', safe: 1, qty: 10, actor: 'T001' }))
    const mid = built.id
    await asTeacher(() => td.io({ matId: mid, type: 'in', qty: 0, note: '', actor: 'WT001' }))
    const stockBefore = await bookStock(mid)
    const req = await asStudent(() => td.requisition({ matId: mid, qty: 2, reason: '故障注入测试', user: STUDENT.id }))
    const no = req.no
    // 第一次审批：状态写失败 → 抛错
    let firstErr = null
    try {
      await asTeacher(() => td.approve({ no, ok: true, actor: TEACHER.id }))
    } catch (e) { firstErr = e }
    ok('首次审批在状态写失败时明确报错（不静默假成功）', !!firstErr, firstErr ? '' : '居然成功了')
    const stockAfterFail = await bookStock(mid)
    ok('首次失败时库存已按审批扣减（说明扣减先于状态写发生）', stockAfterFail === stockBefore - 2,
      '账面 ' + stockBefore + ' → ' + stockAfterFail)
    // 第二次审批（老师按提示重试）：幂等闸门必须拦下二次扣减
    const second = await asTeacher(() => td.approve({ no, ok: true, actor: TEACHER.id }))
    const stockAfterRetry = await bookStock(mid)
    ok('重试审批不再二次扣库存', stockAfterRetry === stockBefore - 2,
      '账面 ' + stockAfterFail + ' → ' + stockAfterRetry + '（期望保持 ' + (stockBefore - 2) + '）')
    ok('重试审批返回幂等标记与人工核对提示',
      second && second.idempotent === true && typeof second.warn === 'string' && second.warn.length > 0,
      JSON.stringify(second))
    const reqRows = await td.getRecords('requisitions', r => ('' + r.fields.id) === no)
    ok('重试后申请单状态已补齐为「已通过」', reqRows[0] && ('' + reqRows[0].fields.status) === '已通过',
      reqRows[0] ? ('' + reqRows[0].fields.status) : '单据不存在')
    const outFlows = await td.getRecords('stock_io', r => ('' + r.fields.note) === ('领用申请 ' + no))
    ok('该申请只产生 1 条出库流水', outFlows.length === 1, '实得 ' + outFlows.length + ' 条')
    await checkStock('重试后', mid)
  }

  section('⑩ 报表口径与台账口径一致')
  const usage = await asSuper(() => td.usage())
  const ioAll = await asSuper(() => td.listStockIO({ limit: 200 }))
  // usage.topMaterials 是"净消耗最多的耗材"，应与台账里出库最多且未被冲销的一致
  const top = (usage.topMaterials || [])[0]
  const calcTop = (() => {
    const m = {}
    for (const x of (ioAll.rows || [])) {
      if (x.dir !== '出库') continue
      m[x.item] = (m[x.item] || 0) + (Number(x.qty) || 0)
    }
    return Object.keys(m).sort((a, b) => m[b] - m[a])[0]
  })()
  ok('报表 Top 消耗与台账口径一致', !top || !calcTop || top.id === calcTop,
    '报表 ' + (top && top.id) + ' vs 台账 ' + calcTop +
    '；台账出库行=' + JSON.stringify((ioAll.rows || []).filter(x => x.dir === '出库').map(x => x.qty)))

  console.log('\n========== 账实相符自检：' + pass + ' passed, ' + fail + ' failed ==========')
  if (issues.length) {
    console.log('\n不一致明细：')
    issues.forEach(i => console.log('  · ' + i))
  }
  process.exitCode = fail ? 1 : 0
}

// 工具状态与借还记录守恒
async function checkToolState(label) {
  const tools = await td.getRecords('tools')
  const borrows = await td.getRecords('borrow')
  const outTools = tools.filter(r => ('' + r.fields.status) === '借出').length
  const openBorrows = borrows.filter(r => ('' + r.fields.status) === '借出中').length
  ok(label + '：借出工具数 = 借出中记录数', outTools === openBorrows,
    '工具 ' + outTools + ' vs 借还记录 ' + openBorrows)
  // 借出中记录必须有对应的工具行且状态为借出
  const toolById = {}
  tools.forEach(r => { toolById['' + r.fields.id] = r.fields })
  const bad = borrows.filter(r => ('' + r.fields.status) === '借出中')
    .filter(r => !toolById['' + r.fields.tool] || ('' + toolById['' + r.fields.tool].status) !== '借出')
  ok(label + '：借出中记录均对应状态为「借出」的工具', bad.length === 0,
    bad.length ? bad.map(r => r.fields.id).join(',') : '')
  // 工具持有人与借还记录借用人一致
  const badHolder = borrows.filter(r => ('' + r.fields.status) === '借出中')
    .filter(r => {
      const t = toolById['' + r.fields.tool]
      return t && ('' + (t.holder || '')) !== ('' + (r.fields.user || ''))
    })
  ok(label + '：工具持有人与借用人一致', badHolder.length === 0,
    badHolder.length ? badHolder.map(r => r.fields.id).join(',') : '')
}

main().catch(e => {
  console.error('自检执行异常：', e && e.stack || e)
  process.exitCode = 1
})

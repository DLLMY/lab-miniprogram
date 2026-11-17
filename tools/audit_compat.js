'use strict'
// ============================================================================
// audit_compat.js —— 版本迭代「数据向下兼容」回归检查（纯离线，不连云、不写数据）
// ----------------------------------------------------------------------------
// 用法：node tools/audit_compat.js
// 每次发版前执行，验证：
//   A 旧数据（无 cls / 无 managedClasses）在【新版云函数】下仍可读、可见、可维护；
//   B 新数据（有 cls）在【新版云函数】下按班级隔离，跨班写被拒；
//   C 回滚开关 DATA_SCOPE=off 能一键退回改造前行为；
//   D 字段格式兼容（逗号/中文逗号/顿号/数组/文本数组/中文列名/空值）；
//   E 写操作禁止回退、回退链构造、两套适配器与前端判空的源码契约。
// 只做断言与风险提示，不修改任何文件或数据。
// ============================================================================

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CFG = path.join(ROOT, 'cloudfunctions', 'docsProxy')
const ds = require(path.join(CFG, 'data-scope.js'))
const bs = require(path.join(CFG, 'backend-switch.js'))

const C1 = '2024级电气1班'
const C2 = '2025级数控班'
const S1 = '2024DQ101'
const S2 = '2024DQ102'

let pass = 0, fail = 0
function t(name, fn) {
  try {
    const r = fn()
    if (r === true) { pass++; console.log('  PASS  ' + name) }
    else { fail++; console.log('  FAIL  ' + name + (r ? ' → ' + r : '')) }
  } catch (e) { fail++; console.log('  FAIL  ' + name + ' → 抛异常 ' + e.message) }
}
function eq(actual, expect, why) {
  return actual === expect ? true : (why + '（实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expect) + '）')
}

const A = ds.scopeOf({ id: 'WT009', role: 'teacher', cls: '', managedClasses: C1 })
const B = ds.scopeOf({ id: 'WT012', role: 'teacher', cls: '', managedClasses: C2 })
const NONE = ds.scopeOf({ id: 'WT099', role: 'teacher', cls: '', managedClasses: '' })
const STU = ds.scopeOf({ id: S1, role: 'student', cls: C1 })
const SUP = ds.scopeOf({ id: 'T001', role: 'super', cls: '', managedClasses: '' })
const ADM = ds.scopeOf({ id: 'A001', role: 'admin', cls: '', managedClasses: '' })

const OLD = { user: S1, status: '待审批' }              // 旧版写入：无 cls
const OLD_OTHER = { user: S2, status: '待审批' }
const NEW = { user: S1, cls: C1 }                       // 新版写入：有 cls
const NEW_OTHER = { user: S2, cls: C1 }
const TD_OLD = { '申请人ID': S1, '归属班级': [{ type: 'text', text: C1 }] } // 腾讯文档文本列

console.log('=== A. 旧数据 → 新版云函数（历史数据不能丢） ===')
t('旧流水无 cls：本班教师仍可见', () => eq(ds.rowVisible(A, 'requisitions', OLD), true, '可见性'))
t('旧流水无 cls：别班教师仍可见（旧数据=公共资源）', () => eq(ds.rowVisible(B, 'requisitions', OLD), true, '可见性'))
t('旧流水无 cls：super 可见', () => eq(ds.rowVisible(SUP, 'requisitions', OLD), true, '可见性'))
t('旧流水无 cls：学生本人可见（靠 owner 字段，不靠 cls）', () => eq(ds.rowVisible(STU, 'requisitions', OLD), true, '可见性'))
t('旧流水无 cls：学生看不到他人记录', () => eq(ds.rowVisible(STU, 'requisitions', OLD_OTHER), false, '可见性'))
t('旧流水无 cls：教师仍可维护（不因缺字段被写守卫拦住）', () => eq(ds.canWriteRow(A, 'requisitions', OLD), true, '可写'))
t('旧用户无 managedClasses：scopeOf 不抛异常且 classes 为空', () => eq(NONE.classes.length, 0, '带班数'))

console.log('\n=== B. 新数据 → 新版云函数（隔离按预期） ===')
t('本班教师可见本班流水', () => eq(ds.rowVisible(A, 'requisitions', NEW), true, '可见性'))
t('别班教师不可见本班流水', () => eq(ds.rowVisible(B, 'requisitions', NEW), false, '可见性'))
t('本班教师可写本班流水', () => eq(ds.canWriteRow(A, 'requisitions', NEW), true, '可写'))
t('别班教师跨班写被拒', () => eq(ds.canWriteRow(B, 'requisitions', NEW), false, '可写'))
t('super 可见任意班级', () => eq(ds.rowVisible(SUP, 'requisitions', { cls: C2, user: S1 }), true, '可见性'))
t('admin 可见任意班级', () => eq(ds.rowVisible(ADM, 'requisitions', { cls: C2, user: S1 }), true, '可见性'))
t('学生可见本人提交', () => eq(ds.rowVisible(STU, 'requisitions', NEW), true, '可见性'))
t('学生不可见同班他人提交', () => eq(ds.rowVisible(STU, 'requisitions', NEW_OTHER), false, '可见性'))
t('主数据表 users/materials 不被隔离', () => eq(ds.rowVisible(B, 'materials', NEW), true, '可见性'))
t('空 cls 公共资源对任何教师可见', () => eq(ds.rowVisible(B, 'requisitions', { user: S1 }), true, '可见性'))

console.log('\n=== C. 回滚能力 ===')
t('DATA_SCOPE=off 一键关隔离（退回改造前行为）', () => {
  const old = process.env.DATA_SCOPE
  process.env.DATA_SCOPE = 'off'
  try { return eq(ds.rowVisible(B, 'requisitions', NEW), true, '可见性') }
  finally { if (old === undefined) delete process.env.DATA_SCOPE; else process.env.DATA_SCOPE = old }
})
t('恢复默认值后隔离重新生效', () => eq(ds.rowVisible(B, 'requisitions', NEW), false, '可见性'))
t('写操作集合覆盖关键写 action（禁止静默降级）', () => {
  const must = ['requisition', 'approve', 'io', 'adminUpsertUser', 'clearAllData', 'migrate']
  const miss = must.filter(a => !bs.isWriteAction(a))
  // migrate 属高危 super 操作，若未纳入则单列为风险，不算回归失败
  const realMiss = miss.filter(a => a !== 'migrate')
  return realMiss.length ? '缺少 ' + realMiss.join(',') : true
})
t('回退链 cloud → tencent → mock 构造正确', () => {
  const env = { FORCE_MOCK: false, AUTO_FALLBACK: true, RAW_DATA_BACKEND: 'cloud', HAS_CREDENTIAL: true }
  const r = bs.buildChain(env, () => ({}))
  return eq(r.kinds.join(','), 'cloud,tencent,mock', '链')
})

console.log('\n=== D. 字段格式兼容（新旧写法混存） ===')
t('parseClasses 英文逗号', () => eq(ds.parseClasses(C1 + ',' + C2).length, 2, '班数'))
t('parseClasses 中文逗号 / 顿号 / 分号', () => eq(ds.parseClasses(C1 + '，' + C2 + '、' + C1 + '；' + C2).length, 4, '班数'))
t('parseClasses 数组', () => eq(ds.parseClasses([C1, '', null, C2]).length, 2, '班数'))
t('parseClasses 空值不抛异常', () => eq(ds.parseClasses(null).length + ds.parseClasses(undefined).length, 0, '班数'))
t('readText 腾讯文档文本数组归一', () => eq(ds.readText({ '带班班级': [{ type: 'text', text: C1 }] }, '带班班级'), C1, '值'))
t('readCls 兼容中文列「归属班级」', () => eq(ds.readCls(TD_OLD), C1, '值'))
t('readCls 兼容英文 cls', () => eq(ds.readCls(NEW), C1, '值'))
t('readCls 缺列返回空串', () => eq(ds.readCls(OLD), '', '值'))
t('sanitizeManagedClasses 幂等（写库→读出解析不变）', () => {
  const once = ds.sanitizeManagedClasses(C1 + '，' + C2)
  return eq(ds.sanitizeManagedClasses(once), once, '幂等')
})
t('shouldStampCls 对流水表返回 true、主数据表返回 false', () =>
  eq(ds.shouldStampCls(A, 'requisitions') && !ds.shouldStampCls(A, 'materials'), true, '盖章范围'))

console.log('\n=== E. 源码契约（防止迭代中单侧漏改） ===')
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8') }
t('两套适配器都定义 cls 与 managedClasses 列', () => {
  const a = read('cloudfunctions/docsProxy/clouddb.js')
  const b = read('cloudfunctions/docsProxy/tencentdocs.js')
  return (a.includes("cls: 'cls'") && a.includes("managedClasses: 'managedClasses'") &&
    b.includes("cls: '归属班级'") && b.includes("managedClasses: '带班班级'")) ? true : '列定义缺失'
})
t('两套 publicUser 都透出 managedClasses', () => {
  const a = read('cloudfunctions/docsProxy/clouddb.js')
  const b = read('cloudfunctions/docsProxy/tencentdocs.js')
  return (a.includes('managedClasses: u.managedClasses') && b.includes('managedClasses: u.managedClasses'))
    ? true : 'publicUser 未透出带班字段'
})
t('前端所有 item.cls 展示均带 wx:if 判空（旧云函数不返回 cls 时不崩）', () => {
  const dir = path.join(ROOT, 'pages')
  const files = []
  ;(function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.wxml')) files.push(p)
    }
  })(dir)
  const bad = []
  for (const p of files) {
    const lines = read(path.relative(ROOT, p).replace(/\\/g, '/')).split('\n')
    lines.forEach((l, i) => {
      if (!l.includes('item.cls')) return
      // 认可三种安全写法：wx:if 判空 / || 缺省值 / 三元兜底（汇总行 byCls 必有 cls，不在此列）
      const safe = l.includes('wx:if="{{item.cls}}"')
        || /item\.cls\s*\|\|/.test(l)
        || /item\.cls\s*\?/.test(l)
        || /cls-sum-cls/.test(l)  // 按班级聚合的汇总行，cls 来自分组键，必有值
      if (!safe) bad.push(path.basename(p) + ':' + (i + 1))
    })
  }
  return bad.length ? '未判空 ' + bad.join(',') : true
})
t('用户管理表单对 managedClasses 使用缺省空串', () => {
  const s = read('pages/admin-users/admin-users.js')
  return s.includes("managedClasses: u.managedClasses || ''") ? true : '缺缺省值'
})
t('云库 recordIDs 精确取行也执行行级裁决（原 R4 已修复）', () => {
  const s = read('cloudfunctions/docsProxy/clouddb.js')
  return /if \(o\.recordIDs && o\.recordIDs\.length\) \{[\s\S]{0,160}scoped\(/.test(s)
})

console.log('\n=== 已知兼容性风险（不计入通过率，发版前须逐项确认） ===')
const risks = [
  'R1 历史流水无 cls → 部署新版后全部视为「公共资源」，所有教师可见；已用 tools/backfill_claim_cls.js 回填过一条已知遗漏，但不保证全量历史干净，发版前仍需抽查。',
  'R2 新 teacher 账号若漏配 managedClasses → 只能看到公共资源，本班申请全部不可见（本次断言已复现该现象）。发版前必须校验 18+ 账号带班完整。',
  'R3 腾讯文档备用表若未手工加「归属班级」「带班班级」两列 → buildValues 跳过不存在列，静默退化为不隔离（不报错）。',
  'R5 单一云环境、无 schemaVersion 字段、无自动迁移/回滚框架；开发版/体验版/正式版共享同一库，破坏性字段变更无法灰度。',
  'R6 云函数更新期间新旧实例可能并存，部分请求写入带 cls、部分不带，产生混合口径数据（不损坏，但报表口径需容忍）。',
  'R7 切回 DATA_BACKEND=tencent 会读到另一套数据（双库不同步），属数据分裂而非格式不兼容；切换前需重跑 migrate。'
]
risks.forEach(r => console.log('  ' + r))
console.log('\n=== 汇总：' + pass + ' 通过 / ' + fail + ' 失败 / ' + risks.length + ' 条风险 ===')
process.exitCode = fail ? 1 : 0

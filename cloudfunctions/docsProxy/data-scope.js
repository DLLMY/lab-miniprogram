'use strict'
// ============================================================
// data-scope.js —— 数据域（班级 / 老师）行级隔离引擎
// ============================================================
// 背景：原有系统只做了「角色层级隔离」（RBAC，谁能管理哪些账号），
//       没有做「数据域隔离」（谁能看到哪些业务数据）。本模块补齐后者。
//
// 设计原则（重要）：
//   1. 单一收敛点：getRecords / addRecord / updateRecord / deleteRecordByIds
//      是两套适配器（clouddb / tencentdocs）唯一的读写入口。过滤与归属注入
//      只在这些入口做，60+ 个业务函数零改动 → 回归风险最低、报表聚合口径天然正确。
//   2. 请求级上下文：用 AsyncLocalStorage 承载 scope，云函数并发请求互不串味。
//      业务函数不用显式传递 me，也不会污染模块级全局状态。
//   3. fail-safe：未登录 / super / admin → 不注入任何过滤，行为与改造前完全一致。
//      只有 teacher / student 登录后才会触发新的隔离逻辑（最小风险增量）。
//   4. 纯函数裁决：所有判定函数无 IO、无副作用，可离线单测（tools/test-data-scope.js）。
//
// 隔离范围（关键决策，详见 docs/数据域隔离设计.md）：
//   • 全局共享（不隔离）：materials / tools / labs / users
//     —— 老师必须能看到全部耗材与工具才能领用，隔离会导致系统不可用。
//   • 按班级隔离（流水）：requisitions / borrow / stock_io / access /
//                        logs / repairs / inspections
//   • 归属列 cls：写入时自动继承发起人班级；空 cls = 公共资源，所有教师可见。

const { AsyncLocalStorage } = require('async_hooks')
const als = new AsyncLocalStorage()

// 全局应急开关：DATA_SCOPE=off 时完全关闭行级隔离（回退到改造前行为），
// 用于线上异常时快速止损，不需要回滚代码。
function enabled() {
  return String(process.env.DATA_SCOPE || 'on').trim().toLowerCase() !== 'off'
}

// —— 常量表 ——
const SCOPED_TABLES = [
  'requisitions', 'borrow', 'stock_io', 'access', 'logs', 'repairs', 'inspections'
]
const GLOBAL_TABLES = ['users', 'materials', 'tools', 'labs']

// 各流水表的「归属人」字段（用于学生级个人隔离；键为表名，值为英文 key）
const OWNER_FIELD = {
  requisitions: 'user',
  borrow: 'user',
  stock_io: 'op',
  access: 'user',
  logs: 'actor',
  repairs: 'reporterId',
  inspections: 'executorId'
}
// 腾讯文档适配器的 fieldsMap 用中文列名，这里给出对应中文名（labs 三表是英文）
const OWNER_FIELD_TD = {
  requisitions: '申请人ID',
  borrow: '借用人ID',
  stock_io: '操作人',
  access: '用户ID',
  logs: '操作人',
  repairs: 'reporterId',
  inspections: 'executorId'
}

// 归属班级列名：云库用英文 cls，腾讯文档用中文「归属班级」
const CLS_KEYS = ['cls', '归属班级']

// —— 纯函数工具 ——
function parseClasses(s) {
  return String(s == null ? '' : s)
    .split(/[,，;；|、\s]+/)
    .map(x => String(x).trim())
    .filter(Boolean)
}

// 读取任意字段并归一化为字符串：腾讯文档文本列是 [{type:'text',text}] 数组，
// 云库是普通字符串 / 数字。两套适配器的 normUser 共用此函数解析带班列表。
function readText(fields, key) {
  if (!fields || !key || typeof fields !== 'object') return ''
  const v = fields[key]
  if (Array.isArray(v)) return v.map(x => (x && (x.text || x.value)) || '').join('').trim()
  if (v === undefined || v === null) return ''
  return String(v).trim()
}

function readCls(fields) {
  if (!fields || typeof fields !== 'object') return ''
  for (const k of CLS_KEYS) {
    const v = fields[k]
    // 腾讯文档文本列可能是 [{type:'text',text}] 数组
    if (Array.isArray(v)) {
      const t = v.map(x => (x && (x.text || x.value) || '')).join('').trim()
      if (t) return t
    } else if (v !== undefined && v !== null && String(v).trim()) {
      return String(v).trim()
    }
  }
  return ''
}

function readOwner(scope, sheetKey, fields) {
  if (!fields || typeof fields !== 'object') return ''
  const keys = [OWNER_FIELD[sheetKey], OWNER_FIELD_TD[sheetKey]].filter(Boolean)
  for (const k of keys) {
    const v = fields[k]
    if (Array.isArray(v)) {
      const t = v.map(x => (x && (x.text || x.value) || '')).join('').trim()
      if (t) return t
    } else if (v !== undefined && v !== null && String(v).trim()) {
      return String(v).trim()
    }
  }
  return ''
}

function isScopedTable(t) { return SCOPED_TABLES.indexOf(t) >= 0 }
function isGlobalTable(t) { return GLOBAL_TABLES.indexOf(t) >= 0 }

/**
 * 由身份对象构造数据域。me 来自 whoami / findUser（normUser 结果）。
 * 返回：{ logged, role, full, classes, ownerCls, actorId }
 *   full = true 表示不做任何过滤（未登录 / super / admin）。
 */
function scopeOf(me) {
  if (!me || !me.id) {
    return { logged: false, role: '', full: true, classes: [], ownerCls: '', actorId: '' }
  }
  const role = String(me.role || '').trim()
  const full = role === 'super' || role === 'admin'
  // 老师带班：优先 managedClasses（可多班），回退 cls（兼容单班/旧数据）
  let classes = []
  if (role === 'teacher') {
    classes = parseClasses(me.managedClasses)
    if (!classes.length) classes = parseClasses(me.cls)
  }
  const own = String(me.cls || '').trim()
  const ownerCls = own || classes[0] || ''
  return {
    logged: true,
    role,
    full,
    classes,
    ownerCls,
    actorId: String(me.id || '').trim()
  }
}

/** 是否需要注入行级过滤（只有已登录的 teacher / student 才需要） */
function needGuard(scope) {
  if (!enabled()) return false
  return !!(scope && scope.logged && !scope.full &&
    (scope.role === 'teacher' || scope.role === 'student'))
}

/**
 * 行是否可见。用于 getRecords 读过滤。
 * 规则：
 *   super/admin/未登录 → 全通
 *   全局主数据表      → 全通
 *   student            → 仅本人产生的流水
 *   teacher            → cls 为空（公共资源）或 cls ∈ 本人带班列表
 */
function rowVisible(scope, sheetKey, fields) {
  if (!needGuard(scope)) return true
  if (!isScopedTable(sheetKey)) return true
  if (scope.role === 'student') {
    const owner = readOwner(scope, sheetKey, fields)
    return !!owner && owner === scope.actorId
  }
  // teacher
  const cls = readCls(fields)
  if (!cls) return true
  return scope.classes.indexOf(cls) >= 0
}

/**
 * 是否允许写这一行（跨班写拦截，用于 updateRecord / deleteRecordByIds）。
 * 与 rowVisible 同规则，但学生额外要求「记录归属本人」。
 */
function canWriteRow(scope, sheetKey, fields) {
  if (!needGuard(scope)) return true
  if (!isScopedTable(sheetKey)) return true
  if (scope.role === 'student') {
    const owner = readOwner(scope, sheetKey, fields)
    return !!owner && owner === scope.actorId
  }
  const cls = readCls(fields)
  if (!cls) return true
  return scope.classes.indexOf(cls) >= 0
}

/** 是否在 addRecord 时自动写入归属班级 */
function shouldStampCls(scope, sheetKey) {
  return !!(enabled() && scope && scope.logged && isScopedTable(sheetKey))
}

/** 用户列表（users 表）按数据域过滤：老师只看自己带班的学生 */
function userVisible(scope, user) {
  if (!needGuard(scope)) return true
  if (scope.role === 'student') {
    return String(user.id || '').trim() === scope.actorId
  }
  if (scope.role === 'teacher') {
    const cls = String(user.cls || '').trim()
    // 无班级的账号（管理员预置等）不向老师暴露；只看本班
    return !!cls && scope.classes.indexOf(cls) >= 0
  }
  return true
}

/** 班级字段是否合法（老师提交带班列表时的服务端校验） */
function sanitizeManagedClasses(v) {
  return parseClasses(v).join(',')
}

// —— AsyncLocalStorage 上下文 ——
function runWithScope(scope, fn) { return als.run(scope, fn) }
function currentScope() { return als.getStore() || null }
/** 覆盖当前请求的归属班级（用于跨班审批产生的流水继承原申请班级） */
function overrideOwnerCls(cls) {
  const s = currentScope()
  if (s) s.ownerCls = String(cls || '').trim()
}

class ScopeDeniedError extends Error {
  constructor(msg) {
    super(msg || '无权操作其他班级的数据')
    this.name = 'ScopeDeniedError'
    this.code = 403
  }
}

module.exports = {
  // 常量
  SCOPED_TABLES, GLOBAL_TABLES, OWNER_FIELD, OWNER_FIELD_TD, CLS_KEYS,
  // 纯函数
  parseClasses, readCls, readOwner, readText, isScopedTable, isGlobalTable, enabled,
  scopeOf, needGuard, rowVisible, canWriteRow, shouldStampCls,
  userVisible, sanitizeManagedClasses,
  // 上下文
  runWithScope, currentScope, overrideOwnerCls, ScopeDeniedError
}

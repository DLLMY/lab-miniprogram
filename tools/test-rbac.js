// tools/test-rbac.js
// 用户创建/管理/删除 层级权限回归测试（纯函数，无网络依赖）
// 模型（与 clouddb.js / tencentdocs.js 内 decideUserWrite/Delete 一致）：
//   super  → 可操作 任意 角色
//   admin  → 仅可操作 严格低于自身层级 的角色 = 教师、学生
//   teacher→ 仅可操作 学生
//   student→ 不可操作用户
// 调用：node tools/test-rbac.js   （需在 lab-miniprogram 根目录执行）
const assert = require('assert')
const clouddb = require('../cloudfunctions/docsProxy/clouddb.js')
const tencent = require('../cloudfunctions/docsProxy/tencentdocs.js')

const ROLES = ['student', 'teacher', 'admin', 'super']
const LEVEL = { student: 0, teacher: 1, admin: 2, super: 3 }

// 期望裁决：super 放行任意；其余仅当 targetLevel < callerLevel 放行
function expectAllow(caller, target) {
  if (caller === 'super') return true
  return LEVEL[target] < LEVEL[caller]
}

let pass = 0, fail = 0
function ok(label, cond) {
  if (cond) { pass++ }
  else { fail++; console.error('  ✗ ' + label) }
}

for (const mod of [clouddb, tencent]) {
  const name = mod === clouddb ? 'clouddb' : 'tencentdocs'

  // 1) decideUserWrite：新增账号（无 existingRole），且非自改
  for (const caller of ROLES) {
    for (const target of ROLES) {
      const me = { id: 'C_' + caller, role: caller }
      const d = mod.decideUserWrite(me, { id: 'NEW', role: target })
      const allow = expectAllow(caller, target)
      ok(`${name} write ${caller}→${target}`, allow ? d === null : (d && d.code === 403))
    }
  }

  // 2) decideUserWrite：非 super 改自己角色被自锁（400）
  for (const caller of ['teacher', 'admin']) {
    const me = { id: 'ME', role: caller }
    const d = mod.decideUserWrite(me, { id: 'ME', role: 'student', existingRole: caller })
    ok(`${name} self-role-lock ${caller}`, d && d.code === 400)
  }

  // 3) decideUserDelete：被删者角色（排除自删，自删单独测）
  for (const caller of ROLES) {
    for (const target of ROLES) {
      const me = { id: 'C_' + caller, role: caller }
      if (me.id.toUpperCase() === 'X') continue
      const d = mod.decideUserDelete(me, target, 'X')
      const allow = expectAllow(caller, target)
      ok(`${name} delete ${caller}→${target}`, allow ? d === null : (d && d.code === 403))
    }
  }

  // 4) decideUserDelete：自删裁决
  //   super 可删 super（同层级放行），但自锁返回 400；
  //   teacher/admin 不能删同层级账号（含自己），层级检查先拦成 403。
  for (const caller of ['teacher', 'admin', 'super']) {
    const me = { id: 'SELF', role: caller }
    const d = mod.decideUserDelete(me, caller, 'SELF')
    if (caller === 'super') ok(`${name} delete-self ${caller}`, d && d.code === 400)
    else ok(`${name} delete-self ${caller}`, d && d.code === 403)
  }
}

  // 5) 新增重号守卫存在性（防误删）：两适配器都应有 `!rid && rec` 的 409 分支，
  //    否则「新增已存在工号」会把已有账号的姓名/角色静默覆盖。
  const fs = require('fs')
  const path = require('path')
  const cSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions/docsProxy/clouddb.js'), 'utf8')
  const tSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions/docsProxy/tencentdocs.js'), 'utf8')
  ok('clouddb 含新增重号 409 守卫', cSrc.includes('!rid && rec'))
  ok('tencentdocs 含新增重号 409 守卫', tSrc.includes('!rid && rec'))

console.log(`RBAC 回归：${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

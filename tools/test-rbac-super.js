// tools/test-rbac-super.js
// 验证超级管理员 RBAC 裁决逻辑（decideUserWrite / decideUserDelete 纯函数，无网络）。
// 覆盖：admin 可管学生/教师并可提 admin；admin 不可授 super、不可管 admin/super、不可改自己；
//      super 可授 super、可管 admin/super、可改自己。
const path = require('path')
const td = require(path.resolve(__dirname, '../cloudfunctions/docsProxy/tencentdocs.js'))

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? ' → ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')) }
}

// me：调用者；t：目标 { id, role(新角色), existingRole(现有角色), statusChanging }
const admin = { id: 'A001', role: 'admin' }
const superA = { id: 'S999', role: 'super' }
const student = { id: 'S001', role: 'student' }

console.log('\n[admin 能力边界]')
check('admin 可新增学生', td.decideUserWrite(admin, { id: 'NEW', role: 'student' }) === null)
check('admin 可把学生提为管理员', td.decideUserWrite(admin, { id: 'S001', role: 'admin', existingRole: 'student' }) === null)
check('admin 可编辑学生姓名(不改角色/状态)', td.decideUserWrite(admin, { id: 'S001', role: 'student', existingRole: 'student' }) === null)
check('admin 不可授予超级管理员', td.decideUserWrite(admin, { id: 'NEW', role: 'super' }).code === 403, '应 403')
check('admin 不可修改已有管理员账号', td.decideUserWrite(admin, { id: 'A002', role: 'admin', existingRole: 'admin' }).code === 403, '应 403')
check('admin 不可修改已有超级管理员账号', td.decideUserWrite(admin, { id: 'S999', role: 'super', existingRole: 'super' }).code === 403, '应 403')
check('admin 不可删除管理员账号', td.decideUserDelete(admin, 'admin', 'A002').code === 403, '应 403')
check('admin 不可删除超级管理员账号', td.decideUserDelete(admin, 'super', 'S999').code === 403, '应 403')
check('admin 不可改自己的角色', td.decideUserWrite(admin, { id: 'A001', role: 'student', existingRole: 'admin' }).code === 400, '应 400')
check('admin 不可改自己的状态', td.decideUserWrite(admin, { id: 'A001', role: 'admin', existingRole: 'admin', statusChanging: true }).code === 400, '应 400')
check('admin 可改他人(学生)状态', td.decideUserWrite(admin, { id: 'S001', role: 'student', existingRole: 'student', statusChanging: true }) === null)
check('非管理员(学生)被拒', td.decideUserWrite(student, { id: 'S002', role: 'student' }).code === 403, '应 403')

console.log('\n[super 全权]')
check('super 可授予超级管理员', td.decideUserWrite(superA, { id: 'NEW', role: 'super' }) === null)
check('super 可修改已有管理员账号', td.decideUserWrite(superA, { id: 'A002', role: 'admin', existingRole: 'admin' }) === null)
check('super 可修改已有超级管理员账号', td.decideUserWrite(superA, { id: 'S888', role: 'super', existingRole: 'super' }) === null)
check('super 可删除管理员账号', td.decideUserDelete(superA, 'admin', 'A002') === null)
check('super 可删除超级管理员账号', td.decideUserDelete(superA, 'super', 'S888') === null)
check('super 可改自己的角色', td.decideUserWrite(superA, { id: 'S999', role: 'admin', existingRole: 'super' }) === null)
check('super 可改自己的状态', td.decideUserWrite(superA, { id: 'S999', role: 'super', existingRole: 'super', statusChanging: true }) === null)
check('super 可新增学生', td.decideUserWrite(superA, { id: 'NEW', role: 'student' }) === null)
check('超级管理员提权路径：admin→super 仅 super 可做', td.decideUserWrite(admin, { id: 'A001', role: 'super', existingRole: 'admin' }).code === 403)

console.log('\n[边界]')
check('decideUserWrite 放行返回 null', td.decideUserWrite(admin, { id: 'S001', role: 'teacher', existingRole: 'student' }) === null)
check('decideUserDelete 删除学生放行', td.decideUserDelete(admin, 'student', 'S001') === null)

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)

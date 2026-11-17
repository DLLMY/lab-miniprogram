// utils/staff.js —— 教职工候选名单（指派执行人 / 处理人用）
//
// 为什么单独抽：
//   「把巡检任务派给谁」「这张报修单谁去处理」都需要一份可选择的教职工名单，
//   而两处（报修页 / 巡检页）都要用，抽出来避免两页各写一套、各自漂移。
//
// 取数策略（对旧版云函数同样可用，不要求前端先发版）：
//   1) 优先 listStaff —— 新增的轻量只读接口，普通教师也能拿到全校教师/管理员名册；
//   2) 云函数还没更新（该 action 不存在 / 返回错误）时，回退 adminListUsers ——
//      管理员/超管能拿到教师名单；普通教师在 adminListUsers 只能看到本班学生，
//      因此回退结果里教师往往只有自己，调用方需据此提示「仅管理员可指派他人」。
const api = require('./api.js')
const identity = require('./identity.js')

const STAFF_ROLES = ['teacher', 'admin', 'super']

function dedupe(list) {
  const seen = {}
  const out = []
  ;(list || []).forEach(u => {
    if (!u || !u.id) return
    const id = ('' + u.id).trim().toUpperCase()
    if (!id || seen[id]) return
    seen[id] = 1
    out.push({
      id: ('' + u.id).trim(),
      name: u.name || u.id,
      role: u.role || 'teacher',
      cls: u.cls || ''
    })
  })
  return out
}

// 返回候选列表（含当前用户自己，排在最前）
async function loadStaffCandidates() {
  const me = identity.current()
  let out = []
  try {
    const r = await api.callFull('listStaff', {}, {})
    if (r && r.code === 0 && Array.isArray(r.data)) out = dedupe(r.data)
  } catch (e) { out = [] }
  if (!out.length) {
    const list = await api.call('adminListUsers', me ? { actor: me.id } : {})
    out = dedupe((Array.isArray(list) ? list : []).filter(u => STAFF_ROLES.indexOf(u.role) >= 0))
  }
  // 把自己并入候选并置顶：任何情况下都能指派给自己（等价于"我来处理"）
  if (me && me.id) {
    const mid = ('' + me.id).trim().toUpperCase()
    const self = {
      id: ('' + me.id).trim(),
      name: me.name || me.id,
      role: me.role || 'teacher',
      cls: me.cls || '',
      self: true
    }
    out = [self].concat(out.filter(u => ('' + u.id).trim().toUpperCase() !== mid))
  }
  return out
}

// 候选不足两人 → 说明当前身份看不到同事名册，调用方应给出提示而不是静默只显示自己
function onlySelf(list) {
  return (list || []).length <= 1
}

module.exports = { loadStaffCandidates, onlySelf, STAFF_ROLES }

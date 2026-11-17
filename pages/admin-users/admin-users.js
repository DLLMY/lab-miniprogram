// pages/admin-users/admin-users.js
// 用户与角色管理页：列表 / 新增 / 编辑 / 删除。
//
// 权限口径【与后端保持一致】（2026-11-17 修正）：
//   后端三个 action（adminListUsers / adminUpsertUser / adminDeleteUser）的闸门都是 gStaff，
//   即「教师及以上」都可调用；再由 decideUserWrite / decideUserDelete / userScopeErr 逐条裁决：
//     super  → 任意角色；
//     admin  → 仅教师 / 学生；
//     teacher→ 仅学生，且只能是自己带班的学生（归属班级必须落在本人 managedClasses 内）。
//   此前本页用 identity.isAdmin() 一刀切把教师挡在门外 → 后端允许的「教师建本班学生」
//   在界面上没有任何入口，属于前后端语义不一致（教师管学生这条最常用的路径直接不可用）。
//   现改为 allowed = identity.isStaff()，并按同一套层级规则裁剪角色选项与归属班级。
const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

const ROLES = [
  { k: 'student', label: '学生' },
  { k: 'teacher', label: '教师' },
  { k: 'admin', label: '管理员' },
  { k: 'super', label: '超级管理员' }
]
const STATUSES = ['启用', '停用']

// 角色可选项：按当前用户层级裁剪，避免越权授予（服务端 decideUserWrite 同样会拦截）。
//   super → 全部；admin → 教师/学生；teacher → 学生；其余 → 无。
const ROLE_LEVEL = { student: 0, teacher: 1, admin: 2, super: 3 }
function visibleRoles(myRole) {
  const lvl = ROLE_LEVEL[myRole] != null ? ROLE_LEVEL[myRole] : -1
  if (lvl >= ROLE_LEVEL.super) return ROLES
  if (lvl >= ROLE_LEVEL.admin) return ROLES.filter(r => r.k === 'teacher' || r.k === 'student')
  if (lvl >= ROLE_LEVEL.teacher) return ROLES.filter(r => r.k === 'student')
  return []
}

Page({
  data: {
    users: [],
    loading: false,
    loadErr: false,
    showForm: false,
    myRole: '',
    isSuper: false,
    editing: null,                                   // 正在编辑的 rid；null = 新增
    form: { id: '', name: '', role: 'student', cls: '', managedClasses: '', status: '启用' },
    roleIndex: 0,
    statusIndex: 0,
    roleLabels: ROLES.map(r => r.label),
    statusLabels: STATUSES,
    // —— 教师模式（与后端 teacher 分支一一对应）——
    isTeacher: false,        // 当前身份是教师
    myClasses: [],           // 本人带班班级（= 后端 scope.classes）
    myClassesText: '',       // 带班班级可读文本（WXML 不能调数组方法，需预拼）
    clsOptions: [],          // 归属班级可选项：教师 = 本人带班；管理员/超管 = 自由输入
    clsIndex: 0
  },

  async onShow() {
    const me = identity.current()
    const myRole = me ? me.role : ''
    const isSuper = myRole === 'super'
    const isTeacher = myRole === 'teacher'
    // ⚠ 与后端保持一致：三个用户管理 action 的闸门是 gStaff（教师及以上），不是 gAdmin。
    //   此前用 isAdmin() 把教师整页挡掉 → 后端允许的「教师建本班学生」在界面上无入口。
    //   学生仍被拦住（直接 navigateTo 进来也只是空列表 + 权限提示，不会误导）。
    const allowed = identity.isStaff()
    const myClasses = identity.managedClassesList()
    this.setData({
      me,
      myRole,
      isSuper,
      isTeacher,
      allowed,
      myClasses,
      myClassesText: myClasses.join('、'),
      clsOptions: isTeacher ? myClasses : [],
      roleText: me ? identity.roleText(myRole) : '未登录',
      roleLabels: visibleRoles(myRole).map(r => r.label)
    })
    if (!allowed) return
    // 教师：回源刷新一次本人带班（登录缓存可能过期，见 identity.refresh 注释）
    if (isTeacher) {
      const fresh = await identity.refresh()
      const freshClasses = identity.managedClassesList()
      this.setData({
        me: fresh,
        myClasses: freshClasses,
        myClassesText: freshClasses.join('、'),
        clsOptions: freshClasses
      })
    }
    this.load()
  },
  // 下拉刷新：先清云端读缓存再重取用户列表
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },

  async load() {
    this.setData({ loading: true, loadErr: false })
    const me = identity.current()
    const list = await api.call('adminListUsers', me ? { actor: me.id } : {})
    if (list === null) { this.setData({ loading: false, loadErr: true }); return }
    const lvl = ROLE_LEVEL[this.data.myRole] != null ? ROLE_LEVEL[this.data.myRole] : -1
    const users = (Array.isArray(list) ? list : []).map(u => ({
      ...u,
      // 双保险：服务端已按层级过滤，这里再算一遍 manageable 供前端按钮门控
      manageable: this.data.isSuper || (ROLE_LEVEL[u.role] != null ? ROLE_LEVEL[u.role] : 0) < lvl
    }))
    this.setData({ users, loading: false })
  },

  openAdd() {
    // 教师只能建学生（后端 decideUserWrite：teacher 仅可创建/管理学生）
    const opts = this.data.clsOptions || []
    if (this.data.isTeacher && !opts.length) {
      // 教师未配置带班班级 → 后端必然拒绝（userScopeErr：新增学生必须属于本人带班）
      // 这里提前把原因讲清楚，而不是让老师填完表单再吃一个 403。
      wx.showModal({
        title: '尚未配置带班班级',
        content: '你的账号还没有配置带班班级，按系统规则无法新增学生账号（新增的学生必须属于你带的班）。\n\n请让管理员先在「用户与角色」里为你配置带班班级，之后你就能在这里录入本班学生了。',
        showCancel: false
      })
      return
    }
    this.setData({
      showForm: true,
      editing: null,
      form: {
        id: '', name: '', role: 'student',
        cls: this.data.isTeacher ? (opts[0] || '') : '',
        managedClasses: '', status: '启用'
      },
      roleIndex: 0,
      statusIndex: 0,
      clsIndex: 0
    })
  },

  openEdit(e) {
    const u = e.currentTarget.dataset.u
    const roles = visibleRoles(this.data.myRole)
    const roleIndex = Math.max(0, roles.findIndex(r => r.k === u.role))
    const statusIndex = u.status === '停用' ? 1 : 0
    // 教师的归属班级只能从本人带班里选：定位到该学生当前班级对应的下标
    const opts = this.data.clsOptions || []
    let clsIndex = opts.indexOf('' + (u.cls || ''))
    if (clsIndex < 0) clsIndex = 0
    this.setData({
      showForm: true,
      editing: u.rid,
      form: { id: u.id, name: u.name, role: u.role, cls: u.cls || '', managedClasses: u.managedClasses || '', status: u.status || '启用' },
      roleIndex,
      statusIndex,
      clsIndex
    })
  },

  closeForm() { this.setData({ showForm: false }) },
  noop() {},

  onId(e) { this.setData({ 'form.id': e.detail.value }) },
  onName(e) { this.setData({ 'form.name': e.detail.value }) },
  onCls(e) { this.setData({ 'form.cls': e.detail.value }) },
  // 教师模式的归属班级选择器：只能选本人带班（后端 userScopeErr 同口径，越班一律 403）
  onClsPick(e) {
    const i = Number(e.detail.value)
    const opts = this.data.clsOptions || []
    const c = opts[i]
    if (!c) return
    this.setData({ clsIndex: i, 'form.cls': c })
  },
  // 老师带班列表：服务端 sanitizeManagedClasses 会按中英文逗号/分号再规范化一次
  onManagedClasses(e) { this.setData({ 'form.managedClasses': e.detail.value }) },
  onRole(e) {
    const i = Number(e.detail.value)
    const roles = visibleRoles(this.data.myRole)
    // 角色列表随当前身份裁剪，切换账号后旧 roleIndex 可能越界导致 roles[i] undefined
    const safe = roles[i] || roles[0]
    if (!safe) return
    this.setData({ roleIndex: roles[i] ? i : 0, 'form.role': safe.k })
  },
  onStatus(e) {
    const i = Number(e.detail.value)
    this.setData({ statusIndex: i, 'form.status': STATUSES[i] })
  },

  async save() {
    const f = this.data.form
    // 教师模式：角色强制为学生（后端也只允许 teacher 建学生），归属班级必须落在本人带班内
    const isTeacher = this.data.isTeacher
    const myClasses = this.data.clsOptions || []
    let cls = (f.cls || '').trim()
    if (isTeacher) {
      if (myClasses.indexOf(cls) < 0) {
        wx.showToast({ title: '归属班级必须是你带的班', icon: 'none' })
        return
      }
    }
    const payload = {
      id: f.id.trim().toUpperCase(),
      name: f.name.trim(),
      role: isTeacher ? 'student' : f.role,
      cls,
      managedClasses: isTeacher ? '' : (f.managedClasses || '').trim(),
      status: f.status,
      // 编辑时带上行 ID（recordId）：服务端按 rid 精确定位，改工号时能查出「目标工号已被占用」
      rid: this.data.editing || ''
    }
    if (!payload.id || !payload.name) {
      wx.showToast({ title: '工号和姓名必填', icon: 'none' })
      return
    }
    // 降级/停用自己时二次确认：服务端会拒绝"最后一个启用超管"，但这里先把风险讲清楚，
    // 免得点了没反应还以为是系统坏了（唯一超管被降级后全校再无管理入口）。
    const me = identity.current()
    if (me && this.data.editing && ('' + payload.id).toUpperCase() === ('' + me.id).toUpperCase()) {
      const loseSuper = payload.role !== 'super' || payload.status !== '启用'
      if (loseSuper) {
        const c = await new Promise(res => wx.showModal({
          title: '确认降级自己？',
          content: '你正在修改自己的账号（' + payload.id + '）。' +
            '若你是系统里最后一名启用中的超级管理员，降级后清库、迁移、日志查看、创建管理员等功能将无人可用，' +
            '只能由 DBA 进数据库改回。确定继续？',
          confirmText: '仍然降级',
          cancelText: '再想想',
          success: res
        }))
        if (!c.confirm) return
      }
    }
    // mask:true：保存期间阻断重复点击——否则快速双击会发两次 upsert（第二次虽幂等，
    // 但会重复刷新列表、Toast 抖动，且失败时的错误提示会被后一次覆盖）
    wx.showLoading({ title: '保存中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('adminUpsertUser', payload, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: this.data.editing ? '已更新' : '已新增', icon: 'success' })
      this.setData({ showForm: false })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '保存失败', icon: 'none' })
    }
  },

  // 停用 / 启用（P2-⑲）：离职或转班人员的正确处理是"停用账号"，而不是删掉这一行。
  // 删除后 users 里查无此人，但历史领用/借还里的工号还在 → 使用概况与列表直接显示裸工号，
  // 谁借的都无法追溯。停用则保留档案、只拦登录，随时可恢复。
  async toggleStatus(e) {
    const u = e.currentTarget.dataset.u
    if (!u) return
    const me = identity.current()
    if (me && ('' + me.id).toUpperCase() === ('' + u.id).toUpperCase()) {
      wx.showToast({ title: '不能停用当前登录账号', icon: 'none' })
      return
    }
    const disabled = ('' + (u.status || '启用')) === '停用'
    const nextLabel = disabled ? '启用' : '停用'
    const ok = await new Promise(res => wx.showModal({
      title: nextLabel + '账号',
      content: (disabled
        ? '恢复 ' + u.id + '（' + u.name + '）的登录权限，确定？'
        : '停用后 ' + u.id + '（' + u.name + '）将无法登录，但其历史领用 / 借还记录完整保留。推荐用此方式代替删除。'),
      confirmText: nextLabel,
      confirmColor: disabled ? '#2B6CFF' : '#DC2626',
      success: r => res(r.confirm)
    }))
    if (!ok) return
    wx.showLoading({ title: '处理中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('adminUpsertUser', {
      id: u.id, name: u.name, role: u.role, cls: u.cls || '',
      // 带上带班列表：避免停用/启用老师账号时把数据域范围清空
      managedClasses: u.managedClasses || '',
      status: nextLabel, rid: u.rid || ''
    }, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已' + nextLabel, icon: 'success' })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '操作失败', icon: 'none' })
    }
  },

  // 解除微信绑定（管理员）：
  //   「一个工号被某个微信绑定后，其他人不可再绑」这条保护一旦录错（如换微信号、绑定到别人微信），
  //   就必须有一条正规出路 —— 否则 bindLogin 的 409 提示「请联系管理员清空绑定」是死路。
  //   解绑后该工号即可被重新绑定（仍需姓名核对）。
  async unbind(e) {
    const u = e.currentTarget.dataset.u
    if (!u) return
    const ok = await new Promise(res => wx.showModal({
      title: '解除微信绑定',
      content: '将解除 ' + u.id + '（' + u.name + '）与当前微信的绑定。\n\n' +
        '解绑后，该工号可以被任何人在小程序里重新绑定（仍需姓名与工号核对）。\n' +
        '请确认是本人换了微信号，或该绑定确实录错。',
      confirmText: '确认解绑',
      confirmColor: '#DC2626',
      success: r => res(r.confirm)
    }))
    if (!ok) return
    wx.showLoading({ title: '处理中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('adminUnbindUser', { id: u.id }, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已解绑', icon: 'success' })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '解绑失败', icon: 'none' })
    }
  },

  async del(e) {
    const u = e.currentTarget.dataset.u
    const me = identity.current()
    if (me && ('' + me.id).toUpperCase() === ('' + u.id).toUpperCase()) {
      wx.showToast({ title: '不能删除当前登录账号', icon: 'none' })
      return
    }
    // 已绑定微信的账号不能物理删除：
    //   删除会让 openid 随行消失，同工号若被重建就会变成「未绑定」状态，
    //   「一个工号被绑定后他人不可再绑」这条保护随之失效 → 任何人都能抢绑该工号。
    //   因此这里直接引导「解绑」或「停用」，不给会造成裸奔的删除入口。
    if (u.bound) {
      const r2 = await new Promise(res => wx.showModal({
        title: '该账号已绑定微信',
        content: u.id + '（' + u.name + '）已绑定微信，不能直接删除 —— ' +
          '删掉后该工号会变成「未绑定」状态，任何人都能抢先绑定它。\n\n' +
          '建议：\n· 人员不再使用 → 改用「停用」（保留档案与绑定）；\n' +
          '· 需要换绑或清理 → 先「解绑」再删除。',
        cancelText: '先解绑',
        confirmText: '改用停用',
        success: r => res(r)
      }))
      if (r2.confirm) return this.toggleStatus({ currentTarget: { dataset: { u } } })
      if (r2.cancel) return this.unbind({ currentTarget: { dataset: { u } } })
      return
    }
    // 删除改为两步确认 + 明确后果：物理删除会让后续统计里的工号变成无法追溯的裸 ID，
    // 所以第一步推荐停用，只有确认"这是录入错的脏账号"才走到真删除。
    const still = await new Promise(res => wx.showModal({
      title: '建议改用「停用」',
      content: '删除会把 ' + u.id + '（' + u.name + '）的档案彻底移除：' +
        '其历史领用 / 借还记录仍在，但统计里只能显示工号、查不到姓名与班级。\n\n' +
        '若该人员仅是不再使用系统，请用列表上的「停用」。',
      cancelText: '改用停用',
      confirmText: '仍要删除',
      success: r => res(r.confirm)
    }))
    if (!still) {
      // 用户选了「改用停用」：直接对该账号执行停用（保留历史档案，比物理删除更安全）
      return this.toggleStatus({ currentTarget: { dataset: { u } } })
    }
    const ok = await new Promise(res => wx.showModal({
      title: '确认删除（不可恢复）',
      content: '此操作不可撤销。确定彻底删除 ' + u.id + '（' + u.name + '）？',
      confirmText: '彻底删除',
      confirmColor: '#DC2626',
      success: r => res(r.confirm)
    }))
    if (!ok) return
    // mask:true：删除确认后阻断重复点击——否则第二次点击会打到已删除的行，
    // 服务端返回 404「该工号不存在」，在「已删除」成功提示后再弹一个错误，用户会困惑
    wx.showLoading({ title: '删除中', mask: true })
    api.warnIfDemo()
    const r = await api.callFull('adminDeleteUser', { id: u.id }, { noFallback: true })
    wx.hideLoading()
    if (r && r.code === 0) {
      wx.showToast({ title: '已删除', icon: 'success' })
      this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '删除失败', icon: 'none' })
    }
  }
})

const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

Page({
  data: { allow: false, stat: null, teachers: [], rank: [], me: null, roleText: '未登录' },
  onShow() {
    // 角色以持久化身份为准（app.globalData.role 冷启动/切号后可能是旧值）
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, me: i, roleText: i ? identity.roleText(i.role) : '未登录' })
    console.log('[usage] 身份=' + (i ? i.id + '/' + i.role : '未登录') + ' allow=' + allow)
    if (allow) this.load()
  },
  switchAccount() {
    identity.switchAccount()
  },
  async load() {
    const d = await api.call('usage', {})
    if (d) {
      // 注入中文角色名 + 头像首字 + 进度百分比，避免页面直接显示英文 role / 做数值运算
      const raw = d.rank || []
      const max = raw.reduce((m, x) => Math.max(m, Number(x.n) || 0), 0) || 1
      const rank = raw.map(x => ({
        ...x,
        roleText: x.user ? identity.roleText(x.user.role) : '?',
        initial: x.user && x.user.name ? x.user.name.charAt(0) : '?',
        pct: Math.max(6, Math.round(((Number(x.n) || 0) / max) * 100))
      }))
      const teachers = rank.filter(x => x.user && x.user.role === 'teacher')
      this.setData({ stat: d, teachers, rank })
    }
  }
})

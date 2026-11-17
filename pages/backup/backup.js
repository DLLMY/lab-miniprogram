const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

// 数据备份（管理员专属）
// 数据源 = 服务端 snapshot（一次性拉取全部 11 张表，字段形状与前端一致）。
// 关键：绝不回退本地 mock——备份必须是真实云端数据，否则用户拿演示台账当正式备份，后果比失败严重。
// 交付方式：写入 USER_DATA_PATH 的 .json 文件后 wx.shareFileMessage 转发给「文件传输助手」，电脑上另存。
Page({
  data: {
    allow: false,
    roleText: '未登录',
    busy: false,
    loaded: false,
    generatedAt: '',
    backendText: '检测中…',
    demo: false,
    tables: [],
    totalRows: 0,
    err: ''
  },
  onShow() {
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isAdmin()
    this.setData({
      allow,
      roleText: i ? identity.roleText(i.role) : '未登录'
    })
  },
  switchAccount() { identity.switchAccount() },

  async load() {
    if (this.data.busy) return
    this.setData({ busy: true, err: '' })
    wx.showLoading({ title: '读取中…', mask: true })
    let r = null
    try {
      r = await api.callFull('snapshot', {}, { noFallback: true })
    } catch (e) {
      this.setData({ err: (e && e.message) || '读取失败' })
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
    if (!r || r.code !== 0) {
      this.setData({ err: (r && r.data && r.data.msg) || (r && r.msg) || '读取失败：云端未返回数据' })
      return
    }
    const d = r.data || {}
    const TABLE_LABELS = {
      users: '账号与角色', materials: '耗材档案', tools: '工具档案',
      requisitions: '领用申请', borrow: '借还记录', stock_io: '出入库流水',
      access: '门禁记录', logs: '操作日志',
      labs: '实训室', repairs: '报修', inspections: '巡检'
    }
    const tables = Object.keys(TABLE_LABELS).map(k => ({
      key: k, label: TABLE_LABELS[k], count: Array.isArray(d[k]) ? d[k].length : 0
    }))
    const totalRows = tables.reduce((s, t) => s + t.count, 0)
    const demo = (r.src === 'mock') || api.isDemoData()
    const be = api.backendLabel(r.backend)
    this.setData({
      loaded: true, demo,
      generatedAt: d.generatedAt || '',
      backendText: demo ? '演示数据（非真实台账）' : be,
      tables, totalRows,
      _snapshot: d
    })
  },

  async download() {
    if (!this.data.loaded || this.data.busy) return
    const d = this.data._snapshot
    if (!d) return
    const p = n => ('' + n).padStart(2, '0')
    const dt = new Date(Date.now() + 8 * 3600 * 1000)
    const stamp = '' + dt.getUTCFullYear() + p(dt.getUTCMonth() + 1) + p(dt.getUTCDate()) + '_' + p(dt.getUTCHours()) + p(dt.getUTCMinutes())
    const filename = '阿磊的工具箱-数据备份-' + stamp + '.json'
    const content = JSON.stringify(d, null, 2)
    const path = wx.env.USER_DATA_PATH + '/' + filename
    this.setData({ busy: true })
    wx.showLoading({ title: '生成备份文件…', mask: true })
    try {
      await new Promise((res, rej) => {
        wx.getFileSystemManager().writeFile({ filePath: path, data: content, encoding: 'utf8', success: res, fail: rej })
      })
      wx.hideLoading()
      this.setData({ busy: false })
      wx.shareFileMessage({
        filePath: path,
        success: () => wx.showToast({ title: '已发起转发', icon: 'success' }),
        fail: (e) => {
          const msg = (e && e.errMsg) || ''
          if (/cancel/.test(msg)) return
          wx.showModal({
            title: '转发未完成',
            content: '备份文件已生成在本机，但转发被取消或失败。可在下一次点击「生成备份文件」重试。',
            showCancel: false
          })
        }
      })
    } catch (e) {
      wx.hideLoading()
      this.setData({ busy: false })
      wx.showModal({
        title: '备份失败',
        content: (e && e.errMsg && /auth deny|permission/.test(e.errMsg)) ? '存储权限不足，请检查小程序设置' : ((e && e.message) || '文件写入失败'),
        showCancel: false
      })
    }
  }
})

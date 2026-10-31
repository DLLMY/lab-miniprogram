const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')

// 盘点 / 期初建账
// mode=stocktake：账面 vs 实盘，差异生成调整流水
// mode=opening  ：实盘数直接定为基线（不看账面），写「期初入库」流水
Page({
  data: {
    allow: false,
    roleText: '未登录',
    mode: 'stocktake',
    modeName: '库存盘点',
    list: [],          // [{ id, name, unit, loc, book, real, diff }]
    busy: false,
    // 汇总
    filled: 0,         // 已填实盘数（与账面不同的项数）
    diffCount: 0
  },
  onLoad(o) {
    const opening = o && o.mode === 'opening'
    this.setData({
      mode: opening ? 'opening' : 'stocktake',
      modeName: opening ? '期初建账' : '库存盘点'
    })
    if (opening) wx.setNavigationBarTitle({ title: '期初建账' })
  },
  onShow() {
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, roleText: i ? identity.roleText(i.role) : '未登录' })
    if (allow) this.load()
  },
  switchAccount() { identity.switchAccount() },
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.allow) { done(); return }
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },
  async load() {
    const mats = await api.call('listMaterials', {})
    const opening = this.data.mode === 'opening'
    this.setData({
      list: (mats || []).map(m => {
        const book = Number(m.stock) || 0
        return {
          id: m.id, name: m.name, unit: m.unit || '', loc: m.loc || '',
          spec: m.spec || '',
          book,
          // 盘点：默认预填账面数，老师只需改有出入的几项（全量重输太累，也容易漏项）
          // 期初：默认空，必须真正数过才算数，避免直接沿用旧值把错误基线固化下来
          real: opening ? '' : book,
          diff: 0
        }
      }),
      filled: 0,
      diffCount: 0
    })
    this.summary()
  },
  // 实盘数录入
  onReal(e) {
    const i = Number(e.currentTarget.dataset.i)
    const v = e.detail.value
    const real = v === '' ? '' : (parseInt(v, 10) || 0)
    const item = this.data.list[i]
    const diff = this.data.mode === 'opening'
      ? (real === '' ? 0 : real)
      : (real === '' ? 0 : real - item.book)
    this.setData({ ['list[' + i + '].real']: real, ['list[' + i + '].diff']: diff })
    this.summary()
  },
  step(e) {
    const i = Number(e.currentTarget.dataset.i)
    const d = parseInt(e.currentTarget.dataset.d, 10) || 0
    const item = this.data.list[i]
    let real = (item.real === '' ? 0 : Number(item.real)) + d
    if (real < 0) real = 0
    const diff = this.data.mode === 'opening' ? real : real - item.book
    this.setData({ ['list[' + i + '].real']: real, ['list[' + i + '].diff']: diff })
    this.summary()
  },
  // 一键把实盘数设为账面数（盘点时表示"这项没问题"）
  same(e) {
    const i = Number(e.currentTarget.dataset.i)
    const book = this.data.list[i].book
    this.setData({ ['list[' + i + '].real']: book, ['list[' + i + '].diff']: 0 })
    this.summary()
  },
  summary() {
    const list = this.data.list
    const opening = this.data.mode === 'opening'
    // 期初：只统计填了数的项；盘点：统计实盘与账面不一致的项
    const active = list.filter(x => opening ? (x.real !== '' ) : (x.real !== '' && Number(x.real) !== x.book))
    this.setData({ filled: active.length, diffCount: active.length })
  },
  async submit() {
    if (!this.data.allow || this.data.busy) return
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    const opening = this.data.mode === 'opening'
    const items = this.data.list
      .filter(x => x.real !== '' && Number.isFinite(Number(x.real)))
      .map(x => ({ matId: x.id, real: Number(x.real) }))
    if (!items.length) {
      wx.showToast({ title: opening ? '请先录入期初数量' : '请先录入实盘数量', icon: 'none' })
      return
    }
    const confirm = await new Promise(res => wx.showModal({
      title: opening ? '确认期初建账' : '确认盘点调整',
      content: '将对 ' + items.length + ' 项物品' +
        (opening ? '按期初数量重置库存，并各记一笔「期初入库」流水。' : '按实盘数调整账面库存，差异各记一笔调整流水。') +
        '\n建议先完成实物清点再操作。',
      success: res
    }))
    if (!confirm.confirm) return

    this.setData({ busy: true })
    wx.showLoading({ title: '处理中…', mask: true })
    api.warnIfDemo()
    try {
      const r = await api.callFull('stocktake', {
        mode: this.data.mode, items: items, actor: me.id
      }, { noFallback: true })
      if (r && r.code === 0) {
        wx.hideLoading()
        const d = r.data || {}
        const failed = (d.details || []).filter(x => x.err)
        wx.showModal({
          title: (opening ? '期初建账完成' : '盘点完成'),
          content: '调整 ' + d.adjusted + ' 项，无差异 ' + d.unchanged + ' 项' +
            (failed.length ? ('\n失败 ' + failed.length + ' 项：' + failed.map(x => x.matId).join('、')) : ''),
          showCancel: false,
          confirmText: '知道了'
        })
        this.load()
      } else {
        wx.hideLoading()
        wx.showModal({
          title: '处理失败',
          content: (r && r.data && r.data.msg) || '请稍后重试',
          showCancel: false, confirmText: '知道了'
        })
      }
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
  }
})

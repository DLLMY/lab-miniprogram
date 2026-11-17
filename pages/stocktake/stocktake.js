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
    diffCount: 0,
    invalidCount: 0    // 填写非法的项数（不提交，但必须提示）
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
      diffCount: 0,
      invalidCount: 0
    })
    this.summary()
  },
  // 实盘数录入
  // ⚠ 非法输入绝不能静默变成 0：此前 parseInt(v)||0 会把 "abc" 当成 0 提交，
  //   后端校验通过后直接把该物品库存清零 —— 一个错字就毁掉一条台账。
  //   现在保留原始字符串，非法值标红并从提交集合里剔除，由用户改成合法数字。
  onReal(e) {
    const i = Number(e.currentTarget.dataset.i)
    const raw = ('' + (e.detail.value || '')).trim()
    const item = this.data.list[i]
    if (raw === '') {
      this.setData({ ['list[' + i + '].real']: '', ['list[' + i + '].diff']: 0, ['list[' + i + '].invalid']: false })
      this.summary()
      return
    }
    const n = Number(raw)
    const invalid = !/^\d+$/.test(raw) || !Number.isFinite(n) || n < 0
    const real = invalid ? raw : Math.floor(n)
    const diff = invalid ? 0 : (this.data.mode === 'opening' ? real : real - item.book)
    this.setData({
      ['list[' + i + '].real']: real,
      ['list[' + i + '].diff']: diff,
      ['list[' + i + '].invalid']: invalid
    })
    this.summary()
  },
  step(e) {
    const i = Number(e.currentTarget.dataset.i)
    const d = parseInt(e.currentTarget.dataset.d, 10) || 0
    const item = this.data.list[i]
    // 非法输入状态下 +/- 直接从 0 起算（相当于重新开始填）
    const cur = item.invalid ? 0 : (item.real === '' ? 0 : Number(item.real))
    let real = cur + d
    if (real < 0) real = 0
    const diff = this.data.mode === 'opening' ? real : real - item.book
    this.setData({
      ['list[' + i + '].real']: real,
      ['list[' + i + '].diff']: diff,
      ['list[' + i + '].invalid']: false
    })
    this.summary()
  },
  // 一键把实盘数设为账面数（盘点时表示"这项没问题"）
  same(e) {
    const i = Number(e.currentTarget.dataset.i)
    const book = this.data.list[i].book
    this.setData({ ['list[' + i + '].real']: book, ['list[' + i + '].diff']: 0, ['list[' + i + '].invalid']: false })
    this.summary()
  },
  summary() {
    const list = this.data.list
    const opening = this.data.mode === 'opening'
    // 期初：只统计填了数的项；盘点：统计实盘与账面不一致的项
    const active = list.filter(x => opening ? (x.real !== '' ) : (x.real !== '' && Number(x.real) !== x.book))
    // 非法填写单独计数：这些项不提交，但必须让老师看见"还有几项没填对"
    const invalid = list.filter(x => x.invalid).length
    this.setData({ filled: active.length, diffCount: active.length, invalidCount: invalid })
  },
  async submit() {
    if (!this.data.allow || this.data.busy) return
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    const opening = this.data.mode === 'opening'
    const invalidItems = this.data.list.filter(x => x.invalid)
    const items = this.data.list
      .filter(x => !x.invalid && x.real !== '' && Number.isFinite(Number(x.real)))
      .map(x => ({ matId: x.id, real: Number(x.real) }))
    if (!items.length) {
      wx.showToast({ title: invalidItems.length ? '填写内容不是有效数字，请先改正' : (opening ? '请先录入期初数量' : '请先录入实盘数量'), icon: 'none' })
      return
    }
    // 非法项不提交（避免把错字当 0 把库存清零），但必须明确告知有几项被跳过
    if (invalidItems.length) {
      const c2 = await new Promise(res => wx.showModal({
        title: '有填写错误的项',
        content: '有 ' + invalidItems.length + ' 项填写不是有效数字（' + invalidItems.map(x => x.name).join('、') + '），' +
          '这些项将被跳过，不会提交。其余 ' + items.length + ' 项继续提交？',
        confirmText: '继续提交',
        success: res
      }))
      if (!c2.confirm) return
    }
    // 实盘填 0 = 账面库存被直接清零（东西真的不在库 / 没登记）→ 误操作代价极大：
    //   手滑把 10 输成 0，这条耗材就再也领不出去，必须重新入库才能恢复。
    //   确认框里把这几项点名，避免"看着像普通调整"就被一路确认掉。
    const zeroed = this.data.list.filter(x =>
      !x.invalid && x.real !== '' && Number(x.real) === 0 && Number(x.book) > 0)
    const confirm = await new Promise(res => wx.showModal({
      title: opening ? '确认期初建账' : '确认盘点调整',
      content: '将对 ' + items.length + ' 项物品' +
        (opening ? '按期初数量重置库存，并各记一笔「期初入库」流水。' : '按实盘数调整账面库存，差异各记一笔调整流水。') +
        (zeroed.length
          ? ('\n\n⚠ 其中 ' + zeroed.length + ' 项实盘填了 0，账面库存将被直接清零：' +
             zeroed.slice(0, 5).map(x => x.name + '（' + x.book + '→0）').join('、') +
             (zeroed.length > 5 ? ' 等' : '') +
             '\n请确认这些物品确实已经不在库；填错请返回修改。')
          : '') +
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
        // 幂等命中：同一份盘点在 5 秒内重复提交 → 后端只执行一次，必须说明
        const idemW = api.idemWarn(r)
        wx.showModal({
          title: (opening ? '期初建账完成' : '盘点完成'),
          content: (idemW ? (idemW + '\n') : '') +
            '调整 ' + d.adjusted + ' 项，无差异 ' + d.unchanged + ' 项' +
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

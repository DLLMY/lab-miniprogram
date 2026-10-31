const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const exporter = require('../../utils/export.js')

Page({
  data: {
    mats: [],
    tools: [],
    matList: [],
    toolList: [],
    lowCount: 0,
    tab: 'mat',
    kw: '',
    srcText: '加载中…',
    // 教职工才展示盘点/导出入口
    isStaff: false,
    // 模糊搜索下拉建议（与首页同一套能力：跨耗材/工具、带容错）
    suggest: [],
    showSuggest: false
  },
  onShow() {
    identity.syncGlobal()
    this.setData({ isStaff: identity.isStaff() })
    this.load()
  },
  // 下拉刷新：先清云端读缓存再重取，保证库存/工具状态是最新的
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },
  async load() {
    const [mats, tools] = await Promise.all([
      api.call('listMaterials', {}),
      api.call('listTools', {})
    ])
    const app = getApp()
    const src = app && app.globalData ? app.globalData.dataSource : ''
    const m = mats || []
    const t = tools || []
    // 预计算库存水位百分比、是否低于安全线与预警数，避免在 WXML 里做数值运算
    const mats2 = m.map(x => {
      const stock = Number(x.stock) || 0
      const safe = Number(x.safe) || 0
      return Object.assign({}, x, { pct: this.pct(stock, safe), low: stock < safe })
    })
    this.setData({
      mats: mats2,
      tools: t,
      lowCount: mats2.filter(x => (Number(x.stock) || 0) < (Number(x.safe) || 0)).length,
      srcText: src === 'cloud' ? '真实腾讯文档' : (src === 'mock' ? '本地演示数据' : '未知')
    })
    this.filter()
  },
  // 以安全库存为 100% 基准
  pct(stock, safe) {
    const s = Number(stock) || 0
    const f = Number(safe) || 0
    let p = f > 0 ? Math.round((s / f) * 100) : (s > 0 ? 100 : 0)
    if (p < 0) p = 0
    if (p > 100) p = 100
    return p
  },
  setTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t === 'tool' ? 'tool' : 'mat' })
    this.filter()
  },
  onKw(e) {
    this.setData({ kw: e.detail.value })
    this.filter()
    this.pullSuggest(e.detail.value)
  },
  // 局部过滤：在当前分段内做即时筛选（不触网，输入即响应）
  filter() {
    const kw = (this.data.kw || '').trim().toLowerCase()
    // 过滤维度扩展到规格与位置：此前只能按名称/ID，老师常常记得"A柜3"却搜不出来
    const hit = (x) => !kw ||
      (x.name || '').toLowerCase().indexOf(kw) >= 0 ||
      (x.id || '').toLowerCase().indexOf(kw) >= 0 ||
      (x.spec || '').toLowerCase().indexOf(kw) >= 0 ||
      (x.loc || '').toLowerCase().indexOf(kw) >= 0
    this.setData({
      matList: this.data.mats.filter(hit),
      toolList: this.data.tools.filter(hit)
    })
  },
  /* ---------- 模糊搜索下拉（P2-⑰：与首页同一套召回能力） ---------- */
  pullSuggest(v) {
    const kw = (v || '').trim()
    if (this._st) clearTimeout(this._st)
    if (!kw) { this.setData({ suggest: [], showSuggest: false }); return }
    this._st = setTimeout(async () => {
      const list = await api.call('search', { kw })
      // 仅当结果仍对应最新输入才渲染，避免快速输入时旧请求覆盖新结果
      if ((this.data.kw || '').trim() === kw) {
        this.setData({
          suggest: (list || []).slice(0, 8).map(x => Object.assign({}, x, {
            key: x.type + ':' + x.id,
            sub: x.sub || (x.stock !== undefined ? ('库存 ' + x.stock) : (x.status || ''))
          })),
          showSuggest: true
        })
      }
    }, 220)
  },
  // 键盘「完成」：有候选就直达第一条，否则回退到当前分段列表（不弹错误）
  pickSuggestFirst() {
    const first = this.data.suggest[0]
    if (first && this.data.showSuggest) return this.pickSuggest({ currentTarget: { dataset: { id: first.id } } })
  },
  pickSuggest(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ showSuggest: false })
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(('' + id).toUpperCase()) })
  },
  closeSuggest() { this.setData({ showSuggest: false }) },
  onSearchBlur() {
    // 延迟收起：先让 bindtap 命中候选项，否则点击瞬间下拉已消失会点空
    setTimeout(() => this.setData({ showSuggest: false }), 200)
  },
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    // encodeURIComponent：表里 ID 理论上规范，但含 & # ? 时会破坏 query 解析，防御性编码
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) })
  },
  /* ---------- 盘点 / 期初（P1-⑪⑫） + 导出（P1-⑩） ---------- */
  goStocktake() {
    wx.navigateTo({ url: '/pages/stocktake/stocktake' })
  },
  // 就地发起出入库：带 ID 与方向跳到登记页并自动选中，省掉重选一遍
  quickIo(e) {
    const id = e.currentTarget.dataset.id
    const dir = e.currentTarget.dataset.dir === 'out' ? 'out' : 'in'
    if (!id) return
    wx.navigateTo({ url: '/pages/io/io?pick=' + encodeURIComponent(id) + '&dir=' + dir })
  },
  exportList() {
    exporter.run(this.data.tab === 'tool' ? 'tools' : 'materials', false, '正在导出…')
  }
})

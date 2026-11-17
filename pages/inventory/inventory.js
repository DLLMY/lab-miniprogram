const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const codeUtil = require('../../utils/code.js')
const exporter = require('../../utils/export.js')
const importer = require('../../utils/importer.js')

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
    isAdmin: false,
    // 批量建档（后端已有 importMaterials/importTools，此前前端无入口）
    showImport: false, importText: '', importBusy: false,
    // 低库存一键补货入库（复用后端既有 batchIo 写操作，零后端改动）
    showReplenish: false, replenishRows: [], replenishNote: '', replenishBusy: false,
    // 模糊搜索下拉建议（与首页同一套能力：跨耗材/工具、带容错）
    suggest: [],
    showSuggest: false,
    // —— 工具操作：建档 / 借出 / 归还 ——
    // 此前工具只有「批量建档导入」一个建档入口（且在另一个分段），借出藏在「扫码→详情」页，
    // 台账列表里既不能建也不能借 → 老师根本找不到入口（第十一轮端到端审查发现）。
    // 全部复用后端既有能力：importTools / directBorrow / returnTool，零后端改动。
    showNewTool: false, toolForm: { name: '', id: '', spec: '', loc: '' }, newToolBusy: false,
    showLend: false, lendToolId: '', lendToolName: '', lendToolOptions: [], lendToolIdx: 0,
    lendBorrower: '', lendDays: 7, lendNote: '', borrowerPresets: [], borrowerHint: '',
    busy: false
  },
  // 支持首页直达工具分段：/pages/inventory/inventory?tab=tool
  onLoad(o) {
    if (o && o.tab === 'tool') this.setData({ tab: 'tool' })
  },
  onShow() {
    identity.syncGlobal()
    this.setData({ isStaff: identity.isStaff(), isAdmin: identity.isAdmin() })
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
    if (mats === null || tools === null) { this.setData({ loadErr: true }); return }
    const app = getApp()
    const src = (app && app.globalData && app.globalData.dataBackend) ||
      (app && app.globalData && app.globalData.dataSource) || ''
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
      srcText: api.backendLabel(src)
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
  },

  /* ---------- 低库存一键补货入库 ----------
     此前预警只到「看得到」为止：首页和统计页都提示「需补货」，但没有下一步动作，
     老师补完货还得逐个搜物品、逐个登记入库，闭环断裂。
     这里复用后端既有的 batchIo（一次写锁、逐项回读校验、逐项流水），零后端改动。 */
  openReplenish() {
    const low = (this.data.mats || []).filter(x => {
      const s = Number(x.stock) || 0
      const f = Number(x.safe) || 0
      return f > 0 && s < f
    })
    if (!low.length) {
      wx.showToast({ title: '当前没有低于安全线的耗材', icon: 'none' })
      return
    }
    // 默认补到安全线（不足 1 件时按 1 件计），老师可逐项改数量
    const rows = low.map(x => {
      const stock = Number(x.stock) || 0
      const safe = Number(x.safe) || 0
      const need = Math.max(1, safe - stock)
      return {
        key: x.id, id: x.id, name: x.name || x.id, unit: x.unit || '个',
        stock, safe, qty: need, checked: true
      }
    })
    this.setData({ showReplenish: true, replenishRows: rows, replenishNote: '' })
  },
  closeReplenish() { this.setData({ showReplenish: false }) },
  toggleReplenish(e) {
    const key = e.currentTarget.dataset.key
    this.setData({
      'replenishRows': this.data.replenishRows.map(r => r.key === key ? Object.assign({}, r, { checked: !r.checked }) : r)
    })
  },
  onReplenishQty(e) {
    const key = e.currentTarget.dataset.key
    const raw = e.detail.value
    let q = parseInt(raw, 10)
    if (!q || q < 1) q = 1
    if (q > 99999) q = 99999
    this.setData({
      'replenishRows': this.data.replenishRows.map(r => r.key === key ? Object.assign({}, r, { qty: q }) : r)
    })
  },
  onReplenishNote(e) { this.setData({ replenishNote: e.detail.value }) },
  async submitReplenish() {
    if (this.data.replenishBusy) return
    const me = identity.current()
    if (!me) { wx.showToast({ title: '请先登录', icon: 'none' }); return }
    const picked = (this.data.replenishRows || []).filter(r => r.checked)
    if (!picked.length) { wx.showToast({ title: '请至少勾选一项', icon: 'none' }); return }
    const items = picked.map(r => ({ matId: r.id, qty: Number(r.qty) || 0 }))
    const total = items.reduce((s, x) => s + x.qty, 0)
    const c = await new Promise(res => wx.showModal({
      title: '补货入库确认',
      content: '将把 ' + items.length + ' 项耗材入库，共 ' + total + ' 件，并生成对应的入库流水。确定继续？',
      success: res
    }))
    if (!c.confirm) return
    this.setData({ replenishBusy: true })
    wx.showLoading({ title: '入库中…', mask: true })
    let r = null
    try {
      r = await api.callFull('batchIo', {
        type: 'in',
        items,
        actor: me.id,
        note: (this.data.replenishNote || '').trim() || '低库存补货入库',
        src: '补货入库'
      }, { noFallback: true })
    } catch (e) {
      r = null
    } finally {
      wx.hideLoading()
      this.setData({ replenishBusy: false })
    }
    if (r && r.code === 0) {
      const d = r.data || {}
      const errs = (d.details || []).filter(x => x.err)
      this.setData({ showReplenish: false })
      // 幂等命中：5 秒内提交了完全相同的一批补货 → 后端只执行一次，必须说明
      const idemW = api.idemWarn(r)
      wx.showModal({
        title: idemW ? '重复提交已忽略' : '入库完成',
        content: (idemW ? (idemW + '\n') : '') + '成功 ' + (d.done || 0) + ' 项' +
          (errs.length ? '，失败 ' + errs.length + ' 项：\n' + errs.map(x => x.matId + '（' + x.err + '）').join('\n') : ''),
        showCancel: false, confirmText: '知道了'
      })
      await this.load()
    } else {
      wx.showToast({ title: (r && r.data && r.data.msg) || '入库失败，请重试', icon: 'none' })
    }
  },

  /* ---------- 批量建档导入 ---------- */
  openImport() {
    const tool = this.data.tab === 'tool'
    this.setData({
      showImport: true, importText: '',
      importHint: tool
        ? '每行一件：名称,编号,规格,位置,状态,持有人（编号可留空自动 Txxx）'
        : '每行一件：名称,编号,规格,类别,位置,单位,期初库存,预警线,有效期（编号可留空自动 Mxxx；有效期选填，格式 2027-06-30）'
    })
  },
  closeImport() { this.setData({ showImport: false }) },
  noop() {},
  onImportText(e) { this.setData({ importText: e.detail.value }) },
  async submitImport() {
    if (this.data.importBusy) return
    const me = identity.current()
    if (!me) { wx.showToast({ title: '请先登录', icon: 'none' }); return }
    const parsed = importer.parseImport(this.data.importText, tool ? 'tool' : 'material')
    const rows = parsed.rows
    if (!rows.length) { wx.showToast({ title: '没有可导入的行', icon: 'none' }); return }
    const c = await new Promise(res => wx.showModal({
      title: '批量建档确认',
      content: '将导入 ' + rows.length + ' 条' + (tool ? '工具' : '耗材') + '，同编号/同名称会覆盖更新并写流水。确定继续？',
      success: res
    }))
    if (!c.confirm) return
    this.setData({ importBusy: true })
    wx.showLoading({ title: '导入中…', mask: true })
    try {
      const r = await api.callFull(tool ? 'importTools' : 'importMaterials',
        { rows, actor: me.id }, { noFallback: true })
      wx.hideLoading()
      if (r && r.code === 0) {
        const d = r.data || {}
        this.setData({ showImport: false })
        wx.showModal({
          title: '导入完成',
          content: '新建 ' + (d.created || 0) + ' 条，更新 ' + (d.updated || 0) + ' 条，跳过 ' + (d.skipped || 0) + ' 条',
          showCancel: false, confirmText: '知道了'
        })
        await this.load()
      } else {
        wx.showModal({ title: '导入失败', content: (r && r.data && r.data.msg) || '请重试', showCancel: false })
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '导入请求失败，请重试', icon: 'none' })
    } finally {
      this.setData({ importBusy: false })
    }
  },

  /* ---------- 工具：单件建档（管理员） ----------
     复用后端 importTools（零后端改动）：传一行即可建档，编号留空由服务端自动生成 Txxx。 */
  openNewTool() {
    // 权限与耗材建档对齐（教师可建单件）；批量导入仍是管理员专属
    if (!this.data.isStaff) { wx.showToast({ title: '仅教师可新建工具', icon: 'none' }); return }
    this.setData({ showNewTool: true, toolForm: { name: '', id: '', spec: '', loc: '' } })
  },
  closeNewTool() { this.setData({ showNewTool: false }) },
  toolNameInput(e) { this.setData({ 'toolForm.name': e.detail.value }) },
  toolIdInput(e) { this.setData({ 'toolForm.id': e.detail.value }) },
  toolSpecInput(e) { this.setData({ 'toolForm.spec': e.detail.value }) },
  toolLocInput(e) { this.setData({ 'toolForm.loc': e.detail.value }) },
  async submitNewTool() {
    if (this.data.newToolBusy) return
    const f = this.data.toolForm || {}
    const name = (f.name || '').trim()
    if (!name) { wx.showToast({ title: '请填写工具名称', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ newToolBusy: true })
    wx.showLoading({ title: '建档中…', mask: true })
    let r = null
    try {
      // 单件建档用 addTool（教师可建、不覆盖同名）；批量覆盖更新才走管理员专属的 importTools
      r = await api.callFull('addTool', {
        name,
        id: (f.id || '').trim(),
        spec: (f.spec || '').trim(),
        loc: (f.loc || '').trim(),
        actor: me.id
      }, { noFallback: true })
    } catch (e) {
      r = null
    } finally {
      wx.hideLoading()
      this.setData({ newToolBusy: false })
    }
    if (r && r.code === 0) {
      this.setData({ showNewTool: false })
      const idemW = api.idemWarn(r)
      wx.showToast({ title: idemW || '已建档', icon: idemW ? 'none' : 'success' })
      await this.load()
    } else {
      wx.showModal({ title: '建档失败', content: (r && r.data && r.data.msg) || '请重试', showCancel: false })
    }
  },

  /* ---------- 工具：扫码登记（工具的「入库」）----------
     耗材有数量，出入库用数量增减；工具一件一码、没有库存数量，
     它的「入库」= 建档（在库）。这里扫码逐件登记：
       · 扫到已在册的工具 → 提示当前状态，可直接跳详情；
       · 扫到没登记过的 → 预填编号，补填名称/规格/位置后建档。 */
  scanTool() {
    if (!this.data.isStaff) { wx.showToast({ title: '仅教师可登记工具', icon: 'none' }); return }
    wx.scanCode({
      success: (r) => {
        // 复用统一物品码解析：本系统二维码是 ITEM:<ID>，第三方码可能带 ?id=
        const id = codeUtil.parseItemCode(r.result)
        if (!id) { wx.showToast({ title: '未识别到物品ID', icon: 'none' }); return }
        const exist = (this.data.toolList || []).find(t => ('' + (t.id || '')).trim().toUpperCase() === id)
        if (exist) {
          wx.showModal({
            title: '该工具已在册',
            content: exist.name + '（' + exist.id + '）\n当前状态：' + (exist.status || '在库') + '\n要查看详情吗？',
            confirmText: '查看详情',
            success: (res) => {
              if (res.confirm) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) + '&type=tool' })
            }
          })
          return
        }
        // 未登记 → 预填编号，补填名称/规格/位置后建档
        this.setData({ showNewTool: true, toolForm: { name: '', id: id, spec: '', loc: '' } })
        wx.showToast({ title: '新工具 ' + id + '，请补填名称', icon: 'none' })
      },
      fail: () => wx.showToast({ title: '扫码取消或模拟器不支持', icon: 'none' })
    })
  },

  /* ---------- 工具：借出（教师/管理员） ----------
     复用后端 directBorrow：借用人工号必填，服务端按带班可见性校验（只能借给本班学生）。 */
  async openLend(e) {
    if (!this.data.isStaff) { wx.showToast({ title: '仅教师可借出工具', icon: 'none' }); return }
    const inStock = (this.data.toolList || []).filter(x => x.status === '在库')
    if (!inStock.length) { wx.showToast({ title: '没有在库的工具', icon: 'none' }); return }
    const ds = e && e.currentTarget && e.currentTarget.dataset ? ('' + (e.currentTarget.dataset.id || '')) : ''
    let idx = 0
    if (ds) {
      const i = inStock.findIndex(x => ('' + x.id) === ds)
      if (i >= 0) idx = i
    }
    this.setData({
      showLend: true,
      lendToolOptions: inStock.map(x => x.name + '（' + x.id + '）'),
      lendToolIdx: idx,
      lendToolId: inStock[idx] ? inStock[idx].id : '',
      lendToolName: inStock[idx] ? inStock[idx].name : '',
      lendBorrower: '', lendDays: 7, lendNote: '', borrowerHint: ''
    })
    await this.loadBorrowers()
  },
  closeLend() { this.setData({ showLend: false }) },
  // 借用人候选：本班学生（服务端已按层级/带班过滤）；加载失败不阻断手动输入工号
  async loadBorrowers() {
    try {
      const me = identity.current()
      const list = await api.call('adminListUsers', me ? { actor: me.id } : {})
      const students = (Array.isArray(list) ? list : [])
        .filter(u => u.role === 'student')
        .slice(0, 30)
        .map(u => ({ id: u.id, name: u.name }))
      this.setData({ borrowerPresets: students })
    } catch (e) {
      this.setData({ borrowerPresets: [], borrowerHint: '候选名单加载失败，可直接手动输入借用工号' })
    }
  },
  onLendTool(e) {
    const i = Number(e.detail.value)
    const inStock = (this.data.toolList || []).filter(x => x.status === '在库')
    const t = inStock[i]
    this.setData({ lendToolIdx: i, lendToolId: t ? t.id : '', lendToolName: t ? t.name : '' })
  },
  lendBorrowerInput(e) { this.setData({ lendBorrower: e.detail.value, borrowerHint: '' }) },
  pickBorrower(e) {
    const id = e.currentTarget.dataset.id || ''
    this.setData({ lendBorrower: id, borrowerHint: '' })
  },
  lendNoteInput(e) { this.setData({ lendNote: e.detail.value }) },
  lendDaysInput(e) {
    let d = parseInt(e.detail.value, 10)
    if (!d || d < 1) d = 1
    if (d > 90) d = 90
    this.setData({ lendDays: d })
  },
  lendDayStep(e) {
    const delta = parseInt(e.currentTarget.dataset.d, 10) || 0
    let d = (parseInt(this.data.lendDays, 10) || 7) + delta
    if (d < 1) d = 1
    if (d > 90) d = 90
    this.setData({ lendDays: d })
  },
  async submitLend() {
    if (this.data.busy) return
    if (!this.data.lendToolId) { wx.showToast({ title: '请选择要借出的工具', icon: 'none' }); return }
    const borrower = (this.data.lendBorrower || '').trim()
    if (!borrower) { wx.showToast({ title: '请填写借用工号', icon: 'none' }); return }
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    this.setData({ busy: true })
    api.warnIfDemo()
    wx.showLoading({ title: '登记中…', mask: true })
    let r = null
    try {
      r = await api.callFull('directBorrow', {
        actor: me.id,
        toolId: this.data.lendToolId,
        borrower,
        days: parseInt(this.data.lendDays, 10) || 7,
        note: (this.data.lendNote || '').trim()
      }, { noFallback: true })
    } catch (e) {
      r = null
    } finally {
      wx.hideLoading()
      this.setData({ busy: false })
    }
    if (r && r.code === 0) {
      this.setData({ showLend: false })
      wx.showToast({ title: '已借出', icon: 'success' })
      await this.load()
    } else {
      wx.showModal({ title: '借出失败', content: (r && r.data && r.data.msg) || '请重试', showCancel: false })
    }
  },

  /* ---------- 工具：归还（教师代还；学生也可在「我的」页自助归还）---------- */
  async doReturn(e) {
    const id = e.currentTarget.dataset.id || ''
    if (!id) return
    const c = await new Promise(res => wx.showModal({
      title: '确认归还',
      content: '确认把工具 ' + id + ' 归还入库？归还后工具恢复「在库」状态。',
      success: res
    }))
    if (!c.confirm) return
    const me = identity.current()
    if (!me) { wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' }); return }
    let r = null
    try {
      r = await api.callFull('returnTool', { toolId: id, actor: me.id }, { noFallback: true })
    } catch (e) {
      r = null
    }
    if (r && r.code === 0) {
      wx.showToast({ title: '已归还', icon: 'success' })
      await this.load()
    } else {
      wx.showModal({ title: '归还失败', content: (r && r.data && r.data.msg) || '请重试', showCancel: false })
    }
  }
})

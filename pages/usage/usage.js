const api = require('../../utils/api.js')
const identity = require('../../utils/identity.js')
const exporter = require('../../utils/export.js')

Page({
  data: {
    allow: false, stat: null, teachers: [], rank: [], me: null, roleText: '未登录', loadErr: false,
    // 按班级领用分布（复用领用记录页已有的 listClaims.byCls，后端无新增）
    byCls: [], clsMax: 1
  },
  onShow() {
    // 角色以持久化身份为准（app.globalData.role 冷启动/切号后可能是旧值）
    identity.syncGlobal()
    const i = identity.current()
    const allow = identity.isStaff()
    this.setData({ allow, me: i, roleText: i ? identity.roleText(i.role) : '未登录' })
    if (allow) this.load()
  },
  switchAccount() {
    identity.switchAccount()
  },
  // 下拉刷新：先清云端读缓存再重取统计
  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh()
    if (!this.data.allow) { done(); return }
    api.call('fresh', {}).then(() => this.load()).then(done, done)
  },
  async load() {
    const [d, claims] = await Promise.all([
      api.call('usage', {}),
      // 按班级领用分布：后端 listClaims 已返回 byCls 汇总，这里直接复用，不新增接口
      api.call('listClaims', { limit: 200 })
    ])
    // null = 云端业务错误：历史上静默不渲染，整页除了权限拦截就是空白，
    // 用户分不清「没数据」还是「没加载出来」。显式落 loadErr 由 WXML 展示重试提示。
    if (!d) {
      this.setData({ stat: null, teachers: [], rank: [], loadErr: true, byCls: [], clsMax: 1 })
      return
    }
    // 注入中文角色名 + 头像首字 + 进度百分比，避免页面直接显示英文 role / 做数值运算
    const raw = d.rank || []
    const max = raw.reduce((m, x) => Math.max(m, Number(x.n) || 0), 0) || 1
    const rank = raw.map(x => ({
      ...x,
      // wx:key 不支持『user.id』这种点路径，必须给一个顶层唯一字段，否则列表 diff 失效并告警
      key: (x.user && x.user.id) || x.id || '',
      roleText: x.user ? identity.roleText(x.user.role) : '?',
      initial: x.user && x.user.name ? x.user.name.charAt(0) : '?',
      pct: Math.max(6, Math.round(((Number(x.n) || 0) / max) * 100))
    }))
    const teachers = rank.filter(x => x.user && x.user.role === 'teacher')

    // 报表数据的展示预处理：柱高百分比、排行条百分比、月份短标签都在 JS 里算好，
    // WXML 不做数值运算（保持与既有页面一致的写法，也避免空值 NaN 污染渲染）
    const trendMax = Number(d.trendMax) || 1
    const trend = (d.trend || []).map(x => ({
      m: x.m, short: ('' + x.m).slice(5) + '月',
      in: x.in || 0, out: x.out || 0,
      inH: Math.round(((Number(x.in) || 0) / trendMax) * 100),
      outH: Math.round(((Number(x.out) || 0) / trendMax) * 100)
    }))
    const topMax = Math.max(1, ...(d.topMaterials || []).map(x => Number(x.qty) || 0))
    const topMaterials = (d.topMaterials || []).map(x => ({
      ...x, unit: x.unit || '', pct: Math.max(6, Math.round(((Number(x.qty) || 0) / topMax) * 100))
    }))
    const stat = Object.assign({}, d, { trend, topMaterials })

    // 按班级领用分布：数量取领用单汇总，百分比按最大班级归一（与排行条同一套算法）
    const rawCls = (claims && claims.byCls) || []
    const clsMax = rawCls.reduce((m, x) => Math.max(m, Number(x.qty) || 0), 0) || 1
    const byCls = rawCls.map(x => ({
      // 后端在无班级时给的是「未标注班级」，这里再兜一次并另存 title：
      // 模板直接用 title，不再出现 item.cls，避免旧数据下渲染出空标题。
      title: x.cls || '未标注班级',
      qty: Number(x.qty) || 0,
      count: Number(x.count) || 0,
      pct: Math.max(6, Math.round(((Number(x.qty) || 0) / clsMax) * 100))
    }))

    this.setData({
      stat,
      teachers,
      rank,
      byCls,
      clsMax,
      // 旧版云函数（尚未重传）不含报表字段，用空集合兜底，避免 WXML 读 undefined 报错
      loadErr: false
    })
  },

  // 导出统计：报表是前端聚合出来的，后端 exportData 无对应分支，故本地组装 CSV。
  // 分段写入（概览 / 排行 / 趋势 / 按班级），Excel 打开后分段清晰。
  exportStat() {
    const s = this.data.stat
    if (!s) { wx.showToast({ title: '暂无可导出的数据', icon: 'none' }); return }
    const sections = []
    sections.push({
      title: '统计概览',
      header: ['指标', '数值'],
      rows: [
        ['操作总次数', s.total || 0],
        ['活跃人数', s.activeUsers || 0],
        ['教师活跃/在册', (s.teacherActive || 0) + '/' + (s.teacherTotal || 0)],
        ['借出记录总数', (s.borrow && s.borrow.total) || 0],
        ['未归还', (s.borrow && s.borrow.open) || 0],
        ['逾期未归还', (s.overdue && s.overdue.length) || 0],
        ['待审批申请', (s.reqStat && s.reqStat.pending) || 0],
        ['低库存物品数', (s.lowStock && s.lowStock.length) || 0]
      ]
    })
    sections.push({
      title: '活跃度排行',
      header: ['工号', '姓名', '角色', '操作次数', '最近操作'],
      rows: (this.data.rank || []).map(x => [
        (x.user && x.user.id) || '', (x.user && x.user.name) || '',
        x.roleText || '', x.n || 0, x.last || ''
      ])
    })
    sections.push({
      title: '出入库趋势',
      header: ['月份', '入库', '出库'],
      rows: (s.trend || []).map(x => [x.m, x.in || 0, x.out || 0])
    })
    sections.push({
      title: '逾期未归还',
      header: ['工具ID', '借用人', '应还日期', '借出备注'],
      rows: (s.overdue || []).map(x => [x.toolId, x.user, x.plan, x.note || ''])
    })
    sections.push({
      title: '按班级领用分布',
      header: ['班级', '领用数量', '申请单数'],
      rows: (this.data.byCls || []).map(x => [x.cls, x.qty, x.count])
    })
    const p = n => ('' + n).padStart(2, '0')
    const dt = new Date(Date.now() + 8 * 3600 * 1000)
    const stamp = '' + dt.getUTCFullYear() + p(dt.getUTCMonth() + 1) + p(dt.getUTCDate()) + '_' + p(dt.getUTCHours()) + p(dt.getUTCMinutes())
    exporter.runLocal(sections, '阿磊的工具箱-使用统计_' + stamp + '.csv', '正在导出统计…')
  }
})

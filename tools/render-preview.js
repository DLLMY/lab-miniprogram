/**
 * WXML → HTML 高保真预览渲染器
 * 目的：在浏览器里还原小程序页面的真实视觉（复用真实 WXSS + 真实 PNG 图标 + 真实 {{}} 表达式求值），
 *       便于在未部署到微信开发者工具前先行评审 UI 效果。
 * 用法：node tools/render-preview.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'preview')

/* ---------------- rpx → px（750rpx = 375px 宽） ---------------- */
const rpx = (v) => v.replace(/(-?[\d.]+)rpx/g, (m, n) => (parseFloat(n) / 2).toFixed(3) + 'px')

/* ---------------- 极简 XML 解析器 ---------------- */
function parse(src) {
  const root = { tag: '#root', attrs: {}, children: [] }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(src))) {
    if (m[0].startsWith('<!--')) continue
    if (m[5] !== undefined) {                       // 文本
      const t = m[5]
      if (t.trim()) stack[stack.length - 1].children.push({ text: t })
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2]
    const selfClose = m[4] === '/'
    const attrs = {}
    const ar = /([\w:-]+)(?:="([^"]*)")?/g
    let a
    while ((a = ar.exec(m[3] || ''))) attrs[a[1]] = a[2] === undefined ? '' : a[2]
    if (closing) { if (stack.length > 1) stack.pop(); continue }
    const node = { tag, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
  }
  return root
}

/* ---------------- {{}} 表达式求值 ---------------- */
function evalExpr(expr, scope) {
  try {
    // 属性值可能带 {{}} 包裹，先剥离
    let e = String(expr).trim()
    if (e.startsWith('{{') && e.endsWith('}}')) e = e.slice(2, -2).trim()
    if (e.indexOf('{{') >= 0) e = e.replace(/\{\{([\s\S]+?)\}\}/g, '$1')
    if (!e) return ''
    const keys = Object.keys(scope)
    const fn = new Function(...keys, 'try{return (' + e + ')}catch(e){return ""}')
    return fn(...keys.map(k => scope[k]))
  } catch (e) { return '' }
}
function interp(str, scope) {
  if (str === undefined || str === null) return ''
  if (typeof str !== 'string') return String(str)
  if (str.indexOf('{{') < 0) return str
  return str.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
    const v = evalExpr(e.trim(), scope)
    return v === undefined || v === null ? '' : String(v)
  })
}

/* ---------------- 节点渲染（wx:for 分支） ---------------- */
function render(node, scope, out) {
  if (node.text !== undefined) { out.push(interp(node.text, scope)); return }
  const at = node.attrs

  // wx:for
  if (at['wx:for']) {
    const list = evalExpr(at['wx:for'], scope) || []
    const itemName = at['wx:for-item'] || 'item'
    const idxName = at['wx:for-index'] || 'index'
    ;(Array.isArray(list) ? list : []).forEach((it, i) => {
      const s2 = Object.assign({}, scope)
      s2[itemName] = it
      s2[idxName] = i
      render(node, s2, out)
    })
    return
  }
  renderChildren(node, scope, out, {})
}

function renderChildren(node, scope, out) {
  const kids = node.children || []
  kids.forEach((k, i) => {
    if (k.tag) k.__siblings = kids
    if (k.tag && k.attrs['wx:if'] !== undefined) {
      // 找同层后续 elif/else
      let taken = false
      for (let j = i + 1; j < kids.length; j++) {
        const s = kids[j]
        if (s.attrs['wx:elif'] !== undefined) {
          if (evalExpr(s.attrs['wx:elif'], scope)) { renderChildren(s, scope, out); taken = true; break }
        } else if (s.attrs['wx:else'] !== undefined) {
          renderChildren(s, scope, out); taken = true; break
        } else break
      }
      if (taken) return
      if (!evalExpr(k.attrs['wx:if'], scope)) return
      renderChildren(k, scope, out)
      return
    }
    render(k, scope, out)
  })
}

/* ---------------- 标签映射（小程序标签 → 合法 HTML） ---------------- */
const TAG_MAP = {
  view: 'div', text: 'span', image: 'img', input: 'input', button: 'button',
  block: 'div', scroll: 'div', swiper: 'div', navigator: 'div', label: 'label',
  picker: 'div', checkbox: 'span', radio: 'span', switch: 'span', slider: 'div',
  progress: 'div', icon: 'span', form: 'div', textarea: 'textarea', canvas: 'canvas'
}

/* ---------------- HTML 输出 ---------------- */
const IMG_CACHE = {}
function imgSrc(p) {
  if (!p) return ''
  if (IMG_CACHE[p]) return IMG_CACHE[p]
  const file = path.join(ROOT, p.replace(/^\//, ''))
  let b64 = ''
  try { b64 = fs.readFileSync(file).toString('base64') } catch (e) { b64 = '' }
  IMG_CACHE[p] = 'data:image/png;base64,' + b64
  return IMG_CACHE[p]
}

function toHtml(node, scope) {
  if (node.text !== undefined) return interp(node.text, scope)
  const at = node.attrs
  const tag = node.tag
  const cls = at.class || ''
  const style = at.style ? ' style="' + rpx(at.style).replace(/"/g, '&quot;') + '"' : ''

  // wx:for —— 展开列表，每个元素注入 item / index
  if (at['wx:for'] !== undefined) {
    const list = evalExpr(at['wx:for'], scope) || []
    const itemName = at['wx:for-item'] || 'item'
    const idxName = at['wx:for-index'] || 'index'
    const arr = Array.isArray(list) ? list : []
    const clean = Object.assign({}, at)
    delete clean['wx:for']
    return arr.map((it, i) => {
      const s2 = Object.assign({}, scope)
      s2[itemName] = it
      s2[idxName] = i
      return toHtml(Object.assign({}, node, { attrs: clean }), s2)
    }).join('')
  }

  if (tag === 'image') {
    const src = interp(at.src, scope)
    const mode = at.mode || 'scaleToFill'
    const obj = mode === 'aspectFit' ? 'object-fit:contain;' : 'object-fit:cover;'
    return '<img class="' + cls + '" src="' + imgSrc(src) + '" style="' + obj + '">'
  }
  if (tag === 'input') {
    const ph = interp(at.placeholder, scope)
    const val = interp(at.value, scope)
    return '<input class="' + cls + '" placeholder="' + ph + '" value="' + val + '" readonly>'
  }
  if (tag === 'button') {
    const dis = at.disabled !== undefined && evalExpr(at.disabled, scope)
    return '<div class="btn-wrap' + (dis ? ' dis' : '') + '"><span class="btn-text">' +
      renderChildrenToStr(node, scope) + '</span></div>'
  }
  if (tag === 'block') return renderChildrenToStr(node, scope)

  const htmlTag = TAG_MAP[tag] || 'div'
  const inner = renderChildrenToStr(node, scope)
  return '<' + htmlTag + ' class="' + cls + '"' + style + '>' + inner + '</' + htmlTag + '>'
}

function renderChildrenToStr(node, scope) {
  const out = []
  const kids = node.children || []
  kids.forEach((k, i) => {
    // wx:elif / wx:else 由前面的 wx:if 分支统一处理，这里跳过
    if (k.tag && (k.attrs['wx:elif'] !== undefined || k.attrs['wx:else'] !== undefined)) return

    if (k.tag && k.attrs['wx:if'] !== undefined) {
      // ① wx:if 自身为真 → 渲染本节点（含其子节点），不碰后续 elif/else
      if (evalExpr(k.attrs['wx:if'], scope)) {
        out.push(toHtml(k, scope))
        return
      }
      // ② wx:if 为假 → 顺次找后续 wx:elif（为真即渲染） / wx:else（兜底渲染）
      for (let j = i + 1; j < kids.length; j++) {
        const s = kids[j]
        if (s.attrs['wx:elif'] !== undefined) {
          if (evalExpr(s.attrs['wx:elif'], scope)) { out.push(toHtml(s, scope)); return }
        } else if (s.attrs['wx:else'] !== undefined) {
          out.push(toHtml(s, scope)); return
        } else break
      }
      return
    }
    out.push(toHtml(k, scope))
  })
  return out.join('')
}

/* ---------------- 页面定义 ---------------- */
const roleText = (r) => ({ student: '学生', teacher: '教师', admin: '管理员' }[r] || '未登录')

const PAGES = [
  {
    id: 'login', file: 'pages/login/login', title: '登录 · 绑定身份',
    nav: '实训室管理系统', tab: null,
    scope: {
      name: '', id: '', busy: false,
      users: [
        { id: 'S001', name: '张三', role: 'student', cls: '24电气1', initial: '张' },
        { id: 'S002', name: '李四', role: 'student', cls: '24电气1', initial: '李' },
        { id: 'T001', name: '邓老师', role: 'teacher', cls: '', initial: '邓' },
        { id: 'A001', name: '王管理员', role: 'admin', cls: '', initial: '王' }
      ]
    }
  },
  {
    id: 'index', file: 'pages/index/index', title: '工作台', nav: '实训室管理系统', tab: '工作台',
    scope: {
      me: { id: 'T001', name: '邓老师', role: 'teacher' }, meInitial: '邓',
      roleText: '教师', isStaff: true, greet: '下午好', qid: '',
      matCount: 4, toolCount: 3, pendingCount: 1,
      samples: [
        { id: 'M001', name: '电阻包' }, { id: 'M002', name: '面包板' }, { id: 'M003', name: '杜邦线' },
        { id: 'T001', name: '万用表' }, { id: 'T002', name: '电烙铁' }, { id: 'T003', name: '示波器' }
      ]
    }
  },
  {
    id: 'mine', file: 'pages/mine/mine', title: '我的', nav: '实训室管理系统', tab: '我的',
    scope: {
      me: { id: 'T001', name: '邓老师', role: 'teacher' }, meInitial: '邓',
      roleText: '教师', isStaff: true, isDemo: true, showReset: true,
      rs: [{ kind: 'material', qty: 2, no: 'R20261001', time: '2026-10-22 09:30', status: 'pending' }],
      bs: [{ id: 'T002', out: '2026-10-20 10:12', status: '借出' }],
      srcText: '真实腾讯文档', srcOk: true,
      diag: { rawUseMock: 'false', fileId: '6b21...', accessToken: '有效', openId: 'oXyZ***', tokenExp: '2026-10-23 18:00', node: 'nodejs18', hasFetch: true },
      diagText: '已连真实腾讯文档，materials 读到 4 条', diagOk: true
    }
  },
  {
    id: 'detail', file: 'pages/detail/detail', title: '物品详情', nav: '实训室管理系统', tab: null,
    scope: {
      type: 'material', role: 'student', stockPct: 250 > 100 ? 100 : 250,
      item: { id: 'M001', name: '电阻包(1kΩ)', cat: '电子耗材', unit: '包', safe: 10, stock: 25, loc: 'A柜1层' }
    }
  },
  {
    id: 'approve', file: 'pages/approve/approve', title: '领用审批', nav: '实训室管理系统', tab: null,
    scope: {
      allow: true, me: { id: 'T001', name: '邓老师', role: 'teacher' }, roleText: '教师',
      list: [
        { kind: 'material', matId: 'M003', qty: 2, user: '李四', no: 'R20261001', time: '2026-10-22 09:30' },
        { kind: 'tool', toolId: 'T003', user: '张三', no: 'R20261002', time: '2026-10-22 10:15' }
      ]
    }
  },
  {
    id: 'io', file: 'pages/io/io', title: '出入库登记', nav: '实训室管理系统', tab: null,
    scope: {
      allow: true, roleText: '教师', type: 'in', qty: 10, idx: 0,
      showNew: false,
      nmName: '', nmSpec: '', nmCat: '', nmLoc: '', nmUnit: '个', nmSafe: '', nmQty: 1,
      logs: [
        { id: 'S1', item: 'M003', itemName: '焊锡丝', dir: '入库', isIn: true, qty: 20, op: 'A001', time: '2026-10-22 14:00', note: '补充', icon: '/images/ic-plus-b.png' },
        { id: 'S2', item: 'M002', itemName: '杜邦线', dir: '出库', isIn: false, qty: 240, op: 'T001', time: '2026-10-22 11:20', note: '领用扣减', icon: '/images/ic-minus-b.png' },
        { id: 'S3', item: 'M001', itemName: '电阻 10kΩ', dir: '入库', isIn: true, qty: 500, op: 'A001', time: '2026-10-22 09:05', note: '期初入库', icon: '/images/ic-plus-b.png' }
      ],
      mats: [
        { id: 'M001', name: '电阻包(1kΩ)', stock: 25, safe: 10, unit: '包' },
        { id: 'M002', name: '面包板', stock: 3, safe: 5, unit: '块' }
      ],
      curMat: { id: 'M001', name: '电阻包(1kΩ)', stock: 25, safe: 10, unit: '包' }, afterStock: 35
    }
  },
  {
    id: 'usage', file: 'pages/usage/usage', title: '使用概况', nav: '实训室管理系统', tab: null,
    scope: {
      allow: true, roleText: '教师',
      stat: { total: 128, activeUsers: 12, teacherActive: 3, teacherTotal: 5 },
      teachers: [
        { user: { name: '邓老师', role: 'teacher' }, n: 46, last: '2026-10-22 16:20', initial: '邓' },
        { user: { name: '周老师', role: 'teacher' }, n: 22, last: '2026-10-22 11:05', initial: '周' },
        { user: { name: '陈老师', role: 'teacher' }, n: 0, last: '', initial: '陈' }
      ],
      rank: [
        { user: { name: '邓老师', role: 'teacher' }, n: 46, roleText: '教师', initial: '邓', pct: 100 },
        { user: { name: '李四', role: 'student' }, n: 31, roleText: '学生', initial: '李', pct: 67 },
        { user: { name: '周老师', role: 'teacher' }, n: 22, roleText: '教师', initial: '周', pct: 48 },
        { user: { name: '张三', role: 'student' }, n: 12, roleText: '学生', initial: '张', pct: 26 }
      ]
    }
  },
  {
    id: 'inventory', file: 'pages/inventory/inventory', title: '库存一览', nav: '实训室管理系统', tab: null,
    scope: {
      tab: 'mat', kw: '', srcText: '真实腾讯文档', lowCount: 2,
      mats: [
        { id: 'M001', name: '电阻包(1kΩ)', cat: '电子耗材', unit: '包', safe: 10, stock: 25, loc: 'A柜1层', pct: 100 },
        { id: 'M002', name: '面包板', cat: '电子耗材', unit: '块', safe: 5, stock: 3, loc: 'A柜2层', pct: 60 },
        { id: 'M003', name: '杜邦线(公对母)', cat: '电子耗材', unit: '扎', safe: 20, stock: 40, loc: 'B柜1层', pct: 100 },
        { id: 'M004', name: '焊锡丝', cat: '焊接耗材', unit: '卷', safe: 3, stock: 1, loc: 'C柜', pct: 33 }
      ],
      matList: [
        { id: 'M001', name: '电阻包(1kΩ)', cat: '电子耗材', unit: '包', safe: 10, stock: 25, loc: 'A柜1层', pct: 100 },
        { id: 'M002', name: '面包板', cat: '电子耗材', unit: '块', safe: 5, stock: 3, loc: 'A柜2层', pct: 60 },
        { id: 'M003', name: '杜邦线(公对母)', cat: '电子耗材', unit: '扎', safe: 20, stock: 40, loc: 'B柜1层', pct: 100 },
        { id: 'M004', name: '焊锡丝', cat: '焊接耗材', unit: '卷', safe: 3, stock: 1, loc: 'C柜', pct: 33 }
      ],
      tools: [
        { id: 'T001', name: '万用表 FLUKE-17', sn: 'FL-17001', status: '在库', borrower: '' },
        { id: 'T002', name: '电烙铁 60W', sn: 'LT-2002', status: '借出', borrower: '李四' },
        { id: 'T003', name: '示波器 SDS1104', sn: 'OS-1104', status: '在库', borrower: '' }
      ],
      toolList: [
        { id: 'T001', name: '万用表 FLUKE-17', sn: 'FL-17001', status: '在库', borrower: '' },
        { id: 'T002', name: '电烙铁 60W', sn: 'LT-2002', status: '借出', borrower: '李四' },
        { id: 'T003', name: '示波器 SDS1104', sn: 'OS-1104', status: '在库', borrower: '' }
      ]
    }
  }
]

/* ---------------- 组装输出 ---------------- */
function buildCss() {
  const global = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  const parts = [global]
  PAGES.forEach(p => {
    const f = path.join(ROOT, p.file + '.wxss')
    if (fs.existsSync(f)) parts.push('/* ==== ' + p.id + ' ==== */\n' + fs.readFileSync(f, 'utf8'))
  })
  let css = parts.join('\n')
  css = rpx(css)
  // 小程序 page 元素选择器 → 预览容器 .screen（须避开 .page / .login-page 这类类名）
  css = css.replace(/(^|[^.\w-])page\s*\{/g, (m, pre) => pre + '.screen {')
  // 小程序标签选择器 → HTML 标签选择器（WXSS 里的 image/text/view 等在小程序里是组件标签）
  css = css.replace(/(\s|^)(image|text|view|input|button|picker|scroll-view|block|icon)(\s*[,{>])/g,
    (m, pre, tag, post) => pre + TAG_MAP[tag] + post)
  return css
}

function tabbarHtml(active) {
  const items = [
    { k: 'work', t: '工作台', ic: 'ic-grid-s' },
    { k: 'mine', t: '我的', ic: 'ic-user-s' }
  ]
  return '<div class="tabbar">' + items.map(i =>
    '<div class="tab-i' + (i.k === active ? ' on' : '') + '">' +
    '<img src="' + imgSrc('/images/' + i.ic + '.png') + '">' +
    '<span>' + i.t + '</span></div>'
  ).join('') + '</div>'
}

function buildHtml() {
  const css = buildCss()
  const screens = PAGES.map(p => {
    const wxml = fs.readFileSync(path.join(ROOT, p.file + '.wxml'), 'utf8')
    const ast = parse(wxml)
    const body = renderChildrenToStr(ast, p.scope)
    const nav = p.nav ? '<div class="navbar"><span>' + p.nav + '</span></div>' : ''
    const tab = p.tab ? tabbarHtml(p.tab === '工作台' ? 'work' : 'mine') : ''
    return '<section class="phone">' +
      '<div class="phone-frame">' +
      '<div class="statusbar"><span>9:41</span><span class="sb-r">●●● ⌁ 100%</span></div>' +
      nav +
      '<div class="screen">' + body + '</div>' +
      tab +
      '</div>' +
      '<div class="cap"><b>' + p.title + '</b><span>' + p.file + '</span></div>' +
      '</section>'
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>实训室管理系统 · UI 预览</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;padding:48px 32px 80px;
  background:radial-gradient(1200px 600px at 20% -10%,#16233f 0%,#0b1020 55%,#070b16 100%);
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  color:#e2e8f0;
}
.hd{max-width:1400px;margin:0 auto 44px}
.hd h1{font-size:34px;margin:0 0 12px;letter-spacing:1px;
  background:linear-gradient(90deg,#22d3ee,#2b6cff);-webkit-background-clip:text;background-clip:text;color:transparent}
.hd p{margin:0;color:#94a3b8;font-size:15px;line-height:1.8}
.hd .tags{margin-top:16px;display:flex;gap:8px;flex-wrap:wrap}
.hd .tag{padding:5px 14px;border-radius:999px;font-size:12px;background:rgba(34,211,238,.12);
  border:1px solid rgba(34,211,238,.28);color:#67e8f9}
.preview-grid{max-width:1400px;margin:0 auto;display:flex;flex-wrap:wrap;gap:40px 32px;justify-content:center}
.phone{width:375px}
.phone-frame{
  width:375px;height:780px;border-radius:44px;overflow:hidden;position:relative;
  background:#F2F5FA;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 10px #161c2c,0 0 0 11px #2b3448;
  display:flex;flex-direction:column;
}
.statusbar{height:44px;flex:0 0 44px;background:#0A1020;display:flex;align-items:center;
  justify-content:space-between;padding:0 20px;font-size:12px;color:#fff;font-weight:600}
.sb-r{font-size:10px;opacity:.75;letter-spacing:1px}
.navbar{height:44px;flex:0 0 44px;background:#0A1020;display:flex;align-items:center;
  justify-content:center;color:#fff;font-size:16px;font-weight:600;letter-spacing:.5px}
.screen{flex:1;overflow-y:auto;overflow-x:hidden;position:relative}
.screen::-webkit-scrollbar{width:0}
.cap{text-align:center;padding-top:16px}
.cap b{display:block;font-size:15px;color:#e2e8f0;font-weight:600}
.cap span{display:block;font-size:12px;color:#64748b;margin-top:4px;font-family:ui-monospace,Menlo,monospace}
.tabbar{height:56px;flex:0 0 56px;background:#fff;border-top:1px solid rgba(15,35,80,.08);
  display:flex;align-items:center}
.tab-i{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
.tab-i img{width:22px;height:22px;opacity:.55}
.tab-i span{font-size:10px;color:#94A3B8}
.tab-i.on img{opacity:1}
.tab-i.on span{color:#2B6CFF;font-weight:600}
/* WXSS 里 button 用 .btn / .go 等类；预览里把 .btn-wrap 伪装成 button */
.btn-wrap{display:flex;align-items:center;justify-content:center;height:46px;border-radius:12px;
  font-size:15px;font-weight:600;background:linear-gradient(135deg,#2B6CFF,#1D4FD8);color:#fff;
  box-shadow:0 6px 14px rgba(43,108,255,.30);cursor:pointer}
.btn-wrap.dis{background:#C7D2E4;box-shadow:none}
.btn-text{pointer-events:none}
${css}
</style>
</head>
<body>
<div class="hd">
  <h1>实训室管理系统 · UI 设计预览</h1>
  <p>本页由 <b>tools/render-preview.js</b> 直接解析真实 WXML + 真实 WXSS + 真实 PNG 图标渲染，
     非手工复刻，改动小程序源码后重跑即可同步更新。</p>
  <div class="tags">
    <span class="tag">深空科技顶区</span>
    <span class="tag">蓝青双主色 #2B6CFF / #22D3EE</span>
    <span class="tag">玻璃拟态</span>
    <span class="tag">线条图标（已替换 emoji）</span>
    <span class="tag">8 页面全覆盖</span>
  </div>
</div>
<div class="preview-grid">
${screens}
</div>
</body>
</html>`
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const html = buildHtml()
  const file = path.join(OUT, 'index.html')
  fs.writeFileSync(file, html, 'utf8')
  console.log('预览已生成 →', file)
  console.log('大小:', (fs.statSync(file).size / 1024).toFixed(1), 'KB')
}
main()

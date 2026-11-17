// tools/test_layout_scan.js —— 布局回归闸门（文字被压扁 / 溢出 / 同款样式分叉）
//
// 为什么需要：
//   微信小程序 WXSS 按页隔离 + 层叠，肉眼很难发现"某个按钮在某个 flex 行里被压扁"：
//   症状是文字溢出胶囊边框、甚至与旁边的说明文字叠在一起
//   （用户截图：「导出领用单 CSV」压住「为完整领用台账」、「按位置分组/全选/取消/清空」压住「共 0 项 · 已选 0 项」，
//     以及搜索框占位符白底不可见 → 看起来像空输入框）。
//   另一类更隐蔽：**同一个组件在多个页面各存一份样式**，改一处漏两页 → 外观分叉。
//
// 本工具查什么（元素级 + 正确层叠）：
//   ① flex 容器的直接子元素是按钮/胶囊类，却缺 flex-shrink:0 → 会被压扁，文字溢出；
//   ② flex 行内 white-space:nowrap 又没有 overflow 裁切 → 文字可能压到邻居上；
//   ③ 同一个类在 ≥2 个页面重复定义 → 应归集到 app.wxss（改一处全站生效）；
//   ④ 页面用单一类选择器覆盖全局同名类 → 换页就换尺寸（除非在白名单里，属于刻意差异）；
//   ⑤ 用了 height+padding 却没有 box-sizing，且元素类型不在全局重置覆盖范围内 → 外框比设定大。
//
// 用法：node tools/test_layout_scan.js
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const issues = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); issues.push(name + (detail ? ' → ' + detail : '')) }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

function pageFiles(ext) {
  const out = []
  const pagesDir = path.join(ROOT, 'pages')
  fs.readdirSync(pagesDir).forEach(d => {
    const f = path.join('pages', d, d + ext)
    if (fs.existsSync(path.join(ROOT, f))) out.push(f)
  })
  return out
}

// 解析 CSS → 类名 → [{body, order}]；同时记录「是否为单一类选择器」
function parseRules(src, base) {
  const map = new Map()
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '')
  let order = base || 0
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    order++
    const sel = m[1].trim()
    const body = m[2]
    const classes = [...sel.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(x => x[1])
    if (!classes.length) continue
    // 单一类选择器（无后代/子代/逗号）才算「本页覆盖了全局同名类」；
    // `.nm-panel .inp { ... }` 这类上下文变体是有意为之，不算冲突。
    const plain = /^\.[A-Za-z_][A-Za-z0-9_-]*$/.test(sel)
    for (const c of classes) {
      if (!map.has(c)) map.set(c, [])
      map.get(c).push({ body, order, sel, plain })
    }
  }
  return { map, next: order }
}

function declOf(rules, cls) {
  const out = {}
  const list = (rules.get(cls) || []).slice().sort((a, b) => a.order - b.order)
  for (const r of list) {
    for (const decl of r.body.split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const k = decl.slice(0, i).trim()
      const v = decl.slice(i + 1).trim()
      if (k) out[k] = v
    }
  }
  return out
}

// 元素生效声明：所有 class 的规则按【全局 → 页面】+【源码顺序】合并
function effective(clsList, appRules, pageRules) {
  const all = []
  for (const c of clsList) {
    for (const r of (appRules.get(c) || [])) all.push(Object.assign({ c, file: 0 }, r))
    for (const r of (pageRules.get(c) || [])) all.push(Object.assign({ c, file: 1 }, r))
  }
  all.sort((a, b) => (a.file - b.file) || (a.order - b.order))
  const out = {}
  for (const r of all) {
    for (const decl of r.body.split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const k = decl.slice(0, i).trim()
      const v = decl.slice(i + 1).trim()
      if (k) out[k] = v
    }
  }
  return out
}

const BUTTONISH = /(^|-)(btn|pill|chip|tag|ck|seg-i|flt-btn|more|tab|flt-p)$/
const FLEX_ROW = ['row', 'row-between', 'flt', 'btn-row', 'tabs', 'qp-row', 'lg-row', 'seg', 'dt-row', 'cls-sum', 'dist']
// 全局盒模型重置覆盖的元素类型（app.wxss: view,text,button,input,scroll-view）
const RESET_TAGS = ['view', 'text', 'button', 'input', 'scroll-view']
// 有意保留的页面级覆盖（刻意差异，白名单）
const INTENTIONAL = {
  'io': ['qty-btn', 'qty-inp'],                 // 出入库页的白底步进器是刻意设计
  'privacy': ['hero', 'page', 'card', 'row', 'hero-grid', 'hero-t', 'hero-s', 'sec-bar', 'lead', 'sub'] // 协议页整页独立版式
}

function main() {
  const app = parseRules(read('app.wxss'), 0)
  const appRules = app.map
  const appClasses = new Set(appRules.keys())

  // 全局重置的元素类型（用于判定盒模型）
  const resetTypes = new Set(['view', 'text', 'button', 'input', 'scroll-view'])

  const squeeze = []
  const overflow = []
  const boxRisk = []

  for (const wxml of pageFiles('.wxml')) {
    const page = path.basename(path.dirname(wxml))
    const wxssFile = wxml.replace(/\.wxml$/, '.wxss')
    const pr = fs.existsSync(path.join(ROOT, wxssFile)) ? parseRules(read(wxssFile), app.next) : { map: new Map(), next: app.next }
    const pageRules = pr.map
    const lines = read(wxml).split('\n')
    const stack = []

    for (const line of lines) {
      const clsRaw = (line.match(/class="([^"]*)"/) || [])[1] || ''
      const clsList = []
      for (const m of clsRaw.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)/g)) clsList.push(m[1])
      const tag = (line.match(/<(view|text|button|input|textarea|picker|canvas|image)\b/) || [])[1] || 'view'
      const selfClose = /\/>/.test(line) || tag === 'input' || tag === 'image'
      const parent = stack.length ? stack[stack.length - 1] : null

      if (clsList.length) {
        const eff = effective(clsList, appRules, pageRules)
        const label = page + ' · <' + tag + ' class="' + clsRaw.trim() + '">'

        // ① flex 直接子元素被压扁
        if (parent && parent.isFlex) {
          const buttonish = clsList.some(c => BUTTONISH.test(c))
          const shrink = eff['flex-shrink']
          const flexShort = /flex\s*:/.test(eff.flex || '') && /\b0\b/.test((eff.flex || '').trim().split(/\s+/).pop() || '')
          if (buttonish && shrink !== '0' && !flexShort) {
            squeeze.push(label + '（缺 flex-shrink:0）')
          }
          // ② 文字不换行且不裁切
          if (/nowrap/.test(eff['white-space'] || '') && !/hidden|auto|scroll/.test(eff.overflow || '')) {
            overflow.push(label + '（nowrap 但无 overflow 裁切）')
          }
        }
        // ⑤ 盒模型：元素类型不在全局重置范围内时，height+padding 必须显式 border-box
        if (!resetTypes.has(tag) && /picker|textarea|canvas|image|label/.test(tag)) {
          const hasH = eff.height && /rpx|px|%/.test(eff.height)
          const hasPad = eff.padding && !/^0(px|rpx)?$/.test(eff.padding.trim())
          if (hasH && hasPad && !/border-box/.test(eff['box-sizing'] || '')) {
            boxRisk.push(label + '（' + tag + ' 不在全局重置覆盖范围，且缺 box-sizing）')
          }
        }
      }

      const opens = (line.match(/<(view|text|block|picker|button|textarea|canvas)\b/g) || []).length
      const closes = (line.match(/<\/(view|text|block|picker|button|textarea|canvas)>/g) || []).length
      const isFlex = clsList.some(c => FLEX_ROW.indexOf(c) >= 0)
      if (opens && !selfClose) stack.push({ isFlex })
      const delta = opens - closes
      for (let i = 0; i < delta; i++) if (stack.length) stack.pop()
    }
  }

  section('① flex 行内的按钮/胶囊不会被压扁')
  ok('所有 flex 直接子元素都具备防压扁能力', squeeze.length === 0, [...new Set(squeeze)].slice(0, 6).join(' | '))

  section('② flex 行内的长文字有溢出保护')
  ok('nowrap 文字均有 overflow 裁切', overflow.length === 0, [...new Set(overflow)].slice(0, 6).join(' | '))

  section('③ 非 view/button/input 的元素用 height+padding 时自带 border-box')
  ok('盒模型外框不会超出设定', boxRisk.length === 0, [...new Set(boxRisk)].slice(0, 6).join(' | '))

  section('④ 同款样式未在多个页面重复定义')
  const dupMap = new Map()
  for (const wxss of pageFiles('.wxss')) {
    const page = path.basename(path.dirname(wxss))
    const pr = parseRules(read(wxss), 200000)
    for (const [cls, list] of pr.map) {
      const plain = list.filter(r => r.plain).map(r => r.body.split(/\s+/).join(' '))
      if (!plain.length) continue
      if (!dupMap.has(cls)) dupMap.set(cls, new Map())
      const m = dupMap.get(cls)
      if (!m.has(plain[0])) m.set(plain[0], [])
      m.get(plain[0]).push(page)
    }
  }
  const dups = []
  for (const [cls, m] of dupMap) {
    for (const [body, pages] of m) {
      const uniq = [...new Set(pages)]
      if (uniq.length < 2) continue
      const allowed = uniq.every(p => (INTENTIONAL[p] || []).indexOf(cls) >= 0)
      if (allowed) continue
      dups.push('.' + cls + '（' + uniq.join(',') + '）')
    }
  }
  ok('没有跨页重复的同款样式', dups.length === 0, dups.join(' | '))

  section('⑤ 页面未用单一类选择器覆盖全局同名类')
  const conflicts = []
  for (const wxss of pageFiles('.wxss')) {
    const page = path.basename(path.dirname(wxss))
    const pr = parseRules(read(wxss), 300000)
    for (const [cls, list] of pr.map) {
      if (!appClasses.has(cls)) continue
      const plain = list.filter(r => r.plain)
      if (!plain.length) continue
      if ((INTENTIONAL[page] || []).indexOf(cls) >= 0) continue
      const g = declOf(appRules, cls)
      const p = declOf(pr.map, cls)
      const changed = Object.keys(p).filter(k => g[k] !== undefined && g[k] !== p[k])
      if (changed.length) conflicts.push('.' + cls + ' [' + page + '] 覆盖：' + changed.join(', '))
    }
  }
  ok('页面未改写全局同名类', conflicts.length === 0, conflicts.join(' | '))

  console.log('\n========== 布局回归：' + pass + ' passed, ' + fail + ' failed ==========')
  if (issues.length) { console.log('\n问题明细：'); issues.forEach(i => console.log('  · ' + i)) }
  process.exitCode = fail ? 1 : 0
}

main()

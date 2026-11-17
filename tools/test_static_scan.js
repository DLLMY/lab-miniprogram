// tools/test_static_scan.js —— 静态一致性扫描（死绑定 / 缺样式 / 标签配对 / 同名类冲突）
//
// 为什么需要：
//   微信小程序有两个"编译器不管、只有运行时才炸"的坑：
//   ① 模板里 bindtap 到一个 JS 里不存在的方法 → 点了没反应（catchtap 绑不到还会冒泡关掉弹层）；
//   ② 模板里用了某个 class，但该 class 只定义在**别的页面**的 wxss 里 →
//      WXSS 按页隔离，于是这一页完全没样式（弹层没有遮罩、提示不变色），肉眼很难发现。
//   两者都是"看起来做完了、实际是坏的"，人工通读两千多行模板不现实，这里自动化。
//
// 用法：node tools/test_static_scan.js
const path = require('path')
const fs = require('fs')
const re = require('path').sep === '\\' ? require('path') : require('path')

const ROOT = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const issues = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); issues.push(name + (detail ? ' → ' + detail : '')) }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

const definedIn = t => new Set((t.match(/\.([A-Za-z_][A-Za-z0-9_-]*)/g) || [])
  .map(s => s.slice(1)))

function pageFiles(ext) {
  const out = []
  const pagesDir = path.join(ROOT, 'pages')
  fs.readdirSync(pagesDir).forEach(d => {
    const f = path.join('pages', d, d + ext)
    if (fs.existsSync(path.join(ROOT, f))) out.push(f)
  })
  return out
}

function main() {
  section('① 模板事件绑定 → JS 方法（死绑定）')
  const dead = []
  for (const wxml of pageFiles('.wxml')) {
    const js = wxml.replace(/\.wxml$/, '.js')
    if (!fs.existsSync(path.join(ROOT, js))) continue
    const methods = new Set()
    for (const line of read(js).split('\n')) {
      let m = line.match(/^\s{0,4}(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/)
      if (m) methods.add(m[1])
      m = line.match(/^\s{0,4}([A-Za-z_$][A-Za-z0-9_$]*)\s*:/)
      if (m) methods.add(m[1])
    }
    const binds = new Set((read(wxml).match(/(?:bind|catch)(?::)?[a-zA-Z]+\s*=\s*"([A-Za-z_$][A-Za-z0-9_$]*)"/g) || [])
      .map(s => s.match(/"([^"]+)"/)[1]))
    const miss = [...binds].filter(b => !methods.has(b)).sort()
    if (miss.length) dead.push(path.basename(path.dirname(wxml)) + ': ' + miss.join(','))
  }
  ok('所有模板事件都有对应实现', dead.length === 0, dead.join(' | '))

  section('② 模板 class → 样式定义（跨页漏定义）')
  const appC = definedIn(read('app.wxss'))
  // 这些是数据值/语义容器，不是样式类，排除误报
  const DATA_TOKENS = new Set(['teacher', 'student', 'admin', 'super', 'tool', 'material', 'wk', 'pg',
    'list', 'detail', 'log', 'access', 'opening', 'pending', 'approved', 'canceled', 'cloud'])
  const missing = []
  for (const wxml of pageFiles('.wxml')) {
    const wxss = wxml.replace(/\.wxml$/, '.wxss')
    const local = fs.existsSync(path.join(ROOT, wxss)) ? definedIn(read(wxss)) : new Set()
    const txt = read(wxml)
    const used = new Set()
    for (const m of txt.matchAll(/class="([^"]*)"/g)) {
      if (m[1].includes('{{')) continue
      m[1].split(/\s+/).forEach(c => c && used.add(c))
    }
    // 只取 class 属性【内部】三元表达式的「结果分支」作为条件类名：
    //   class="tab {{tab==='pending'?'on':''}}" → 候选类名是 on（结果分支），
    //   'pending' 是被比较的值、不是类名（早期写法扫全页 {{}} 会把它误判成"缺样式"）。
    for (const m of txt.matchAll(/class="([^"]*\{\{[^"]*\})[^"]*"/g)) {
      for (const c of m[1].matchAll(/\?\s*'([A-Za-z][A-Za-z0-9_-]*)'\s*:\s*'([A-Za-z][A-Za-z0-9_-]*)'/g)) {
        used.add(c[1]); used.add(c[2])
      }
    }
    const miss = [...used].filter(c => !appC.has(c) && !local.has(c) && !DATA_TOKENS.has(c)).sort()
    if (miss.length) missing.push(path.basename(path.dirname(wxml)) + ': ' + miss.join(','))
  }
  ok('所有模板用到的 class 都有样式定义', missing.length === 0, missing.join(' | '))

  section('③ WXML 标签配对')
  const unbalanced = []
  for (const wxml of pageFiles('.wxml')) {
    const s = read(wxml)
    for (const tag of ['view', 'block', 'text', 'button', 'picker', 'canvas']) {
      const o = (s.match(new RegExp('<' + tag + '(?:\\s|>)', 'g')) || []).length
      const c = (s.match(new RegExp('</' + tag + '>', 'g')) || []).length
      if (o !== c) unbalanced.push(path.basename(path.dirname(wxml)) + '.' + tag + ' ' + o + '/' + c)
    }
  }
  ok('所有页面标签闭合正确', unbalanced.length === 0, unbalanced.join(' | '))

  section('④ 同名类跨页定义一致性（同名不同义 → 换个页面样式就变）')
  const defs = new Map()
  for (const wxss of pageFiles('.wxss')) {
    const s = read(wxss)
    const page = path.basename(path.dirname(wxss))
    for (const m of s.matchAll(/^\.([A-Za-z_][A-Za-z0-9_-]*)\s*\{([^}]*)\}/gm)) {
      if (!defs.has(m[1])) defs.set(m[1], new Map())
      defs.get(m[1]).set(page, m[2].split(/\s+/).join(' '))
    }
  }
  const conflicts = []
  for (const [cls, pages] of defs) {
    if (pages.size < 2) continue
    const vals = new Set(pages.values())
    if (vals.size > 1) {
      // 只报告"同名且语义应当一致"的告警类（尺寸微差允许存在，如 .qty-btn）
      const warnings = ['list-warn', 'list-soon', 'clm-reject', 'sec-t', 'pill', 'btn-sm']
      if (warnings.indexOf(cls) >= 0) {
        conflicts.push(cls + '（' + [...pages.keys()].join(',') + ' 定义不一致）')
      }
    }
  }
  ok('关键公共类跨页定义一致', conflicts.length === 0, conflicts.join(' | '))

  section('⑤ 全局样式无重复定义')
  const appTxt = read('app.wxss')
  const counter = new Map()
  for (const m of appTxt.matchAll(/^\.([A-Za-z_][A-Za-z0-9_-]*)\s*\{/gm)) counter.set(m[1], (counter.get(m[1]) || 0) + 1)
  const dup = [...counter.entries()].filter(([, v]) => v > 1).map(([k]) => k)
  ok('app.wxss 每个类只定义一次', dup.length === 0, dup.join(','))

  console.log('\n========== 静态扫描：' + pass + ' passed, ' + fail + ' failed ==========')
  if (issues.length) {
    console.log('\n问题明细：')
    issues.forEach(i => console.log('  · ' + i))
  }
  process.exitCode = fail ? 1 : 0
}

main()

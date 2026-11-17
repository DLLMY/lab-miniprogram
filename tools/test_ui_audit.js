// tools/test_ui_audit.js —— UI 样式异常静态体检
//
// 为什么需要它：
//   第八轮发现三处真实 UI 异常（占位符隐形、按钮文字贴边/溢出胶囊、审批撤销按钮文字错位），
//   根因都在**全局样式**上：
//     ① `.inp-ph` 用的是深色场景的白色半透明占位符 → 被浅色输入框引用后占位符几乎看不见；
//     ② `.btn` / `.btn-sm` 没有水平内边距 → 文字直接贴住边框（截图里「导出领用单 CSV」的 V 被裁掉）；
//     ③ 裸类名 `.primary`（实心蓝 + line-height:92rpx）与 `.btn-sm.primary`（浅蓝 + height:72rpx）
//        同名共存 → 后者被前者的 line-height/height 覆盖 → 文字行盒超出按钮盒 → 文字错位；
//     ④ flex 行里的按钮默认 flex-shrink:1 → 空间不足时背景被压窄、文字溢出胶囊（「按位置分组」）。
//   这些不是三个孤立 bug，而是四类**可复现的样式契约缺口**，必须全量体检而不是逐页打补丁。
//
// 本工具做三件事：
//   A. 扫描全部 WXML，统计按钮/输入框类名的使用组合与「裸类名」误用；
//   B. 检查全局样式里关键类是否具备「内边距 / 不换行 / 不被压缩 / 文字垂直居中」四要素；
//   C. 校验每个输入框的 placeholder-class 是否与所在容器的背景明暗匹配（浅底不能用白色占位符）。
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PAGES = path.join(ROOT, 'pages')

let pass = 0, fail = 0
const issues = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); issues.push(name + (detail ? ' → ' + detail : '')) }
}
function section(t) { console.log('\n===== ' + t + ' =====') }

function readApp() { return fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8') }
function listPages() {
  return fs.readdirSync(PAGES).filter(d => fs.existsSync(path.join(PAGES, d, d + '.wxml')))
}
function readPage(p, ext) {
  const f = path.join(PAGES, p, p + '.' + ext)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

// 从 app.wxss 里抽出某个类的声明体（支持 .a.b 组合选择器）
function rule(app, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm')
  const m = app.match(re)
  return m ? m[2] : ''
}
function hasProp(body, prop) {
  // 属性可能出现在块首、行首或分号之后，不能只认 ^ 与 ;
  return new RegExp('(^|[;{}\\n])\\s*' + prop + '\\s*:').test(body || '')
}

function main() {
  const app = readApp()
  const pages = listPages()
  console.log('===== UI 样式异常体检（' + pages.length + ' 个页面） =====')

  // ---------- A. 全局按钮类契约 ----------
  section('A. 按钮类四要素（内边距 / 不换行 / 不被压缩 / 文字居中）')
  const btnRule = rule(app, '.btn')
  const btnSmRule = rule(app, '.btn-sm')
  ok('.btn 有水平内边距（否则文字贴边被边框裁切）', hasProp(btnRule, 'padding'), btnRule.trim())
  ok('.btn 不换行（按钮文案不被折成两行）', hasProp(btnRule, 'white-space'), btnRule.trim())
  ok('.btn 在 flex 行里不被压扁（压扁会让背景窄于文字）', hasProp(btnRule, 'flex-shrink'), btnRule.trim())
  ok('.btn 有 box-sizing:border-box（padding 不撑破固定高度）', hasProp(btnRule, 'box-sizing'), btnRule.trim())
  ok('.btn-sm 有水平内边距', hasProp(btnSmRule, 'padding'), btnSmRule.trim())
  ok('.btn-sm 文字不换行', hasProp(btnSmRule, 'white-space'), btnSmRule.trim())
  ok('.btn-sm 在 flex 行里不被压扁', hasProp(btnSmRule, 'flex-shrink'), btnSmRule.trim())

  // ---------- B. 裸类名污染检查 ----------
  section('B. 裸类名不得与 .btn-sm 组合类抢样式')
  // .primary/.off/.reject 若以裸类存在，会覆盖 .btn-sm 的 height/line-height/font-size
  const barePrimary = rule(app, '.primary')
  ok('裸 .primary 不再存在（否则覆盖 .btn-sm.primary 的高度与行高）', barePrimary.trim() === '',
    barePrimary.trim())
  const bareOff = rule(app, '.off')
  const bareReject = rule(app, '.reject')
  ok('裸 .off / .reject 不再存在', bareOff.trim() === '' && bareReject.trim() === '',
    (bareOff + bareReject).trim())
  // .btn-sm 组合类自身必须声明完整的高度/行高/内边距，不能被任何裸类覆盖
  const smPrimary = rule(app, '.btn-sm.primary')
  ok('.btn-sm.primary 自行声明 height（不依赖继承）', hasProp(smPrimary, 'height'), smPrimary.trim())
  ok('.btn-sm.primary 自行声明 line-height（文字不越界）', hasProp(smPrimary, 'line-height'), smPrimary.trim())

  // ---------- C. 占位符明暗匹配 ----------
  section('C. 输入框占位符明暗匹配（浅底不得用白色占位符）')
  const phRule = rule(app, '.inp-ph')
  const isLight = /color:\s*(#fff\b|#FFFFFF|rgba\(\s*255\s*,\s*255\s*,\s*255)/i.test(phRule)
  ok('.inp-ph 不是白色/半透明白（浅色输入框上会隐形）', !isLight, phRule.trim())
  const inpRule = rule(app, '.inp')
  const inpDark = /(background:\s*#(0|1|2)[0-9A-Fa-f]{5})/i.test(inpRule)
  ok('.inp 背景为浅色（决定占位符必须用深色）', !inpDark, inpRule.trim())

  // 逐页扫描：placeholder-class 用了什么，所在输入框是什么底色
  const phUsage = {}
  for (const p of pages) {
    const wxml = readPage(p, 'wxml')
    const re = /placeholder-class="([^"]+)"/g
    let m
    while ((m = re.exec(wxml))) {
      const cls = m[1]
      phUsage[cls] = phUsage[cls] || { pages: [], count: 0 }
      phUsage[cls].pages.push(p)
      phUsage[cls].count++
    }
  }
  const phClasses = Object.keys(phUsage)
  ok('页面里用到的占位符类都已在全局定义',
    phClasses.every(c => rule(app, '.' + c).trim() !== ''),
    phClasses.filter(c => rule(app, '.' + c).trim() === '').join(', '))

  // C2. 逐个输入框核对「占位符明暗 vs 所在底色」
  section('C2. 每个输入框的占位符与底色匹配')
  function isLightColor(c) {
    // 返回 true 表示「这是浅色（白系）占位符」——只能用在深底上
    const t = ('' + c).trim().toLowerCase()
    if (t === '#fff' || t === '#ffffff') return true
    const m = t.match(/rgba?\(([^)]+)\)/)
    if (m) {
      const p = m[1].split(',').map(x => parseFloat(x))
      return (p[0] + p[1] + p[2]) / 3 >= 200
    }
    const hex = t.replace('#', '')
    if (/^[0-9a-f]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16)
      return (r + g + b) / 3 >= 200
    }
    return false
  }
  // 用标签栈还原该 input 的祖先链，判断它是否落在深色卡片里
  // （登录页 .login-card 是半透明深色底，里面的 .inp 被覆盖成深色底白字）
  function inDarkCard(wxml, upto) {
    const stack = []
    const tagRe = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
    let m
    while ((m = tagRe.exec(wxml)) && m.index < upto) {
      const [full, name, attrs, selfClose] = m
      if (full.startsWith('</')) { stack.pop(); continue }
      if (selfClose === '/') continue
      const cm = attrs.match(/class="([^"]*)"/)
      stack.push(cm ? cm[1] : '')
    }
    return stack.some(c => /login-card|dark-card|hero-dark/.test(c))
  }
  const mismatches = []
  for (const p of pages) {
    const wxml = readPage(p, 'wxml')
    const re = /<input[^>]*class="([^"]*)"[^>]*placeholder-class="([^"]+)"[^>]*>|<input[^>]*placeholder-class="([^"]+)"[^>]*class="([^"]*)"[^>]*>/g
    let m
    while ((m = re.exec(wxml))) {
      const phCls = (m[2] || m[3] || '')
      const phBody = rule(app, '.' + phCls)
      const c = (phBody.match(new RegExp('color:\\s*([^;]+)')) || [])[1]
      if (!c) { mismatches.push(p + '：占位符类 .' + phCls + ' 未声明 color'); continue }
      const idx = m.index
      const inDark = inDarkCard(wxml, idx)
      const light = isLightColor(c)
      if (inDark && !light) mismatches.push(p + '：深色底输入框用了深色占位符 .' + phCls + '(' + c.trim() + ')')
      if (!inDark && light) mismatches.push(p + '：浅色底输入框用了白色占位符 .' + phCls + '(' + c.trim() + ') → 占位符隐形')
    }
  }
  ok('所有输入框的占位符与底色明暗匹配', mismatches.length === 0, mismatches.slice(0, 6).join(' | '))

  // ---------- D. 逐页按钮结构体检 ----------
  section('D. 逐页按钮/输入框结构')
  const problems = []
  for (const p of pages) {
    const wxml = readPage(p, 'wxml')
    // D1: <view> 上用了 .btn 却没带 .btn-sm / .btn-block 等修饰 → 仍受全局 padding 保护，这里只统计
    // D2: 按钮文案跨行书写 → WXML 会把换行与缩进当作文本渲染，视觉上多出空格
    const btnRe = /<view[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>\s*\n\s*([^<\n][^<]*?)\s*\n\s*<\/view>/g
    let m
    while ((m = btnRe.exec(wxml))) {
      problems.push(p + '：按钮文案跨行书写 →「' + m[1].trim() + '」会带多余空白')
    }
    // D3: flex 行里的按钮没有最小宽度保护（文字被压到背景外）
    const rowBtn = /class="row[^"]*"[^>]*>[\s\S]{0,400}?class="btn-sm[^"]*"/g
    if (rowBtn.test(wxml) && !hasProp(rule(app, '.btn-sm'), 'flex-shrink')) {
      problems.push(p + '：.row 内使用 .btn-sm 但按钮可被压扁')
    }
  }
  ok('未发现按钮文案跨行 / 可压扁问题', problems.length === 0, problems.slice(0, 6).join(' | '))

  // ---------- E. 关键控件存在性 ----------
  section('E. 关键页面控件齐备')
  const checks = [
    ['pages/qrprint/qrprint.wxml', /placeholder="搜索 ID \/ 名称 \/ 存放位置"/, '二维码页搜索框有占位文案'],
    ['pages/qrprint/qrprint.wxml', /placeholder-class="inp-ph"/, '二维码页搜索框使用 inp-ph 占位符'],
    ['pages/claims/claims.wxml', /导出领用单 CSV/, '领用记录页导出按钮文案'],
    ['pages/claims/claims.wxml', /撤销此审批/, '领用记录页撤销按钮文案']
  ]
  for (const [f, re, name] of checks) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8')
    ok(name, re.test(s))
  }

  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====')
  if (issues.length) {
    console.log('--- 问题清单 ---')
    issues.forEach(i => console.log('  · ' + i))
  }
  process.exit(fail ? 1 : 0)
}

main()

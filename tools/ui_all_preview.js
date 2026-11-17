// tools/ui_all_preview.js —— 全站控件总览渲染（一次性目视检查所有按钮/输入框）
//
// 用途：用户报的是「模拟器里有样式问题」，说明这类缺陷必须**看图**才能确认修干净。
//   本工具自动扫描所有页面的 WXML，抽出全部「带按钮类名的元素」与「带 placeholder 的输入框」，
//   用真实 app.wxss 渲染成一张总览图 → 一眼看出还有没有贴边/溢出/占位符隐形。
//
// 用法：node tools/ui_all_preview.js  → output/ui_all.png
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'output')
const PAGES = path.join(ROOT, 'pages')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

function rpx2px(css) {
  return css.replace(/(-?[\d.]+)rpx/g, (_, n) => (parseFloat(n) * 0.5).toFixed(3) + 'px')
}
function placeholderColor(css, cls) {
  const m = css.match(new RegExp('(^|[\\n}])\\s*\\.' + cls + '\\s*\\{([^}]*)\\}'))
  if (!m) return '#A3AFC2'
  const c = m[2].match(new RegExp('color:\\s*([^;]+)'))
  return c ? c[1].trim() : '#A3AFC2'
}

function listPages() {
  return fs.readdirSync(PAGES).filter(d => fs.existsSync(path.join(PAGES, d, d + '.wxml')))
}

// 从 WXML 抽出所有按钮类元素与输入框（保留 class 与文案，便于原样渲染）
function extract(pageFile) {
  const s = fs.readFileSync(pageFile, 'utf8')
  const out = []
  // 按钮/可点元素：class 里含 btn
  const btnRe = /<(view|button)([^>]*class="([^"]*\bbtn\b[^"]*)"[^>]*)>([^<]*)</g
  let m
  while ((m = btnRe.exec(s))) {
    const attrs = m[2]
    const cls = m[3]
    const text = (m[4] || '').trim()
    const style = (attrs.match(/style="([^"]*)"/) || [])[1] || ''
    out.push({ kind: 'btn', tag: m[1], cls, text, style })
  }
  // 输入框
  const inpRe = /<input([^>]*placeholder="([^"]*)"[^>]*)>/g
  while ((m = inpRe.exec(s))) {
    const attrs = m[1]
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || ''
    const phCls = (attrs.match(/placeholder-class="([^"]*)"/) || [])[1] || ''
    const ph = m[2]
    out.push({ kind: 'input', cls, phCls, ph, style: (attrs.match(/style="([^"]*)"/) || [])[1] || '' })
  }
  return out
}

function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
  const app = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  const phLight = placeholderColor(app, 'inp-ph')
  const phDark = placeholderColor(app, 'inp-ph-light')

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin:0; width:760px; background:#EEF2F8; font-family:"PingFang SC","Microsoft YaHei",sans-serif; font-size:12px; }
  ${rpx2px(app)}
  .wrap { padding:10px 14px; }
  .grp { background:#fff; border-radius:10px; margin:8px 0; padding:10px; }
  .grp-t { font-size:13px; font-weight:600; color:#0F2350; margin-bottom:8px; }
  .items { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .cell { display:flex; flex-direction:column; align-items:flex-start; gap:3px; }
  .cap { font-size:10px; color:#94A3B8; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  input.inp::placeholder { color:${phLight}; opacity:1; }
  .login-card { background:#0B1A3A; border-radius:18px; padding:14px; }
  .login-card .inp { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.13); color:#fff; }
  .login-card input.inp::placeholder { color:${phDark}; opacity:1; }
  </style></head><body><div class="wrap">`

  let total = 0
  for (const p of listPages()) {
    const items = extract(path.join(PAGES, p, p + '.wxml'))
    if (!items.length) continue
    const btns = items.filter(x => x.kind === 'btn')
    const inputs = items.filter(x => x.kind === 'input')
    html += `<div class="grp"><div class="grp-t">${p}（按钮 ${btns.length} · 输入框 ${inputs.length}）</div><div class="items">`
    for (const b of btns) {
      total++
      const tag = b.tag === 'button' ? 'button' : 'div'
      html += `<div class="cell"><${tag} class="${b.cls}" style="${b.style}">${b.text || '按钮'}</${tag}><div class="cap">${b.cls}</div></div>`
    }
    for (const i of inputs) {
      total++
      const dark = /inp-ph-light/.test(i.phCls)
      html += `<div class="cell">${dark ? '<div class="login-card">' : ''}<input class="${i.cls}" placeholder="${i.ph}" placeholder-class="${i.phCls}" style="${i.style}" />${dark ? '</div>' : ''}<div class="cap">${i.phCls || '(无)'}</div></div>`
    }
    html += `</div></div>`
  }
  html += `</div></body></html>`

  const htmlFile = path.join(OUT, '_ui_all.html')
  fs.writeFileSync(htmlFile, html, 'utf8')
  const png = path.join(OUT, 'ui_all.png')
  try { fs.unlinkSync(png) } catch (e) {}
  execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=780,2400', '--screenshot=' + png.replace(/\//g, '\\'),
    'file:///' + htmlFile.replace(/\\/g, '/')
  ], { stdio: 'ignore', timeout: 120000 })
  let waited = 0
  while (waited < 20000 && (!fs.existsSync(png) || fs.statSync(png).size < 1024)) {
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},300)'])
    waited += 300
  }
  console.log('控件总数 ' + total + ' → ' + (fs.existsSync(png) ? png : '生成失败'))
}

main()

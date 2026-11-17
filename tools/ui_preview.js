// tools/ui_preview.js —— 生成 UI 渲染对比页（修复前 vs 修复后）
//
// 用途：样式类缺陷（按钮文字贴边/溢出胶囊、占位符隐形）光看代码不够，
//   必须把同一组控件用「旧 CSS / 新 CSS」各渲染一次并截图，肉眼确认差异。
//   用系统 Edge 的 headless --screenshot 出图，不需要装 playwright。
//
// 用法：node tools/ui_preview.js   → 生成 output/ui_before.png / output/ui_after.png
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'output')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

// 375px 宽设备：750rpx = 375px → 1rpx = 0.5px
function rpx2px(css) {
  return css.replace(/(-?[\d.]+)rpx/g, (_, n) => (parseFloat(n) * 0.5).toFixed(3) + 'px')
}

// —— 控件样例：全部取自真实页面 ——
const SAMPLES = `
  <div class="dt-hero"><div class="dt-name">二维码批量打印</div><div class="dt-id">勾选物品 → 生成 A4 标签图 → 存相册打印</div></div>
  <div class="page">
    <div class="card">
      <div class="tabs"><div class="tab on">耗材</div><div class="tab">工具</div></div>
      <input class="inp mt-s" placeholder="搜索 ID / 名称 / 存放位置" placeholder-class="inp-ph" />
      <div class="row-between mt-s">
        <div class="list-sub">共 0 项 · 已选 0 项</div>
        <div class="row">
          <div class="btn-sm off" style="margin-right:12rpx">按位置分组</div>
          <div class="btn-sm primary">全选/取消</div>
          <div class="btn-sm off" style="margin-left:12rpx">清空</div>
        </div>
      </div>
    </div>

    <div class="card mt-m">
      <div class="row-between mb-m">
        <div class="list-sub">导出不受筛选影响，为完整整理用台账</div>
        <div class="btn btn-ghost btn-sm">导出领用单 CSV</div>
      </div>
      <div class="list-sub" style="margin-bottom:8rpx">已通过的单据（管理员可撤销）</div>
      <div><span class="btn-sm reject" style="display:inline-block">撤销此审批</span></div>
    </div>

    <div class="card mt-m">
      <div class="list-sub" style="margin-bottom:8rpx">登录页（深色卡片上的输入框）</div>
      <div class="login-card">
        <input class="inp" placeholder="请输入你的姓名" placeholder-class="inp-ph" />
      </div>
    </div>
  </div>
`

// 小程序里 placeholder-class 是给占位文字单独挂一个类；HTML 里用 ::placeholder 模拟，
// 颜色必须从该类的声明里取，否则预览会「看起来正常」而真机隐形。
function placeholderColor(css, cls) {
  const m = css.match(new RegExp('(^|[\\n}])\\s*\\.' + cls + '\\s*\\{([^}]*)\\}'))
  if (!m) return '#A3AFC2'
  const c = m[2].match(new RegExp('color:\\s*([^;]+)'))
  return c ? c[1].trim() : '#A3AFC2'
}

function buildHtml(css) {
  const phLight = placeholderColor(css, 'inp-ph')
  const phDark = placeholderColor(css, 'inp-ph-light')
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { margin:0; width:390px; background:#EEF2F8; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  ${rpx2px(css)}
  /* 登录页深色卡片（真实样式在 login.wxss，这里内联以便同屏对照） */
  .login-card { background:#0B1A3A; border-radius:18px; padding:22px 18px; }
  .login-card .inp { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.13); color:#fff; }
  /* placeholder-class="inp-ph" → 浅色输入框 */
  input.inp::placeholder { color:${phLight}; opacity:1; }
  /* placeholder-class="inp-ph-light" → 深色底输入框 */
  .login-card input.inp::placeholder { color:${phDark}; opacity:1; }
</style></head><body>${SAMPLES}</body></html>`
}

// 把本轮修复「反向应用」得到修复前基线。
// 不能直接用 git HEAD 的 app.wxss：HEAD 里还没有第 5 轮的样式归集（.inp-ph 等），
//  基线会失真（占位符反而显示正常，看不出问题）。
function toLegacy(css) {
  let s = css
  // ① .btn 去掉盒模型补充
  s = s.replace(/\/\* 水平内边距：[\s\S]*?line-height: 1\.25;\n\}/, '}')
  // ② .btn-sm 还原为旧的三属性版本，并补回裸 .primary
  s = s.replace(/\.btn-sm \{[\s\S]*?\n\}/, '.btn-sm { height: 72rpx; font-size: 27rpx; border-radius: 20rpx; }')
  s = s.replace(/\.btn-sm\.primary \{[^}]*\}/, '.btn-sm.primary { background: rgba(43, 108, 255, .12); color: #2B6CFF; }')
  s = s.replace(/\/\* 注：裸 \.primary 已删除。[\s\S]*?\*\//,
    '.primary { background: linear-gradient(135deg, #2B6CFF 0%, #1D4FD8 100%); color: #fff; border-radius: 24rpx; font-size: 30rpx; font-weight: 600; height: 92rpx; line-height: 92rpx; text-align: center; }\n.primary::after { border: none; }')
  // ③ 占位符还原为白色半透明（浅色输入框上会隐形）
  s = s.replace(/\.inp-ph \{ color: #A3AFC2; \}/, '.inp-ph { color: rgba(255, 255, 255, .30); }')
  s = s.replace(/\.inp-ph-light \{[^}]*\}/, '')
  // ④ 行容器还原为不换行
  s = s.replace(/\.row \{ display: flex; align-items: center; flex-wrap: wrap; \}/, '.row { display: flex; align-items: center; }')
  s = s.replace(/\.row-between \{ display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; \}/, '.row-between { display: flex; align-items: center; justify-content: space-between; }')
  return s
}

function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
  const after = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  const before = toLegacy(after)
  const pages = [['before', before], ['after', after]]
  for (const [tag, css] of pages) {
    const html = path.join(OUT, '_ui_' + tag + '.html')
    fs.writeFileSync(html, buildHtml(css), 'utf8')
    const png = path.join(OUT, 'ui_' + tag + '.png')
    try {
      // 注意：Edge 新版必须用 --headless=new；截图路径要 Windows 原生路径，file:// 用正斜杠
      const winPng = png.replace(/\//g, '\\')
      const url = 'file:///' + html.replace(/\\/g, '/')
      execFileSync(EDGE, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--window-size=390,760', '--screenshot=' + winPng, url
      ], { stdio: 'ignore', timeout: 90000 })
      // Edge 会在截图写完前就退出，这里轮询等文件落地
      let waited = 0
      while (waited < 15000 && (!fs.existsSync(png) || fs.statSync(png).size < 1024)) {
        execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},300)'])
        waited += 300
      }
      console.log(fs.existsSync(png) ? ('已生成 ' + png + ' (' + fs.statSync(png).size + ' 字节)') : ('⚠ 未生成 ' + png))
    } catch (e) {
      console.error('截图失败', tag, e.message)
    }
  }
}

main()

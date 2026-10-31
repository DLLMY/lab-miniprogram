// 上传包体检（上传/预览前必跑）
// ---------------------------------------------------------------------------
// 为什么需要这个脚本：
//   小程序包里除了页面，还可能混进 Node 专用脚本（tools/ 等）。服务端在上传时会对
//   包内文件做编译校验，只要某个 .js 用了「小程序编译器不认的语法」，就会收到
//     invalid file: <文件>, 1:0
//     SyntaxError: Invalid or unexpected token
//   2026-10-23 上传就是这么失败的：tools/bootstrap-schema.js 的 shebang。
//   本脚本复刻 DevTools 的 packOptions.ignore 匹配算法（asar → filerules.js 的 doRule），
//   算出「哪些文件会进包」，再按小程序编译器口径扫一遍不兼容语法。
// 判定口径（小程序编译器 = 浏览器目标 babel/swc，非 Node）：
//   ① Buffer 字面量 b'...'（Node 专有，Node 22 起连 node 自己都报 SyntaxError）
//   ② shebang #!（只在首行合法，且小程序编译器不接受）
//   ③ ESM import/export（小程序包内必须是 CommonJS）
//   ④ with 语句（严格模式禁用）
//   ⑤ 顶层 await（CommonJS 不支持）
//   ⑥ debugger 语句
// 用法：node tools/check-pack-ignore.js
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))

// —— 复刻 DevTools filerules.js 的 doRule ——
const leading = (s) => (s.startsWith('/') ? s : '/' + s)
const trailing = (s) => (s.endsWith('/') ? s : s + '/')
function doRule(e, rule) {
  if (!rule) return false
  const v = String(rule.value).toLowerCase()
  if (rule.type === 'prefix') return e.slice(e.lastIndexOf('/') + 1).startsWith(v)
  if (rule.type === 'suffix') return e.slice(e.lastIndexOf('/') + 1).endsWith(v)
  if (rule.type === 'folder') return leading(e).startsWith(trailing(leading(v)))
  if (rule.type === 'file') return leading(e) === leading(v)
  if (rule.type === 'glob') {
    const rx = new RegExp('^' + v.split('**').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('.*') + '$')
    return rx.test(e) || rx.test(leading(e))
  }
  if (rule.type === 'regexp') { try { return new RegExp(v, 'i').test(e) } catch (x) { return false } }
  return false
}
const isIgnored = (rel, rules) => rules.some(r => doRule(rel.toLowerCase(), r))

// —— 收集项目文件（相对 miniprogramRoot）——
const scanRoot = path.resolve(ROOT, cfg.miniprogramRoot || './')
const SKIP = new Set(['node_modules', '.git', '.workbuddy'])
const all = []
;(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    if (SKIP.has(n)) continue
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) walk(p)
    else all.push(path.relative(scanRoot, p).replace(/\\/g, '/'))
  }
})(scanRoot)

const rules = (cfg.packOptions && cfg.packOptions.ignore) || []

// DevTools 内置排除规则（asar → filerules.js 的 getIgnoreRulesByProjectConfig）：
// jsserverRoot / cloudfunctionRoot / qcloudRoot / testRoot 会被自动排除出小程序包。
// 不建模这条规则会把整个 cloudfunctions/ 误判成"进包"，进而误报凭证泄露风险。
const BUILTIN_ROOTS = ['jsserverRoot', 'cloudfunctionRoot', 'qcloudRoot', 'testRoot']
const builtinRules = []
for (const k of BUILTIN_ROOTS) {
  const v = cfg[k]
  if (!v) continue
  const t = v.endsWith('/') ? '**/*' : '/**/*'
  builtinRules.push({ type: 'glob', value: v + t, _builtin: k })
}
const allRules = rules.concat(builtinRules)
const included = all.filter(rel => !isIgnored(rel, allRules))
const builtinExcluded = all.filter(rel => !isIgnored(rel, rules) && isIgnored(rel, builtinRules))

console.log('miniprogramRoot = ' + JSON.stringify(cfg.miniprogramRoot || './'))
console.log('packOptions.ignore ' + rules.length + ' 条 → ' + rules.map(r => r.type + ':' + r.value).join(', '))
if (builtinRules.length) {
  console.log('DevTools 内置排除 ' + builtinRules.length + ' 条 → ' + builtinRules.map(r => r.value).join(', ') +
    '（命中 ' + builtinExcluded.length + ' 个文件）')
}
console.log('项目文件 ' + all.length + ' 个，进入上传包 ' + included.length + ' 个\n')

// —— 小程序编译器不兼容语法扫描 ——
const BOM = [0xef, 0xbb, 0xbf]
function scanJs(rel) {
  const raw = fs.readFileSync(path.join(scanRoot, rel))
  const issues = []
  if (raw.length >= 3 && raw[0] === BOM[0] && raw[1] === BOM[1] && raw[2] === BOM[2]) {
    issues.push('UTF-8 BOM（小程序编译器：Invalid or unexpected token）')
  }
  const text = raw.toString('utf8')
  if (text.slice(0, 2) === '#!') issues.push('shebang #!（小程序编译器：Invalid or unexpected token）')
  // Buffer 字面量：b'...' / b"..."（前面不能是标识符字符）
  const buf = /(?:^|[^A-Za-z0-9_$.])b(['"])/m.exec(text)
  if (buf) {
    const line = text.slice(0, buf.index).split('\n').length
    issues.push('Buffer 字面量 b' + buf[1] + '...' + buf[1] + '（Node 专有语法，第 ' + line + ' 行）')
  }
  if (/^\s*import\s[^\n]*\sfrom\s+['"]/m.test(text)) issues.push('ESM import 语句（小程序包内必须是 CommonJS）')
  if (/^\s*export\s+(default|const|let|var|function|class|\{)/m.test(text)) issues.push('ESM export 语句（小程序包内必须是 CommonJS）')
  if (/(^|[^.\w])with\s*\(/.test(text)) issues.push('with 语句（严格模式禁用）')
  if (/^\s*await\s/m.test(text) && !/async\s+function|async\s*\(|\.then\(/m.test(text)) issues.push('顶层 await（CommonJS 不支持）')
  if (/(^|[^.\w])debugger\s*;?/m.test(text)) issues.push('debugger 语句')
  return issues
}

let risk = 0
console.log('=== 上传包内 .js 的小程序编译器兼容性 ===')
const jsInPack = included.filter(f => f.endsWith('.js'))
for (const rel of jsInPack) {
  const issues = scanJs(rel)
  if (issues.length) {
    risk++
    console.log('  ❌ ' + rel)
    issues.forEach(i => console.log('       - ' + i))
  }
}
if (!risk) {
  console.log('  ✅ ' + jsInPack.length + ' 个 .js 全部兼容（无 Node 专有语法）')
} else {
  console.log('\n  ⚠ ' + risk + ' 个文件会导致上传/预览被服务端拒绝')
  console.log('  修法：把这些文件移出 miniprogramRoot，或改名 .cjs（小程序编译器只处理 .js）')
}

// —— 顺带提示：包内被小程序编译器处理但属于 Node 脚本的目录 ——
const dirs = {}
for (const f of jsInPack) {
  const d = f.includes('/') ? f.split('/')[0] : '(根目录)'
  dirs[d] = (dirs[d] || 0) + 1
}
console.log('\n=== 上传包内 .js 分布 ===')
Object.keys(dirs).sort().forEach(d => console.log('   ' + d.padEnd(18) + dirs[d]))

// —— 云函数部署包里的明文凭证（这才是真正的泄露面）——
// 小程序包不含 cloudfunctions/（DevTools 内置排除），但「上传并部署：云端安装依赖」
// 会把 cloudfunctions/docsProxy/ 整个目录上传到云端函数代码，任何有云函数读取权限者可下载查看。
console.log('\n=== 云函数部署包内的明文凭证 ===')
const cfRoot = cfg.cloudfunctionRoot ? path.resolve(ROOT, cfg.cloudfunctionRoot) : null
let credRisk = 0
if (cfRoot && fs.existsSync(cfRoot)) {
  ;(function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n)
      if (fs.statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); continue }
      if (!/\.(js|json)$/.test(n)) continue
      const txt = fs.readFileSync(p, 'utf8')
      const hits = []
      const notes = []
      // ACCESS_TOKEN = 访问凭证（泄露即可直接读写数据底座）；OPEN_ID = 具体微信用户标识（个人信息）；
      // CLIENT_ID 属公开客户端标识（类似 appid），单独标注为提示，避免噪音淹没真风险。
      if (/ACCESS_TOKEN\s*:\s*["'][^"']{20,}/.test(txt)) hits.push('ACCESS_TOKEN 明文（可直连读写数据底座）')
      if (/OPEN_ID\s*:\s*["'][^"']{10,}/.test(txt)) hits.push('OPEN_ID 明文（个人身份标识）')
      if (/CLIENT_ID\s*:\s*["'][^"']{10,}/.test(txt)) notes.push('CLIENT_ID（公开客户端标识，敏感度低）')
      if (hits.length) {
        credRisk++
        console.log('  ❌ ' + path.relative(ROOT, p) + ' → ' + hits.join('、'))
      }
      notes.forEach(n => console.log('  · ' + path.relative(ROOT, p) + ' → ' + n))
    }
  })(cfRoot)
}
if (!credRisk) console.log('  ✅ 云函数部署包内未发现明文凭证')
else {
  console.log('  ⚠ 这些文件会随「上传并部署」进入云端函数代码（不进小程序主包，但有云函数读取权限者可下载）')
  console.log('    修法：凭证只放云开发控制台环境变量；本机兜底文件移出 cloudfunctionRoot/；部署后重置 token')
}
process.exit(risk ? 1 : 0)

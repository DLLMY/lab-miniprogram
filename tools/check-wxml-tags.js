// WXML 严格标签检查（上传/预览前必跑）
// ---------------------------------------------------------------------------
// 为什么要有这个脚本：
//   微信开发者工具编译 WXML 时要求标签严格嵌套，一旦某个 <view> 漏了闭合标签，
//   编译器会在后面的某个结束标签处报：
//     [ WXML 文件编译错误] expect end-tag `view`., near `block`
//   报错位置指向的是「发现不对的地方」，而不是「漏闭合的地方」，极难定位
//   （2026-10-25 实例：pages/io/io.wxml 的「新建物品弹层」漏了 2 个 </view>，
//     编译器却把错指到 40 行之后的 </block> 上）。
//   早期版本的检查器遇到标签不匹配会「向上回溯找匹配标签」，把真错误吞掉了，
//   故改为严格 LIFO 嵌套校验：任何不按顺序的结束标签都直接判错。
// 用法：node tools/check-wxml-tags.js
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
// 可选参数：指定要检查的 wxml 文件或目录（默认检查 pages/ 下全部）
const target = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : path.join(ROOT, 'pages')

// WXML 与 HTML 不同：没有 void 元素，<image>/<button> 也必须写 </image></button>，
// 或者写成自闭合 <image />。因此这里不设 VOID 白名单——凡不是自闭合的标签，
// 一律要求配对的结束标签。
const files = []
if (fs.existsSync(target) && fs.statSync(target).isFile()) {
  if (target.endsWith('.wxml')) files.push(target)
} else {
  ;(function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.wxml')) files.push(p)
    }
  })(target)
}

let total = 0
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const lineOf = (idx) => raw.slice(0, idx).split('\n').length
  // 去注释（保留换行以维持行号）
  const text = raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))

  const stack = []
  const errors = []
  const tagRe = /<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>/g
  let m
  while ((m = tagRe.exec(text)) !== null) {
    const isClose = !!m[1]
    const tag = m[2]
    const selfClose = !!m[4]
    const ln = lineOf(m.index)
    if (isClose) {
      if (!stack.length) {
        errors.push('第 ' + ln + ' 行：多余的结束标签 </' + tag + '>（此处没有对应的开始标签）')
        continue
      }
      const top = stack[stack.length - 1]
      if (top.tag === tag) { stack.pop(); continue }
      // 严格模式：结束标签必须与栈顶一致，不允许「向上回溯找匹配」
      errors.push('第 ' + ln + ' 行：结束标签 </' + tag + '> 与当前未闭合的 <' + top.tag +
        '>（第 ' + top.line + ' 行）不匹配 —— 缺一个 </' + top.tag + '>，或这里多了一个 </' + tag + '>')
      // 弹出到匹配为止，避免连锁刷屏
      const idx = stack.map(x => x.tag).lastIndexOf(tag)
      if (idx >= 0) stack.length = idx
    } else {
      if (selfClose) continue
      stack.push({ tag, line: ln })
    }
  }
  for (const s of stack) errors.push('第 ' + s.line + ' 行的 <' + s.tag + '> 从未闭合')

  // {{ }} 配对
  const open = (text.match(/\{\{/g) || []).length
  const close = (text.match(/\}\}/g) || []).length
  if (open !== close) errors.push('{{ }} 不配对：' + open + ' / ' + close)

  if (errors.length) {
    total += errors.length
    console.log('❌ ' + path.relative(ROOT, file))
    errors.forEach(e => console.log('     ' + e))
  }
}

console.log('\n扫描 WXML ' + files.length + ' 个文件' + (total ? '，发现 ' + total + ' 处问题' : '，全部通过 ✅'))
process.exit(total ? 1 : 0)

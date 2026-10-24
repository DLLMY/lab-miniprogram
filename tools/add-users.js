/**
 * tools/add-users.js —— 批量录入 / 补录用户工号（内测前必做）
 *
 * 为什么需要：users 表目前只有 4 个演示账号。真实师生登录时输入的工号
 *             必须在这张表里且状态为启用，否则会提示「工号不存在」。
 *
 * 用法：
 *   1) 先预览将要写入的内容（安全，不改动）
 *        node tools/add-users.js --file tools/users.csv
 *   2) 确认无误后执行
 *        node tools/add-users.js --file tools/users.csv --yes
 *   3) 查看当前已录入的用户
 *        node tools/add-users.js --list
 *
 * CSV 格式（第一行必须是表头，支持 UTF-8 BOM）：
 *   工号,姓名,角色,班级
 *   T002,李老师,teacher,
 *   S101,张三,student,24电气1
 *
 * 角色只能是 student / teacher / admin，否则会被拒绝。
 * 已存在的工号不会被覆盖，只会报告「已存在」。
 */
const fs = require('fs')
const path = require('path')
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

const ROLE_OK = ['student', 'teacher', 'admin']

function parseCsv(text) {
  // 去 BOM
  text = text.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return []
  const head = lines[0].split(',').map(s => s.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(s => (s || '').trim())
    rows.push({
      id: cells[0] || '',
      name: cells[1] || '',
      role: cells[2] || '',
      cls: cells[3] || '',
      line: i + 1
    })
  }
  return { head, rows }
}

;(async () => {
  const args = process.argv.slice(2)
  const APPLY = args.includes('--yes')
  const LIST = args.includes('--list')

  // 兼容两种传参写法：--file=xxx  与  --file xxx
  // （Git Bash / cmd / PowerShell 对 `--file=x` 的处理可能不同，统一兜住）
  let filePath = ''
  const eqArg = args.find(a => a.startsWith('--file='))
  if (eqArg) filePath = eqArg.slice('--file='.length)
  else {
    const i = args.indexOf('--file')
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) filePath = args[i + 1]
  }

  // ---------- 查看当前用户 ----------
  const existing = await td.listUsers()
  if (LIST || !filePath) {
    console.log('当前 users 表共 ' + existing.length + ' 个账号：\n')
    existing.forEach(u => {
      console.log('   ' + String(u.id).padEnd(8) +
        String(u.name).padEnd(10) +
        String(u.role).padEnd(9) +
        String(u.cls || '-').padEnd(12) +
        (u.status === '停用' ? '停用' : '启用'))
    })
    if (!filePath) {
      console.log('\n提示：加 --file tools/users.csv 可批量录入。')
      return
    }
    console.log('')
  }

  // ---------- 读取 CSV ----------
  const csvPath = path.resolve(filePath)
  if (!fs.existsSync(csvPath)) {
    console.error('找不到文件：' + csvPath)
    process.exit(1)
  }
  const { head, rows } = parseCsv(fs.readFileSync(csvPath, 'utf8'))
  console.log('\n表头：' + head.join(' | '))
  if (head.length < 3) {
    console.error('表头至少需要 3 列：工号,姓名,角色（可选第 4 列 班级）')
    process.exit(1)
  }

  // ---------- 校验 ----------
  const bad = []
  const valid = []
  rows.forEach(r => {
    if (!r.id || !r.name) { bad.push([r.line, '工号或姓名为空']); return }
    if (!ROLE_OK.includes(r.role)) { bad.push([r.line, r.id + ' 角色非法：' + r.role + '（只能是 ' + ROLE_OK.join('/') + '）']); return }
    valid.push(r)
  })
  if (bad.length) {
    console.log('\n❌ 以下行有问题，不会写入：')
    bad.forEach(b => console.log('   第' + b[0] + '行：' + b[1]))
  }
  if (!valid.length) { console.log('没有可写入的有效行。'); return }

  // ---------- 与现有数据比对 ----------
  const existMap = {}
  existing.forEach(u => { existMap[String(u.id)] = u })
  const toAdd = []
  const skip = []
  valid.forEach(r => {
    if (existMap[r.id]) skip.push(r)
    else toAdd.push(r)
  })

  console.log('\n将新增 ' + toAdd.length + ' 个账号：')
  toAdd.forEach(r => console.log('   + ' + r.id + '  ' + r.name + '  ' + r.role + '  ' + (r.cls || '-')))
  if (skip.length) {
    console.log('\n跳过（已存在，不会覆盖）' + skip.length + ' 个：')
    skip.forEach(r => console.log('   = ' + r.id + '  ' + r.name + '（现角色 ' + (existMap[r.id].role || '?') + '）'))
  }

  if (!APPLY) {
    console.log('\n这是预览模式，未做任何写入。确认后执行：')
    console.log('  node tools/add-users.js --file ' + filePath + ' --yes')
    return
  }

  // ---------- 写入 ----------
  console.log('\n开始写入…')
  let ok = 0
  for (const r of toAdd) {
    try {
      await td.addRecord('users', {
        [td.COL.users.id]: r.id,
        [td.COL.users.name]: r.name,
        [td.COL.users.role]: r.role,
        [td.COL.users.cls]: r.cls,
        [td.COL.users.status]: '启用',
        [td.COL.users.openid]: ''
      })
      console.log('   ✓ ' + r.id + ' ' + r.name)
      ok++
    } catch (e) {
      console.log('   ✗ ' + r.id + ' ' + r.name + ' → ' + e.message)
    }
  }
  console.log('\n成功写入 ' + ok + ' / ' + toAdd.length + ' 个账号。')
  console.log('提示：新增账号默认「未绑微信」，内测同学首次打开输入姓名+工号即可自动绑定。')
})().catch(e => {
  console.error('ERR', e.message)
  process.exit(1)
})
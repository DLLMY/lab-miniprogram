'use strict'
// ============================================================================
// export_account_list.js —— 导出当前线上账号清单（Excel）
// ----------------------------------------------------------------------------
// 只读：直连云数据库 users 集合 + 读学期主数据，不修改任何线上数据。
// 输出：tools/data/terms/账号清单_<学期>.xlsx（含真实姓名，已 gitignore）
//   四个工作表：
//     账号清单    —— 全部账号（工号/姓名/角色/类型/归属班级/带班/状态/备注）
//     班级对照    —— 20 个班级的权威全称、管理员双账号、任课教师
//     教师带班    —— 18 位教师的带班明细与唯一任课教师提示（归属核查固化）
//     使用说明    —— 命名口径、登录方式、审批链路、每学期更新与核查命令
//
// 用法：node tools/export_account_list.js --term 2026-2027-1
// 凭证：优先环境变量；缺省读 ~/.workbuddy/mcp.json 的 lab-docs-proxy 配置。
// 依赖：mcp/node_modules/@cloudbase/node-sdk、mcp/node_modules/xlsx
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const TERM_DIR = path.join(__dirname, 'data', 'terms')

function pickTerm() {
  const t = arg('term', '')
  if (t) return t
  const files = fs.readdirSync(TERM_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()
  return files.length ? files[files.length - 1].replace(/\.json$/, '') : ''
}

function loadCreds() {
  const e = {
    TCB_SECRET_ID: (process.env.TCB_SECRET_ID || '').trim(),
    TCB_SECRET_KEY: (process.env.TCB_SECRET_KEY || '').trim(),
    TCB_ENV: (process.env.TCB_ENV || '').trim()
  }
  if (!(e.TCB_SECRET_ID && e.TCB_SECRET_KEY && e.TCB_ENV)) {
    const cfg = require(path.join(os.homedir(), '.workbuddy', 'mcp.json'))
    const c = (((cfg.mcpServers || {})['lab-docs-proxy'] || {}).env || {})
    e.TCB_SECRET_ID = e.TCB_SECRET_ID || (c.TCB_SECRET_ID || '').trim()
    e.TCB_SECRET_KEY = e.TCB_SECRET_KEY || (c.TCB_SECRET_KEY || '').trim()
    e.TCB_ENV = e.TCB_ENV || (c.TCB_ENV || '').trim()
  }
  return e
}

function loadPkg(name) {
  const cands = [name, path.join(__dirname, '..', 'mcp', 'node_modules', name)]
  for (const c of cands) { try { return require(c) } catch (_) { /* 换下一个 */ } }
  throw new Error('找不到依赖 ' + name + '（应在 mcp/ 目录安装）')
}

const ROLE_EN = { '学生': 'student', '教师': 'teacher', '管理员': 'admin', '超级管理员': 'super',
  student: 'student', teacher: 'teacher', admin: 'admin', super: 'super' }

function kindOf(u) {
  const id = String(u.id || '').toUpperCase()
  const role = ROLE_EN[String(u.role || '').trim()] || ''
  if (role === 'super') return '超级管理员'
  if (role === 'admin') return '管理员'
  if (id.indexOf('WT') === 0) return '教师'
  if (/^\d{4}[A-Z]{2}\d{3}$/.test(id)) return '班级管理员'
  if (role === 'student') return '学生'
  return '其他'
}

async function main() {
  const term = pickTerm()
  if (!term) { console.error('❌ 未找到学期主数据'); process.exit(2) }
  const termFile = path.join(TERM_DIR, term + '.json')
  const doc = JSON.parse(fs.readFileSync(termFile, 'utf8'))
  const classes = doc.classes || []
  const teachers = doc.teachers || []
  const admins = doc.classAdmins || []

  const creds = loadCreds()
  const sdk = loadPkg('@cloudbase/node-sdk')
  const init = (typeof sdk === 'function') ? sdk : sdk.init
  const app = init({ secretId: creds.TCB_SECRET_ID, secretKey: creds.TCB_SECRET_KEY, env: creds.TCB_ENV })
  const res = await app.database().collection('users').limit(1000).get()
  const users = res.data || []
  if (!users.length) { console.error('❌ 线上 users 为空，已中止'); process.exit(2) }

  // 排序：super → admin → 教师(WT) → 班级管理员 → 其他学生
  const order = { '超级管理员': 0, '管理员': 1, '教师': 2, '班级管理员': 3, '学生': 4, '其他': 5 }
  const enriched = users.map(u => ({ u, kind: kindOf(u) }))
  enriched.sort((a, b) => {
    // 注意：0 是合法排序值（超级管理员），不能用 `|| 9` 兜底，否则会被挤到最后
    const oa = order[a.kind] != null ? order[a.kind] : 9
    const ob = order[b.kind] != null ? order[b.kind] : 9
    const d = oa - ob
    return d !== 0 ? d : String(a.u.id || '').localeCompare(String(b.u.id || ''))
  })

  const head = ['序号', '工号', '姓名', '角色', '账号类型', '所属班级（权威全称）',
    '带班班级', '状态', '登录方式', '备注']
  const rows = [head]
  enriched.forEach((x, i) => {
    const u = x.u, id = String(u.id || '').toUpperCase()
    const role = String(u.role || '').trim()
    const mc = String(u.managedClasses || '').trim()
    let note = ''
    if (x.kind === '教师') note = '本学期授课教师；带 ' + (mc ? mc.split(',').length : 0) + ' 个班，可审批本班申请'
    else if (x.kind === '班级管理员') note = '本班学生共用账号，用于提交耗材申请；流水自动归属本班'
    else if (x.kind === '管理员' || x.kind === '学生') {
      note = /test|测试/i.test(String(u.name || '')) || ['T100', 'TEST1', 'S001', 'S002'].indexOf(id) >= 0
        ? '测试账号，正式启用前可删除' : '初始账号'
    } else if (x.kind === '超级管理员') note = '全校数据可见，不可删除'
    rows.push([
      i + 1, id, String(u.name || ''), role, x.kind,
      String(u.cls || ''), mc, String(u.status || '启用'),
      '工号 + 姓名，首次登录绑定微信（工号不区分大小写）', note
    ])
  })

  // 班级对照表
  const clsHead = ['序号', '班级（权威全称 / 系统存值）', '班级简称（用于账号命名）',
    '管理员1 工号', '管理员1 姓名', '管理员2 工号', '管理员2 姓名', '任课教师（工号·姓名）']
  const clsRows = [clsHead]
  classes.forEach((cls, i) => {
    const pair = admins.filter(a => a.cls === cls)
    const short = pair.length ? String(pair[0].name).replace(/管理员\d+$/, '') : ''
    const ts = teachers.filter(t => (t.managedClasses || []).indexOf(cls) >= 0)
      .map(t => t.id + '·' + t.name).join('、')
    clsRows.push([
      i + 1, cls, short,
      pair[0] ? pair[0].id : '', pair[0] ? pair[0].name : '',
      pair[1] ? pair[1].id : '', pair[1] ? pair[1].name : '', ts || '本学期无排课'
    ])
  })

  // 教师带班表：把归属核查结果固化进清单，便于分发给各教师确认
  const tHead = ['序号', '工号', '姓名', '带班数', '带班班级（权威全称）', '备注']
  const tRows = [tHead]
  const teacherCountByClass = {}
  classes.forEach(c => {
    teacherCountByClass[c] = teachers.filter(t => (t.managedClasses || []).indexOf(c) >= 0).length
  })
  teachers.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).forEach((t, i) => {
    const mc = t.managedClasses || []
    const solo = mc.filter(c => teacherCountByClass[c] === 1)
    tRows.push([
      i + 1, t.id, t.name, mc.length, mc.join('、'),
      solo.length ? '唯一任课教师班级（请假时需管理员兜底）：' + solo.join('、') : ''
    ])
  })

  const noteRows = [
    ['项目', '说明'],
    ['学期', term],
    ['导出时间', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })],
    ['账号总数', String(users.length)],
    ['教师账号', 'WT001 起顺序编号，按姓名永久绑定，跨学期复用（生成时带 --prev）'],
    ['班级管理员工号', doc.classAdminRule ? doc.classAdminRule.idFormat : '<4位年份><专业缩写><1位班号><2位序号>'],
    ['班级管理员名字', doc.classAdminRule ? doc.classAdminRule.nameFormat : '<班级简称>管理员<序号>'],
    ['⚠️ 班级命名口径', 'users.cls 与教师 managedClasses 必须逐字使用「班级（权威全称）」列，禁止用简称；否则任课教师看不到本班申请'],
    ['⚠️ 工号大小写', '系统统一转大写存储，如 2024dq101 → 2024DQ101；登录时大小写均可'],
    ['登录方式', '登录页输入「工号 + 姓名」校验通过后绑定微信 openid，之后免输自动登录'],
    ['审批链路', '学生/班级管理员提交 → 任课教师优先审批本班（部署新版云函数后只看得到本班+公共）→ 管理员/超级管理员可审批全部'],
    ['流水班级显示', '领用审批、我的申请、出入库、日志、报修、巡检列表均显示归属班级；空班级为公共资源，不显示'],
    ['⚠️ 隔离生效前提', '需在微信开发者工具「上传并部署 docsProxy」新版云函数；当前线上仍为旧版，数据已就位但隔离未生效'],
    ['每学期更新', 'python tools/build_term_data.py --term <新学期> --roster <通讯录> --workload <工作量表> --prev tools/data/terms/<上学期>.json'],
    ['每学期导入', 'node tools/import_teachers.js --term <新学期> --apply   （默认 all：教师 + 班级管理员，幂等可重跑）'],
    ['重新导出清单', 'node tools/export_account_list.js --term <学期>'],
    ['归属核查（原始表）', 'python tools/audit_term_mapping.py --check --term <学期>'],
    ['归属核查（线上）', 'node tools/audit_online_scope.js --term <学期>   （只读，含云函数版本探测与隔离模拟）'],
    ['敏感信息', '本表含真实姓名与工号，已加入 .gitignore，请勿外传或提交到代码仓库']
  ]

  const XLSX = loadPkg('xlsx')
  const wb = XLSX.utils.book_new()
  const ws1 = XLSX.utils.aoa_to_sheet(rows)
  const ws2 = XLSX.utils.aoa_to_sheet(clsRows)
  const ws3 = XLSX.utils.aoa_to_sheet(noteRows)
  const ws4 = XLSX.utils.aoa_to_sheet(tRows)
  ws1['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 22 }, { wch: 12 }, { wch: 14 },
    { wch: 26 }, { wch: 48 }, { wch: 8 }, { wch: 42 }, { wch: 46 }]
  ws2['!cols'] = [{ wch: 6 }, { wch: 28 }, { wch: 24 }, { wch: 15 }, { wch: 26 },
    { wch: 15 }, { wch: 26 }, { wch: 56 }]
  ws3['!cols'] = [{ wch: 22 }, { wch: 110 }]
  ws4['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 56 }, { wch: 56 }]
  XLSX.utils.book_append_sheet(wb, ws1, '账号清单')
  XLSX.utils.book_append_sheet(wb, ws2, '班级对照')
  XLSX.utils.book_append_sheet(wb, ws4, '教师带班')
  XLSX.utils.book_append_sheet(wb, ws3, '使用说明')
  // 默认写 账号清单_<学期>.xlsx；若该文件正被 Excel/WPS 打开（EBUSY），
  // 可用 --out 指定新文件名，避免导出失败。
  const outArg = arg('out', '')
  const out = outArg
    ? path.resolve(TERM_DIR, outArg)
    : path.join(TERM_DIR, '账号清单_' + term + '.xlsx')
  XLSX.writeFile(wb, out)

  console.log('✅ 已导出：' + out)
  console.log('   账号 ' + users.length + ' 行 / 班级 ' + classes.length + ' 行 / 教师带班 ' +
    (tRows.length - 1) + ' 行 / 说明 ' + (noteRows.length - 1) + ' 条')
  const stat = {}
  enriched.forEach(x => { stat[x.kind] = (stat[x.kind] || 0) + 1 })
  console.log('   类型分布：' + JSON.stringify(stat))
  console.log('\n=== 账号清单（控制台速览）===')
  for (const r of rows) {
    console.log([r[0], r[1], r[2], r[3], r[5] || '-', r[6] || '-'].join(' | '))
  }
}

main().catch(e => { console.error('💥 异常：', e.stack || e.message); process.exit(1) })

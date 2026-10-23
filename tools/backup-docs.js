/**
 * tools/backup-docs.js —— 把腾讯文档 8 张表导出为本地 JSON 备份
 *
 * 为什么需要：内测期间数据每天都在变，而腾讯文档里的数据是「活的」——
 *             误删/误改难以恢复。养成每天跑一次的习惯，出问题可回滚。
 *
 * 用法：
 *   node tools/backup-docs.js            # 备份到 backup/YYYY-MM-DD-HHmm.json
 *   node tools/backup-docs.js --latest   # 只在控制台看最新备份，不落盘
 *   node tools/backup-docs.js --keep 14   # 只保留最近 14 份，自动清旧的
 *
 * 备份文件结构：
 *   { meta: { 时间, 各表行数 }, data: { users:[], materials:[], ... } }
 *
 * 回滚提示：回滚需要手工把 JSON 逐行写回腾讯文档（buildValues 的中文列名映射），
 *          详见 `测试上架清单.md` 的风险章节。数据量小时可接受。
 */
const fs = require('fs')
const path = require('path')
const td = require('../cloudfunctions/docsProxy/tencentdocs.js')

const BACKUP_DIR = path.join(__dirname, '..', 'backup')
const TABLES = ['users', 'materials', 'tools', 'requisitions', 'borrow', 'stock_io', 'access', 'logs']

function pad(n) { return String(n).padStart(2, '0') }
function stamp() {
  const d = new Date()
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes())
}

;(async () => {
  const args = process.argv.slice(2)

  // 只看最新备份
  if (args.includes('--latest')) {
    if (!fs.existsSync(BACKUP_DIR)) { console.log('还没有任何备份。'); return }
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort()
    if (!files.length) { console.log('还没有任何备份。'); return }
    const last = files[files.length - 1]
    const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, last), 'utf8'))
    console.log('最新备份：' + last)
    console.log('备份时间：' + data.meta.time)
    console.log('各表行数：')
    TABLES.forEach(t => console.log('   ' + t.padEnd(14) + (data.data[t] || []).length + ' 行'))
    return
  }

  // 导出
  console.log('开始备份 8 张表…\n')
  const data = {}
  const counts = {}
  for (const t of TABLES) {
    const rows = await td.getRecords(t)
    // 只留 fields，去掉 recordId（文档行 ID 会变，备份里没意义）
    data[t] = rows.map(r => r.fields)
    counts[t] = rows.length
    console.log('   ' + t.padEnd(14) + String(rows.length).padStart(4) + ' 行')
  }

  const payload = {
    meta: {
      time: new Date().toLocaleString('zh-CN'),
      fileId: td.CFG.FILE_ID,
      counts,
      total: TABLES.reduce((s, t) => s + counts[t], 0)
    },
    data
  }

  if (args.includes('--dry-run')) {
    console.log('\n试运行（未落盘），总行数 ' + payload.meta.total)
    return
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const file = path.join(BACKUP_DIR, 'docs-' + stamp() + '.json')
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  console.log('\n✅ 备份完成：' + file)
  console.log('   总行数 ' + payload.meta.total + '  大小 ' + (fs.statSync(file).size / 1024).toFixed(1) + ' KB')

  // 清理旧备份
  const keepArg = args.find(a => a.startsWith('--keep='))
  if (keepArg) {
    const keep = parseInt(keepArg.split('=')[1], 10) || 0
    if (keep > 0) {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort()
      const del = files.slice(0, Math.max(0, files.length - keep))
      del.forEach(f => { fs.unlinkSync(path.join(BACKUP_DIR, f)); console.log('   已删除旧备份 ' + f) })
      if (del.length) console.log('   保留最近 ' + keep + ' 份')
    }
  }
})().catch(e => {
  console.error('ERR', e.message)
  process.exit(1)
})
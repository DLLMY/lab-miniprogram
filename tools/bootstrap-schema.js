// 注：原 shebang 已移除 —— 小程序编译器会把项目内 .js 当小程序源码扫，shebang 会报 SyntaxError
//     Windows 下用 `node xxx.js` 运行，无需 shebang。
// tools/bootstrap-schema.js
// ============================================================
// 用途：在你自己的腾讯文档账号下，为一个【新建的空智能表格】自动创建
//       8 张子表 + 全部字段 + 演示种子数据，并打印可直接粘进 tencentdocs.js 的 TABLE。
//
// 前置：
//   1) 在 docs.qq.com 新建一个空白「智能表格」（会自动带一个默认子表，跑完手动删掉即可）
//   2) 从它的 URL 取 file_id：https://docs.qq.com/smartsheet/<FILE_ID>
//   3) 完成 OAuth 授权，拿到 access_token / refresh_token / user_id(Open ID)
//
// 运行（PowerShell 或 bash 均可）：
//   TD_ACCESS_TOKEN=xxx TD_OPEN_ID=xxx TD_CLIENT_ID=xxx TD_FILE_ID=xxx \
//     node tools/bootstrap-schema.js
//
// 可选：TD_NO_SEED=1 只建表结构、不写种子数据
// ============================================================

const BASE = 'https://docs.qq.com/openapi/smartbook/v2'

const TOKEN = process.env.TD_ACCESS_TOKEN || ''
const OPEN_ID = process.env.TD_OPEN_ID || ''
const CLIENT_ID = process.env.TD_CLIENT_ID || ''
const FILE_ID = process.env.TD_FILE_ID || ''
const SEED = process.env.TD_NO_SEED !== '1'

if (!TOKEN || !OPEN_ID || !CLIENT_ID || !FILE_ID) {
  console.error('❌ 缺少环境变量：需要 TD_ACCESS_TOKEN / TD_OPEN_ID / TD_CLIENT_ID / TD_FILE_ID')
  process.exit(1)
}

const TEXT = 1
const NUM = 2
const fText = (t) => ({ fieldTitle: t, fieldType: TEXT, propertyText: {} })
const fNum = (t) => ({ fieldTitle: t, fieldType: NUM, propertyNumber: { decimalPlaces: 0, useSeparate: false } })

// 与 tencentdocs.js 的 COL 逐字对应；列名错一个字，写入时就会被跳过，务必别改。
const SCHEMA = [
  {
    key: 'users', title: '用户表',
    fields: [fText('用户ID'), fText('姓名'), fText('角色'), fText('班级')],
    seed: [
      { 用户ID: 'S001', 姓名: '张三', 角色: '学生', 班级: '电子1班' },
      { 用户ID: 'S002', 姓名: '李四', 角色: '学生', 班级: '电子1班' },
      { 用户ID: 'T001', 姓名: '邓老师', 角色: '教师', 班级: '' },
      { 用户ID: 'A001', 姓名: '王管理员', 角色: '管理员', 班级: '' }
    ]
  },
  {
    key: 'materials', title: '耗材表',
    fields: [fText('耗材ID'), fText('名称'), fText('规格'), fText('类别'), fText('位置'), fNum('当前库存'), fText('单位'), fNum('预警线'), fText('状态')],
    seed: [
      { 耗材ID: 'M001', 名称: '电阻包(1kΩ)', 规格: '1kΩ 100只/包', 类别: '电子耗材', 位置: 'A柜1层', 当前库存: 25, 单位: '包', 预警线: 10, 状态: '正常' },
      { 耗材ID: 'M002', 名称: '面包板', 规格: '830孔', 类别: '电子耗材', 位置: 'A柜2层', 当前库存: 3, 单位: '块', 预警线: 5, 状态: '预警' },
      { 耗材ID: 'M003', 名称: '杜邦线(公对母)', 规格: '20cm 40根/扎', 类别: '电子耗材', 位置: 'B柜1层', 当前库存: 40, 单位: '扎', 预警线: 20, 状态: '正常' },
      { 耗材ID: 'M004', 名称: '焊锡丝', 规格: '0.8mm 100g', 类别: '焊接耗材', 位置: 'C柜', 当前库存: 1, 单位: '卷', 预警线: 3, 状态: '预警' }
    ]
  },
  {
    key: 'tools', title: '工具表',
    fields: [fText('工具ID'), fText('名称'), fText('规格'), fText('位置'), fText('状态'), fText('持有人')],
    seed: [
      { 工具ID: 'T001', 名称: '万用表 FLUKE-17', 规格: 'FL-17001', 位置: 'A柜', 状态: '在库', 持有人: '' },
      { 工具ID: 'T002', 名称: '电烙铁 60W', 规格: 'LT-2002', 位置: 'C柜', 状态: '借出', 持有人: 'S002' },
      { 工具ID: 'T003', 名称: '示波器 SDS1104', 规格: 'OS-1104', 位置: 'B柜', 状态: '在库', 持有人: '' }
    ]
  },
  {
    key: 'requisitions', title: '领用申请表',
    fields: [fText('申请ID'), fText('申请人'), fText('物品'), fText('类型'), fNum('数量'), fText('用途'), fText('状态'), fText('时间'), fText('审批人')],
    seed: [
      { 申请ID: 'R20261001', 申请人: 'S002', 物品: 'M003', 类型: '领用', 数量: 2, 用途: '课堂实训', 状态: '待审批', 时间: '2026-10-22 09:30', 审批人: '' }
    ]
  },
  {
    key: 'borrow', title: '借还记录表',
    fields: [fText('借还ID'), fText('借用人'), fText('工具'), fText('借出'), fText('计划归还'), fText('实际归还'), fText('状态')],
    seed: []
  },
  {
    key: 'stock_io', title: '出入库流水表',
    fields: [fText('流水ID'), fText('物品ID'), fText('方向'), fNum('数量'), fText('操作人'), fText('时间'), fText('备注')],
    seed: []
  },
  {
    key: 'access', title: '门禁记录表',
    fields: [fText('记录ID'), fText('用户ID'), fText('门禁点'), fText('刷卡时间'), fText('结果')],
    seed: []
  },
  {
    key: 'logs', title: '操作日志表',
    fields: [fText('日志ID'), fText('时间'), fText('操作人'), fText('操作类型'), fText('对象'), fText('结果')],
    seed: []
  }
]

async function call(action, params, sheetId) {
  const url = sheetId
    ? `${BASE}/files/${FILE_ID}/sheets/${sheetId}`
    : `${BASE}/files/${FILE_ID}/sheets`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': TOKEN,
      'Client-Id': CLIENT_ID,
      'Open-Id': OPEN_ID
    },
    body: JSON.stringify({ [action]: params || {} })
  })
  const text = await res.text()
  let j
  try { j = JSON.parse(text) } catch (_) {
    throw new Error(`${action} 返回非 JSON：HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  if (!res.ok) throw new Error(`${action} HTTP ${res.status}：${text.slice(0, 300)}`)
  if (j.ret !== undefined && j.ret !== 0) throw new Error(`${action} ret=${j.ret} ${j.msg || ''}`)
  return (j.data && j.data[action]) || {}
}

const wrap = (v) => [{ type: 'text', text: v == null ? '' : String(v) }]

async function main() {
  const out = {}
  for (let i = 0; i < SCHEMA.length; i++) {
    const s = SCHEMA[i]

    process.stdout.write(`创建子表「${s.title}」... `)
    const r = await call('addSheet', { properties: { title: s.title, index: i } })
    const sheetID = r.properties && r.properties.sheetID
    if (!sheetID) throw new Error(`addSheet 未返回 sheetID：${JSON.stringify(r)}`)
    out[s.key] = sheetID
    console.log(sheetID)

    process.stdout.write(`  添加字段 ${s.fields.length} 个... `)
    await call('addFields', { fields: s.fields }, sheetID)
    console.log('ok')

    if (SEED && s.seed && s.seed.length) {
      process.stdout.write(`  写入种子 ${s.seed.length} 条... `)
      const records = s.seed.map(row => {
        const values = {}
        for (const [k, v] of Object.entries(row)) {
          const isNum = s.fields.some(x => x.fieldTitle === k && x.fieldType === NUM)
          values[k] = isNum ? (Number(v) || 0) : wrap(v)
        }
        return { values }
      })
      await call('addRecords', { records }, sheetID)
      console.log('ok')
    }
  }

  console.log('\n=== 把下面这段覆盖到 tencentdocs.js 的 TABLE ===\n')
  console.log('const TABLE = {')
  SCHEMA.forEach(s => console.log(`  ${s.key}: '${out[s.key]}',`))
  console.log('}')
  console.log('\n云函数环境变量请设：TENCENT_DOCS_FILE_ID = ' + FILE_ID)
  console.log('提示：新建文档自带的默认子表（工作表1）可手动删除。')
}

main().catch(e => { console.error('\n❌ 失败：', e.message); process.exit(1) })

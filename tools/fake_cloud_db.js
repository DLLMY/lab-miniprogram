// tools/fake_cloud_db.js
// 内存伪云库（各回归套件共用）：模拟 @cloudbase/node-sdk 的最小接口。
//
// 支持：
//   collection(name).skip(n).limit(n).get()      —— 分页读
//   collection(name).add({data})                  —— 新增
//   collection(name).doc(id).update({data})       —— 按 id 整行更新（部分字段）
//   collection(name).doc(id).remove()             —— 删除
//   collection(name).where(cond).update({data})   —— 【条件更新 / CAS】只更新匹配的行
//   command.inc(n) / command.gte(n) 等            —— 原子自增与比较条件
//
// 为什么要有 where().update()：
//   真实云数据库支持「条件更新」——把期望值写进 where 条件，由数据库保证原子性。
//   这是跨云函数实例并发安全的关键（进程内的写锁只能挡住单实例）。
//   测试若不支持它，就无法验证 CAS 逻辑，等于把最要紧的并发防线留成盲区。
//
// 匹配语义：
//   {_id: 'x'}                     —— 按主键
//   {stock: 10}                    —— 等值（数字按数值比较，字符串按字符串）
//   {stock: command.gte(5)}        —— 大于等于
function makeDb(rows) {
  const store = {}
  Object.keys(rows || {}).forEach(t => {
    store[t] = (rows[t] || []).map((r, i) => Object.assign({ _id: 'r' + (i + 1) + '_' + t }, r))
  })
  let seq = 1000

  const command = {
    inc: (n) => ({ __op: 'inc', n: Number(n) || 0 }),
    gte: (n) => ({ __op: 'gte', n: Number(n) || 0 }),
    gt: (n) => ({ __op: 'gt', n: Number(n) || 0 }),
    lte: (n) => ({ __op: 'lte', n: Number(n) || 0 }),
    lt: (n) => ({ __op: 'lt', n: Number(n) || 0 }),
    eq: (n) => ({ __op: 'eq', n })
  }

  function matchOne(actual, expected) {
    if (expected && typeof expected === 'object' && expected.__op) {
      const a = Number(actual) || 0
      const n = Number(expected.n) || 0
      switch (expected.__op) {
        case 'inc': return true
        case 'gte': return a >= n
        case 'gt': return a > n
        case 'lte': return a <= n
        case 'lt': return a < n
        case 'eq': return a === n
        default: return false
      }
    }
    if (typeof expected === 'number' && typeof actual === 'number') return actual === expected
    return ('' + (actual === undefined || actual === null ? '' : actual)) === ('' + expected)
  }

  function applyData(row, data) {
    Object.keys(data || {}).forEach(k => {
      const v = data[k]
      if (v && typeof v === 'object' && v.__op === 'inc') {
        row[k] = (Number(row[k]) || 0) + v.n
      } else {
        row[k] = v
      }
    })
  }

  return {
    store,
    command,
    collection(name) {
      if (!store[name]) store[name] = []
      const list = store[name]
      let skipN = 0, limitN = null
      return {
        skip(n) { skipN = Math.max(0, Number(n) || 0); return this },
        limit(n) { limitN = Math.max(0, Number(n) || 0); return this },
        async get() {
          const end = limitN == null ? list.length : Math.min(list.length, skipN + limitN)
          return { data: list.slice(skipN, end).map(r => Object.assign({}, r)) }
        },
        async add({ data }) {
          const _id = 'new' + (++seq)
          list.push(Object.assign({ _id }, data))
          return { _id }
        },
        where(cond) {
          return {
            async update({ data }) {
              const matched = list.filter(r => Object.keys(cond || {}).every(k => matchOne(r[k], cond[k])))
              matched.forEach(r => applyData(r, data))
              return { updated: matched.length, stats: { updated: matched.length } }
            }
          }
        },
        doc(id) {
          return {
            async update({ data }) {
              const r = list.find(x => x._id === id)
              if (r) applyData(r, data)
              return { updated: r ? 1 : 0, stats: { updated: r ? 1 : 0 } }
            },
            async remove() {
              const i = list.findIndex(x => x._id === id)
              if (i >= 0) list.splice(i, 1)
              return {}
            }
          }
        }
      }
    }
  }
}

module.exports = { makeDb }

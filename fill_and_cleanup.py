# -*- coding: utf-8 -*-
"""填充示例记录到已创建的 8 张表，并清理重复/默认空表。"""
import sys, json
SKILL_DIR = r"C:\Users\53527\.workbuddy\plugins\cache\workbuddy-builtin\tencent-docs-plugin\5.8.3-wb.41334564.gdb0e9b51.h4da087921e4a\skills\tencent-docs"
sys.path.insert(0, SKILL_DIR)
import tencentdocs

FILE_ID = "DDJvsIIuHZKh"

# 从 list_tables 解析出的业务表 sheet_id（保留 tyR05n 版用户档案）
SHEETS = {
    "users": "tyR05n",
    "materials": "t2KB8x",
    "tools": "ti1nff",
    "requisitions": "tJOBvr",
    "borrow": "tX2nVn",
    "stock_io": "tAgqo0",
    "access": "tCvzwQ",
    "logs": "tzomXO",
}
# 待删除：run1 多建的重复 用户档案 + 默认空表
DELETE = ["tYwkBL", "t00i2h"]

def rpc(service, tool, args):
    res, err = tencentdocs.call_tool(service, tool, args)
    if err:
        raise RuntimeError(f"{service}.{tool} 失败: {err}")
    result = res.get("result", res) if isinstance(res, dict) else res
    if isinstance(result, dict) and "structuredContent" in result and result["structuredContent"]:
        return result["structuredContent"]
    if isinstance(result, dict) and "content" in result:
        try:
            return json.loads(result["content"][0]["text"])
        except Exception:
            return {"_raw": result["content"][0]["text"]}
    return result

def T(v):  return {"field": v[0], "text_value": {"items": [{"text": v[1], "type": "text"}]}}
def N(v):  return {"field": v[0], "number_value": v[1]}
def S(v):  return {"field": v[0], "option_value": {"items": [{"text": v[1]}]}}
def D(v):  return {"field": v[0], "string_value": v[1]}

import datetime
def ts(y,m,d,hh=9,mm=0): return str(int(datetime.datetime(y,m,d,hh,mm).timestamp()*1000))

RECORDS = {
"users": [
  [T(("用户ID","S001")), T(("姓名","张三")), S(("角色","学生")), T(("班级","24电气1")), T(("卡号","C1001")), S(("状态","启用")), D(("创建时间", ts(2026,9,1)))],
  [T(("用户ID","S002")), T(("姓名","李四")), S(("角色","学生")), T(("班级","24电气1")), T(("卡号","C1002")), S(("状态","启用")), D(("创建时间", ts(2026,9,1)))],
  [T(("用户ID","T001")), T(("姓名","邓老师")), S(("角色","教师")), T(("班级","")), T(("卡号","C2001")), S(("状态","启用")), D(("创建时间", ts(2026,8,20)))],
  [T(("用户ID","A001")), T(("姓名","王管理员")), S(("角色","管理员")), T(("班级","")), T(("卡号","C3001")), S(("状态","启用")), D(("创建时间", ts(2026,8,20)))],
],
"materials": [
  [T(("耗材ID","M001")), T(("名称","电阻 10kΩ")), T(("规格","1/4W")), S(("类别","电子元件")), T(("存放位置","A柜-1")), N(("当前库存",320)), T(("单位","个")), N(("预警线",100)), S(("状态","正常"))],
  [T(("耗材ID","M002")), T(("名称","杜邦线")), T(("规格","20cm 公对公")), S(("类别","电子元件")), T(("存放位置","A柜-2")), N(("当前库存",80)), T(("单位","根")), N(("预警线",100)), S(("状态","紧缺"))],
  [T(("耗材ID","M003")), T(("名称","焊锡丝")), T(("规格","0.8mm")), S(("类别","工具耗材")), T(("存放位置","B柜-1")), N(("当前库存",15)), T(("单位","卷")), N(("预警线",5)), S(("状态","正常"))],
  [T(("耗材ID","M004")), T(("名称","A4打印纸")), T(("规格","70g")), S(("类别","办公耗材")), T(("存放位置","C柜-1")), N(("当前库存",12)), T(("单位","包")), N(("预警线",8)), S(("状态","正常"))],
],
"tools": [
  [T(("工具ID","T001")), T(("名称","万用表")), T(("规格","VC830L")), T(("存放位置","工具墙-1")), S(("状态","在库")), T(("当前持有人",""))],
  [T(("工具ID","T002")), T(("名称","电烙铁")), T(("规格","60W")), T(("存放位置","工具墙-2")), S(("状态","借出")), T(("当前持有人","S001"))],
  [T(("工具ID","T003")), T(("名称","示波器")), T(("规格","DS1054Z")), T(("存放位置","仪器柜-1")), S(("状态","在库")), T(("当前持有人",""))],
  [T(("工具ID","T004")), T(("名称","热风枪")), T(("规格","858D")), T(("存放位置","维修台")), S(("状态","维修")), T(("当前持有人",""))],
],
"requisitions": [
  [T(("申请人ID","S002")), T(("物品ID","M003")), S(("物品类型","耗材")), N(("数量",2)), T(("用途说明","焊接练习")), S(("状态","待审批")), D(("申请时间", ts(2026,10,20))), T(("审批人",""))],
  [T(("申请人ID","S001")), T(("物品ID","M001")), S(("物品类型","耗材")), N(("数量",10)), T(("用途说明","课程实验")), S(("状态","通过")), D(("申请时间", ts(2026,10,18))), T(("审批人","T001"))],
  [T(("申请人ID","S002")), T(("物品ID","T002")), S(("物品类型","工具")), N(("数量",1)), T(("用途说明","焊接作业")), S(("状态","通过")), D(("申请时间", ts(2026,10,15))), T(("审批人","T001"))],
  [T(("申请人ID","S001")), T(("物品ID","M004")), S(("物品类型","耗材")), N(("数量",3)), T(("用途说明","文档打印")), S(("状态","拒绝")), D(("申请时间", ts(2026,10,10))), T(("审批人","T001"))],
],
"borrow": [
  [T(("借用人ID","S002")), T(("工具ID","T002")), D(("借出时间", ts(2026,10,15))), D(("计划归还", ts(2026,10,22))), D(("实际归还","")), S(("状态","借出中"))],
  [T(("借用人ID","S001")), T(("工具ID","T003")), D(("借出时间", ts(2026,9,28))), D(("计划归还", ts(2026,10,5))), D(("实际归还", ts(2026,10,4))), S(("状态","已归还"))],
  [T(("借用人ID","S002")), T(("工具ID","T001")), D(("借出时间", ts(2026,8,30))), D(("计划归还", ts(2026,9,10))), D(("实际归还","")), S(("状态","逾期"))],
  [T(("借用人ID","S001")), T(("工具ID","T004")), D(("借出时间", ts(2026,9,1))), D(("计划归还", ts(2026,9,5))), D(("实际归还", ts(2026,9,4))), S(("状态","已归还"))],
],
"stock_io": [
  [T(("物品ID","M001")), S(("方向","入库")), N(("数量",500)), T(("操作人","A001")), D(("操作时间", ts(2026,9,1))), T(("备注","期初入库"))],
  [T(("物品ID","M001")), S(("方向","出库")), N(("数量",180)), T(("操作人","T001")), D(("操作时间", ts(2026,10,18))), T(("备注","领用扣减"))],
  [T(("物品ID","M003")), S(("方向","入库")), N(("数量",20)), T(("操作人","A001")), D(("操作时间", ts(2026,9,5))), T(("备注","补充"))],
  [T(("物品ID","M002")), S(("方向","出库")), N(("数量",240)), T(("操作人","T001")), D(("操作时间", ts(2026,10,20))), T(("备注","领用扣减"))],
],
"access": [
  [T(("用户ID","T001")), T(("门禁点","实训室正门")), D(("刷卡时间", ts(2026,10,22,8,5))), S(("结果","成功"))],
  [T(("用户ID","S001")), T(("门禁点","实训室正门")), D(("刷卡时间", ts(2026,10,22,9,10))), S(("结果","成功"))],
  [T(("用户ID","S099")), T(("门禁点","实训室正门")), D(("刷卡时间", ts(2026,10,22,12,0))), S(("结果","拒绝"))],
  [T(("用户ID","S002")), T(("门禁点","实训室正门")), D(("刷卡时间", ts(2026,10,22,14,30))), S(("结果","成功"))],
],
"logs": [
  [D(("时间", ts(2026,10,22,8,5))), T(("操作人","T001")), T(("操作类型","刷卡进门")), T(("对象","实训室正门")), T(("结果","成功"))],
  [D(("时间", ts(2026,10,20,10,0))), T(("操作人","S002")), T(("操作类型","提交领用申请")), T(("对象","M003")), T(("结果","待审批"))],
  [D(("时间", ts(2026,10,18,11,0))), T(("操作人","T001")), T(("操作类型","审批通过")), T(("对象","M001")), T(("结果","通过"))],
  [D(("时间", ts(2026,10,15,9,0))), T(("操作人","T001")), T(("操作类型","工具借出")), T(("对象","T002")), T(("结果","借出中"))],
],
}

# ---- 校验：先写 users 第1条 ----
name = "users"
sid = SHEETS[name]
print(f"[校验] {name} ({sid}) 写入1条...")
r = rpc("tencent-docs", "smartsheet.add_records", {
    "file_id": FILE_ID, "sheet_id": sid,
    "records": [{"field_values": RECORDS[name][0]}]
})
print("  返回：", json.dumps(r, ensure_ascii=False)[:400])
if r.get("error"):
    print("  !! users 校验失败，停止。请检查字段名/值格式。")
    sys.exit(1)
print("  校验通过，继续批量填充其余 3 条 users + 其他 7 表。\n")

# ---- 批量填充 ----
for name, sid in SHEETS.items():
    rows = RECORDS[name]
    # users 第1条已写，跳过
    if name == "users":
        rows = rows[1:]
    r = rpc("tencent-docs", "smartsheet.add_records", {
        "file_id": FILE_ID, "sheet_id": sid,
        "records": [{"field_values": row} for row in rows]
    })
    ok = not r.get("error")
    print(f"[{'OK' if ok else 'FAIL'}] {name} ({sid}) 写入 {len(rows)} 条 -> {json.dumps(r, ensure_ascii=False)[:160]}")

# ---- 清理重复/默认空表 ----
print("\n[清理] 删除重复/默认空表：", DELETE)
for sid in DELETE:
    r = rpc("tencent-docs", "smartsheet.delete_table", {"file_id": FILE_ID, "sheet_id": sid})
    print(f"  删除 {sid} -> {json.dumps(r, ensure_ascii=False)[:160]}")

# ---- 最终列表 ----
lt = rpc("tencent-docs", "smartsheet.list_tables", {"file_id": FILE_ID})
print("\n[最终] 工作表清单：")
for s in lt.get("sheets", []):
    print(f"  - {s['title']}  ({s['sheet_id']})  visible={s.get('is_visible')}")

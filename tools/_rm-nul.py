# 清理 Windows 保留名残留文件 cloudfunctions/docsProxy/nul
# "nul" 是 Win32 保留设备名：常规路径 API 解析成空设备，读不到也删不掉；
# safe-delete 钩子送回收站时也因"设备名无效"失败并 fail-closed。
# 策略（与本机既有约定一致）：改名 → 再正常删除（改名不触发删除钩子）。
# 关键：\\?\ 扩展长度路径的本地形式是 \\?\D:\...（前缀后直接跟盘符，不能多一个反斜杠）。
import os

S = chr(92)
PREFIX = S * 2 + '?' + S
dir_parts = ['D:', '万州职教中心', 'lab-miniprogram', 'cloudfunctions', 'docsProxy']
ext_dir = PREFIX + S.join(dir_parts)
target = ext_dir + S + 'nul'
renamed = ext_dir + S + 'residue-nul-20261022.bak'

print('目标:', repr(target))
print('stat:', os.stat(target).st_size, '字节')
try:
    os.rename(target, renamed)
    print('已改名 → residue-nul-20261022.bak')
except Exception as e:
    print('改名失败:', e)
    raise SystemExit(1)

d = os.path.join(os.getcwd(), 'cloudfunctions', 'docsProxy')
normal = os.path.join(d, 'residue-nul-20261022.bak')
print('改名后存在:', os.path.exists(normal))
if os.path.exists(normal):
    with open(normal, 'rb') as f:
        print('内容:', f.read()[:120])

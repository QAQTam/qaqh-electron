# ADR-0028 切片 5 的净行数判定（验收线 Δ ≤ 0）。
#
# 删除基线 = §切片 5 实测清单的 138 行：
#   package.json 2 + src/main/pty-host.ts 107 + src/main/index.ts 3
#   + src/preload/index.ts 7 + webui/src/lib/desktop-host.ts 19
# 新增侧只算本轮为 shell 写的行。这些文件同时带着其他人的在飞改动，所以
# **不能**用 git diff 当口径；改为按锚点正则取区间，锚点漂移会当场报错而不是悄悄算错。
# 逐行分代码/注释/空行三个数都报：判定线看的是总行数，代码行是辅助口径。
$ErrorActionPreference = "Stop"
$root = "D:\Projects\qaqh-electron"

# 每块 = 文件 + 起始锚点 + 结束锚点（1-based 闭区间；结束锚点自身不含在内）
$blocks = @(
  @{ f = "src/main/ipc-handlers.ts"; s = '数据面四条\(ADR-0028 切片 5\)'; e = '工作区 git 状态' },
  @{ f = "src/main/ringing-client.ts"; s = '/\* 用户 shell 的 ws 数据面'; e = 'async reconnect\(\)' },
  @{ f = "src/main/native-client.ts"; s = '三个回调互不重叠'; e = 'submit\(target: unknown' },
  @{ f = "src/preload/index.ts"; s = '用户 shell 的 ws 数据面四条'; e = 'find: \{' },
  @{ f = "webui/src/lib/desktop-host.ts"; s = '^\s+\| "shell_attach"'; e = '^\s+\| "git_status"' },
  @{ f = "webui/src/lib/desktop-host.ts"; s = '/\*\* 用户 shell 的 ws 帧'; e = '/\*\* 转录页内查找' },
  @{ f = "webui/src/api/contract.ts"; s = 'import type \{ ShellCloseParams \}'; e = 'export type ServiceMap' },
  @{ f = "src/main/types.ts"; s = 'import type \{ ShellCloseParams \}'; e = 'import type \{ WorkspaceEntry \}' },
  @{ f = "src/main/types.ts"; s = '"用户 shell'; e = 'x-none-x' }  # 占位，下面用两条精确块替代
)
# 表条目 / 清单行 / 抽屉闸门：这三处太小，按匹配行计数
$lineMatchers = @(
  @{ f = "src/main/types.ts"; re = '^\s+"shell\.(open|close|list)":|^\s+// 用户 shell 面' },
  @{ f = "webui/src/api/contract.ts"; re = '^\s+// 用户 shell 面|^\s+"shell\.(open|close|list)":' },
  @{ f = "src/main/types.ts"; re = '^\s+"shell\.open", "shell\.close", "shell\.list",' },
  @{ f = "webui/src/lib/desktop-host.ts"; re = '^\s+shell\?: ShellBridge;' }
)

function Trim-Blank([string[]]$lines) {
  while ($lines.Count -gt 0 -and $lines[-1].Trim() -eq "") { $lines = $lines[0..($lines.Count - 2)] }
  return , $lines
}

$code = 0; $cmt = 0; $blank = 0; $report = @()
foreach ($b in $blocks[0..($blocks.Count - 2)]) {
  $path = Join-Path $root $b.f
  $lines = Get-Content $path
  $si = ($lines | Select-String -Pattern $b.s | Select-Object -First 1).LineNumber
  $ei = ($lines | Select-String -Pattern $b.e | Select-Object -First 1).LineNumber
  if ($null -eq $si -or $null -eq $ei -or $ei -le $si) { throw "锚点失配: $($b.f) [$($b.s) → $($b.e)] si=$si ei=$ei" }
  $slice = Trim-Blank ($lines[($si - 1)..($ei - 2)])
  $c = 0; $m = 0; $k = 0
  foreach ($l in $slice) {
    $t = $l.Trim()
    if ($t -eq "") { $k++ } elseif ($t -match '^(//|\*|/\*)') { $m++ } else { $c++ }
  }
  $code += $c; $cmt += $m; $blank += $k
  $report += ("  {0,-34} L{1}-{2}  代码 {3} 注释 {4} 空行 {5}" -f (Split-Path $b.f -Leaf), $si, ($ei - 1), $c, $m, $k)
}
foreach ($lm in $lineMatchers) {
  $lines = Get-Content (Join-Path $root $lm.f)
  $hits = @($lines | Select-String -Pattern $lm.re)
  foreach ($h in $hits) {
    $t = $h.Line.Trim()
    if ($t -eq "") { $blank++ } elseif ($t -match '^(//|\*|/\*)') { $cmt++ } else { $code++ }
  }
  $report += ("  {0,-34} 匹配 {1} 行" -f (Split-Path $lm.f -Leaf), $hits.Count)
}
# ShellTerminal 的改接：基线 132 行（§切片 5 实测），取现值差
$stPath = Join-Path $root "webui/src/exec/ShellTerminal.tsx"
$stNow = (Get-Content $stPath).Count
$stNet = $stNow - 132
$report += ("  ShellTerminal.tsx 现 {0} 行(基线 132)  净 {1}" -f $stNow, $stNet)
$report | ForEach-Object { $_ }
$total = $code + $cmt + $blank + $stNet
""
"新增合计：代码 {0} + 注释 {1} + 空行 {2} + ShellTerminal {3} = {4}" -f $code, $cmt, $blank, $stNet, $total
"删除基线 138 ⇒ Δ = {0}（判定线 Δ ≤ 0）⇒ {1}" -f ($total - 138), $(if ($total - 138 -le 0) { "PASS" } else { "FAIL" })
"辅助口径（只算代码行）：{0} ⇒ Δ = {1}" -f ($code + $stNet), ($code + $stNet - 138)

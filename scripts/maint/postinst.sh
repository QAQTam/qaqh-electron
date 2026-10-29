#!/usr/bin/env bash
# deb afterInstall —— 把出厂基线落成系统 seed。非交互、恒返零:任何失败只记
# stderr,绝不让包卡在半安装状态。
#
# 架构口径:dpkg 就是解压器,但 postinst 以 root 运行、无法感知任何用户家目录,
# 所以这里只把基线 unpack 到共享 seed(/var/lib/qaqh-harness,世界可读);
# 「提升到用户域 ~/.local/share/QAQ-Harness」由壳首跑以用户身份执行
# (src/main/baseline.ts ensureBaselineSeeded)。
set -u

# chrome-sandbox 必须 root:root 4755:Electron 只要发现 exe 旁的 chrome-sandbox
# 就走 SUID 沙箱路径,权限不对直接 CHECK 失败自杀(SIGTRAP)。上游 after-install.tpl
# 在 userns 可用时会故意 chmod 0755,且自定义 afterInstall 会整体替换模板
# (electron-builder#8951,未修复),所以这里显式兜底。恒返零,不阻塞安装。
for candidate in /opt/QAQ-Harness /opt/qaqh-harness; do
  sandbox_helper="$candidate/chrome-sandbox"
  if [ -f "$sandbox_helper" ]; then
    chown root:root "$sandbox_helper" 2>/dev/null || true
    chmod 4755 "$sandbox_helper" 2>/dev/null || true
  fi
done

BASE_DIR="${QAQH_BASE_DIR:-}"
if [ -z "$BASE_DIR" ]; then
  for candidate in /opt/QAQ-Harness /opt/qaqh-harness; do
    if [ -d "$candidate/resources/baseline" ]; then
      BASE_DIR="$candidate"
      break
    fi
  done
fi
if [ -z "$BASE_DIR" ]; then
  echo "postinst: baseline directory not found, skip seeding" >&2
  exit 0
fi

MAINT="$BASE_DIR/resources/bin/qaqh-maint"
if [ ! -x "$MAINT" ]; then
  echo "postinst: $MAINT missing or not executable, skip seeding" >&2
  exit 0
fi

SEED_DIR="${QAQH_SEED_DIR:-/var/lib/qaqh-harness}"
mkdir -p "$SEED_DIR" || exit 0

for bundle in "$BASE_DIR/resources/baseline/"*.zip; do
  [ -e "$bundle" ] || continue
  if ! "$MAINT" unpack "$bundle" "$SEED_DIR" >/dev/null 2>&1; then
    echo "postinst: seeding $(basename "$bundle") failed" >&2
  fi
done
# seed 是共享只读基线:用户域提升时由用户进程读取,权限放宽到 a+rX。
chmod -R a+rX "$SEED_DIR" 2>/dev/null || true
echo "postinst: baseline seeded into $SEED_DIR"
exit 0

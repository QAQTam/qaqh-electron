#!/usr/bin/env bash
# deb afterRemove —— 升级与卸载都会走到这里(fpm 未暴露 before-remove 钩子;
# Linux 上替换运行中的二进制无风险,daemon 停止时机略晚于文件替换是可接受的)。
# 职责:带超时停 daemon → 清系统 seed。恒返零。
#
# 用户域 overlay(~/.local/share/QAQ-Harness)包含用户数据,**有意保留**——
# root 不该遍历家目录删东西;需要彻底清理时由用户自跑 `qaqh-maint cleanup`。
set -u

stop_daemon() {
  pkill -x qaqh-daemon >/dev/null 2>&1 || return 0
  for _ in $(seq 1 40); do
    pgrep -x qaqh-daemon >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  pkill -9 -x qaqh-daemon >/dev/null 2>&1 || true
  return 0
}
stop_daemon

SEED_DIR="${QAQH_SEED_DIR:-/var/lib/qaqh-harness}"
rm -rf "$SEED_DIR" 2>/dev/null || true
echo "postrm: daemon stopped; seed $SEED_DIR removed (user overlay preserved)"
exit 0

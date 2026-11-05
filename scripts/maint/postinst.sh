#!/usr/bin/env bash
# deb afterInstall: system files are owned by dpkg. Validate the installed
# Chromium sandbox permissions; never seed a user install.
set -u

BASE_DIR="${QAQH_BASE_DIR:-/opt/QAQ-Harness}"
sandbox_helper="$BASE_DIR/chrome-sandbox"
if [ -f "$sandbox_helper" ]; then
  chown root:root "$sandbox_helper" || exit 1
  chmod 4755 "$sandbox_helper" || exit 1
fi

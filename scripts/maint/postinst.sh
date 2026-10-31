#!/usr/bin/env bash
# deb afterInstall: system files are owned by dpkg. Validate the installed
# system payload and configure sandbox permissions; never seed a user install.
set -u

BASE_DIR="${QAQH_BASE_DIR:-/opt/QAQ-Harness}"
MAINT="$BASE_DIR/resources/bin/qaqh-maint"

if [ ! -x "$MAINT" ]; then
  echo "postinst: required maintenance CLI missing or not executable: $MAINT" >&2
  exit 1
fi
if [ ! -d "$BASE_DIR/resources/baseline" ]; then
  echo "postinst: required offline baseline missing: $BASE_DIR/resources/baseline" >&2
  exit 1
fi

sandbox_helper="$BASE_DIR/chrome-sandbox"
if [ -f "$sandbox_helper" ]; then
  chown root:root "$sandbox_helper" || exit 1
  chmod 4755 "$sandbox_helper" || exit 1
fi

"$MAINT" system-check --resources "$BASE_DIR/resources"

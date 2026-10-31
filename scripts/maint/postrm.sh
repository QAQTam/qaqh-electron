#!/usr/bin/env bash
# deb afterRemove: dpkg owns the system files. User components and daemon
# processes are deliberately outside this hook; users manage them in-session.
set -u

case "${1:-}" in
  remove|purge)
    # The old shared seed is no longer authoritative and may contain files not
    # owned by dpkg. Never recursively remove it from a root lifecycle hook.
    echo "postrm: $1 complete; user components and data were left untouched"
    ;;
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear|*)
    echo "postrm: ${1:-unknown} complete; no user processes or home directories touched"
    ;;
esac
exit 0

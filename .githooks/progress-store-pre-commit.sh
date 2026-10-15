#!/bin/sh
# progress-tracking (store mode): the pre-commit gate. Installed by `triqual progress-init --store`; re-running it
# updates this file. It does nothing in a checkout whose `triqual.tracking` marker is unset.
[ "$(git config --local --get triqual.tracking)" = store ] || exit 0
command -v triqual >/dev/null 2>&1 || { echo "pre-commit (progress-tracking, store mode): triqual is not on PATH, so this commit cannot be checked for a pending progress entry: install triqual or fix PATH" >&2; exit 1; }
exec triqual tracking hook pre-commit

#!/bin/sh
# progress-tracking (store mode): the post-commit gate. Installed by `triqual progress-init --store`; re-running it
# updates this file. It does nothing in a checkout whose `triqual.tracking` marker is unset.
[ "$(git config --local --get triqual.tracking)" = store ] || exit 0
command -v triqual >/dev/null 2>&1 || { echo "post-commit (progress-tracking, store mode): triqual is not on PATH, so this commit's progress entries stay pending" >&2; exit 0; }
exec triqual tracking hook post-commit

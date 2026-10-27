#!/bin/sh
# Stub for `gh` used by the smoke test: pr view fails (no PR yet), pr create
# prints a fake URL, pr merge merges the branch locally into the base.
case "$1 $2" in
  "pr view") exit 1 ;;
  "pr create") echo "https://example.invalid/pr/1" ;;
  "pr merge")
    base=$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p'); [ -n "$base" ] || base=main
    branch=$(git rev-parse --abbrev-ref HEAD)
    git push --quiet origin "HEAD:refs/heads/$base" && echo "merged $branch into $base" ;;
  *) echo "fake gh: unsupported $*" >&2; exit 1 ;;
esac

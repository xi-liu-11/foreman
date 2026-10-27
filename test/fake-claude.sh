#!/bin/sh
# Stub for `claude -p`: emits stream-json like the real CLI. No model is called.
# Mode comes from $FOREMAN_HOME/mode: done | block | fail. A --resume run always completes.
mode=$(cat "$FOREMAN_HOME/mode" 2>/dev/null || echo done)
case "$*" in *--resume*) mode=resumed ;; esac
sid=$(uuidgen | tr 'A-Z' 'a-z')
echo "{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"fake\",\"session_id\":\"$sid\"}"
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"fake worker in $(pwd), mode=$mode\"},{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}]}}"
sleep 2
case $mode in
  block) task block "Which colour should the button be?" >/dev/null 2>&1
         so='{"status":"blocked","summary":"Need the button colour.","verdict":"n/a","artifacts":[],"notes_for_next":""}' ;;
  fail)  echo "fake crash" >&2; exit 1 ;;
  slow)  sleep 12; so='{"status":"done","summary":"Slow but done.","verdict":"n/a","artifacts":[],"notes_for_next":""}' ;;
  resumed) so='{"status":"done","summary":"Resumed and finished.","verdict":"n/a","artifacts":[],"notes_for_next":""}' ;;
  *)     task note "fake milestone" >/dev/null 2>&1
         so='{"status":"done","summary":"Fake report written.","verdict":"n/a","artifacts":[{"path":"specs/research/fake.md","kind":"report"}],"notes_for_next":""}' ;;
esac
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":3,\"total_cost_usd\":0.01,\"session_id\":\"$sid\",\"structured_output\":$so}"

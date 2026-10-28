#!/bin/sh
# Stub for `claude -p`: emits stream-json like the real CLI. No model is called.
# Mode comes from $FOREMAN_HOME/mode: done | block | fail | slow. A --resume run
# always completes. For implement pipelines the step name (FOREMAN_STEP_NAME)
# drives behaviour: QA children fail once per task (counter file) then pass,
# and the pr step writes pr.md so open_pr has a body.
mode=$(cat "$FOREMAN_HOME/mode" 2>/dev/null || echo done)
case "$*" in *--resume*) mode=resumed ;; esac
sid=$(uuidgen | tr 'A-Z' 'a-z')
echo "{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"fake\",\"session_id\":\"$sid\"}"
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"fake worker in $(pwd), step=${FOREMAN_STEP_NAME:-?}, mode=$mode\"},{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}]}}"
sleep 1
verdict='n/a'
case "${FOREMAN_STEP_NAME:-}" in
  review|test)
    counter="$FOREMAN_HOME/qa-fails-$FOREMAN_TASK-$FOREMAN_STEP_NAME"
    if [ -f "$counter" ]; then verdict=pass; else touch "$counter"; verdict=fail; fi
    mode=done ;;
  specify|plan|plan_qa|implement)
    echo "step $FOREMAN_STEP_NAME ran" >> work.log; git add -A >/dev/null 2>&1; git -c user.email=f@x -c user.name=foreman commit -qm "fake $FOREMAN_STEP_NAME" >/dev/null 2>&1
    [ "$FOREMAN_STEP_NAME" = plan_qa ] && verdict=pass
    mode=done ;;
  handoff)
    fd=$(ls -d specs/*/ 2>/dev/null | head -1); mkdir -p "$fd"; printf '## Summary\nThe widget now exists.\n\n## To verify\n1. Open the app.\n' > "$fd/handoff.md"; git add -A >/dev/null 2>&1; git -c user.email=f@x -c user.name=foreman commit -qm "fake handoff" >/dev/null 2>&1
    [ -n "$FOREMAN_TASK" ] && task ticket comment "Ready to verify: the widget now exists." >/dev/null 2>&1; task ticket transition "In Review" >/dev/null 2>&1
    mode=done ;;
esac
case $mode in
  block) task block "Which colour should the button be?" >/dev/null 2>&1
         so='{"status":"blocked","summary":"Need the button colour.","verdict":"n/a","artifacts":[],"notes_for_next":""}' ;;
  fail)  echo "fake crash" >&2; exit 1 ;;
  slow)  sleep 12; so='{"status":"done","summary":"Slow but done.","verdict":"n/a","artifacts":[],"notes_for_next":""}' ;;
  resumed) so='{"status":"done","summary":"Resumed and finished.","verdict":"n/a","artifacts":[],"notes_for_next":""}' ;;
  *)     task note "fake milestone" >/dev/null 2>&1
         so="{\"status\":\"done\",\"summary\":\"Fake ${FOREMAN_STEP_NAME:-step} done.\",\"verdict\":\"$verdict\",\"artifacts\":[{\"path\":\"specs/research/fake.md\",\"kind\":\"report\"}],\"notes_for_next\":\"\"}" ;;
esac
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":3,\"total_cost_usd\":0.01,\"session_id\":\"$sid\",\"structured_output\":$so}"

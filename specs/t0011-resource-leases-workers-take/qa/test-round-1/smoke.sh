#!/bin/zsh
# Route + CLI smoke for T0011 against a throwaway taskd. Run from the repo root.

ROOT=$PWD; PORT=17791; TOKEN=qatoken
export FOREMAN_HOME=$(mktemp -d /tmp/fm-qa-XXXX)
cat > $FOREMAN_HOME/config.toml <<TOML
[server]
port = $PORT
bind = "127.0.0.1"
token = "$TOKEN"
[defaults]
lease_sec = 3600
[projects.P]
path = "$ROOT"
verify = "inspect"
resources = ["ios-sim", "android-emu"]
[projects.Q]
path = "$ROOT"
TOML
bun specs/t0011-resource-leases-workers-take/qa/test-round-1/seed.ts $FOREMAN_HOME/foreman.db
bin/foreman taskd > $FOREMAN_HOME/taskd.log 2>&1 &
TASKD=$!; trap "kill $TASKD" EXIT
sleep 2
export FOREMAN_URL=http://127.0.0.1:$PORT FOREMAN_TOKEN=$TOKEN
T() { echo "\$ FOREMAN_TASK=$1 FOREMAN_STEP=$2 task ${@:3}"; FOREMAN_TASK=$1 FOREMAN_STEP=$2 bin/task "${@:3}"; echo "[exit $?]"; }
C() { echo "\$ curl $1 $2 $3"; curl -s -o /dev/stdout -w "  [http %{http_code}]\n" -X $1 -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "${3}"} $FOREMAN_URL$2; }

echo "== S8 fencing"
C POST /steps/4/lease '{"resource":"ios-sim"}'
C POST /steps/5/lease '{"resource":"ios-sim"}'
C GET "/leases?project=P"

echo "== S10 grant / already held / undeclared warning"
T T0001 1 lease ios-sim --reason "maestro flows"
T T0001 1 lease ios-sim
T T0001 1 lease ios-sm
T T0001 1 release ios-sm

echo "== S10 --wait 5 exits 3 and keeps place"
T T0002 2 lease ios-sim --wait 5
T T0003 3 lease ios-sim --wait 1
T T0002 2 leases
T T0002 2 show | sed -n '/^leases:/,/^$/p'

echo "== S5 scoping: P/mini and Q/local are not blocked"
T T0006 6 lease ios-sim --wait 1
T T0007 7 lease ios-sim --wait 1

echo "== S10 indefinite wait: B waits, A releases after 40s"
( sleep 40; T T0001 1 release ios-sim ) & RELEASER=$!
T T0002 2 lease ios-sim
wait $RELEASER
echo "== S3 cancel route releases holder T0002, T0003 granted"
C POST /tasks/T0002/cancel '{}'
T T0003 3 lease ios-sim --wait 1
T T0003 3 leases --project P
echo "== dashboard serves devices block"
curl -s $FOREMAN_URL/ | grep -ci 'devices'
echo "== lease events"
sqlite3 $FOREMAN_HOME/foreman.db "select id, task_id, step_id, type, data from events where type like 'lease.%' order by id"
echo "== taskd log"; cat $FOREMAN_HOME/taskd.log

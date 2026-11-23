#!/usr/bin/env bash
# Worked example: drives the expense-approval definition down BOTH sides of its branch
# to completion, proves runs are unaffected by later definition edits, and exercises
# the main error paths. Exits non-zero on the first unexpected response.
#
# Usage: docker compose up --build -d && ./examples/demo.sh
# Needs: bash, curl, node (used only to read JSON fields).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS=""
BODY=""

# call METHOD PATH [JSON_BODY]  -> sets STATUS and BODY
call() {
  local method=$1 path=$2 data=${3:-} out
  if [[ -n "$data" ]]; then
    out=$(curl -sS -X "$method" "$BASE_URL$path" -H 'Content-Type: application/json' -d "$data" -w $'\n%{http_code}')
  else
    out=$(curl -sS -X "$method" "$BASE_URL$path" -w $'\n%{http_code}')
  fi
  STATUS=${out##*$'\n'}
  BODY=${out%$'\n'*}
}

# expect CODE METHOD PATH [JSON_BODY]
expect() {
  local code=$1
  shift
  call "$@"
  if [[ "$STATUS" != "$code" ]]; then
    echo "FAIL: $1 $2 -> expected HTTP $code, got $STATUS"
    echo "$BODY"
    exit 1
  fi
  echo "  ok  $1 $2 -> $STATUS"
}

# get JS_EXPR  -> evaluates the expression against the last response body, bound to `r`
get() {
  node -e 'const r = JSON.parse(process.argv[1]); const v = eval(process.argv[2]);
           console.log(v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));' "$BODY" "$1"
}

# check JS_EXPR EXPECTED DESCRIPTION
check() {
  local actual
  actual=$(get "$1")
  if [[ "$actual" != "$2" ]]; then
    echo "FAIL: $3: expected '$2', got '$actual'"
    echo "$BODY"
    exit 1
  fi
  echo "  ok  $3 ($actual)"
}

section() { printf '\n== %s ==\n' "$1"; }

section "Health"
expect 200 GET /health

section "Author the definition"
expect 400 POST /definitions '{"name":"broken","startTaskId":"a","tasks":[{"id":"a","type":"data_entry","steps":[{"id":"s","fields":[{"key":"x","type":"text"}]}],"next":"nowhere"},{"id":"e","type":"end"}]}'
check "r.error.code" "INVALID_DEFINITION" "dangling next is rejected"
expect 201 POST /definitions "$(cat "$DIR/expense-approval.json")"
DEF=$(get "r.id")
expect 200 GET "/definitions/$DEF"
check "r.tasks.find(t => t.id === 'route').rules[0].when.all[0].value" "500" "threshold is 500"

section "Path A: amount 700 > 500 -> manager_review -> approved_end"
expect 201 POST /runs "{\"definitionId\":\"$DEF\"}"
RUN_A=$(get "r.id")
check "r.status" "active" "run starts active"
check "r.currentStep.taskId + '/' + r.currentStep.id" "request/basics" "waiting on request step 1"
expect 200 POST "/runs/$RUN_A/tasks/request/submit" '{"action":"save","data":{"amount":700}}'
check "r.active[0].draft.amount" "700" "save keeps progress without finishing the step"
check "r.currentStep.index" "0" "still on step 1 after save"
expect 400 POST "/runs/$RUN_A/tasks/request/submit" '{"action":"complete","data":{}}'
check "r.error.details.errors[0].key + ' ' + r.error.details.errors[0].message" "category is required" "complete without a required field is rejected"
expect 200 POST "/runs/$RUN_A/tasks/request/submit" '{"action":"complete","data":{"category":"travel"}}'
check "r.currentStep.id + ' ' + r.currentStep.index + '/' + r.currentStep.totalSteps" "details 1/2" "moved to step 2"
expect 409 POST "/runs/$RUN_A/tasks/manager_review/submit" '{"action":"complete","data":{"decision":"approve"}}'
check "r.error.code + ' ' + r.error.details.activeTaskId" "TASK_NOT_ACTIVE request" "submit to a non-active task is rejected"
expect 200 POST "/runs/$RUN_A/tasks/request/submit" '{"action":"complete","data":{"reason":"Client dinner","tags":["client"]}}'
check "(d => d.matchedRule + ' -> ' + d.next)(r.done.find(t => t.taskId === 'route').decision)" "0 -> manager_review" "branch matched rule 0"
check "r.currentTaskId" "manager_review" "engine advanced to manager_review"
expect 200 POST "/runs/$RUN_A/tasks/manager_review/submit" '{"action":"complete","data":{"decision":"approve","comment":"ok"}}'
check "r.status + ' at ' + r.currentTaskId" "completed at approved_end" "run A completed"
check "r.done.map(t => t.taskId).join(',')" "request,route,manager_review,approved_end" "run A path"
expect 409 POST "/runs/$RUN_A/tasks/manager_review/submit" '{"action":"complete","data":{"decision":"approve"}}'
check "r.error.code" "RUN_NOT_ACTIVE" "submit to a completed run is rejected"

section "Path B: amount 120 <= 500 -> auto_approved"
expect 201 POST /runs "{\"definitionId\":\"$DEF\"}"
RUN_B=$(get "r.id")
expect 400 POST "/runs/$RUN_B/tasks/request/submit" '{"action":"complete","data":{"amount":"120","category":"meals"}}'
check "r.error.details.errors[0].message" "must be a JSON number" "string \"120\" is not coerced to a number"
expect 200 POST "/runs/$RUN_B/tasks/request/submit" '{"action":"complete","data":{"amount":120,"category":"meals"}}'
expect 200 POST "/runs/$RUN_B/tasks/request/submit" '{"action":"complete","data":{"reason":"Team lunch"}}'
check "(d => d.matchedRule + ' -> ' + d.next)(r.done.find(t => t.taskId === 'route').decision)" "null -> auto_approved" "no rule matched, default taken"
check "r.status + ' at ' + r.currentTaskId" "completed at auto_approved" "run B completed"
check "r.done.map(t => t.taskId).join(',')" "request,route,auto_approved" "run B path"

section "Snapshot: editing the definition does not affect a run already started"
expect 201 POST /runs "{\"definitionId\":\"$DEF\"}"
RUN_C=$(get "r.id")
EDITED=$(node -e 'const d = require(process.argv[1]);
  d.tasks.find(t => t.id === "route").rules[0].when.all[0].value = 1000;
  console.log(JSON.stringify(d));' "$DIR/expense-approval.json")
expect 200 PUT "/definitions/$DEF" "$EDITED"
check "r.tasks.find(t => t.id === 'route').rules[0].when.all[0].value" "1000" "definition threshold is now 1000"
expect 200 POST "/runs/$RUN_C/tasks/request/submit" '{"action":"complete","data":{"amount":700,"category":"equipment"}}'
expect 200 POST "/runs/$RUN_C/tasks/request/submit" '{"action":"complete","data":{"reason":"Monitor"}}'
check "r.currentTaskId" "manager_review" "run C (started before edit) still uses threshold 500"
expect 201 POST /runs "{\"definitionId\":\"$DEF\"}"
RUN_D=$(get "r.id")
expect 200 POST "/runs/$RUN_D/tasks/request/submit" '{"action":"complete","data":{"amount":700,"category":"equipment"}}'
expect 200 POST "/runs/$RUN_D/tasks/request/submit" '{"action":"complete","data":{"reason":"Monitor"}}'
check "r.status + ' at ' + r.currentTaskId" "completed at auto_approved" "run D (started after edit) uses threshold 1000"

section "Inspect and cancel"
expect 200 GET "/runs/$RUN_C"
check "r.active.map(t => t.taskId).join(',')" "manager_review" "run C has manager_review active"
expect 200 POST "/runs/$RUN_C/cancel"
check "r.status" "cancelled" "run C cancelled"
check "r.active.length + ' ' + r.done.find(t => t.taskId === 'manager_review').status" "0 cancelled" "active task marked cancelled"
expect 409 POST "/runs/$RUN_C/cancel"
check "r.error.code" "RUN_NOT_ACTIVE" "cancelling a finished run is rejected"
expect 404 GET /runs/00000000-0000-0000-0000-000000000000

printf '\nALL CHECKS PASSED\n'

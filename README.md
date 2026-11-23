# Workflow Engine

A small service to **define a workflow once** (a graph of tasks) and **run it many times**, driving each run to completion over an HTTP API. Runs move through human data-entry tasks, engine-resolved branch tasks and end tasks. Each run follows the definition exactly as it was when the run started.

**Stack:** Node.js + TypeScript, Express, PostgreSQL 16, Sequelize, zod. Everything runs under Docker Compose.

---

## Run it

```bash
docker compose up --build          # Postgres + API on http://localhost:3000
```

Then, in another terminal, run the worked example. It drives both sides of the branch to completion and checks every response:

```bash
./examples/demo.sh                 # needs bash, curl and node on the host; prints ALL CHECKS PASSED
```

- Tables are created on boot (`sequelize.sync()`).
- Postgres is not published to the host. Inspect it with `docker compose exec db psql -U postgres -d workflow`.
- Reset all data with `docker compose down -v`.

### Input limits

These limits turn input that JSON allows, but that would break later, into a 400:

- Names, task ids, step ids and field keys are at most 255 characters (the database column size).
- `"__proto__"` is reserved: it can't be used as an id or key, in a definition or in submitted data.
- Strings may not contain NUL (`\u0000`), which Postgres can't store.
- Numbers must be finite. `1e309` would otherwise become `Infinity` and then be stored as `null`.
- Conditions can be nested about 500 levels deep before the request is rejected as too deeply nested.

---

## Concepts

| Term | Meaning |
|---|---|
| **Definition** | A reusable workflow template: `name`, `startTaskId`, and `tasks[]`. Can be edited in place with `PUT`. |
| **Run** | One execution of a definition. It holds a **frozen snapshot** of the definition, its status (`active` / `completed` / `cancelled`), the active task, and the `data` collected so far. |
| **Run task** | One execution of a task inside a run, stored as a row in `run_tasks`. Its status is `active`, `completed` or `cancelled`. Re-entering a task (in a loop) creates a new row. |

### Task kinds

| Kind | Who completes it | Shape |
|---|---|---|
| `data_entry` | A human, via the submit API | `{ id, type: "data_entry", steps: [{ id, fields: [...] }], next }` |
| `branch` | The engine, automatically | `{ id, type: "branch", rules: [{ when, next }], default }` |
| `end` | The engine; it marks the run `completed` | `{ id, type: "end" }` |

### Field types (data entry)

`{ key, type, label?, required?, options? }`. Types are strict JSON, with no coercion:

| `type` | Accepted value |
|---|---|
| `text` | a JSON string |
| `number` | a finite JSON number (`"700"` is rejected) |
| `single_select` | one string from `options` |
| `multi_select` | an array of distinct strings from `options` |

A `required` field must be present and non-empty when its step is completed: not `""` and not `[]`. Field keys are unique within a task, because a task's answers are stored as one flat object.

---

## Branch decision logic: what it can express and how to write it

A branch task holds an **ordered list of rules** plus a **mandatory `default`**:

```json
{
  "id": "route",
  "type": "branch",
  "rules": [
    { "when": { "field": "request.amount", "op": "gt", "value": 500 }, "next": "manager_review" },
    { "when": { "any": [
        { "field": "request.category", "op": "eq", "value": "equipment" },
        { "field": "request.tags", "op": "contains", "value": "urgent" }
      ] }, "next": "fast_track" }
  ],
  "default": "auto_approved"
}
```

**Evaluation:** rules are tried top to bottom, and the **first matching rule wins**. If none match, the run goes to `default`. The decision (`matchedRule` index, or `null` for the default, plus `next`) is recorded on the branch's run-task row and shown when you inspect the run.

**Grammar.** A condition is one of:

- **Comparison**: `{ "field": "<taskId>.<fieldKey>", "op": <op>, "value": <json> }`
- **AND**: `{ "all": [ <condition>, ... ] }`. An empty list is true.
- **OR**: `{ "any": [ <condition>, ... ] }`. An empty list is false.

Groups nest to any depth, so any AND/OR combination of comparisons can be written. There is no `not`; write the negated operator (`neq`, `lte` and so on) or order the rules instead.

**Operators.** `actual` is the collected value; `value` is the constant in the rule.

| op | True when | `value` must be |
|---|---|---|
| `eq` / `neq` | `actual` equals / does not equal `value`. Type-strict (`5` ≠ `"5"`). Arrays are compared in order (`["p","q"]` ≠ `["q","p"]`). | any JSON |
| `gt` `gte` `lt` `lte` | both are numbers and the comparison holds | number |
| `in` | `actual` is one of the items of `value` | array |
| `contains` | `actual` is an array (a `multi_select`) that includes `value` | any JSON |
| `exists` | the field was collected. A submitted empty string `""` counts as collected. | (no value) |

**What a branch can read:** only answers from data-entry tasks that have **completed** in this run (`run.data`). Drafts and unfinished steps are invisible to branches.

**Missing data:** if the referenced task never ran on this path, or an optional field was left out, **every comparison on that field is false**. That includes `neq` and `exists`, so the rule falls through to the next rule or to `default`. To branch on "was this filled in?", use `exists`.

**Checked when a definition is saved** (400 `INVALID_DEFINITION` otherwise):

- `field` must be `taskId.fieldKey`, pointing at an existing `data_entry` task and a field it declares.
- `gt`/`gte`/`lt`/`lte` need a number, `in` needs an array, and `exists` takes no value.
- Every `next` and `default` must point to an existing task.
- Branch tasks must not form a cycle among themselves. A loop must pass through a human data-entry task.

---

## How a run executes

1. **Start:** `POST /runs` copies the definition into the run (the snapshot). The engine then advances from `startTaskId`.
2. **Advance (automatic):** the engine walks the snapshot.
   - `branch`: evaluates the rules, records the decision, moves on.
   - `end`: marks the run `completed` and stops.
   - `data_entry`: creates an active run task and stops to wait for a human.
3. **Submit:** a human submits to the active data-entry task.
   - `save` stores a draft without finishing anything, and no required-field check runs.
   - `complete` validates the current step (types and required fields) and moves to the next step.
   - Completing the **last** step completes the task: its answers are copied into `run.data[taskId]` and the engine advances again (step 2).
4. This repeats until an `end` task is reached, or the run is cancelled.

**Loops** are allowed when they pass through a data-entry task (e.g. "rejected → back to request"). Re-entry creates a new run-task row, and the latest answers overwrite `run.data[taskId]`.

### Runs are unaffected by later edits: how

- When a run is created, the definition's `name`, `startTaskId` and `tasks` are **deep-copied into `workflow_runs.definition_snapshot`**, in the same transaction that creates the run.
- The engine **only ever reads the run's snapshot**, never the `workflow_definitions` row.
- `PUT /definitions/:id` updates only the definition row, so a run in flight keeps the graph it started with, and runs started after the edit get the new one.

`demo.sh` proves this. A run started at threshold 500 still routes to `manager_review` after the definition is edited to 1000, while a new run with the same input is auto-approved.

**Alternatives considered:**

- **Immutable numbered versions**, with each run pinned to `(definitionId, version)`. This gives history and no per-run duplication, but version history isn't needed here.
- **Content-hash versions** (Git-style), which deduplicate identical edits.
- **Time-keyed versions**, which depend on clocks.
- **An event-sourced definition**, which is overkill.
- **Temporal-style patching**, where in-flight runs deliberately pick up new logic.

The snapshot column is the simplest option that satisfies the requirement. It can move to versioned definitions later without changing the engine, because the engine already takes the graph as an argument.

### Consistency

- Every write to a run (submit, cancel, the engine advancing) happens in **one database transaction** that first **locks the run row** (`SELECT … FOR UPDATE`). Validation, the step change, task completion, the copy into `run.data` and all automatic engine moves commit together or not at all.
- A **partial unique index** (`run_tasks(run_id) WHERE status = 'active'`) makes "at most one active task per run" a database guarantee. A `(run_id, seq)` unique index keeps the task order deterministic.
- In a quick manual check, 5 parallel `complete` calls on the same step gave exactly one success. The rest were rejected because the step had already moved on. This wasn't built as the optional concurrency stretch goal, but the locking design already covers it.

---

## API contract

Base URL is `http://localhost:3000`, and all bodies are JSON.

**Errors** always look like this:

```json
{ "error": { "code": "TASK_NOT_ACTIVE", "message": "Task \"manager_review\" is not the active task", "details": { "activeTaskId": "request" } } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_DEFINITION` | The definition shape or semantics are wrong. `details.problems[]` or `details.issues[]` say what. |
| 400 | `INVALID_INPUT` | The submit data fails the current step. `details.errors[] = {key, message}` |
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | The request body is wrong or not JSON. |
| 404 | `DEFINITION_NOT_FOUND` / `RUN_NOT_FOUND` / `NOT_FOUND` | Unknown id or route. |
| 409 | `TASK_NOT_ACTIVE` | The submit targets a task that isn't the active one. `details.activeTaskId` names the active task. |
| 409 | `RUN_NOT_ACTIVE` | Submit or cancel on a completed or cancelled run. |

### Definitions

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/definitions` | definition | `201` definition with `id`, `createdAt`, `updatedAt` |
| `GET` | `/definitions/:id` | | `200` definition |
| `PUT` | `/definitions/:id` | full definition (replaces it) | `200` definition. Runs already started are unaffected. |

```bash
curl -s -X POST localhost:3000/definitions -H 'Content-Type: application/json' -d @examples/expense-approval.json
```

### Runs

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/runs` | `{ "definitionId": "<uuid>" }` | `201` RunView, already advanced to the first data-entry task |
| `GET` | `/runs/:id` | | `200` RunView |
| `POST` | `/runs/:id/tasks/:taskId/submit` | `{ "action": "save" \| "complete", "data": { ... } }` | `200` RunView |
| `POST` | `/runs/:id/cancel` | | `200` RunView with `status: "cancelled"`. The active task is marked `cancelled`. |

`:taskId` in the submit path must be the currently active task. This guards against stale clients writing into the wrong task. `data` may only contain fields of the **current step**.

**RunView** (shown here for a run waiting on step 2 of `request`):

```json
{
  "id": "f64f…", "definitionId": "c125…", "definitionName": "Expense approval",
  "status": "active",
  "currentTaskId": "request",
  "currentStep": {
    "taskId": "request", "id": "details", "index": 1, "totalSteps": 2,
    "fields": [ { "key": "reason", "type": "text", "required": true }, { "key": "tags", "type": "multi_select", "options": ["urgent","client","internal"] } ]
  },
  "done": [],
  "active": [
    { "id": "…", "taskId": "request", "type": "data_entry", "status": "active", "stepIndex": 1,
      "draft": { "amount": 700, "category": "travel" }, "startedAt": "…", "completedAt": null }
  ],
  "data": {},
  "createdAt": "…", "updatedAt": "…"
}
```

- `done` lists finished task executions in order. Completed data-entry tasks carry `output`; branch tasks carry `decision: { matchedRule, next }`; cancelled tasks are included too.
- `active` holds the task currently waiting on a human (empty once the run is finished).
- `data` holds the answers of completed tasks, keyed by `taskId`. This is what branches read.
- `currentStep` is `null` unless the run is waiting on a human.

---

## Worked example

The definition is [`examples/expense-approval.json`](examples/expense-approval.json):

```text
request (data_entry, 2 steps)            route (branch)                         
  basics:  amount* number, category*   ──►  amount > 500 ──► manager_review ──► approved_end
  details: reason* text, tags          ──►  otherwise    ──► auto_approved
```

The call sequence, which `examples/demo.sh` runs and asserts:

```bash
B=localhost:3000; J='Content-Type: application/json'
DEF=$(curl -s -X POST $B/definitions -H "$J" -d @examples/expense-approval.json | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

# ---- Path A: amount 700 → manager_review → approved_end
RUN=$(curl -s -X POST $B/runs -H "$J" -d "{\"definitionId\":\"$DEF\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -X POST $B/runs/$RUN/tasks/request/submit -H "$J" -d '{"action":"save","data":{"amount":700}}'            # draft only
curl -s -X POST $B/runs/$RUN/tasks/request/submit -H "$J" -d '{"action":"complete","data":{"category":"travel"}}'  # step 1 done
curl -s -X POST $B/runs/$RUN/tasks/request/submit -H "$J" -d '{"action":"complete","data":{"reason":"Client dinner","tags":["client"]}}'
#   → route decision {matchedRule: 0, next: "manager_review"}; active task is manager_review
curl -s -X POST $B/runs/$RUN/tasks/manager_review/submit -H "$J" -d '{"action":"complete","data":{"decision":"approve"}}'
#   → status "completed", currentTaskId "approved_end"

# ---- Path B: amount 120 → auto_approved
RUN=$(curl -s -X POST $B/runs -H "$J" -d "{\"definitionId\":\"$DEF\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -X POST $B/runs/$RUN/tasks/request/submit -H "$J" -d '{"action":"complete","data":{"amount":120,"category":"meals"}}'
curl -s -X POST $B/runs/$RUN/tasks/request/submit -H "$J" -d '{"action":"complete","data":{"reason":"Team lunch"}}'
#   → route decision {matchedRule: null, next: "auto_approved"}; status "completed"

curl -s $B/runs/$RUN            # inspect: status, done[], active[], data
curl -s -X POST $B/runs/$RUN/cancel   # 409 RUN_NOT_ACTIVE (already completed)
```

`demo.sh` also covers:

- 400 for a missing required field, and for `"120"` sent as a string
- 409 for a submit to the wrong task, or to a completed run
- the edit-after-start snapshot check
- cancel and cancel-again (409)
- 404 for an unknown run

---

## Code layout

```text
src/
  server.ts               boot: sync tables, listen
  app.ts                  express app, routers, 404 + error handler
  db.ts / models.ts       Sequelize connection; workflow_definitions, workflow_runs, run_tasks
  jsonGuard.ts            request-body reviver: rejects NUL, non-finite numbers, "__proto__" keys
  errors.ts               ApiError, async wrapper, error → {error:{code,message,details}}
  domain/
    types.ts              definition + run types
    definitionSchema.ts   zod shape + semantic validation (refs, fields, ops, branch-only cycles)
  engine/                 pure: no database or HTTP
    conditions.ts         evaluateCondition, resolveBranch
    fields.ts             validateStepInput (strict types, required on complete)
    advance.ts            advance(snapshot, fromTaskId, data) → auto steps + where it stops
  services/
    runService.ts         startRun / submit / cancelRun / getRun (transaction + run-row lock)
    runView.ts            run + run_tasks → API shape
  routes/                 definitions.ts, runs.ts
```

The engine is a pure function of `(snapshot, data)`. The service layer only persists what the engine decided. That split is what keeps adding a new task kind contained.

---

## Limitations and next steps

- **Schema migrations:** tables come from `sequelize.sync()`. Production would use versioned migrations.
- **No list endpoints** (`GET /definitions`, `GET /runs`), and no pagination.
- **Steps are forward-only.** A `back` action would decrement `stepIndex` and keep the draft.
- **Validation doesn't check reachability:** it doesn't reject tasks unreachable from the start, or tasks that can't reach an end.
- **Definition history:** move from snapshot-per-run to immutable versions if version history or "which runs use the old version" is needed. Only `startRun` changes.
- **Parallel task (stretch, not built):** add `{ type: "parallel", branches: [startTaskId…], join: taskId }`. The one-active-task index would become "one active task per *branch path*" (add a `path_id` to `run_tasks`). `advance` would return several stop points, and the join waits until all branch paths reach it. Data entry and branch evaluation stay as they are.
- **Async orchestration (stretch, not built):** have submit only record input and enqueue an "advance run X" job. A worker would take the same run-row lock, call the same pure `advance`, and use an outbox table for at-least-once delivery. Idempotency comes from advancing only from the run's current state.
- **No unit-test suite.** Verification is end to end against the running service, with `examples/demo.sh` (the worked example).

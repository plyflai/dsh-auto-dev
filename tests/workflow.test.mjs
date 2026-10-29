import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFlow } from '../tools/flow.mjs'

/**
 * The workflow test: one task lived end to end through the real plugin —
 * command → work_start → plan → activate → two deliveries → closed.
 *
 * Every new workflow batch adds a step here. A unit test proves a function;
 * this proves the eight things a person and their model actually do in order,
 * including the registration and gating that unit tests stub out.
 */
test('a task runs end to end: start, plan, deliver, close', async () => {
  const run = await runFlow({ quiet: true })

  assert.equal(run.task.state, 'closed')
  assert.equal(run.task.ledger.length >= 2, true, 'two deliveries land in the ledger')
  assert.equal(run.task.acceptanceMode, 'pm', 'a do task is judged by the person by default')
  assert.equal(String(run.task.receipt?.text ?? '').includes('验收'), true, 'the four-line receipt is on the record')

  const units = run.plan.units
  assert.equal(units.length, 3, 'two declared units plus the 日需 bucket')
  const daily = units.find(unit => unit.id === 'daily')
  assert.equal(daily.role, 'daily')
  assert.deepEqual(units.filter(unit => unit.parent === 'daily').map(unit => unit.id).sort(), ['b1', 'b2'])

  // The board counts leaves only: the bucket is a container, not work.
  assert.equal(run.status.progress.done, 2)
  assert.equal(run.status.progress.total, 2)
  assert.equal(run.status.task.state, 'closed')

  // The person got one message per delivery decision, not a wall of tool output.
  assert.equal(run.steps.filter(line => line.startsWith('模型←')).length >= 5, true)
})

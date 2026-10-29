/**
 * One task, two conversations.
 *
 * The point of `sessions[]` and of the record being the board's root: a person
 * pauses in one window and picks the work up in another. These tests run two
 * plugin instances over the *same* storage object, which is what the host gives
 * two sessions in one profile.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { stubHost, stubAgent } from '../tools/flow.mjs'
import { boardOf, foldBoard, syncState } from '../src/projection.mjs'

const hostFor = async tables => {
  const host = stubHost({ cwd: '/repo/example', tables })
  await apply(host.ctx, { checkpoints: false })
  return host
}

const session = (host, sessionId) => {
  const made = stubAgent({ sessionId })
  const call = async (name, args) => {
    const definition = host.tools.get(name)
    if (!definition) throw new Error(`${sessionId}: ${name} is not installed`)
    const callId = `${sessionId}-${made.log.length}`
    made.log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
    return definition.execute(args, { agent: made.agent, callId, turn: 1 })
  }
  return { ...made, call }
}

const held = task => [...new Set([...(task.sessions ?? []), task.sessionId].filter(Boolean))]

const storeOf = tables => ({
  taskFor(sessionId) {
    const found = Object.values(tables.tasks)
      .filter(task => task.state !== 'cancelled' && (task.sessionId === sessionId || held(task).includes(sessionId)))
      .sort((l, r) => (l.state === 'active' ? 0 : 1) - (r.state === 'active' ? 0 : 1) || String(r.updatedAt).localeCompare(String(l.updatedAt)))[0]
    return found ? { task: found, plan: tables.plans[found.planId] } : undefined
  },
})

const boardFor = (log, sessionId, store) => {
  let state = syncState({ ...foldBoard(null, { type: 'noop' }), sessionId }, store)
  for (const event of log) state = syncState(foldBoard(state, event), store)
  return boardOf(state, [])
}

test('a paused task is picked up in another session, and both still see it', async () => {
  const tables = { tasks: {}, plans: {}, decisions: {}, sessions: {} }
  const first = await hostFor(tables)
  const second = await hostFor(tables)
  const a = session(first, 'session-A')
  const b = session(second, 'session-B')

  await first.commands[0].handler({ agent: a.agent, rawInput: 'start 做导出按钮' })
  const task = await a.call('work_start', {
    request: '做导出按钮', mode: 'build', scope: ['src/App.tsx'], acceptance: ['点了能导出'],
  })
  await a.call('work_plan', {
    taskId: task.taskId, operation: 'set',
    units: [
      { id: 'u1', goal: '按钮', scope: ['src/App.tsx'], acceptance: ['点了能导出'] },
      { id: 'u2', goal: '三种格式', scope: ['src/export.mjs'], acceptance: ['都能打开'] },
    ],
  })
  await a.call('work_plan', { taskId: task.taskId, operation: 'activate', unit: 'u1' })
  await first.commands[0].handler({ agent: a.agent, rawInput: 'pause' })
  assert.equal(tables.tasks[task.taskId].state, 'paused')

  // The second window says the same thing a person would; the plugin takes over.
  const picked = await second.commands[0].handler({ agent: b.agent, rawInput: 'start 继续做导出' })
  assert.equal(picked.kind, 'success')
  assert.match(picked.text, /已接管并交给模型继续/)
  const record = tables.tasks[task.taskId]
  assert.equal(record.sessionId, 'session-B')
  assert.deepEqual(record.sessions, ['session-A', 'session-B'])
  assert.equal(record.state, 'active')

  // The work is the one that was already planned; nothing is re-declared.
  const before = await b.call('work_status', { taskId: task.taskId })
  assert.equal(before.nextUnit.id, 'u1')

  // The window that handed it over can still see it, and its tools say where it
  // went instead of pretending the project has no task.
  // The old window still reads it, the way its board still draws it; writing is
  // the holding session's business.
  const stale = await a.call('work_status', {})
  assert.equal(stale.readOnly, true)
  assert.equal(stale.task.id, task.taskId)
  assert.match(stale.hint, /held by session-?B/)
  assert.doesNotMatch(stale.hint, /no task in this session yet/)
  const staleBoard = await a.call('work_status', { view: 'board' })
  assert.equal(staleBoard.readOnly, true)
  assert.equal(staleBoard.readOnly === true, true)

  b.log.push({ type: 'tool/call', data: { callId: 'b-run', name: 'bash', arguments: { command: 'npx playwright test --headed' } } })
  b.log.push({ type: 'tool/result', data: { message: { toolCallId: 'b-run', isError: false, content: [{ type: 'text', text: '1 passed' }] } } })
  await b.call('work_submit', {
    taskId: task.taskId, unit: 'u1', outcome: 'complete', summary: '按钮能点', next: '三种格式',
    claims: [{ statement: '点了能导出', case: 'happy', assert: '有文件', expected: 'xlsx', actual: 'xlsx', execution: { callId: 'b-run' } }],
  })
  assert.equal(tables.plans[record.planId].units.find(row => row.id === 'u1').state, 'done')

  // Both windows draw the same task, and the first one is not stuck on its own
  // stale replay: the record is the root of the board.
  const store = storeOf(tables)
  const fromA = boardFor(a.log, 'session-A', store)
  const fromB = boardFor(b.log, 'session-B', store)
  assert.equal(fromA.taskId, task.taskId)
  assert.equal(fromB.taskId, task.taskId)
  assert.equal(fromA.counting.label, '1/2')
  assert.equal(fromB.counting.label, '1/2')
})

test('a session that never opted in sees nothing of the hand-off', async () => {
  const tables = { tasks: {}, plans: {}, decisions: {}, sessions: {} }
  const first = await hostFor(tables)
  const third = await hostFor(tables)
  const a = session(first, 'session-A')
  await first.commands[0].handler({ agent: a.agent, rawInput: 'start 做导出按钮' })
  const task = await a.call('work_start', { request: '做导出按钮', scope: [], acceptance: [] })
  await first.commands[0].handler({ agent: a.agent, rawInput: 'pause' })

  assert.equal(third.tools.size, 0)
  const board = boardFor([], 'session-C', storeOf(tables))
  assert.equal(board, null)
  assert.equal(tables.tasks[task.taskId].sessionId, 'session-A')
})

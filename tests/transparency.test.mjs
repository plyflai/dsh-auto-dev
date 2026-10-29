import test from 'node:test'
import assert from 'node:assert/strict'
import { boardOf, foldBoard, syncState } from '../src/projection.mjs'

const call = (seq, name, args, callId) => ({ type: 'tool/call', seq, time: 1000 * seq, data: { name, arguments: args, callId } })
const result = (callId, text) => ({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text }] } } })

test('T3: the pulse names the unit in flight, since when, and how its check went', () => {
  let state = foldBoard(null, call(1, 'work_start', { mode: 'do', goal: 'g', plan: [{ id: 'a', goal: 'A', state: 'active' }] }, 'c1'))
  state = foldBoard(state, result('c1', JSON.stringify({ taskId: 't' })))
  state = foldBoard(state, call(2, 'work_plan', { operation: 'activate', unit: 'a' }, 'c1b'))
  state = foldBoard(state, result('c1b', JSON.stringify({ ok: true })))
  state = foldBoard(state, call(2, 'bash', { command: 'npm test' }, 'c2'))
  state = foldBoard(state, result('c2', 'fail\n[exit code: 1]'))
  state = foldBoard(state, call(3, 'bash', { command: 'npm test' }, 'c3'))
  state = foldBoard(state, result('c3', 'fail\n[exit code: 1]'))
  state = foldBoard(state, call(4, 'bash', { command: 'ls' }, 'c4'))
  const pulse = boardOf(state, []).pulse
  assert.equal(pulse.unit, 'a')
  assert.equal(typeof pulse.since, 'number')
  assert.deepEqual(pulse.check, { command: 'npm test', ok: false, count: 2 })
  state = foldBoard(state, call(5, 'bash', { command: 'npm test' }, 'c5'))
  state = foldBoard(state, result('c5', 'ok\n[exit code: 0]'))
  assert.deepEqual(boardOf(state, []).pulse.check, { command: 'npm test', ok: true, count: 3 })
})

test('T4/T2: each unit carries what its settlement rested on, and the last reminders', () => {
  const blank = { ...foldBoard(null, { type: 'noop' }), sessionId: 's' }
  const task = { id: 't', mode: 'do', state: 'active', goal: 'g', ledger: [{ unit: 'a', claims: [
    { statement: '测试过', execution: { callId: 'x', command: 'npm test' } },
    { statement: '人看过', manual: { steps: ['打开页面'] } },
  ], reminders: ['没跑项目检查 npm test'] }] }
  const plan = { id: 'p', units: [{ id: 'a', goal: 'A', state: 'done' }] }
  const board = boardOf(syncState(blank, { taskFor: () => ({ task, plan }) }), [])
  assert.deepEqual(board.units[0].claims, [
    { text: '测试过', proven: true, command: 'npm test' },
    { text: '人看过', proven: false },
  ])
  assert.deepEqual(board.reminders, ['没跑项目检查 npm test'])
  assert.equal(board.pulse, null, 'nothing is in flight')
})

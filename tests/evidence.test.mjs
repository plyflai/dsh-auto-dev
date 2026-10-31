import test from 'node:test'
import assert from 'node:assert/strict'
import { collectObservations, executionFailed } from '../src/session-log.mjs'
import { childIds } from '../src/child-sessions.mjs'
import { opaqueDelegation, reconcileDelegation, validateSubmission, windowObservations } from '../src/task.mjs'

/** A session log shaped exactly like the one DSH records: tool/call then tool/result. */
function makeSession(events) {
  const log = events.map((event, index) => ({
    type: event.type,
    time: 1000 + index,
    data: event.data,
  }))
  return { id: 'sess-1', seq: log.length, eventAt: index => log[index] }
}

const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: args } })
const result = (callId, { isError = false, text = '{"exitCode":0}' } = {}) => ({
  type: 'tool/result',
  data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } },
})


const task = overrides => ({
  id: 'task-1', version: 1, project: '/repo', sessionId: 'sess-1', mode: 'do',
  scope: ['src'], acceptance: ['the new endpoint answers 200'], state: 'active',
  startedSeq: 0, ledger: [], decisions: [], request: 'make it work', goal: 'g', ...overrides,
})

const taskFixture = () => task({})
// What submit passes in: the repository declares a check, so G1 can ask for it.
const CHECKED = { verifier: { name: '测试', command: 'npm test' } }
const G1 = /交付前最后一次改动之后没有跑通的检查/

test('observations carry the command and the call id of every execution', () => {
  const session = makeSession([
    call('c1', 'bash', { command: 'npm test' }),
    result('c1'),
    call('c2', 'edit', { path: 'src/a.js' }),
    result('c2', { text: '{"path":"src/a.js"}' }),
  ])
  const observations = collectObservations(session, 0)
  assert.equal(observations.results.length, 2)
  assert.deepEqual(observations.results.map(row => row.command), ['npm test', undefined])
  assert.equal(observations.results[1].path, 'src/a.js')
})

for (const failure of [{ exitCode: 1 }, { signal: 'SIGTERM' }, { aborted: true }, { timedOut: true }]) {
  test(`process failure ${JSON.stringify(failure)} overrides a successful tool result`, () => {
    const observations = collectObservations(makeSession([
      call('c1', 'bash', { command: 'npm test' }), result('c1', { text: JSON.stringify(failure) }),
    ]))
    assert.equal(executionFailed(observations.results[0]), true)
  })
}

test('DSH rendered process status overrides isError false for submissions and UI tiers', () => {
  for (const name of ['bash', 'pwsh']) {
    for (const suffix of ['[exit code: 1]', '[exit code: null]', '[killed by signal: SIGTERM]',
      '[timed out after 100ms]', '[stopped: user stopped the job]', '[timed out after 100ms]\n[exit code: 0]',
      '[exit code: 0]\n[exit code: 1]']) {
      const observations = collectObservations(makeSession([
        call('c1', name, { command: 'npm test' }), result('c1', { text: `actual process output\n${suffix}` }),
      ]))
      assert.equal(observations.results[0].isError, false)
      assert.equal(executionFailed(observations.results[0]), true)
      if (suffix === '[exit code: 0]\n[exit code: 1]') assert.equal(observations.results[0].exitCode, 1)
    }
  }
})

test('shell status parsing keeps program prose and non-shell tool text separate', () => {
  for (const [name, text] of [['bash', '0 tests failed'], ['bash', '[exit code: 5]'],
    ['bash', 'example\n[exit code: 5]\nmore output'], ['read', 'example\n[exit code: 5]']]) {
    const row = collectObservations(makeSession([call('c1', name, { command: 'npm test' }), result('c1', { text })])).results[0]
    assert.equal(row.exitCode, undefined, text)
  }
})

test('a delegation result carries its child id under the name the host actually uses', async () => {
  const rows = [
    { callId: 'c1', seq: 5, name: 'subagent_medium', isError: false, value: { kind: 'activation', subagentId: 'agent-abc' } },
    { callId: 'c2', seq: 6, name: 'subagent_medium', isError: true, value: { subagentId: 'agent-dead' } },
  ]
  assert.deepEqual(childIds(rows), [{ childId: 'agent-abc', callId: 'c1', seq: 5 }])
})

test('once the children are read, the warning stops calling the work opaque', () => {
  const warnings = [opaqueDelegation(1)]
  const reconciled = reconcileDelegation(warnings, [{ reachable: true, writes: ['a'] }])
  assert.equal(reconciled.length, 1)
  assert.match(reconciled[0], /ran in 1 subagent session/)
  assert.match(reconciled[0], /run the check yourself/)
  assert.doesNotMatch(reconciled[0], /opaque/)
})

test('an unreadable child keeps the opaque wording', () => {
  const warnings = [opaqueDelegation(2)]
  assert.deepEqual(reconcileDelegation(warnings, [{ reachable: false, reason: 'gone' }]), warnings)
})

test('observations resume from the last read as the log grows, and match a fresh scan', () => {
  const log = [call('c1', 'bash', { command: 'npm test' }), result('c1')].map((event, index) => ({ ...event, time: 1000 + index }))
  const wrapper = () => ({ id: 'sess-grow', get seq() { return log.length }, eventAt: index => log[index] })
  const first = collectObservations(wrapper())
  log.push({ ...call('c2', 'bash', { command: 'npm run lint' }), time: 2000 }, { ...result('c2'), time: 2001 })
  const second = collectObservations(wrapper())
  assert.deepEqual(second.results.map(row => row.callId), ['c1', 'c2'])
  assert.equal(second.results[0], first.results[0], 'the earlier row is reused, not rebuilt')
  assert.equal(second.results[1].time, 2001)
  const fresh = collectObservations({ id: 'sess-other', seq: log.length, eventAt: index => structuredClone(log[index]) })
  assert.deepEqual(second.results, fresh.results)
})

test('two logs that share a session id never share observations', () => {
  const one = makeSession([call('c1', 'bash', { command: 'npm test' }), result('c1')])
  const two = makeSession([call('c1', 'bash', { command: 'npm run build' }), result('c1')])
  assert.equal(collectObservations(one).results[0].command, 'npm test')
  assert.equal(collectObservations(two).results[0].command, 'npm run build')
})

test('observation rows are shared read-only, and a window does not see calls before it', () => {
  const session = makeSession([call('c1', 'bash', { command: 'npm test' }), result('c1'), call('c2', 'bash', { command: 'ls' }), result('c2')])
  const row = collectObservations(session).results[0]
  assert.throws(() => { row.callId = 'x' }, TypeError)
  assert.throws(() => { row.content[0].text = 'x' }, TypeError)
  const window = collectObservations(session, 1).results
  assert.deepEqual(window.map(entry => [entry.callId, entry.command]), [['c1', undefined], ['c2', 'ls']])
})

test('a submission is words, never refused: shape digested, a subagent named', () => {
  const observations = collectObservations(makeSession([
    call('c1', 'task', { prompt: 'do it' }), result('c1', { text: 'child done' }),
  ]))
  const verdict = validateSubmission({ task: task(), observations, args: { outcome: 'finished', claims: ['npm test 过了', { statement: '' }, 7] } })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.claims, [{ statement: 'npm test 过了' }])
  assert.equal(typeof verdict.summary, 'string')
})

test('exactCheck: the plain check or the agreed pipefail + tail form, nothing else', async () => {
  const { exactCheck, trimmedCheck } = await import('../src/facts.mjs')
  const verifier = { command: 'npm test' }
  for (const run of ['npm test', ' npm test ', trimmedCheck('npm test'), 'set -o pipefail; npm test 2>&1 | tail -5'])
    assert.equal(exactCheck(run, verifier), true, run)
  // No pipefail: the exit code is tail's, a red would read green. head can close the pipe early.
  for (const run of ['npm test | tail -3', 'npm test 2>&1 | tail -40', 'set -o pipefail; npm test 2>&1 | head -40',
    'set -o pipefail; npm test 2>&1 | tail -40; echo done', 'cd /tmp && npm test', 'npm testx', 'set -o pipefail; npm test.x 2>&1 | tail -4'])
    assert.equal(exactCheck(run, verifier), false, run)
  assert.equal(exactCheck('set -o pipefail; npm run t.e 2>&1 | tail -4', { command: 'npm run t.e' }), true, 'regex-escaped')
  assert.equal(exactCheck('set -o pipefail; npm run tXe 2>&1 | tail -4', { command: 'npm run t.e' }), false, 'dot is literal')
})

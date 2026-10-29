import test from 'node:test'
import assert from 'node:assert/strict'
import { collectObservations, evidenceCommand, executionFailed, findExecution, writesAfter } from '../src/session-log.mjs'
import { childIds } from '../src/child-sessions.mjs'
import { namesCommand, opaqueDelegation, reconcileDelegation, validateSubmission } from '../src/task.mjs'
import { observedTier } from '../src/uicheck.mjs'

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

test('claimed checks must run at a command position, not appear in printed text', () => {
  for (const command of ['echo npm test', 'printf npm test', 'git log npm test', '! npm test']) {
    assert.equal(namesCommand(command, 'npm test'), false)
  }
  assert.equal(namesCommand('cd . && CI=1 npm test -- --run', 'npm test'), true)
  for (const command of ['cd . && npm test', 'cd "ui project" && CI=1 npm test -- --run']) {
    assert.equal(namesCommand(command, command), true)
  }
  assert.equal(namesCommand('cd . && npm test; echo masked', 'cd . && npm test; echo masked'), false)
  assert.equal(namesCommand('node -e "console.log(1)"', 'node -e "console.log(1)"'), true)
  assert.equal(namesCommand('node -e "console.log(1)"', 'node -e "console.log(2)"'), false)
})

test('shell wrappers cannot support even an unnamed passing claim', () => {
  for (const command of ['env sh -c "npm test; echo masked"', 'command eval "npm test; true"',
    'xargs sh -c "npm test; true"']) {
    assert.equal(evidenceCommand(command), undefined)
    const observations = collectObservations(makeSession([call('c1', 'bash', { command }), result('c1')]))
    const validation = validateSubmission({ task: task(), observations,
      args: { outcome: 'complete', summary: '完成', next: '收尾', claims: [{ statement: '项目测试通过', execution: 'c1' }] } })
    assert.equal(validation.ok, false, command)
    assert.equal(validation.evidence.length, 0, command)
  }
})

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

test('a claim with an unknown call id is refused', async () => {
  const session = makeSession([call('c1', 'bash', { command: 'npm test' }), result('c1')])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'tests pass', execution: 'ghost' }] },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /not an observed result/)
})

test('a claim may not cite a failed run as success', async () => {
  const session = makeSession([call('c1', 'bash', { command: 'npm test' }), result('c1', { isError: true })])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'tests pass', execution: 'c1' }] },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /failed/)
})

for (const failure of [{ exitCode: 1 }, { signal: 'SIGTERM' }, { aborted: true }, { timedOut: true }]) {
  test(`process failure ${JSON.stringify(failure)} overrides a successful tool result`, () => {
    const observations = collectObservations(makeSession([
      call('c1', 'bash', { command: 'npm test' }), result('c1', { text: JSON.stringify(failure) }),
    ]))
    const verdict = validateSubmission({ task: task({}), observations,
      args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'npm test passed', execution: 'c1' }] } })
    assert.equal(verdict.ok, false)
    assert.match(verdict.errors.join('\n'), /failed/)
    assert.equal(verdict.evidence.length, 0)
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
      const verdict = validateSubmission({ task: task(), observations,
        args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'npm test passed', execution: 'c1' }] } })
      assert.equal(verdict.ok, false, `${name}: ${suffix}`)
      assert.equal(verdict.evidence.length, 0)
      assert.equal(observedTier(observations.results), undefined)
    }
  }
})

test('shell status parsing keeps program prose and non-shell tool text separate', () => {
  for (const [name, text] of [['bash', '0 tests failed'], ['bash', '[exit code: 5]'],
    ['bash', 'example\n[exit code: 5]\nmore output'], ['read', 'example\n[exit code: 5]']]) {
    const row = collectObservations(makeSession([call('c1', name, { command: 'npm test' }), result('c1', { text })])).results[0]
    assert.equal(row.exitCode, undefined, text)
    assert.equal(observedTier([row]), 'logic')
  }
})

test('a claim is stale when a file-changing call ran after it', async () => {
  const session = makeSession([
    call('c1', 'bash', { command: 'npm test' }),
    result('c1'),
    call('c2', 'edit', { path: 'src/a.js' }),
    result('c2', { text: '{"path":"src/a.js"}' }),
  ])
  const observations = collectObservations(session, 0)
  assert.equal(writesAfter(observations, 0).length, 1)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'tests pass', command: 'npm test', execution: 'c1' }] },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /stale/)
})

test('a claim whose command differs from the run is refused', async () => {
  const session = makeSession([call('c1', 'bash', { command: 'npm test' }), result('c1')])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'e2e pass', command: 'npm run e2e', execution: 'c1' }] },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /the claim names "npm run e2e" but the cited execution ran "npm test"/)
})

test('complete with acceptance needs at least one claim', async () => {
  const session = makeSession([call('c1', 'edit', { path: 'src/a.js' }), result('c1')])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'nothing' },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /at least one executed check/)
})

test('a look task may finish without a claim', async () => {
  const session = makeSession([call('c1', 'read', { path: 'src/a.js' }), result('c1')])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({ mode: 'look', acceptance: ['explain the flow'] }), observations,
    args: { outcome: 'complete', summary: 'explained', next: 'nothing' },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
})

test('a matching, fresh claim passes and is recorded as evidence', async () => {
  const session = makeSession([
    call('c1', 'edit', { path: 'src/a.js' }),
    result('c1', { text: '{"path":"src/a.js"}' }),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'endpoint answers', next: 'ship it', claims: [{ statement: 'unit suite green', command: 'npm test', execution: 'c2' }] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
  assert.equal(verdict.evidence.length, 1)
  assert.equal(verdict.evidence[0].execution.callId, 'c2')
})

test('an irreversible action without a recorded authorization is refused', async () => {
  const session = makeSession([
    call('c1', 'bash', { command: 'rm -rf src' }),
    result('c1'),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'tests', execution: 'c2' }] },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /without authorization/)
})

test('a recorded authorization unlocks the same action', async () => {
  const session = makeSession([
    call('c1', 'bash', { command: 'rm -rf dist' }),
    result('c1'),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({ decisions: [{ risk: 'recursive-delete', granted: true }] }), observations,
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'tests', execution: 'c2' }] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
})

test('writes outside the declared scope are advisory by default and blocking on request', async () => {
  const session = makeSession([
    call('c1', 'edit', { path: 'docs/a.md' }),
    result('c1', { text: '{"path":"docs/a.md"}' }),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const observations = collectObservations(session, 0)
  const advisory = validateSubmission({
    task: task({}), observations, config: { scopeEnforcement: 'advisory' },
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'tests', execution: 'c2' }] },
  })
  assert.equal(advisory.ok, true, advisory.errors.join('\n'))
  assert.match(advisory.warnings.join('\n'), /outside the declared scope/)
  const blocking = validateSubmission({
    task: task({}), observations, config: { scopeEnforcement: 'blocking' },
    args: { outcome: 'complete', summary: 'done', next: 'nothing', claims: [{ statement: 'tests', execution: 'c2' }] },
  })
  assert.equal(blocking.ok, false)
  assert.match(blocking.errors.join('\n'), /outside the declared scope/)
})

test('a reference object with a seq pins the exact execution', () => {
  const session = makeSession([
    call('c1', 'bash', { command: 'npm test' }),
    result('c1'),
    call('c1', 'bash', { command: 'npm test' }),
    result('c1', { isError: true }),
  ])
  const observations = collectObservations(session, 0)
  assert.equal(findExecution(observations, { callId: 'c1', seq: 1 }).row.isError, false)
  assert.equal(findExecution(observations, { callId: 'c1', seq: 3 }).row.isError, true)
})

test('a claim that names a command the cited execution did not run is refused', () => {
  const observations = {
    source: 'session-log', sessionId: 's', startSeq: 0, endSeq: 5,
    results: [
      { seq: 2, callId: 'c1', name: 'bash', command: 'npm test', isError: false, exitCode: 0 },
      { seq: 4, callId: 'c2', name: 'bash', command: 'tsc --noEmit', isError: false, exitCode: 0 },
    ],
  }
  const task = taskFixture()
  const verdict = validateSubmission({
    task, unit: undefined, observations,
    args: { outcome: 'complete', summary: 'done', next: 'stop', claims: [
      { statement: 'npm test passes', execution: { callId: 'c1' } },
      { statement: 'tsc --noEmit passes', execution: { callId: 'c1' } },
    ] },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /the claim names "tsc --noEmit" but the cited execution ran "npm test"/)
})

test('a behaviour statement is not treated as a command claim', () => {
  const observations = {
    source: 'session-log', sessionId: 's', startSeq: 0, endSeq: 3,
    results: [{ seq: 2, callId: 'c1', name: 'bash', command: 'npm test', isError: false, exitCode: 0 }],
  }
  const verdict = validateSubmission({
    task: taskFixture(), unit: undefined, observations,
    args: { outcome: 'complete', summary: 'done', next: 'stop', claims: [
      { statement: 'subtract(5,2) returns 3 and multiply(3,4) returns 12', execution: { callId: 'c1' } },
    ] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('; '))
})

test('failed executed writes invalidate checks while refused writes do not', () => {
  for (const refused of [false, true]) {
    const observations = collectObservations(makeSession([
      call('c1', 'bash', { command: 'npm test' }), result('c1'),
      call('c2', 'edit', { path: 'src/a.js' }),
      result('c2', { isError: true, text: refused ? 'Error: auto-dev-v3: refused before execution' : 'write failed after partial change' }),
    ]))
    assert.equal(writesAfter(observations, 1).length, refused ? 0 : 1)
    const verdict = validateSubmission({
      task: taskFixture(), observations,
      args: { outcome: 'complete', summary: 'done', next: 'stop', claims: [
        { statement: 'npm test passes', execution: { callId: 'c1' } },
      ] },
    })
    assert.equal(verdict.ok, refused, verdict.errors.join('; '))
    if (!refused) assert.match(verdict.errors.join(' '), /stale/)
  }
})

test('a scope written for a subdirectory is explained, not silently ignored', () => {
  const session = makeSession([
    call('c1', 'bash', { command: 'echo hi > /repo/example/nested/calc.mjs' }),
    result('c1'),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({ scope: ['calc.mjs'] }),
    observations,
    args: { outcome: 'complete', summary: 'done', next: 'none', claims: [{ statement: 'wrote subtract', execution: 'c1' }] },
    config: { project: '/repo/example' },
  })
  assert.equal(verdict.ok, true, 'advisory scope keeps the submission valid')
  assert.match(verdict.warnings.join('\n'), /only matches at nested\/calc\.mjs/)
})

test('an absolute write path is compared in the scope\'s own coordinates', () => {
  // Journey E: a subagent edited /…/v3-journey-e/str.mjs while the scope said
  // "str.mjs", and the submission warned about "writes outside the declared
  // scope" for the very files it had declared.
  const observations = {
    source: 'session-log', sessionId: 's', startSeq: 0, endSeq: 5,
    results: [
      { seq: 2, callId: 'c1', name: 'edit', path: '/work/v3-journey-e/str.mjs', isError: false },
      { seq: 3, callId: 'c2', name: 'edit', path: '/work/v3-journey-e/str.test.mjs', isError: false },
      { seq: 4, callId: 'c3', name: 'bash', command: 'npm test', isError: false, exitCode: 0 },
    ],
  }
  const verdict = validateSubmission({
    task: task({ project: '/work/v3-journey-e', scope: ['str.mjs', 'str.test.mjs'] }), observations,
    config: { project: '/work/v3-journey-e' },
    args: { outcome: 'complete', summary: 'done', next: 'stop', claims: [{ statement: 'npm test passes', execution: { callId: 'c3' } }] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
  assert.deepEqual(verdict.warnings, [])
})

test('a write outside the project is still out of scope', () => {
  const observations = {
    source: 'session-log', sessionId: 's', startSeq: 0, endSeq: 5,
    results: [
      { seq: 2, callId: 'c1', name: 'edit', path: '/elsewhere/str.mjs', isError: false },
      { seq: 4, callId: 'c3', name: 'bash', command: 'npm test', isError: false, exitCode: 0 },
    ],
  }
  const verdict = validateSubmission({
    task: task({ project: '/work/repo', scope: ['str.mjs'] }), observations,
    config: { project: '/work/repo' },
    args: { outcome: 'complete', summary: 'done', next: 'stop', claims: [{ statement: 'npm test passes', execution: { callId: 'c3' } }] },
  })
  assert.match(verdict.warnings.join('\n'), /outside the declared scope.*\/elsewhere\/str\.mjs/)
})

test('a call the gate refused is not an irreversible action the task performed', async () => {
  const session = makeSession([
    call('c1', 'bash', { command: "echo '{}' > .auto-dev/ledger.json" }),
    result('c1', { isError: true, text: 'Error: auto-dev-v3: control-plane is irreversible, and task task-1 has no recorded authorization for it.' }),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'partial', summary: 'blocked at the gate', next: 'ask the owner', claims: [{ statement: 'npm test passes', execution: 'c2' }] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
})

test('a command that really ran and failed is still an action the task performed', async () => {
  const session = makeSession([
    call('c1', 'bash', { command: 'rm -rf src' }),
    result('c1', { isError: true, text: 'rm: src: Permission denied' }),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'partial', summary: 'x', next: 'y', claims: [{ statement: 'npm test passes', execution: 'c2' }] },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join('\n'), /without authorization/)
})

test('a completion that leans on a subagent is refused until the parent checks itself', async () => {
  const session = makeSession([
    call('c1', 'subagent_medium', { prompt: 'write the parser' }),
    result('c1', { text: '{"childId":"child-1"}' }),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const observations = collectObservations(session, 0)
  // The claim cites the delegation itself: a child's result is not this task's check.
  const leaning = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'none', claims: [{ statement: 'tests pass', execution: 'c1' }] },
  })
  assert.equal(leaning.ok, false)
  assert.match(leaning.errors.join('\n'), /handed work to a subagent and then claimed completion/)

  // The same submission citing a check the parent ran later is accepted.
  const checked = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'none', claims: [{ statement: 'npm test passes', execution: 'c2' }] },
  })
  assert.equal(checked.ok, true, checked.errors.join('\n'))
  assert.match(checked.warnings.join('\n'), /delegated work is opaque/)
  assert.equal(checked.delegations, 1)
})

test('a partial result may report delegated work without claiming it is done', async () => {
  const session = makeSession([
    call('c1', 'subagent_medium', { prompt: 'write the parser' }),
    result('c1', { text: '{"childId":"child-1"}' }),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'partial', summary: 'the child is still working', next: 'check its output', residue: ['no parent run yet'] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
})

test('a long command that ends in the project check still counts as running it', async () => {
  // Regression: the verifier comparison used the claim's *summary* of the execution,
  // which is truncated at 240 characters for display. A long setup followed by
  // `npm test` looked like it never ran the check. && preserves the check's failure.
  const long = `printf '%s' '${'x'.repeat(400)}' && npm test`
  const session = makeSession([
    call('c1', 'bash', { command: long }),
    result('c1'),
  ])
  const observations = collectObservations(session, 0)
  const verdict = validateSubmission({
    task: task({}), observations,
    args: { outcome: 'complete', summary: 'done', next: 'none', claims: [{ statement: 'npm test passes', execution: 'c1' }] },
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.claims[0].execution.command.length, 240, 'the summary stays short for display')
  assert.match(observations.results[0].command, /npm test$/, 'the record itself keeps the whole line')
})

test('a delegation the runtime refused is not work that went somewhere', async () => {
  const session = makeSession([
    call('c1', 'subagent_medium', { prompt: 'write the parser' }),
    result('c1', { text: 'Error: subagent depth 2 exceeds maxDepth 1', isError: true }),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const verdict = validateSubmission({
    task: task({}), observations: collectObservations(session, 0),
    args: { outcome: 'complete', summary: 'done', next: 'none', claims: [{ statement: 'npm test passes', execution: 'c2' }] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
  assert.equal(verdict.delegations, 0, 'a refused spawn handed work to nobody')
  assert.doesNotMatch(verdict.warnings.join('\n'), /delegated work is opaque/)
})

test('the plugin writing its own memory is not a control-plane write by the model', async () => {
  const session = makeSession([
    call('c1', 'work_control', { operation: 'remember', payload: { kind: 'fact', text: 'the suite runs through npm test' } }),
    result('c1', { text: JSON.stringify({ stored: true, kind: 'fact', path: '/repo/.auto-dev/memory.json' }) }),
    call('c2', 'bash', { command: 'npm test' }),
    result('c2'),
  ])
  const verdict = validateSubmission({
    task: task({}), observations: collectObservations(session, 0),
    args: { outcome: 'complete', summary: 'done', next: 'none', claims: [{ statement: 'npm test passes', execution: 'c2' }] },
  })
  assert.equal(verdict.ok, true, verdict.errors.join('\n'))
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

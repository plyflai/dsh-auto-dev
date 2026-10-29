import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_STATE_VERSION, boardOf, foldBoard as foldEvent, registerBoard, syncState } from '../src/projection.mjs'

const call = (name, args) => ({ fixtureSuccess: true, type: 'tool/call', data: { callId: `c-${name}`, name, arguments: args } })
const result = () => ({ type: 'tool/result', data: { message: { toolCallId: 'c', isError: false, content: [] } } })

// Fixture calls run through both real fold steps. callAs/raw events below test pending/refused calls.
function foldBoard(state, event) {
  const pending = foldEvent(state, event)
  return event.fixtureSuccess && ['work_start', 'work_plan', 'work_submit', 'work_control'].includes(event.data.name)
    ? foldEvent(pending, { type: 'tool/result', data: { message: { toolCallId: event.data.callId,
      isError: false, content: [{ type: 'text', text: '{}' }] } } }) : pending
}

function fold(events) {
  return events.reduce((state, event) => foldBoard(state, event), null)
}

test('an empty session has no board', () => {
  assert.equal(boardOf(null), null)
  assert.equal(boardOf(fold([result()])), null)
})

test('work_start draws the task in its lane', () => {
  const board = boardOf(fold([call('work_start', {
    request: '给下载按钮加一个进度条', goal: '下载有可见进度', mode: 'do', acceptance: ['下载时看到百分比'],
  })]))
  assert.equal(board.mode, 'do')
  assert.equal(board.lane, '交付')
  assert.equal(board.goal, '下载有可见进度')
  assert.equal(board.counting.label, '未开始')
})

test('a look task reads as 查看 and needs no units', () => {
  const board = boardOf(fold([call('work_start', { request: '这个函数是干什么的', mode: 'look' })]))
  assert.equal(board.lane, '查看（只读意图）')
  assert.equal(board.next, '这个函数是干什么的')
})

test('units accumulate, activate, finish and advance', () => {
  const state = fold([
    call('work_start', { request: 'x', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [
      { id: 'm1', goal: '抽出领域模型', scope: ['src/domain'], acceptance: [] },
      { id: 'm2', goal: '迁移调用方', scope: ['src'], acceptance: [], dependsOn: ['m1'] },
    ] }),
    call('work_plan', { operation: 'activate', unit: 'm1' }),
  ])
  assert.deepEqual(boardOf(state).units.map(unit => unit.state), ['active', 'pending'])
  const after = foldBoard(state, call('work_submit', {
    unit: 'm1', outcome: 'complete', summary: '模型已抽出', next: '开始迁移调用方',
  }))
  assert.deepEqual(boardOf(after).units.map(unit => unit.state), ['done', 'pending'])
  // The next unit outranks the prose the last submission wrote about it.
  assert.equal(boardOf(after).next, '迁移调用方')
})

test('a submission marks the active unit done and moves the next one forward', () => {
  let state = fold([
    call('work_start', { request: 'x', goal: 'g', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [
      { id: 'm1', goal: '第一步', scope: ['src'], acceptance: [] },
      { id: 'm2', goal: '第二步', scope: ['src'], acceptance: [], dependsOn: ['m1'] },
    ] }),
    call('work_plan', { operation: 'activate', unit: 'm1' }),
  ])
  assert.equal(boardOf(state).next, '第一步')
  state = foldBoard(state, call('work_submit', { unit: 'm1', outcome: 'complete', summary: '好了', next: '进入第二步' }))
  const board = boardOf(state)
  assert.deepEqual(board.units.map(unit => unit.state), ['done', 'pending'])
  assert.equal(board.counting.label, '1/2')
  assert.equal(board.next, '第二步')
  assert.equal(board.last.outcome, 'complete')
})

test('a failed unit becomes blocked rather than done', () => {
  let state = fold([
    call('work_start', { request: 'x', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [{ id: 'm1', goal: '一步', scope: ['src'], acceptance: [] }] }),
  ])
  state = foldBoard(state, call('work_submit', { unit: 'm1', outcome: 'failed', summary: '没做成', next: '需要你决定' }))
  assert.deepEqual(boardOf(state).units.map(unit => unit.state), ['blocked'])
  assert.equal(boardOf(state).counting.label, '0/1')
})

test('replaying the same log twice gives the same board', () => {
  const events = [
    call('work_start', { request: 'x', goal: 'g', mode: 'do' }),
    call('work_submit', { outcome: 'complete', summary: '做完了', next: '可以用了' }),
  ]
  assert.deepEqual(boardOf(fold(events)), boardOf(fold(events)))
})

test('a second work_start replaces the first task', () => {
  const board = boardOf(fold([
    call('work_start', { request: 'a', goal: '第一个', mode: 'do' }),
    call('work_start', { request: 'b', goal: '第二个', mode: 'look' }),
  ]))
  assert.equal(board.goal, '第二个')
  assert.equal(board.mode, 'look')
})

test('arguments arrive as a JSON string in the session log', () => {
  // Real shape captured from a live session: data.arguments is a string.
  let state = foldBoard(null, {
    type: 'tool/call',
    data: {
      name: 'work_start',
      arguments: JSON.stringify({
        request: 'add subtract and multiply',
        mode: 'build',
        acceptance: ['npm test passes'],
        plan: [
          { id: 'u-subtract', goal: 'subtract works', scope: ['calc.mjs'], acceptance: ['npm test passes'], dependsOn: [] },
          { id: 'u-multiply', goal: 'multiply works', scope: ['calc.mjs'], acceptance: ['npm test passes'], dependsOn: ['u-subtract'] },
        ],
      }),
    },
  })
  const board = boardOf(state)
  assert.equal(board.mode, 'build')
  assert.equal(board.lane, '交付（历史 build）')
  assert.equal(board.goal, 'add subtract and multiply')
  assert.equal(board.units.length, 2)
  assert.equal(board.next, 'subtract works')
  assert.equal(board.counting.label, '0/2')

  state = foldBoard(state, { type: 'tool/call', data: { name: 'work_plan', arguments: '{"operation":"activate","unit":"u-subtract"}' } })
  assert.equal(boardOf(state).next, 'subtract works')
  assert.equal(boardOf(state).units[0].state, 'active')

  state = foldBoard(state, { type: 'tool/call', data: { name: 'work_submit', arguments: JSON.stringify({ outcome: 'complete', unit: 'u-subtract', summary: 'done', next: 'multiply' }) } })
  const after = boardOf(state)
  assert.equal(after.units[0].state, 'done')
  assert.equal(after.counting.label, '1/2')
  assert.equal(after.last.outcome, 'complete')
})

test('the task state the bar changes is on the board', () => {
  const started = fold([
    call('work_start', { request: 'x', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [{ id: 'm1', goal: '一步', scope: ['src'], acceptance: [] }] }),
  ])
  assert.equal(boardOf(started).taskState, 'active')
  const paused = foldBoard(started, call('work_control', { operation: 'pause' }))
  assert.equal(boardOf(paused).taskState, 'paused')
  const resumed = foldBoard(paused, call('work_control', { operation: 'resume' }))
  assert.equal(boardOf(resumed).taskState, 'active')
  const cancelled = foldBoard(resumed, call('work_control', { operation: 'cancel' }))
  assert.equal(boardOf(cancelled).taskState, 'cancelled')
  // A read-only operation changes nothing the bar acts on. The heartbeat is the
  // one field allowed to move: a status call is a tool call, and counting it is
  // exactly what keeps a busy session's board from looking dead.
  const { beats: _leftBeats, ...settledBoard } = boardOf(foldBoard(cancelled, call('work_control', { operation: 'status' })))
  const { beats: _beforeBeats, ...beforeBoard } = boardOf(cancelled)
  assert.deepEqual(settledBoard, beforeBoard)
})

test('the registration version is bumped when the fold changes', () => {
  // The host reuses a cached cell at the same key and stateVersion. A fold fix that
  // left the version alone kept showing the old, wrong board on live sessions.
  assert.ok(BOARD_STATE_VERSION >= 2)
  const registered = []
  registerBoard({ sessionProjections: { register: definition => registered.push(definition) } })
  assert.equal(registered[0].key, 'autoDevV3')
  assert.equal(registered[0].stateVersion, BOARD_STATE_VERSION)
})

test('the registration is owned by the plugin and released on dispose', () => {
  // A registration nobody releases survives the plugin instance: the service keeps the
  // first (possibly buggy) fold forever and every later build silently cannot take the key.
  const disposed = []
  const effects = []
  const definition = { dispose: () => disposed.push(true) }
  const stub = {
    sessionProjections: { register: value => { assert.equal(value.key, 'autoDevV3'); return definition } },
    effect: factory => { effects.push(factory); return () => {} },
  }
  registerBoard(stub)
  assert.equal(effects.length, 1)
  const disposer = effects[0]()
  assert.equal(typeof disposer, 'function')
  disposer()
  assert.deepEqual(disposed, [true])
})


test('a closing submission settles the strip instead of leaving it mid-task', () => {
  const board = boardOf(fold([
    call('work_start', { request: '看看这个函数', mode: 'look' }),
    call('work_submit', { outcome: 'complete', summary: 'answer given', next: '无（look 车道到此为止）' }),
  ]))
  assert.equal(board.taskState, 'closed')
  // The submission's own `next` must not be repeated as if work were still queued.
  assert.equal(board.next, '')
  assert.equal(board.last.summary, 'answer given')
})

test('a multi-unit task stays open until its last unit is done', () => {
  const state = fold([
    call('work_start', { request: 'x', mode: 'build', plan: [
      { id: 'a', goal: 'first', scope: ['src'], acceptance: [] },
      { id: 'b', goal: 'second', scope: ['src'], acceptance: [], dependsOn: ['a'] },
    ] }),
    call('work_plan', { operation: 'activate', unit: 'a' }),
    call('work_submit', { outcome: 'complete', unit: 'a', summary: 'a done', next: 'b next' }),
  ])
  const board = boardOf(state)
  assert.equal(board.taskState, 'active')
  assert.equal(board.next, 'second')

  const finished = boardOf([
    call('work_plan', { operation: 'activate', unit: 'b' }),
    call('work_submit', { outcome: 'complete', unit: 'b', summary: 'b done', next: 'ship it' }),
  ].reduce((acc, event) => foldBoard(acc, event), state))
  assert.equal(finished.taskState, 'closed')
  assert.equal(finished.counting.label, '2/2')
})

test('a subagent call shows on the board as work that left this session', () => {
  const started = foldBoard(null, call('work_start', { request: 'fix the parser', mode: 'do', scope: ['.'] }))
  const delegated = foldBoard(foldBoard(started, call('subagent_medium', { prompt: 'rewrite the parser' })), call('subagent_heavy', { prompt: 'review it' }))
  assert.equal(boardOf(delegated).delegations, 2)
  // A new task starts from zero: the count belongs to the task, not to the session.
  assert.equal(boardOf(foldBoard(delegated, call('work_start', { request: 'next', mode: 'do', scope: ['.'] }))).delegations, 0)
})

test('a tool that merely looks like a subagent is not counted', () => {
  const started = foldBoard(null, call('work_start', { request: 'x', mode: 'do', scope: ['.'] }))
  assert.equal(boardOf(foldBoard(started, call('subagents_list', {}))).delegations, 0)
})

test('a milestone counts the work inside it, not itself', () => {
  const start = { type: 'tool/call', data: { name: 'work_start', arguments: JSON.stringify({
    request: 'ship it', mode: 'build',
    plan: { units: [{ id: 'm1', goal: 'the model', scope: ['.'], acceptance: [], units: [
      { id: 'm1-a', goal: 'extract', scope: ['.'], acceptance: [] },
      { id: 'm1-b', goal: 'migrate', scope: ['.'], acceptance: [] },
    ] }] },
  }) } }
  const board = boardOf(foldBoard(null, start))
  assert.equal(board.counting.total, 2, 'two units of work, not three rows')
  assert.equal(board.next, 'extract')
  assert.equal(board.milestones.length, 1)
  assert.deepEqual(board.milestones[0].units.map(unit => unit.id), ['m1-a', 'm1-b'])
})

test('the board counts checkpoints and warnings from the host result, not the request', () => {
  // A checkpoint the host did not capture is not a checkpoint; a warning list the
  // caller wrote does not count. Both are read from the result payload, so the bar
  // cannot be talked into showing a safety it does not have.
  const answer = (callId, value) => ({ type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
  const started = foldBoard(null, { type: 'tool/call', data: { callId: 'c1', name: 'work_start', arguments: JSON.stringify({ request: 'x', mode: 'do', checkpoint: { snapshot: 'captured' } }) } })
  assert.equal(started.checkpoints, 0, 'the request saying "captured" proves nothing')
  const opened = foldBoard(started, answer('c1', { taskId: 't', checkpoint: { snapshot: 'captured', ref: 'refs/auto-dev-v3/a/1-before' } }))
  assert.equal(opened.checkpoints, 1)

  const asked = foldBoard(opened, { type: 'tool/call', data: { callId: 'c2', name: 'work_submit', arguments: JSON.stringify({ outcome: 'complete', summary: 's', next: 'n' }) } })
  const settled = foldBoard(asked, answer('c2', {
    outcome: 'complete',
    checkpoint: { snapshot: 'captured', ref: 'refs/auto-dev-v3/a/2-after' },
    warnings: ['writes outside the declared scope (a): b'],
  }))
  const board = boardOf(settled)
  assert.equal(board.checkpoints, 2)
  assert.equal(board.warnings, 1)

  const quietCall = foldBoard(settled, { type: 'tool/call', data: { callId: 'c3', name: 'work_submit', arguments: JSON.stringify({ outcome: 'partial', summary: 's', next: 'n' }) } })
  const quiet = boardOf(foldBoard(quietCall, answer('c3', { outcome: 'partial', checkpoint: { snapshot: 'skipped', reason: 'not a git repository' }, warnings: [] })))
  assert.equal(quiet.warnings, 0, 'a submission with no warnings clears the count')
  assert.equal(quiet.checkpoints, 2, 'a skipped snapshot keeps the count')

  const untouched = foldBoard(null, answer('c9', { taskId: 't', checkpoint: { snapshot: 'captured' } }))
  assert.equal(untouched, null, 'a result for a call the fold did not track changes nothing')
  assert.equal(boardOf(untouched), null, 'and a session with no task still has no board')
})

test('the project band comes from the host answer, not from what was asked for', () => {
  const answer = (callId, value) => ({ type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
  const asked = foldBoard(null, { type: 'tool/call', data: { callId: 'c1', name: 'work_start', arguments: JSON.stringify({
    request: '加一个 download()', mode: 'build', program: '让 PM 能下载周报', project: '/somewhere/else',
  }) } })
  const opened = foldBoard(asked, answer('c1', {
    taskId: 't', mode: 'build', project: '/repo/report-tool', program: '让 PM 能下载周报',
    gates: { evidence: true, scope: true, authorization: true, plan: true },
    compiled: { units: 2, leaves: 2, milestones: 0, order: ['a', 'b'], verifier: { command: 'npm test', source: 'package.json scripts.test' } },
    checkpoint: { snapshot: 'captured', ref: 'refs/auto-dev-v3/t/1-before' },
    memory: { facts: ['这个仓库用 npm test 跑测试'], incidents: [{ symptom: 's' }, { symptom: 't' }], counts: { facts: 1, incidents: 2 } },
  }))
  const board = boardOf(opened)
  assert.equal(board.program, '让 PM 能下载周报')
  assert.equal(board.project, '/repo/report-tool', 'the resolved root wins over the requested one')
  assert.equal(board.assets.verifier, 'npm test', 'the check command is read off the compile report')
  assert.equal(board.assets.memory.facts, 1)
  assert.equal(board.assets.memory.incidents, 2)
  assert.deepEqual(board.assets.memory.items, ['这个仓库用 npm test 跑测试'])
  assert.equal(board.assets.checkpoint.count, 1)
  assert.equal(board.assets.checkpoint.ref, 'refs/auto-dev-v3/t/1-before')
  assert.deepEqual(board.gates, { evidence: true, scope: true, authorization: true, plan: true })
})

test('delegated children are counted from the submission answer', () => {
  const answer = (callId, value) => ({ type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
  const started = foldBoard(foldBoard(null, { type: 'tool/call', data: { callId: 'c0', name: 'work_start', arguments: JSON.stringify({ request: 'x', mode: 'do' }) } }), answer('c0', {}))
  const asked = foldBoard(started, { type: 'tool/call', data: { callId: 'c1', name: 'work_submit', arguments: JSON.stringify({ outcome: 'complete', summary: 's', next: 'n' }) } })
  const settled = foldBoard(asked, answer('c1', {
    outcome: 'complete',
    checkpoint: { snapshot: 'captured', ref: 'refs/auto-dev-v3/t/2-after' },
    warnings: [],
    children: [{ childId: 'k1', writes: ['/repo/a.mjs', '/repo/a.test.mjs'], checks: ['cd /repo && npm test'], state: 'settled' }],
  }))
  const board = boardOf(settled)
  assert.deepEqual(board.assets.children, [{ written: 2, checked: 1, state: 'settled' }])
  assert.equal(board.assets.checkpoint.count, 1)
})

test('心跳：非 work 调用也给 beats 计数', () => {
  const state = fold([call('bash', { command: 'ls' }), call('read', { file_path: 'a.mjs' })])
  assert.equal(state.beats.calls, 2)
})

test('beats 盖日志自己的时间与 seq，work_start 重置计划但保留心跳', () => {
  const state = fold([
    { ...call('bash', { command: 'ls' }), time: 111, seq: 5 },
    { ...call('work_start', { request: 'x', mode: 'do' }), time: 222, seq: 9 },
  ])
  assert.equal(state.mode, 'do')
  assert.equal(state.beats.calls, 2)
  assert.equal(state.beats.lastAt, 222)
  assert.equal(state.beats.lastSeq, 9)
})

test('beats 透出到看板；result 事件不加计数', () => {
  let state = fold([
    { ...call('work_start', { request: 'x', mode: 'do' }), time: 50, seq: 1 },
    { ...call('compress', {}), time: 80, seq: 4 },
    result(),
  ])
  assert.equal(state.beats.calls, 2)
  assert.equal(boardOf(state).beats.lastAt, 80)
})

const planStart = () => ({
  fixtureSuccess: true, type: 'tool/call', time: 90, seq: 4,
  data: { callId: 'c-start', name: 'work_start', arguments: { request: 'split the parser', mode: 'build', plan: [{ id: 'u-a', goal: 'lexer', scope: [], acceptance: [] }] } },
})
const noteCall = (callId, text, time, seq) => ({
  type: 'tool/call', time, seq,
  data: { callId, name: 'work_plan', arguments: { operation: 'note', unit: 'u-a', text } },
})
const noteAnswer = (callId, value = { recorded: true }) => ({
  type: 'tool/result',
  data: { message: { toolCallId: callId, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } },
})

test('a work_plan note reaches the board without changing the unit state', () => {
  const state = fold([planStart(), noteCall('c-note', 'token table extracted', 100, 5), noteAnswer('c-note')])
  const unit = boardOf(state).units.find(row => row.id === 'u-a')
  assert.equal(unit.state, 'pending', 'a note is progress, not a state change')
  assert.equal(unit.note, 'token table extracted')
  // The board also carries the trail, so the packet's expander has something to
  // open without asking the host for the plan record again.
  assert.deepEqual(unit.notes?.map(entry => entry.text), ['token table extracted'])
  assert.ok(unit.notes[0].at, 'each trail line keeps its stamp')
  // Order is oldest first: the expander reads top-down like a log.
  const twice = fold([
    planStart(),
    noteCall('c-note-1', 'first line', 100, 5), noteAnswer('c-note-1'),
    noteCall('c-note-2', 'second line', 200, 6), noteAnswer('c-note-2'),
  ])
  assert.deepEqual(boardOf(twice).units.find(row => row.id === 'u-a').notes.map(entry => entry.text), ['first line', 'second line'])
  // A later `add` redeclares the plan and must not erase the note.
  const after = fold([
    planStart(),
    noteCall('c-note', 'token table extracted', 100, 5), noteAnswer('c-note'),
    { type: 'tool/call', time: 200, seq: 9, data: { callId: 'c-add', name: 'work_plan', arguments: { operation: 'add', units: [{ id: 'u-b', goal: 'parser', scope: [], acceptance: [] }] } } },
  ])
  assert.equal(boardOf(after).units.find(row => row.id === 'u-a').note, 'token table extracted')
})

test('a refused note call leaves nothing on the board', () => {
  const asked = fold([planStart(), noteCall('c-probe', 'probe', 100, 5)])
  assert.ok(!boardOf(asked).units.find(row => row.id === 'u-a').note, 'a call alone claims nothing')
  // The host answers a refusal with plain text, not JSON — that answer must not
  // turn into a line of progress, which is exactly how one probe call became
  // "probe" on the board.
  const refused = foldBoard(asked, noteAnswer('c-probe', 'auto-dev-v3: task is closed'))
  assert.ok(!boardOf(refused).units.find(row => row.id === 'u-a').note, 'a refusal is not progress')
  const accepted = foldBoard(asked, noteAnswer('c-probe'))
  assert.equal(boardOf(accepted).units.find(row => row.id === 'u-a').note, 'probe')
})

const answerFor = (callId, value, isError = false) => ({
  type: 'tool/result',
  data: {
    message: {
      toolCallId: callId,
      isError,
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
  },
})
const callAs = (name, args, callId) => ({ type: 'tool/call', data: { callId, name, arguments: args } })

test('an adopted task draws the board even though this session never started it', () => {
  // The session that picks up somebody else's task calls `work_control adopt`; it
  // never calls `work_start`, so the snapshot in the answer is the only description
  // of the work in this log. Without seeding from it the panel stays empty while the
  // task record says 2/4 — the exact failure this rule exists to prevent.
  const state = fold([
    callAs('work_control', { operation: 'adopt', taskId: 'task-1' }, 'c-adopt'),
    answerFor('c-adopt', {
      taskId: 'task-1', adopted: true, from: 'session-old', project: '/p', mode: 'build', state: 'active',
      request: '把第三个入口接进新分支，顺手把共用兜底拆干净',
      planId: 'plan-1',
      units: [
        { id: 'U1', goal: '枚举渲染失败分支', state: 'done', notes: [{ at: 1, text: '三个失败分支都定位到了' }] },
        { id: 'U2', goal: '造最小错误皮肤包', state: 'done' },
        { id: 'U3', goal: '真机四组合验证', state: 'active', note: '两台机器上已经跑过一对组合' },
        { id: 'U4', goal: '实验室复现', state: 'pending' },
      ],
    }),
  ])
  const board = boardOf(state)
  assert.ok(board, 'an adopted task is still a task: the board has to exist')
  assert.equal(board.mode, 'build')
  assert.equal(board.counting.label, '2/4')
  assert.deepEqual(board.units.map(unit => unit.state), ['done', 'done', 'active', 'pending'])
  assert.equal(board.goal, '把第三个入口接进新分支，顺手把共用兜底拆干净')
  // The progress line travels with the snapshot: it is the only progress this
  // session has ever seen.
  assert.equal(board.units[2].note, '两台机器上已经跑过一对组合')
})

test('a status snapshot fills an empty board but never rewrites a drawn one', () => {
  const snapshot = {
    taskId: 'task-2', mode: 'do', state: 'active', request: 'x',
    units: [{ id: 'm1', goal: '一步', state: 'done' }],
  }
  const fromStatus = fold([
    callAs('work_status', { view: 'summary' }, 'c-status'),
    answerFor('c-status', snapshot),
  ])
  assert.equal(boardOf(fromStatus).counting.label, '1/1')
  // A read taken mid-run reports the host record, which may lag behind the calls
  // this session already folded. Filling an empty board is help; rewriting a drawn
  // one would silently roll progress back.
  const drawn = fold([
    call('work_start', { request: 'x', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [{ id: 'm1', goal: '一步', scope: ['src'], acceptance: [] }] }),
  ])
  const afterRead = foldBoard(drawn, callAs('work_status', { view: 'summary' }, 'c-status-2'))
  const final = foldBoard(afterRead, answerFor('c-status-2', snapshot))
  assert.deepEqual(boardOf(final).units.map(unit => unit.state), ['pending'])
})

test('a refused adopt leaves the board empty, and an imported plan keeps nested units', () => {
  const refused = fold([
    callAs('work_control', { operation: 'adopt', taskId: 'nope' }, 'c-bad'),
    answerFor('c-bad', 'Error: task nope does not exist on this host', true),
  ])
  assert.equal(boardOf(refused), null)
  const imported = fold([
    callAs('work_control', { operation: 'import', file: 'x.json' }, 'c-import'),
    answerFor('c-import', {
      taskId: 'task-3', mode: 'build', state: 'active', request: 'y',
      units: [
        { id: 'M1', goal: '第一阶段', state: 'done', units: [
          { id: 'M1a', goal: '子步骤', state: 'done' },
          { id: 'M1b', goal: '另一个子步骤', state: 'pending' },
        ] },
      ],
    }),
  ])
  const board = boardOf(imported)
  assert.deepEqual(board.units.map(unit => unit.id), ['M1', 'M1a', 'M1b'])
  assert.equal(board.counting.label, '1/2')
})

// ---------------------------------------------------------------------------
// Delegated work. The child keeps its own log, so the parent's log is folded for
// what it records (dispatch, label, reports) and the live registry supplies the
// running half (model, effort, current tool) at read time.

test('a catalog row attaches a child to its packet and adds a dispatch note', () => {
  const state = fold([
    call('work_start', { request: 'x', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [
      { id: 'B7', goal: '准入校验', scope: ['src'], acceptance: [] },
      { id: 'B8', goal: '复杂字段', scope: ['src'], acceptance: [] },
    ] }),
    call('subagent_heavy', { description: 'B7 iOS 准入校验链', prompt: '把 B7 的校验补齐' }),
    { type: 'subagent/catalog', time: 100, data: { childId: 'child-a', label: 'B7 iOS 准入校验链' } },
  ])
  const board = boardOf(state, () => [{
    childId: 'child-a', label: 'B7 iOS 准入校验链',
    model: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl', agentProvider: 'home-5090-strata', effort: 'xhigh',
    state: 'running', startedAt: 90, writes: ['src/a.mjs'], checks: ['npm test'],
    activity: { tool: 'edit', target: 'src/a.mjs', text: 'edit · src/a.mjs' },
  }])
  const packet = board.units.find(unit => unit.id === 'B7')
  assert.match(packet.notes[0].text, /子代理派出 · B7 iOS 准入校验链/)
  assert.match(packet.notes.at(-1).text, /子代理 qwen3\.8-flash-next-unsloth-ud-q4_k_xl · xhigh 正在做 · edit · src\/a\.mjs/)
  assert.equal(board.children.length, 1)
  assert.equal(board.children[0].unit, 'B7')
  assert.equal(board.children[0].model, 'qwen3.8-flash-next-unsloth-ud-q4_k_xl')
  assert.equal(board.children[0].effort, 'xhigh')
  assert.equal(board.children[0].written, 1)
  assert.equal(board.running, 1)
})

test('a report lands in its packet once, and the settled notice does not repeat it', () => {
  const state = fold([
    call('work_start', { request: 'x', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [
      { id: 'B7', goal: '准入校验', scope: ['src'], acceptance: [] },
    ] }),
    call('subagent_heavy', { description: 'B7 iOS 准入校验链', prompt: '把 B7 的校验补齐' }),
    { type: 'subagent/catalog', time: 100, data: { childId: 'child-a', label: 'B7 iOS 准入校验链' } },
    { type: 'user/message', time: 200, data: {
      source: { kind: 'agent-message', senderSessionId: 'child-a' },
      content: [{ text: 'Agent child-a sent a message: ' }, { text: '补完了 3 个用例' }],
    } },
  ])
  const relayed = boardOf(state)
  assert.equal(relayed.children[0].state, 'running')
  assert.match(relayed.units.find(unit => unit.id === 'B7').note, /子代理回报 · 补完了 3 个用例/)

  const settled = foldBoard(state, { type: 'user/message', time: 300, data: {
    source: { kind: 'subagent-settled', senderSessionId: 'child-a' },
    content: [
      { text: 'Background subagent child-a finished.' },
      { text: 'Its closing message:' },
      { text: '补完了 3 个用例' },
    ],
  } })
  const board = boardOf(settled)
  assert.equal(board.children[0].state, 'settled')
  const reports = board.units.find(unit => unit.id === 'B7').notes.filter(note => /子代理回报/.test(note.text))
  assert.equal(reports.length, 1)
})

test('a child that never relayed still gets its closing message on the packet', () => {
  const state = fold([
    call('work_start', { request: 'x', mode: 'build' }),
    call('work_plan', { operation: 'set', units: [{ id: 'B7', goal: '准入校验', scope: ['src'], acceptance: [] }] }),
    call('subagent_medium', { description: 'B7 复查', prompt: '复查 B7' }),
    { type: 'subagent/catalog', time: 100, data: { childId: 'child-b', label: 'B7 复查' } },
    { type: 'user/message', time: 200, data: {
      source: { kind: 'subagent-settled', senderSessionId: 'child-b' },
      content: [{ text: 'Its closing message:' }, { text: '没有发现回归' }],
    } },
  ])
  const board = boardOf(state)
  assert.equal(board.children[0].state, 'settled')
  assert.match(board.units.find(unit => unit.id === 'B7').note, /子代理回报 · 没有发现回归/)
})

test('a live child without a catalog row still shows, but is not attached to a packet', () => {
  const state = fold([call('work_start', { request: 'x', mode: 'do' })])
  const board = boardOf(state, () => [{
    childId: 'child-live', label: '临时派活', model: 'deepseek-flash', agentProvider: 'deepseek-responses', effort: 'max',
    state: 'running', startedAt: 10, writes: [], checks: [], activity: { tool: 'bash', text: 'bash · npm test' },
  }])
  assert.equal(board.children.length, 1)
  assert.equal(board.children[0].unit, null)
  assert.equal(board.children[0].state, 'running')
  assert.equal(board.running, 1)
})

// --- the task record is the root of the board -------------------------------
//
// The log only carries what this conversation did. A task can outlive the
// conversation that started it, and a handed-on task starts in a conversation
// that has done nothing yet, so the board reads the record first and treats the
// log as the increment on top of it.

const recordFor = (overrides = {}) => ({
  task: {
    id: 'task-h', mode: 'build', state: 'active', project: '/repo/example',
    request: '把交接文档里的 B 系列做完', goal: 'B 系列交付',
    updatedAt: '2026-10-22T00:00:00.000Z', ...(overrides.task ?? {}),
  },
  ...(overrides.plan ? { plan: { id: 'plan-h', updatedAt: '2026-10-22T00:00:01.000Z', units: overrides.plan } } : {}),
})
const storeOf = found => ({ taskFor: id => (id === 'session-h' ? found : undefined) })
// A state with every EMPTY field present and nothing drawn: the shape `init`
// hands the fold before the first event.
const blank = sessionId => ({ ...fold([call('work_status', {})]), sessionId })

test('the project timeline rides the board: past tasks keep their place', () => {
  const found = recordFor({ plan: [{ id: 'u1', goal: '跑回归', scope: ['src'], acceptance: [] }] })
  const rows = [
    { id: 'task-now', at: '2026-10-24T06:16:00.000Z', updatedAt: '2026-10-24T07:20:00.000Z', state: 'active', mode: 'do', goal: '接着做 B 系列', current: true, themes: 1, marks: 2, units: [{ id: 'u1', goal: '跑回归', state: 'pending' }] },
    { id: 'task-old', at: '2026-10-20T10:13:00.000Z', updatedAt: '2026-10-21T08:40:00.000Z', state: 'closed', mode: 'build', goal: '还原渲染失败的原因', current: false, themes: 0, marks: 9, units: [] },
  ]
  const store = { ...storeOf(found), timeline: id => (id === 'session-h' ? rows : []) }
  const seeded = syncState(blank('session-h'), store)
  const board = boardOf(seeded, [])
  assert.equal(board.timeline.length, 2, 'a new task must not erase the one before it')
  assert.equal(board.timeline[0].id, 'task-now')
  assert.equal(board.timeline[0].current, true)
  assert.equal(board.timeline[1].goal, '还原渲染失败的原因')
  // Same rows, same reference — the timeline is read on every event, so an
  // unchanged history must not restate the board.
  assert.equal(syncState(seeded, store), seeded)
  const moved = { ...store, timeline: () => [rows[0], { ...rows[1], updatedAt: '2026-10-22T00:00:00.000Z' }] }
  assert.notEqual(syncState(seeded, moved), seeded, 'a task that moved must move the board')
})

test('a task handed to this session draws a board before the model runs a thing', () => {
  const store = storeOf(recordFor({ plan: [
    { id: 'u1', goal: '解析交接文档', scope: ['docs'], acceptance: [], state: 'done' },
    { id: 'u2', goal: '跑回归', scope: ['src'], acceptance: [], state: 'active' },
  ] }))
  const state = syncState(blank('session-h'), store)
  const board = boardOf(state)
  assert.equal(board.taskId, 'task-h', 'the board knows which task it is showing')
  assert.equal(board.lane, '交付（历史 build）')
  assert.equal(board.goal, 'B 系列交付')
  assert.equal(board.counting.label, '1/2')
  assert.equal(board.next, '跑回归', 'the running unit is what "next" is about')
})

test('the flat rows the record keeps still nest into milestones', () => {
  const store = storeOf(recordFor({ plan: [
    { id: 'm1', goal: '先把旧接口拆出来', parent: null, depth: 0, state: 'active' },
    { id: 'u1', goal: '拆出读写两条路', parent: 'm1', depth: 1, state: 'done', scope: ['src'], acceptance: [] },
    { id: 'u2', goal: '把调用方接过去', parent: 'm1', depth: 1, state: 'active', scope: ['src'], acceptance: [] },
  ] }))
  const board = boardOf(syncState(blank('session-h'), store))
  assert.equal(board.milestones.length, 1)
  assert.equal(board.milestones[0].label, '先把旧接口拆出来')
  assert.equal(board.counting.total, 2, 'a milestone counts the work inside it, not itself')
})

test('the record is read once per state: nothing new keeps the same reference', () => {
  const store = storeOf(recordFor({ plan: [{ id: 'u1', goal: '跑回归', scope: ['src'], acceptance: [] }] }))
  const seeded = syncState(blank('session-h'), store)
  assert.equal(syncState(seeded, store), seeded)
  assert.equal(syncState(foldBoard(seeded, { type: 'noise', data: {} }), store), seeded,
    'an event that says nothing new must not restate the board')
  // A record that moved on is adopted on the next read. A plan write bumps its
  // own `updatedAt`, which is what the signature watches — that is the contract
  // the record keeps, so a changed unit cannot arrive with an unchanged stamp.
  const moved = storeOf(recordFor({
    task: { updatedAt: '2026-10-22T00:00:02.000Z' },
    plan: [{ id: 'u1', goal: '跑回归', scope: ['src'], acceptance: [], state: 'done' }],
  }))
  moved.taskFor = id => {
    const found = storeOf(recordFor({
      task: { updatedAt: '2026-10-22T00:00:02.000Z' },
      plan: [{ id: 'u1', goal: '跑回归', scope: ['src'], acceptance: [], state: 'done' }],
    })).taskFor(id)
    if (found?.plan) found.plan.updatedAt = '2026-10-22T00:00:02.000Z'
    return found
  }
  assert.equal(boardOf(syncState(seeded, moved)).counting.label, '1/1')
})

test('a handed-on task keeps drawing in the conversation it came from', () => {
  const built = recordFor({ task: { sessionId: 'session-new', sessions: ['session-old', 'session-new'] } })
  const store = { taskFor: id => (built.task.sessions.includes(id) ? built : undefined) }
  assert.equal(boardOf(syncState(blank('session-old'), store)).taskId, 'task-h')
  assert.equal(boardOf(syncState(blank('session-new'), store)).taskId, 'task-h')
  assert.equal(boardOf(syncState(blank('session-cold'), store)), null, 'an unrelated session stays empty')
})

test('the registered projection seeds its first read from the record', () => {
  const store = storeOf(recordFor({ plan: [{ id: 'u1', goal: '跑回归', scope: ['src'], acceptance: [] }] }))
  let spec
  registerBoard({ sessionProjections: { register: value => { spec = value; return { dispose() {} } } } }, { store })
  // The first read of a conversation that has logged nothing yet still has a board:
  // that is what makes `/dsh-auto-dev start` show a panel immediately.
  const initial = spec.init({ id: 'session-h' })
  assert.ok(spec.wire.view(initial))
  assert.equal(spec.stateVersion, BOARD_STATE_VERSION)
  assert.equal(spec.apply(initial, { type: 'noise', data: {} }), initial,
    'apply must keep the reference when nothing moved')
  assert.equal(spec.init({ id: 'session-cold' }).mode, null)
})

test('a unit row carries its deliverable and the pair of checkpoints it earned', () => {
  const store = storeOf(recordFor({
    task: {
      checkpoints: [
        { ref: 'refs/auto-dev-v3/task-h/1-before', seq: 1, tag: 'before', unit: 'u1', label: '一屏能演示的渲染管线' },
        { ref: 'refs/auto-dev-v3/task-h/2-after', seq: 2, tag: 'after', unit: 'u1', label: '一屏能演示的渲染管线', outcome: 'won' },
        { ref: 'refs/auto-dev-v3/task-h/3-after', seq: 3, tag: 'after' },
      ],
      updatedAt: '2026-10-22T00:00:03.000Z',
    },
    plan: [
      { id: 'u1', goal: '渲染管线落地', deliverable: '一屏能演示的渲染管线', scope: ['src'], acceptance: [], state: 'active' },
      { id: 'u2', goal: '跑回归', scope: ['src'], acceptance: [] },
    ],
  }))
  const board = boardOf(syncState(blank('session-h'), store))
  const row = board.units.find(unit => unit.id === 'u1')
  assert.equal(row.deliverable, '一屏能演示的渲染管线', 'the panel needs the sentence a person would be shown')
  assert.deepEqual(board.marks.map(mark => mark.tag), ['before', 'after', 'after'])
  assert.equal(board.marks[0].unit, 'u1')
  assert.equal(board.marks.filter(mark => mark.unit === 'u1').length, 2, 'only the promised pair is drawn on the row')
})

test('a unit waiting on a person says so on its row', () => {
  const store = storeOf(recordFor({
    plan: [{ id: 'u1', goal: '放进仓库里的产物', scope: ['out'], acceptance: [], asked: { at: '2026-10-22T00:00:04.000Z', question: '产物要放进仓库吗？' } }],
  }))
  const row = boardOf(syncState(blank('session-h'), store)).units.find(unit => unit.id === 'u1')
  assert.equal(row.asked, '产物要放进仓库吗？')
})

test('the board carries who calls the task done, and keeps the old default for old records', () => {
  const auto = syncState(blank('session-h'), storeOf(recordFor({ task: { acceptanceMode: 'auto' } })))
  assert.equal(auto.acceptanceMode, 'auto')
  assert.equal(boardOf(auto).acceptanceMode, 'auto')

  // Records written before the field existed are judged by the person, which is
  // what every task in the store assumed anyway.
  const legacy = syncState(blank('session-h'), storeOf(recordFor({ task: { acceptanceMode: undefined } })))
  assert.equal(legacy.acceptanceMode, null)
})

test('改过的目标带着版本号上板，没改过的就是第 1 版', () => {
  const revised = recordFor({})
  revised.task.goalHistory = [
    { at: '2026-10-23T00:00:00.000Z', text: '导出能用' },
    { at: '2026-10-23T01:00:00.000Z', text: '导出三种格式，列顺序跟页面一致' },
  ]
  revised.task.goal = '导出三种格式，列顺序跟页面一致'
  const board = boardOf(syncState(blank('session-h'), storeOf(revised)))
  assert.equal(board.goalRevision, 2)

  const plain = boardOf(syncState(blank('session-h'), storeOf(recordFor({}))))
  assert.equal(plain.goalRevision, 0, 'no history means the goal was never revised')

  // A revision is a change of the goal, not of the number: same record, same state.
  const state = syncState(blank('session-h'), storeOf(revised))
  const again = syncState(state, storeOf(revised))
  assert.equal(again, state, 'nothing changed, so the host gets the same reference back')
})

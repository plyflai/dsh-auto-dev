import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callsSince, lastAssistant, pseudoCallOf, rescueMessage } from '../src/pseudo-call.mjs'
import { registerHooks } from '../src/hooks.mjs'

/**
 * The exact text session 73c87539 ended on: provider home-5090-strata with the
 * `ptc` preset, where only `run_code` is declared, so the model's call to
 * `work_status` arrived as prose and never executed. The parser invented the
 * `tools=` prefix while grouping names.
 */
const FAILED_TURN_TEXT = [
  '<tool_call>',
  '<function=tools=work_status>',
  '<parameter=args>',
  '{"taskId": "task-mvfa08hs-xgc5q4", "view": "summary"}',
  '</parameter>',
  '</function>',
  '</tool_call>',
].join('\n')

test('the failed turn is read back as the call it meant to make', () => {
  assert.deepEqual(pseudoCallOf(FAILED_TURN_TEXT), {
    name: 'work_status',
    arguments: { taskId: 'task-mvfa08hs-xgc5q4', view: 'summary' },
  })
})

test('the JSON body form parses too', () => {
  const text = '<tool_call>\n{"name":"work_status","arguments":{"taskId":"t1"}}\n</tool_call>'
  assert.deepEqual(pseudoCallOf(text), { name: 'work_status', arguments: { taskId: 't1' } })
})

test('ordinary prose is not a call', () => {
  assert.equal(pseudoCallOf('我看了一下计划，两个单元都做完了。'), null)
  assert.equal(pseudoCallOf({ content: [{ type: 'reasoning', text: '<tool_call>' }] }), null)
})

/**
 * Session f40c042c, step 7 and 8: seven real `run_code` calls ran, and the last
 * `read` arrived as prose — then a step that repeated only the prose and ended
 * the turn. The turn was busy, the ending was dead, and only the newest message
 * tells those apart.
 */
const DEAD_END_TURN = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { turn: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', name: 'run_code', arguments: '{}' }] } } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: {} } },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 7,
      message: {
        content: [
          { type: 'reasoning', text: 'That file is the one I need.' },
          { type: 'text', text: '<tool_call>\n<function=read>\n<parameter=file_path>README.md</parameter>\n</function>\n</tool_call>' },
          { type: 'tool-call', name: 'run_code', arguments: '{}' },
        ],
      },
    },
  },
  { type: 'tool/call', data: { turn: 1, step: 7, callId: 'c2', name: 'run_code', arguments: {} } },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 8,
      message: {
        content: [
          { type: 'reasoning', text: 'The read result seems to be missing. Let me re-read it.' },
          { type: 'text', text: '<tool_call>\n<function=read>\n<parameter=file_path>README.md</parameter>\n</function>\n</tool_call>' },
        ],
      },
    },
  },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

test('the newest message is what a turn is judged by', () => {
  const session = { seq: DEAD_END_TURN.length, eventAt: index => DEAD_END_TURN[index] }
  const last = lastAssistant(session, 1)
  assert.deepEqual(last.callNames, [])
  assert.match(last.text, /<function=read>/)
  assert.equal(lastAssistant({ seq: 0, eventAt: () => undefined }, 9), null)
  assert.equal(lastAssistant({ seq: DEAD_END_TURN.length, eventAt: index => DEAD_END_TURN[index] }, 2), null)
})

test('a minute later, the same turn ends on prose after real calls', () => {
  // The bug this test locks: seven real calls made the turn look healthy, so the
  // rescue skipped it and the person got silence with the task half done.
  const handlers = rescueHost()
  const steered = []
  handlers.get('agent/turn-stopping')({ agent: agentFor(DEAD_END_TURN, steered), turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /await tools\.read\(/)
  assert.match(steered[0].content[0].text, /README\.md/)
})

test('prose that repeats a call the message really made is narration', () => {
  const handlers = rescueHost()
  const steered = []
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '<tool_call>\n<function=run_code>\n<parameter=code>x</parameter>\n</function>\n</tool_call>' },
            { type: 'tool-call', name: 'run_code', arguments: '{}' },
          ],
        },
      },
    },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: {} } },
  ]
  handlers.get('agent/turn-stopping')({ agent: agentFor(events, steered), turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 0)
})

test('the same message is corrected once, however often the turn stops', () => {
  const handlers = rescueHost()
  const steered = []
  const agent = agentFor(pseudoTurn(), steered)
  const turnEnd = handlers.get('agent/turn-stopping')
  turnEnd({ agent, turn: 1, signal: new AbortController().signal })
  turnEnd({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1)
})

test('a model that answers a correction with more prose gets silence', () => {
  // No real call between the three prose messages: the second and third are the
  // same sentence twice, so only the first is corrected.
  const handlers = rescueHost()
  const steered = []
  const turnEnd = handlers.get('agent/turn-stopping')
  const at = step => agentFor([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, step, message: { content: [{ type: 'text', text: FAILED_TURN_TEXT }] } } },
  ], steered)
  turnEnd({ agent: at(1), turn: 1, signal: new AbortController().signal })
  turnEnd({ agent: at(2), turn: 1, signal: new AbortController().signal })
  turnEnd({ agent: at(3), turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1)
})

test('a real call is found past the events that carry no step', () => {
  // `agent/inbox/spliced` and tool results carry no step; a scan that treats "step
  // absent" as "step 0" stops there and reports a long turn as making no progress.
  const session = {
    seq: 5,
    eventAt: index => [
      { type: 'tool/call', data: { turn: 3, step: 2, name: 'run_code' } },
      { type: 'tool/result', data: { turn: 3, step: 2 } },
      { type: 'agent/inbox/spliced', data: { target: 'next-step' } },
      { type: 'assistant/message', data: { turn: 3, step: 9, message: { content: [{ type: 'text', text: 'x' }] } } },
      { type: 'step/end', data: { turn: 3, step: 9 } },
    ][index],
  }
  assert.equal(callsSince(session, 3, 1), true)
  assert.equal(callsSince(session, 3, 5), false)
})

test('a turn that recovers and loses another call later is corrected again', () => {
  // f40c042c's turn 2: corrected at step 1 and again at step 5, real `run_code`
  // calls in between, then a 10 KB `write` written as prose at step 24. A fixed
  // two-per-turn cap spent itself by step 5 and let step 24 end in silence.
  const handlers = rescueHost()
  const steered = []
  const turnEnd = handlers.get('agent/turn-stopping')
  const call = (step, callId) => [
    { type: 'assistant/message', data: { turn: 7, step, message: { content: [{ type: 'tool-call', name: 'run_code', arguments: '{}' }] } } },
    { type: 'tool/call', data: { turn: 7, step, callId, name: 'run_code', arguments: {} } },
  ]
  const prose = step => ({ type: 'assistant/message', data: { turn: 7, step, message: { content: [{ type: 'text', text: FAILED_TURN_TEXT }] } } })
  const start = { type: 'turn/start', data: { turn: 7 } }
  // First stopping point: the turn has lost its first call and made none since.
  turnEnd({ agent: agentFor([start, prose(1)], steered), turn: 7, signal: new AbortController().signal })
  // Later: real calls landed (steps 2 and 5), and step 24 wrote a `write` as prose.
  const later = [start, prose(1), ...call(2, 'c2'), ...call(5, 'c5'), prose(24)]
  turnEnd({ agent: agentFor(later, steered), turn: 7, signal: new AbortController().signal })
  // The same lost message is not corrected twice.
  turnEnd({ agent: agentFor(later, steered), turn: 7, signal: new AbortController().signal })
  assert.equal(steered.length, 2)
})

test('the step after a lost call is told before the turn ends', async () => {
  // f40c042c's step 8 began right after a message that made a real call and wrote
  // a second one as prose. Waiting for turn end is one step too late: the model
  // reads its result, finds the wanted one missing, and blames the tool.
  const handlers = rescueHost()
  const events = DEAD_END_TURN.slice(0, 6)
  const decision = await handlers.get('agent/pre-step')(
    { agent: agentFor(events, []), messages: [], step: 8 },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.summary, 'auto-dev-v3 伪调用纠正')
  assert.match(decision.messages[0].content[0].text, /await tools\.read\(/)
  assert.match(decision.messages[0].content[0].text, /README\.md/)
})

test('a new turn is not judged by the prose of the one before it', async () => {
  const handlers = rescueHost()
  const events = [
    ...DEAD_END_TURN.slice(0, 6),
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { turn: 2 } },
  ]
  const decision = await handlers.get('agent/pre-step')(
    { agent: agentFor(events, []), messages: [], step: 1 },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.equal(decision.messages.length, 0)
})

test('a step that follows a healthy message is left alone', async () => {
  const handlers = rescueHost()
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', name: 'run_code', arguments: '{}' }] } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: {} } },
  ]
  const decision = await handlers.get('agent/pre-step')(
    { agent: agentFor(events, []), messages: [], step: 2 },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.equal(decision.messages.length, 0)
})

/** A host stub reduced to what `registerHooks` needs to wire the rescue. */
function rescueHost(optedIn = () => true) {
  const handlers = new Map()
  const ctx = { on: (event, handler) => { handlers.set(event, handler); return () => {} } }
  const api = {
    notice: (body, summary, extra = {}) => ({
      id: 'notice-1',
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'auto-dev-v3', form: extra.form ?? 'notice', summary },
    }),
    optedIn,
    sessionId: () => 'session-1',
    // The pre-step hook reads session state and the task record; with no task it
    // stops before anything that would shape a decision.
    seq: () => 1,
    records: { get: () => undefined, change: async () => {}, close: () => {} },
    settings: () => ({ requireUserStart: false }),
    sessionState: () => ({ userTexts: [] }),
    markUserSpoke: async () => {},
    takeIntake: () => null,
    grantStart: () => {},
    readStartGrant: () => ({ ok: false }),
    activeTask: () => undefined,
    latestTask: () => undefined,
    stoppedTask: () => undefined,
    takeReceipts: () => [],
    planOf: () => null,
    observationsOf: () => [],
    unfinishedElsewhere: () => [],
  }
  registerHooks(ctx, api)
  return handlers
}

function agentFor(events, steered) {
  return {
    session: { id: 'session-1', seq: events.length, eventAt: index => events[index] },
    steer: message => { steered.push(message) },
  }
}

const pseudoTurn = () => [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { turn: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: FAILED_TURN_TEXT }] } } },
  { type: 'turn/end', data: { turn: 1 } },
]

test('a silent dead turn is corrected once, with the call that was lost', () => {
  const handlers = rescueHost()
  const steered = []
  const turnEnd = handlers.get('agent/turn-stopping')
  const agent = agentFor(pseudoTurn(), steered)
  turnEnd({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /work_status/)
  assert.match(steered[0].content[0].text, /await tools\.work_status\(/)
  assert.match(steered[0].content[0].text, /没有执行/)
})

test('a message that narrated its own call and made it needs no rescue', () => {
  const handlers = rescueHost()
  const steered = []
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '现在读一下这个文件。' },
            { type: 'tool-call', name: 'run_code', arguments: '{"code":"x"}' },
          ],
        },
      },
    },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: { code: 'x' } } },
  ]
  handlers.get('agent/turn-stopping')({ agent: agentFor(events, steered), turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 0)
})

test('a session that never asked for Auto Dev is left alone', () => {
  const handlers = rescueHost(() => false)
  const steered = []
  handlers.get('agent/turn-stopping')({ agent: agentFor(pseudoTurn(), steered), turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 0)
})

test('an aborted turn is not resurrected', () => {
  const handlers = rescueHost()
  const steered = []
  const controller = new AbortController()
  controller.abort()
  handlers.get('agent/turn-stopping')({ agent: agentFor(pseudoTurn(), steered), turn: 1, signal: controller.signal })
  assert.equal(steered.length, 0)
})

test('a broken rescue costs the rescue, not the turn', () => {
  // A listener that throws turns `turn/end` into an error the person cannot
  // connect to anything they did; the guard is sealed for exactly this case.
  const handlers = rescueHost()
  const brokenLog = { session: { id: 'session-1', seq: 3, eventAt: () => { throw new Error('log gone') } }, steer: () => {} }
  const brokenInbox = { session: { id: 'session-2', seq: 3, eventAt: () => undefined }, steer: () => { throw new Error('inbox closed') } }
  assert.doesNotThrow(() => handlers.get('agent/turn-stopping')({ agent: brokenLog, turn: 1, signal: new AbortController().signal }))
  assert.doesNotThrow(() => handlers.get('agent/turn-stopping')({ agent: brokenInbox, turn: 1, signal: new AbortController().signal }))
})

test('the rescue reads like a next step, not a complaint', () => {
  const body = rescueMessage({ name: 'work_status', arguments: { taskId: 't1' } })
  assert.match(body, /run_code/)
  assert.match(body, /await tools\.work_status\(\{"taskId":"t1"\}\)/)
  assert.equal(rescueMessage({ name: '', arguments: {} }).includes('工具名缺失'), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { childIds, childRegistry, describeChild, descriptorOf, lastAction, readChild, readChildren } from '../src/child-sessions.mjs'

const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })

/** A child session shaped like the host's: events by seq, a call per tool. */
function childSession(events) {
  return { seq: events.length, eventAt: index => events[index] }
}

const sessionsWith = table => ({ get: async id => { if (!(id in table)) throw new Error(`no session ${id}`); return table[id] } })

test('a delegation result names the session that got the work', () => {
  const ids = childIds([
    { name: 'subagent_medium', callId: 'c1', seq: 4, value: { childId: 'child-a' } },
    // A refused spawn handed the work to nobody.
    { name: 'subagent_medium', callId: 'c2', seq: 9, isError: true, value: { childId: 'child-b' } },
    { name: 'subagent_medium', callId: 'c3', seq: 12, value: { agentId: 'child-c' } },
    { name: 'bash', callId: 'c4', seq: 15, value: { id: 'not-a-delegation' } },
  ])
  assert.deepEqual(ids, [{ childId: 'child-a', callId: 'c1', seq: 4 }, { childId: 'child-c', callId: 'c3', seq: 12 }])
})

test('a child session reports the files it wrote and the checks it ran', async () => {
  const child = childSession([
    call('k1', 'read', { path: 'src/a.mjs' }),
    call('k2', 'write', { path: '/repo/src/a.mjs' }),
    call('k3', 'bash', { command: 'cd /repo && npm test 2>&1 | tail -3' }),
    call('k4', 'edit', { path: '/repo/src/a.test.mjs' }),
  ])
  const summary = await readChild(sessionsWith({ 'child-a': child }), { childId: 'child-a', callId: 'c1', seq: 4 })
  assert.equal(summary.reachable, true)
  assert.equal(summary.calls, 4)
  assert.deepEqual(summary.writes.sort(), ['/repo/src/a.mjs', '/repo/src/a.test.mjs'])
  assert.deepEqual(summary.checks, ['cd /repo && npm test 2>&1 | tail -3'])
  assert.match(describeChild(summary), /2 file\(s\): \/repo\/src\/a\.mjs, \/repo\/src\/a\.test\.mjs/)
  assert.match(describeChild(summary), /evidence for its own log/)
})

test('a child that is gone degrades to saying its writes are unknown', async () => {
  const summary = await readChild(sessionsWith({}), { childId: 'child-gone' })
  assert.equal(summary.reachable, false)
  assert.match(summary.reason, /no session child-gone/)
  assert.match(describeChild(summary), /could not be read .*writes are unknown/)
})

test('no session store is a reason, not a crash', async () => {
  const summary = await readChild(undefined, { childId: 'child-a' })
  assert.equal(summary.reachable, false)
  assert.match(summary.reason, /no session store/)
  const all = await readChildren(null, [{ name: 'subagent', value: { childId: 'x' } }])
  assert.equal(all.length, 1)
  assert.equal(all[0].reachable, false)
})

test('a recorded child is read from its own session and reported as its account', async () => {
  const { childRegistry, describeRecord } = await import('../src/child-sessions.mjs')
  const childSession = {
    id: 'child-1',
    seq: 3,
    eventAt(at) {
      return [
        { type: 'tool/call', data: { name: 'edit', arguments: JSON.stringify({ path: 'cart.mjs' }) } },
        { type: 'tool/call', data: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
        { type: 'tool/message', data: {} },
      ][at]
    },
  }
  // The parent is read off the child's own header, not off the listener's
  // arguments: the delegating agent rides the dispatch carrier as a scope filter.
  childSession.header = { parentSession: 'parent-1', cwd: '/repo' }
  const registry = childRegistry({ agentOf: id => (id === 'child-1' ? { session: childSession } : undefined) })
  registry.start({ runId: 'run-1', provider: 'in-process', id: 'child-1', local: true })
  registry.end({ runId: 'run-1', provider: 'in-process', id: 'child-1', local: true, stopReason: 'stop', lastAssistantMessage: [{ type: 'text', text: 'added the cart and ran npm test' }] })

  const [child] = registry.list('parent-1')
  assert.deepEqual(child.writes, ['cart.mjs'])
  assert.deepEqual(child.checks, ['npm test'])
  assert.equal(child.reported, 'added the cart and ran npm test')
  assert.match(describeRecord(child), /1 file\(s\): cart\.mjs; it ran npm test; it reported: added the cart/)
  assert.deepEqual(registry.list('someone-else'), [])
})

test('the descriptor is the only source of the model and effort that actually ran', () => {
  const child = childSession([
    { type: 'subagent/descriptor', data: {
      version: 3, mode: 'continuable', provider: 'configured-subagent', label: '修实验室键级发光宿主',
      agentProvider: 'home-5090-strata', agentModel: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl', agentReasoningEffort: 'xhigh',
    } },
    call('k1', 'edit', { path: 'src/lab.mjs' }),
  ])
  assert.deepEqual(descriptorOf(child), {
    label: '修实验室键级发光宿主', mode: 'continuable',
    provider: 'home-5090-strata', model: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl', effort: 'xhigh',
  })
  assert.equal(descriptorOf(undefined), null)
  assert.equal(descriptorOf(childSession([call('k1', 'read', { path: 'x' })])), null)
})

test('the last tool is read from the tail, not the head', () => {
  const child = childSession([
    call('k1', 'read', { path: 'old.mjs' }),
    call('k2', 'bash', { command: 'npm test' }),
  ])
  assert.deepEqual(lastAction(child), { tool: 'bash', target: 'npm test', text: 'bash · npm test', at: null })
})

test('the live snapshot carries the child model, effort and current action', () => {
  const child = childSession([
    { type: 'subagent/descriptor', data: {
      version: 3, mode: 'continuable', provider: 'configured-subagent', label: 'B7 准入校验',
      agentProvider: 'home-5090-strata', agentModel: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl', agentReasoningEffort: 'xhigh',
    } },
    call('k1', 'edit', { path: 'src/a.mjs' }),
    call('k2', 'bash', { command: 'npm test' }),
  ])
  child.header = { parentSession: 'parent-1', cwd: '/repo' }
  const registry = childRegistry({ agentOf: id => (id === 'child-1' ? { session: child } : undefined) })
  registry.start({ runId: 'run-1', provider: 'in-process', id: 'child-1', local: true })
  const [row] = registry.snapshot('parent-1')
  assert.equal(row.childId, 'child-1')
  assert.equal(row.label, 'B7 准入校验')
  assert.equal(row.model, 'qwen3.8-flash-next-unsloth-ud-q4_k_xl')
  assert.equal(row.agentProvider, 'home-5090-strata')
  assert.equal(row.effort, 'xhigh')
  assert.equal(row.state, 'running')
  assert.equal(row.activity.tool, 'bash')
  assert.equal(row.writes.length, 1)
  assert.deepEqual(row.checks, ['npm test'])
  // A settled child keeps its descriptor: the strip still says who did the work.
  registry.end({ runId: 'run-1', provider: 'in-process', id: 'child-1', local: true, stopReason: 'stop' })
  assert.equal(registry.snapshot('parent-1')[0].model, 'qwen3.8-flash-next-unsloth-ud-q4_k_xl')
  assert.equal(registry.list('parent-1')[0].effort, 'xhigh')
})

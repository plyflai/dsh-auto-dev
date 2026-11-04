import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { stubHost } from '../tools/flow.mjs'
import { consent, decisionSource, controlTransition } from '../src/decisions.mjs'
import { foldBoard, boardOf, syncState } from '../src/projection.mjs'
import { envDigest, readEnv } from '../src/env.mjs'

const unit = (id, extra = {}) => ({ id, goal: `交付 ${id}`, scope: ['.'], acceptance: [], ...extra })
const submit = (id, callId, extra = {}) => ({ ...(id ? { unit: id } : {}), outcome: 'complete', summary: '实际检查已通过', next: '查看结果',
  claims: [{ statement: '项目测试通过', execution: { callId } }], ...extra })

async function harness({ project = mkdtempSync(join(tmpdir(), 'dsh-p1-')), tables, sessionId = 'p1-session', checkpoints = false } = {}) {
  const host = stubHost({ cwd: project, tables })
  await apply(host.ctx, { checkpoints })
  const log = []
  const notices = []
  const agent = { id: sessionId, session: { id: sessionId, header: { id: sessionId }, get seq() { return log.length }, eventAt: n => log[n],
    append: async event => { log.push(event); return event } }, followup: async message => { log.push({ type: 'user/message', data: { message } }); return {} } }
  const say = (text, { wrapped = false, kind = 'user' } = {}) => {
    const message = { id: `human-${log.length}`, source: { kind }, role: 'user', content: [{ type: 'text', text }] }
    log.push({ type: 'user/message', data: wrapped ? { message } : message })
  }
  const result = (callId, value, isError = false) => log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError,
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } })
  async function tool(name, args = {}) {
    const callId = `p0-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
    let value, failure
    try { value = await host.tools.get(name).execute(args, { agent, callId, turn: 1 }) } catch (error) { failure = error }
    result(callId, failure ? failure.message : value, Boolean(failure))
    const downstream = { additionalContexts: [] }
    const post = await host.handlers.get('tools/post-execute')({ agent, callId, name, arguments: args }, downstream, async () => downstream)
    notices.push(...(post?.additionalContexts ?? []).filter(row => row.source?.form))
    if (failure) throw failure
    return value
  }
  const exec = command => {
    const callId = `shell-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name: 'bash', arguments: { command } } })
    // Child test runners need their own process context, not node:test's worker channel.
    const { NODE_TEST_CONTEXT: _workerContext, ...commandEnv } = process.env
    try { result(callId, execFileSync('/bin/sh', ['-c', command], { cwd: project, env: commandEnv, encoding: 'utf8', stdio: 'pipe' })) }
    catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      const status = error.signal ? `[killed by signal: ${error.signal}]` : `[exit code: ${error.status}]`
      // DSH reports process exits in text; isError is reserved for tool failures.
      result(callId, `${output}${output.endsWith('\n') ? '' : '\n'}${status}`)
    }
    return callId
  }
  const start = async (extra = {}) => {
    await host.commands.find(row => row.name === 'dsh-auto-dev').handler({ agent, rawInput: `start ${extra.request ?? 'P1 回归'}` })
    return tool('work_start', { request: 'P1 回归', mode: 'do', scope: ['.'], acceptance: ['项目测试通过'], acceptanceMode: 'auto', ...extra })
  }
  const task = () => Object.values(host.tables.tasks).find(row => row.sessionId === sessionId)
  const plan = () => host.tables.plans[task()?.planId]
  const pre = args => host.handlers.get('tools/pre-execute')({ agent, callId: `pre-${log.length}`, name: 'bash', arguments: args }, async () => ({ kind: 'continue' }))
  const board = () => boardOf(syncState({ ...log.reduce(foldBoard, null), sessionId }, { taskFor: () => ({ task: task(), plan: plan() }) }))
  return { host, project, log, agent, notices, tool, exec, start, task, plan, say, result, pre, board }
}



const proof = (id, callId, outcome = 'complete') => ({ ...(id ? { unit: id } : {}), outcome,
  summary: '探针已执行', next: '继续已授权工作', claims: [{ statement: '探针可执行', execution: { callId } }] })
const begin = (h, extra = {}) => h.start({ acceptance: ['探针可执行'], ...extra })
const step = async h => {
  const result = await h.host.handlers.get('agent/pre-step')({ agent: h.agent, messages: [], step: 2 }, async () => ({ kind: 'continue', messages: [] }))
  return result.messages ?? []
}

test('P1 U06: successful span continues without human confirmation; PM still waits', async () => {
  const h = await harness()
  await begin(h)
  await h.tool('work_plan', { operation: 'set', units: [unit('a'), unit('b')] })
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  const first = await h.tool('work_submit', proof('a', h.exec('node -e "console.log(1)"')))
  assert.equal(first.continueAuthorized, true)
  assert.equal(first.waiting, null)
  assert.equal(h.task().state, 'active')
  await h.tool('work_plan', { operation: 'activate', unit: 'b' })
  const last = await h.tool('work_submit', proof('b', h.exec('node -e "console.log(2)"')))
  assert.equal(last.continueAuthorized, false)
  assert.equal(h.task().state, 'closed')
  assert.doesNotMatch(h.host.tools.get('work_submit').description, /END THE TURN|stop after|等.*确认/i)
  const pm = await harness()
  await begin(pm, { acceptanceMode: 'pm' })
  const reviewed = await pm.tool('work_submit', { ...proof(undefined, pm.exec('node -e "console.log(3)"')), deliverable: { kind: 'file', path: 'result.txt' } })
  assert.equal(reviewed.waiting, 'user-review')
  assert.equal(reviewed.continueAuthorized, false)
})

test('P1 U07: planless record batches use existing owners and validate before writing', async () => {
  const h = await harness()
  await begin(h)
  const long = '业务说明'.repeat(140)
  const result = await h.tool('work_control', { operation: 'record', payload: { entries: [
    { kind: 'goal', text: '交付可验证的探针' }, { kind: 'receipt', text: long },
    { kind: 'clarify', asked: Array.from({ length: 4 }, (_, i) => ({ q: `问题${i}` })) },
    { kind: 'alternative', text: '复用现有探针' }, { kind: 'learning', text: '观察到子进程失败码；根因尚未知' },
  ] } })
  assert.equal(result.entries.length, 5)
  assert.equal(h.task().goal, '交付可验证的探针')
  assert.equal(h.task().receipt.text, long)
  assert.equal(h.task().clarify.asked.length, 4)
  assert.equal(h.task().alternatives[0].text, '复用现有探针')
  assert.match(readFileSync(join(h.project, '.auto-dev/memory.json'), 'utf8'), /根因尚未知/)
  assert.equal(h.plan(), undefined)
  // A kind the plugin does not know is read from its fields, not refused.
  const odd = await h.tool('work_control', { operation: 'record', entries: [{ kind: 'goal', text: '收下的目标' }, { kind: 'unknown', text: '一句话' }] })
  assert.equal(odd.entries.length, 2)
  assert.equal(h.task().goal, '收下的目标')
  const legacy = await h.tool('work_control', { operation: 'goal', text: '兼容目标' })
  assert.equal(legacy.goalRevision, 3)
  assert.equal(h.notices.find(row => row.source.form === 'ask').source.data.tone, 'ask')
  assert.equal(h.notices.some(row => row.source.form === 'alternative'), false)
  assert.equal(result.waiting, 'user-answer')
})

test('P1 U07: documented question and legacy q normalize alike; invalid batches write nothing', async () => {
  const stored = []
  for (const field of ['question', 'q']) {
    const h = await harness()
    await begin(h)
    const result = await h.tool('work_control', { operation: 'record', payload: {
      kind: 'clarify', asked: [{ [field]: '导出需要保留历史版本吗？' }], assumption: '先按只导出当前版本实现，已告知用户。',
    } })
    stored.push(h.task().clarify.asked)
    assert.equal(result.waiting, null)
    assert.equal(result.continueAuthorized, true)
    // An empty question is dropped; the rest of the batch still lands.
    await h.tool('work_control', { operation: 'record', entries: [
      { kind: 'goal', text: '照样写入' }, { kind: 'clarify', asked: [{}] },
    ] })
    assert.equal(h.task().goal, '照样写入')
    assert.equal(h.task().clarify.asked.length, 1)
  }
  assert.deepEqual(stored[0], stored[1])
})

test('P1 U07: unresolved questions and choices wait visibly; resolved records continue through both interfaces', async () => {
  for (const planned of [false, true]) for (const legacy of [false, true]) {
    const h = await harness()
    await begin(h)
    if (planned) await h.tool('work_plan', { operation: 'set', units: [unit('a')] })
    const record = (kind, payload) => h.tool('work_control', legacy
      ? { operation: kind, ...payload } : { operation: 'record', payload: { kind, ...payload } })
    const question = '输出位置？'
    const pending = await record('clarify', { asked: [{ question }] })
    assert.equal(pending.waiting, 'user-answer')
    assert.equal(pending.continueAuthorized, false)
    assert.match(pending.tellUser, /输出位置/)
    assert.ok(h.notices.some(row => row.source.form === 'ask' && row.source.data.line.includes(question)))
    let board = h.board()
    assert.equal(board.clarify.waiting, 'user-answer')
    assert.match(board.next, /等待回答.*输出位置/)
    const answered = await record('clarify', { answers: [{ question, answer: '项目根目录' }] })
    assert.equal(answered.waiting, null)
    assert.equal(answered.continueAuthorized, true)
    const assumed = await record('clarify', { asked: [{ q: '文件名？' }], assumption: '使用 output.txt，已告知用户' })
    assert.equal(assumed.waiting, null)
    // A new question must not inherit the old question's continuing assumption.
    assert.equal((await record('clarify', { asked: [{ q: '编码？' }] })).waiting, 'user-answer')
    await record('clarify', { answers: [{ q: '编码？', answer: 'UTF-8' }] })
    // alternative is retired (F-clarify 6b): taken as history, never a card or a wait.
    assert.equal((await record('alternative', { text: '复用已有导出器？' })).waiting, null)
    assert.equal(h.notices.some(row => row.source.form === 'alternative'), false)
    board = h.board()
    assert.equal(board.clarify?.waiting ?? null, null)
    for (const kind of ['goal', 'receipt']) assert.equal((await record(kind, { text: '已说明的普通信息' })).continueAuthorized, true)
    const learning = await h.tool('work_control', legacy ? { operation: 'postmortem', text: '观察到 UTF-8 可用' }
      : { operation: 'record', payload: { kind: 'learning', text: '观察到 UTF-8 可用' } })
    assert.equal(learning.waiting, null)
  }
})

test('P1 U07: alternatives are history only, through both interfaces', async () => {
  for (const planned of [false, true]) for (const legacy of [false, true]) {
    const h = await harness()
    await begin(h)
    if (planned) {
      await h.tool('work_plan', { operation: 'set', units: [unit('a')] })
      await h.tool('work_plan', { operation: 'activate', unit: 'a' })
    }
    h.task().alternatives = [{ text: '历史建议，已说明后继续', at: '2026-10-25T00:00:00Z', by: 'old-session' }]
    assert.equal(h.board().clarify?.waiting ?? null, null)
    assert.doesNotMatch(h.board().next ?? '', /等待选择/)
    const result = await h.tool('work_submit', proof(planned ? 'a' : undefined, h.exec('node -e "console.log(1)"'), 'partial'))
    assert.equal(result.waiting, null)
    assert.equal(result.continueAuthorized, true)
    const record = payload => h.tool('work_control', legacy ? { operation: 'alternative', ...payload }
      : { operation: 'record', payload: { kind: 'alternative', ...payload } })
    assert.equal((await record({ text: '需要选择新方案？' })).waiting, null)
    assert.equal(h.task().alternatives.at(-1).text, '需要选择新方案？')
    assert.equal((await record({ text: '需要选择新方案？', verdict: 'kept' })).waiting, null)
    assert.equal(h.board().clarify?.waiting ?? null, null)
  }
})

test('P1 U07: batch notices describe only the final unresolved question', async () => {
  for (const planned of [false, true]) {
    const h = await harness()
    await begin(h)
    if (planned) await h.tool('work_plan', { operation: 'set', units: [unit('a')] })
    const record = entries => h.tool('work_control', { operation: 'record', entries })
    const waits = () => h.notices.filter(row => ['ask', 'alternative'].includes(row.source.form))
    const question = '保存位置？'
    for (const entries of [
      [{ kind: 'clarify', asked: [{ question }] }, { kind: 'clarify', answers: [{ question, answer: '根目录' }] }],
      [{ kind: 'alternative', text: '复用导出器？' }, { kind: 'alternative', text: '复用导出器？', verdict: 'kept' }],
    ]) {
      const count = waits().length
      const result = await record(entries)
      assert.equal(result.waiting, null)
      assert.equal(result.continueAuthorized, true)
      assert.equal(waits().length, count)
    }
    let count = waits().length
    const result = await record([{ kind: 'clarify', asked: [{ q: '尚未回答的问题？' }] },
      { kind: 'clarify', asked: [{ q: '最终问题？' }] }, { kind: 'alternative', text: '另一个待选方案？' }])
    assert.equal(result.waiting, 'user-answer')
    assert.equal(waits().length, count + 1)
    assert.equal(waits().at(-1).source.data.line, '最终问题？')
    count = waits().length
    assert.equal((await record([{ kind: 'clarify', answers: [{ q: '最终问题？', answer: '已回答' }] }])).waiting, null)
    assert.equal(waits().length, count)
  }
})

test('P1 U08: observed facts carry real provenance, duplicates stay quiet, stale requires fresh proof', async () => {
  const h = await harness()
  await begin(h)
  const callId = h.exec('node -e "console.log(\'http://localhost:4321\')"')
  const args = { operation: 'observe', kind: 'gui', key: 'preview', value: 'http://localhost:4321', callId }
  const value = await h.tool('work_env', args)
  assert.equal(value.source.by, 'execution')
  assert.equal(value.source.callId, callId)
  let env = await readEnv(h.project)
  assert.equal(env.gui[0].status, 'observed')
  assert.match(envDigest(env).gui[0], /observed; execution;/)
  const notices = h.notices.length
  assert.equal((await h.tool('work_env', args)).unchanged, true)
  assert.equal(h.notices.length, notices)
  await h.tool('work_env', { operation: 'stale', key: 'preview' })
  assert.equal(envDigest(await readEnv(h.project)).gui.length, 0)
  // Unsupported observations are kept as candidates, never refused.
  assert.match((await h.tool('work_env', args)).tellUser, /过期.*先记成候选/)
  await h.tool('work_env', { ...args, callId: h.exec('node -e "console.log(\'http://localhost:4321\')"') })
  env = await readEnv(h.project)
  assert.equal(env.gui[0].status, 'observed')
  assert.ok(env.gui[0].history.some(row => row.status === 'stale'))
  assert.match((await h.tool('work_env', { ...args, kind: 'blocked' })).tellUser, /规则要用户确认.*先记成候选/)
  assert.match((await h.tool('work_env', { ...args, value: 'unobserved' })).tellUser, /输出里没有.*先记成候选/)
  assert.match((await h.tool('work_env', { ...args, callId: h.exec('node -e "process.exit(1)"') })).tellUser, /没跑通.*先记成候选/)
  await h.tool('work_env', { operation: 'propose', kind: 'fact', key: 'interpretation', value: 'model guess' })
  assert.equal(envDigest(await readEnv(h.project)).usable, 0)
})

test('P1 U08: user facts need exact human provenance without becoming authorization', async () => {
  const h = await harness()
  await begin(h)
  const quote = '开发端口不是 4322，当前端口为 4321'
  h.say(quote, { kind: 'dsh-auto-dev' })
  const args = { operation: 'observe', kind: 'fact', key: 'port', value: '4321', quote }
  // A plugin notice is not the person: the value stays a candidate.
  assert.match((await h.tool('work_env', args)).tellUser, /先记成候选/)
  assert.equal((await readEnv(h.project)).facts.length, 0)
  h.say(quote)
  await h.tool('work_env', args)
  const env = await readEnv(h.project)
  assert.equal(env.facts[0].source.by, 'user')
  assert.equal(envDigest(env).usable, 1)
  assert.equal(env.facts[0].status, 'observed')
  assert.match((await h.tool('work_env', { ...args, kind: 'lock' })).tellUser, /规则要用户确认.*先记成候选/)
  const old = h.exec('node -e "console.log(9)"')
  await h.tool('work_control', { operation: 'cancel' })
  await begin(h)
  assert.match((await h.tool('work_env', { ...args, quote: undefined, callId: old })).tellUser, /不在本任务里.*先记成候选/)
})

test('F-fix: an incident keeps what was ruled out, the green check and the lesson, and is searched by them', async () => {
  const { remember, readMemory, memoryBrief } = await import('../src/memory.mjs')
  const project = mkdtempSync(join(tmpdir(), 'fix-memory-'))
  remember(project, { kind: 'incident', symptom: '导出为空', ruledOut: '不是权限', check: 'npm test', lesson: '先看时区' })
  const row = readMemory(project).incidents[0]
  assert.deepEqual(row.ruledOut, ['不是权限'])
  assert.equal(row.check, 'npm test')
  assert.equal(memoryBrief(readMemory(project), { query: '时区' }).incidents[0].lesson, '先看时区')
})

test('v16: remember with only text stores a fact, not an incident without a symptom', async () => {
  const h = await harness()
  await begin(h)
  const stored = await h.tool('work_control', { operation: 'remember', text: '热点在 listed() 循环里重复 load；量法 time node src/cli.js list，3.55s→0.13s' })
  assert.equal(stored.kind, 'fact')
})

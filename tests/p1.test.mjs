import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { stubHost } from '../tools/flow.mjs'
import { decisionSource, grantsAction, controlTransition } from '../src/decisions.mjs'
import { foldBoard, boardOf, syncState } from '../src/projection.mjs'
import { envDigest, readEnv } from '../src/env.mjs'
import { observedTier } from '../src/uicheck.mjs'

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


import { failureContext, craftHints } from '../src/craft.mjs'

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
  const before = JSON.stringify(h.host.tables), notices = h.notices.length
  await assert.rejects(h.tool('work_control', { operation: 'record', entries: [{ kind: 'goal', text: '不得写入' }, { kind: 'unknown', text: '错误' }] }), /record kind/)
  assert.equal(JSON.stringify(h.host.tables), before)
  assert.equal(h.notices.length, notices)
  const legacy = await h.tool('work_control', { operation: 'goal', text: '兼容目标' })
  assert.equal(legacy.goalRevision, 2)
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
    const before = JSON.stringify(h.host.tables), notices = h.notices.length
    await assert.rejects(h.tool('work_control', { operation: 'record', entries: [
      { kind: 'goal', text: '不得写入' }, { kind: 'clarify', asked: [{}] },
    ] }), /clarify asked/)
    assert.equal(JSON.stringify(h.host.tables), before)
    assert.equal(h.notices.length, notices)
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
    assert.equal((await record('alternative', { text: '复用已有导出器？' })).waiting, 'user-choice')
    assert.ok(h.notices.some(row => row.source.form === 'alternative' && row.source.data.tone === 'ask'))
    board = h.board()
    assert.equal(board.clarify.waiting, 'user-choice')
    assert.match(board.next, /等待选择.*导出器/)
    assert.equal((await record('alternative', { text: '复用已有导出器', verdict: 'kept' })).waiting, null)
    for (const kind of ['goal', 'receipt']) assert.equal((await record(kind, { text: '已说明的普通信息' })).continueAuthorized, true)
    const learning = await h.tool('work_control', legacy ? { operation: 'postmortem', text: '观察到 UTF-8 可用' }
      : { operation: 'record', payload: { kind: 'learning', text: '观察到 UTF-8 可用' } })
    assert.equal(learning.waiting, null)
  }
})

test('P1 U07: old alternatives remain advisory; both new interfaces mark actual pending choices', async () => {
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
    assert.equal((await record({ text: '需要选择新方案？' })).waiting, 'user-choice')
    assert.equal(h.task().alternatives.at(-1).pending, true)
    assert.equal((await record({ text: '需要选择新方案？', verdict: 'kept' })).waiting, null)
    assert.equal(h.board().clarify?.waiting ?? null, null)
  }
})

test('P1 U07: batch notices describe only the final unresolved question or choice', async () => {
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
    assert.equal((await record([{ kind: 'clarify', answers: [{ q: '最终问题？', answer: '已回答' }] }])).waiting, 'user-choice')
    assert.equal(waits().length, count + 1)
    assert.equal(waits().at(-1).source.data.line, '另一个待选方案？')
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
  await assert.rejects(h.tool('work_env', args), /fresh observation/)
  await h.tool('work_env', { ...args, callId: h.exec('node -e "console.log(\'http://localhost:4321\')"') })
  env = await readEnv(h.project)
  assert.equal(env.gui[0].status, 'observed')
  assert.ok(env.gui[0].history.some(row => row.status === 'stale'))
  await assert.rejects(h.tool('work_env', { ...args, kind: 'blocked' }), /protected rules/)
  await assert.rejects(h.tool('work_env', { ...args, value: 'unobserved' }), /not supported/)
  await assert.rejects(h.tool('work_env', { ...args, callId: h.exec('node -e "process.exit(1)"') }), /successful execution/)
  await h.tool('work_env', { operation: 'propose', kind: 'fact', key: 'interpretation', value: 'model guess' })
  assert.equal(envDigest(await readEnv(h.project)).usable, 0)
})

test('P1 U08: user facts need exact human provenance without becoming authorization', async () => {
  const h = await harness()
  await begin(h)
  const quote = '开发端口不是 4322，当前端口为 4321'
  h.say(quote, { kind: 'auto-dev-v3' })
  const args = { operation: 'observe', kind: 'fact', key: 'port', value: '4321', quote }
  await assert.rejects(h.tool('work_env', args), /user answer|human|not found|source/i)
  h.say(quote)
  await h.tool('work_env', args)
  const env = await readEnv(h.project)
  assert.equal(env.facts[0].source.by, 'user')
  assert.equal(envDigest(env).usable, 1)
  assert.equal(env.facts[0].status, 'observed')
  await assert.rejects(h.tool('work_env', { ...args, kind: 'lock' }), /protected rules/)
  const old = h.exec('node -e "console.log(9)"')
  await h.tool('work_control', { operation: 'cancel' })
  await begin(h)
  await assert.rejects(h.tool('work_env', { ...args, quote: undefined, callId: old }), /evidence window/)
})

test('P1 U09: partial progress is not failure; actual failure method resets with successful check', async () => {
  const h = await harness()
  await begin(h)
  await h.tool('work_plan', { operation: 'set', units: [unit('a', { deliverable: 'result.txt' })] })
  for (let i = 0; i < 3; i++) await h.tool('work_submit', proof('a', h.exec('node -e "console.log(1)"'), 'partial'))
  assert.equal(h.task().pulse.sameDefectCount, 0)
  assert.equal(h.notices.some(row => ['halt', 'unit-blocked'].includes(row.source.form)), false)
  assert.equal((await step(h)).some(row => /停一下|等你拿个主意/.test(JSON.stringify(row))), false)
  writeFileSync(join(h.project, 'probe.cjs'), 'process.exit(1)')
  const command = 'node probe.cjs'
  h.exec(command); h.exec(command)
  let context
  const { collectObservations } = await import('../src/session-log.mjs')
  context = failureContext(collectObservations(h.agent.session).results)
  assert.equal(context.count, 2)
  const messages = await step(h)
  assert.match(JSON.stringify(messages), /最小复现/)
  assert.equal(h.task().state, 'active')
  const repeated = await step(h)
  assert.doesNotMatch(JSON.stringify(repeated), /auto-dev-v3 method debug/)
  writeFileSync(join(h.project, 'probe.cjs'), 'console.log("repaired")')
  h.exec(command)
  assert.equal(failureContext(collectObservations(h.agent.session).results), undefined)
})

test('P1 U09: distinct failure outputs are new evidence, not the same defect', () => {
  const row = (seq, text, exitCode = 1) => ({ name: 'bash', command: 'npm test', seq, exitCode, content: [{ type: 'text', text }] })
  assert.equal(failureContext([row(1, 'missing A'), row(2, 'missing B')]).count, 1)
  assert.equal(failureContext([row(1, 'missing A'), row(2, 'missing A')]).count, 2)
  assert.equal(failureContext([row(1, 'missing A'), row(2, 'passed', 0)]), undefined)
})

test('P1 U09: accepted related proof resets old failures; unrelated success does not; blocked state is truthful', async () => {
  const h = await harness()
  await begin(h)
  await h.tool('work_plan', { operation: 'set', units: [unit('a', { deliverable: '探针' })] })
  const command = 'node -e "process.exit(1)"'
  h.exec(command); h.exec(command)
  const { collectObservations } = await import('../src/session-log.mjs')
  const failure = () => failureContext(collectObservations(h.agent.session).results, h.task().ledger)
  assert.equal(failure().count, 2)
  assert.match(JSON.stringify(await step(h)), /最小复现/)
  h.exec('ls')
  assert.equal(failure().count, 2)
  const progressed = await h.tool('work_submit', proof('a', h.exec('node -e "console.log(\'related probe passed\')"'), 'partial'))
  assert.equal(h.task().pulse.sameDefectCount, 0)
  assert.equal(failure(), undefined)
  assert.doesNotMatch(JSON.stringify(progressed.warnings), /真实执行.*失败/)
  assert.doesNotMatch(JSON.stringify(await step(h)), /method debug/)
  h.exec(command)
  assert.equal(failure().count, 1)
  assert.match(JSON.stringify(await step(h)), /method debug/)
  assert.doesNotMatch(JSON.stringify(await step(h)), /method debug/)
  const blocked = await h.tool('work_submit', proof('a', h.exec('node -e "console.log(\'missing prerequisite\')"'), 'blocked'))
  assert.equal(h.plan().units.find(row => row.id === 'a').state, 'blocked')
  assert.equal(h.task().ledger.at(-1).outcome, 'blocked')
  assert.equal(h.task().state, 'active')
  assert.equal(blocked.waiting, null)
  assert.equal(h.notices.at(-1).source.form, 'unit-blocked')
  assert.equal((await h.tool('work_status', { view: 'board' })).units.find(row => row.id === 'a').state, 'blocked')
  await h.tool('work_plan', { operation: 'state', unit: 'a', state: 'pending' })
  assert.equal(h.plan().units.find(row => row.id === 'a').state, 'pending')
})

test('P1 U10/U11: independent planless methods are useful, deduplicated, and do not demand ledger updates', async () => {
  const h = await harness()
  await begin(h, { request: '优化一下并交接探针' })
  const messages = await step(h)
  const body = JSON.stringify(messages)
  assert.match(body, /一个具体输入/)
  assert.match(body, /调用方/)
  assert.match(body, /回滚路径/)
  const repeated = JSON.stringify(await step(h))
  assert.doesNotMatch(repeated, /auto-dev-v3 method (ambiguity|impact|release)/)
  for (let i = 0; i < 21; i++) h.exec('node -e "console.log(1)"')
  assert.doesNotMatch(JSON.stringify(await step(h)), /settle-up|no-active-unit|补一句简短记录|该交一段/)
  assert.equal(h.task().state, 'active')
  const verification = craftHints({ task: h.task(), changed: true, context: { verification: 'write:10' } })
  assert.ok(verification.some(row => row.key === 'verification' && /最后一次改动/.test(row.line)))
  const seen = new Set(verification.map(row => row.identity))
  assert.equal(craftHints({ task: h.task(), changed: true, seen, context: { verification: 'write:10' } }).length, 0)
  assert.equal(craftHints({ task: h.task(), changed: true, seen, context: { verification: 'write:11' } }).length, 1)
})

test('P1 U09: the same command failing again is one debug hint until it passes', () => {
  const row = (seq, exitCode = 1, command = 'npm test') => ({ name: 'bash', command, seq, exitCode, content: [{ type: 'text', text: exitCode ? 'missing A' : 'ok' }] })
  const identity = rows => craftHints({ failure: failureContext(rows) }).find(page => page.key === 'debug')?.identity
  const first = identity([row(1)])
  assert.equal(identity([row(1), row(2), row(3)]), first)
  assert.notEqual(identity([row(1), row(2, 0), row(3)]), first)
  assert.notEqual(identity([row(1), row(2, 1, 'npm run lint')]), first)
})

test('P1 U10: real write results trigger verification through pre-step, once per submission', async () => {
  const h = await harness()
  const write = (text, refused = false) => {
    const callId = `write-${h.log.length}`
    h.log.push({ type: 'tool/call', data: { callId, name: 'write', arguments: { file_path: join(h.project, 'probe.txt'), content: text } } })
    if (!refused) writeFileSync(join(h.project, 'probe.txt'), text)
    h.result(callId, refused ? 'auto-dev-v3: refused before execution' : 'written', refused)
  }
  write('before task')
  await begin(h)
  const verification = async () => (await step(h)).filter(row => row.source?.data?.title === '方法提示 · verification')
  assert.equal((await verification()).length, 0)
  write('refused', true)
  assert.equal((await verification()).length, 0)
  write('first change')
  assert.equal((await verification()).length, 1)
  assert.equal((await verification()).length, 0)
  h.exec('node --version')
  assert.equal((await verification()).length, 0)
  // More writes before anything is submitted are the same stretch of work.
  for (const text of ['next change', 'and another', 'and one more']) {
    write(text)
    assert.equal((await verification()).length, 0)
  }
  assert.equal(h.task().state, 'active')
  assert.equal(h.plan(), undefined)
})


for (const loggedBeforePost of [false, true]) test(`P1 verification counts current writes once (result logged first: ${loggedBeforePost})`, async () => {
  const h = await harness()
  await begin(h)
  const write = async (i, refused, failed = false) => {
    const args = { path: join(h.project, 'count.txt'), content: String(i) }
    const callId = `write-${h.log.length}`
    h.log.push({ type: 'tool/call', data: { callId, name: 'write', arguments: args } })
    if (!refused) writeFileSync(args.path, args.content)
    const text = refused ? 'auto-dev-v3: refused before execution' : failed ? 'failed after partial write' : 'written'
    const result = { isError: refused || failed, content: [{ type: 'text', text }], ...(refused || failed ? { error: { message: text } } : { value: 'written' }) }
    if (loggedBeforePost) h.result(callId, text, refused || failed)
    const downstream = { additionalContexts: [] }
    const post = await h.host.handlers.get('tools/post-execute')({ agent: h.agent, callId, name: 'write', arguments: args }, result, async () => downstream)
    if (!loggedBeforePost) h.result(callId, text, refused || failed)
    return (post.additionalContexts ?? []).filter(row => /no check after/.test(row.source?.summary ?? ''))
  }
  for (let i = 0; i < 6; i++) assert.equal((await write(i, true)).length, 0)
  for (let i = 0; i < 4; i++) assert.equal((await write(i, false, i % 2 === 0)).length, 0)
  const notices = await write(5, false, true)
  assert.equal(notices.length, 1)
  assert.match(notices[0].content[0].text, /改了 5 次文件/)
  assert.equal((await write(6, false)).length, 0)
})

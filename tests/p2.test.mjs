import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { stubHost } from '../tools/flow.mjs'
import { foldBoard, boardOf, syncState } from '../src/projection.mjs'
import { readMemory, remember, memoryBrief, relatedRows } from '../src/memory.mjs'

const unit = (id, extra = {}) => ({ id, goal: `交付 ${id}`, scope: ['.'], acceptance: [], ...extra })
const submit = (id, callId, extra = {}) => ({ ...(id ? { unit: id } : {}), outcome: 'complete', summary: '实际检查已通过', next: '查看结果',
  claims: [{ statement: '项目测试通过', execution: { callId } }], ...extra })

async function harness({ project = mkdtempSync(join(tmpdir(), 'dsh-p2-')), tables, sessionId = 'p2-session', checkpoints = false } = {}) {
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
  const start = async ({ forceNew = false, ...extra } = {}) => {
    await host.commands.find(row => row.name === 'dsh-auto-dev').handler({ agent, rawInput: `${forceNew ? 'new' : 'start'} ${extra.request ?? 'P2 回归'}` })
    return tool('work_start', { request: 'P2 回归', mode: 'do', scope: ['.'], acceptance: ['项目测试通过'], acceptanceMode: 'auto', ...extra })
  }
  const task = () => Object.values(host.tables.tasks).filter(row => row.sessionId === sessionId).at(-1)
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

test('P2 new build normalizes to do, optional plan does not bypass existing leaves or PM acceptance', async () => {
  const h = await harness()
  const started = await h.start({ mode: 'build' })
  assert.equal(started.mode, 'do')
  assert.equal(started.gates.plan, false)
  assert.equal(h.task().mode, 'do')
  await h.tool('work_submit', submit(null, h.exec('node -e "console.log(1)"')))
  assert.equal(h.task().state, 'closed')
  const completion = h.notices.find(row => row.source.form === 'task-done')
  assert.ok(completion)
  assert.equal('unit' in completion.source.data, false)
  // Host finalization snapshots post-execute additionalContexts, not just the tool value.
  assert.deepEqual(JSON.parse(JSON.stringify(completion)), completion)
  await h.start({ mode: 'do', acceptanceMode: 'pm', plan: { units: [unit('a'), unit('b')] } })
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
  assert.equal(h.task().state, 'active')
  assert.equal(h.plan().units.find(row => row.id === 'b').state, 'pending')
  await h.tool('work_plan', { operation: 'activate', unit: 'b' })
  await h.tool('work_submit', submit('b', h.exec('node -e "console.log(1)"'), { deliverable: '真实探针结果' }))
  assert.equal(h.task().state, 'review_ready')
})

test('P2 historical build stays raw build and behaves as do without mandatory plan', async () => {
  const h = await harness()
  await h.start()
  h.task().mode = 'build' // record from a pre-P2 host; do not rewrite persisted history
  const summary = await h.tool('work_status')
  const legacy = await h.tool('work_control', { operation: 'status' })
  assert.equal(summary.task.mode, 'build')
  assert.equal(summary.task.effectiveMode, 'do')
  assert.equal(legacy.mode, 'build')
  assert.equal(legacy.effectiveMode, 'do')
  assert.equal(h.board().lane, '交付（历史 build）')
  await h.tool('work_submit', submit(null, h.exec('node -e "console.log(1)"')))
  assert.equal(h.task().mode, 'build')
  assert.equal(h.task().state, 'closed')
})

test('P2 status owners agree on grouped leaves, waiting and legacy return shapes', async () => {
  const h = await harness()
  await h.start({ plan: { units: [unit('a'), unit('b', { state: 'blocked' })] } })
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
  await h.tool('work_plan', { operation: 'group', unit: 'g', text: '交付组', members: ['a', 'b'] })
  await h.tool('work_control', { operation: 'record', payload: { kind: 'clarify', asked: [{ question: '谁提供外部条件？' }] } })
  const status = await h.tool('work_status')
  const control = await h.tool('work_control', { operation: 'status' })
  const board = await h.tool('work_status', { view: 'board' })
  assert.deepEqual(status.progress, { done: 1, total: 2, label: '1/2' })
  assert.deepEqual(control.progress, status.progress)
  assert.equal(control.units, 2)
  assert.equal(control.unitRows.length, 3)
  assert.deepEqual(control.pending, status.pending)
  assert.equal(status.pending.waiting, 'user-answer')
  assert.deepEqual(board.progress, status.progress)
  assert.equal(board.task.mode, status.task.mode)
  assert.equal(board.units.find(row => row.id === 'b').state, 'blocked')
  assert.equal(h.board().counting.label, '1/2')
  const command = await h.host.commands.find(row => row.name === 'dsh-auto-dev').handler({ agent: h.agent, rawInput: 'status' })
  assert.match(JSON.stringify(command), /1\/2/)
})

test('P2 public schemas expose ask and goal while seven tools remain discoverable', async () => {
  const h = await harness()
  await h.start({ mode: 'look' })
  assert.equal(h.host.tools.size, 7)
  assert.ok(h.host.tools.get('work_plan').parameters.properties.operation.enum.includes('ask'))
  assert.ok(h.host.tools.get('work_control').parameters.properties.operation.enum.includes('goal'))
  for (const tool of h.host.tools.values()) {
    assert.ok(tool.description.length > 0)
    assert.ok(tool.description.length < 650)
  }
  await h.tool('work_control', { operation: 'goal', text: '查看真实运行结果' })
  assert.equal(h.task().goal, '查看真实运行结果')
  assert.equal(h.board().lane, '查看（只读意图）')
})

test('P2 knowledge separates new engineering learning, old history, business and temporary task records', async () => {
  const project = mkdtempSync(join(tmpdir(), 'dsh-p2-knowledge-'))
  mkdirSync(join(project, '.auto-dev'))
  const legacyText = '旧复盘：只作历史，不证明当前环境。'
  writeFileSync(join(project, '.auto-dev/postmortem.md'), legacyText)
  const h = await harness({ project })
  await h.start({ request: '查缓存问题' })
  await h.tool('work_control', { operation: 'record', payload: { kind: 'learning', symptom: '缓存偶发为空', cause: '未知，仍在排查', finding: '检查复现一次' } })
  await h.tool('work_control', { operation: 'postmortem', symptom: '缓存偶发为空', cause: '未知，仍在排查', change: '追加诊断日志' })
  await h.tool('work_control', { operation: 'remember', target: 'domain', payload: { kind: 'term', key: '缓存账期', text: '缓存账期按自然日结算', quote: '账期按自然日结算' } })
  await h.tool('work_control', { operation: 'record', payload: { kind: 'receipt', text: '只处理今天的探针' } })
  const memory = readMemory(project)
  assert.equal(memory.incidents.length, 1)
  assert.equal(memory.incidents[0].status, 'observation')
  assert.equal(memory.incidents[0].mechanism, undefined)
  assert.match(memory.incidents[0].hypothesis, /未知/)
  assert.match(memory.incidents[0].repair, /诊断/)
  assert.equal(readFileSync(join(project, '.auto-dev/postmortem.md'), 'utf8'), legacyText)
  assert.match(readFileSync(join(project, '.auto-dev/project-domain.md'), 'utf8'), /缓存账期/)
  assert.equal(JSON.stringify(memory).includes('只处理今天'), false)
  const later = await harness({ project, tables: h.host.tables, sessionId: 'p2-later' })
  const next = await later.start({ request: '继续核对缓存账期', forceNew: true })
  const text = JSON.stringify(next)
  assert.match(text, /缓存偶发为空/)
  assert.match(text, /observation/)
  assert.match(text, /缓存账期/)
  assert.match(text, /legacy-unverified/)
})

test('P2 relevant deduplicated memory ranks matching older facts before unrelated recent rows', () => {
  const rows = [{ text: 'checkout uses pnpm' }, { text: 'checkout uses pnpm' }, { text: 'unrelated theme' }, { text: 'newer unrelated font' }]
  assert.deepEqual(relatedRows(rows, { query: 'checkout', limit: 2 }).map(row => row.text), ['checkout uses pnpm', 'newer unrelated font'])
  const project = mkdtempSync(join(tmpdir(), 'dsh-p2-memory-'))
  remember(project, { kind: 'incident', symptom: '启动卡住', mechanism: '未知' })
  assert.equal(remember(project, { kind: 'incident', symptom: '启动卡住', mechanism: '未知' }).stored, false)
  assert.match(JSON.stringify(memoryBrief(readMemory(project))), /observation/)
})

test('P2 learning and legacy postmortem preserve uncertain causes in later task summaries', async () => {
  const h = await harness()
  await h.start()
  const causes = ['目前根因未知', '缓存问题，原因未知', 'we do not know yet', 'the cause may be cache']
  for (const operation of ['record', 'postmortem']) {
    for (const [index, cause] of causes.entries()) {
      await h.tool('work_control', { operation, payload: { ...(operation === 'record' ? { kind: 'learning' } : {}), symptom: `缓存异常 ${operation} ${index}`, cause } })
      const saved = readMemory(h.project).incidents.at(-1)
      assert.equal(saved.status, 'observation')
      assert.equal(saved.mechanism, undefined)
      assert.equal(saved.hypothesis, cause)
    }
  }
  const later = await h.start({ request: '再次排查缓存异常', forceNew: true })
  assert.equal(later.memory.incidents.length > 0, true)
  for (const row of later.memory.incidents) {
    assert.equal(row.status, 'observation')
    assert.equal(row.mechanism, undefined)
    assert.equal(causes.includes(row.hypothesis), true)
  }
})

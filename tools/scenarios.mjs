/**
 * Scenario bench: drive the real plugin through every state a person would see,
 * and record the receipts (bars/cards) it produces.
 *
 * Two audiences:
 *   node tools/scenarios.mjs                 → run everything, print a table, write design/scenarios.json
 *   node tools/scenarios.mjs --only S03,S07  → run a subset (subagents work this way)
 *
 * A scenario is a function. The harness hands it `host` helpers; whatever it did
 * is reported as `forms` (in order) plus the final board. A scenario declares the
 * forms it must produce; the runner compares and exits non-zero on a miss.
 */
import { boardOf, foldBoard, syncState } from '../src/projection.mjs'
import { execFileSync } from 'node:child_process'
import '../tests/env.mjs'
import assert from 'node:assert/strict'
import { setMarks } from '../src/disk.mjs'
import { CONSENT_NO, CONSENT_YES } from '../src/decisions.mjs'
import { inventory, PANEL_KEYS } from './inventory.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { stubHost } from './flow.mjs'
import { readEnv } from '../src/env.mjs'
import { rememberDomain } from '../src/domain.mjs'
import { readMemory, remember as rememberIncident } from '../src/memory.mjs'
import { fillsIn } from './fills.mjs'

const formsOf = message => message?.source?.form

function agentFor(state) {
  return {
    id: `agent-${state.sessionId}`,
    session: {
      id: state.sessionId,
      header: { id: state.sessionId },
      get seq() { return state.log.length },
      eventAt: index => state.log[index],
      // The host's shape: append(type, data, intent). A dsh-auto-dev card written
      // straight into the log is drawn like any other.
      append: async (type, data) => {
        const event = typeof type === 'string' ? { type, data } : type
        state.log.push(event)
        if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-auto-dev') state.appended?.(event.data)
        return event
      },
    },
    followup: async message => { state.log.push({ type: 'user/message', data: { message } }); return {} },
  }
}

// Call ids unique across the whole bench: the plugin keeps per-call facts (src/disk.mjs) by id.
let opened = 0
async function open({ project, sessionId, checkpoints = false, tables }) {
  const host = stubHost({ cwd: project, ...(tables ? { tables } : {}) })
  await apply(host.ctx, { checkpoints })
  const state = { project, sessionId, log: [], tables: host.tables, grants: [], commands: [], run: ++opened }
  return { host, state }
}

function helpers(host, state) {
  const receipts = []
  const hints = []
  const calls = []
  const trace = []
  const collect = message => {
    trace.push({ message })
    const form = formsOf(message)
    if (message.source?.summary?.startsWith('dsh-auto-dev')) hints.push({
      summary: message.source.summary,
      text: (message.content ?? []).map(part => part.text ?? '').join(''),
    })
    if (!form) return
    receipts.push({ form, title: message.source.data?.title ?? '', line: message.source.data?.line ?? '', tag: message.source.data?.tag ?? '', ...(message.source.data?.warnings ? { warnings: message.source.data.warnings } : {}), text: Array.isArray(message.content) ? message.content.map(p => p.text ?? '').join('') : String(message.content ?? '') })
  }
  const agent = () => agentFor(state)
  state.appended = message => collect(message)
  return {
    trace,
    receipts,
    hints,
    calls,
    state,
    host,
    async cmd(rawInput, { deliverFollowup = false } = {}) {
      const verb = String(rawInput).trim().split(/\s+/)[0] || 'status'
      state.commands.push(verb)
      const command = host.commands.find(entry => entry.name === 'dsh-auto-dev')
      if (!command) throw new Error('the command is not registered')
      const followups = []
      const commandAgent = deliverFollowup ? {
        ...agent(),
        followup: message => {
          const pending = (async () => {
            state.log.push({ type: 'user/message', data: { message } })
            const preStep = host.handlers.get('agent/pre-step')
            const decision = await preStep({ agent: agent(), messages: [message], step: 1 },
              async () => ({ kind: 'continue', messages: [message] }))
            for (const extra of decision?.messages ?? []) if (extra !== message) collect(extra)
          })()
          followups.push(pending)
          return pending
        },
      } : { ...agent(), followup: async () => ({}) }
      const result = await command.handler({ agent: commandAgent, rawInput })
      await Promise.all(followups)
      // The real host splices the request in as the person's message (v31 #10); it is not a reply.
      const request = String(rawInput).trim().replace(/^(start|new)\s+/, '')
      if (/^(start|new)\s+\S/.test(String(rawInput).trim())) {
        state.log.push({ type: 'user/message', data: { message: { id: `m-${state.log.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: request }] } } })
      }
      if (/^(start|new)\b/.test(String(rawInput).trim())) state.grants.push(rawInput)
      return result
    },
    // The model ends its turn on `text`: the host's turn-stopping, with what the plugin steers back.
    async stop(text) {
      state.log.push({ type: 'assistant/message', data: { turn: 1, step: state.log.length, message: { role: 'assistant', content: [{ type: 'text', text }] } } })
      const steered = []
      await host.handlers.get('agent/turn-stopping')({ agent: { ...agent(), steer: message => { steered.push(message); collect(message) } },
        turn: 1, signal: new AbortController().signal })
      return steered
    },
    async tool(name, args = {}) {
      const definition = host.tools.get(name)
      if (!definition) throw new Error(`tool ${name} is not offered (not opted in?)`)
      calls.push({ name, args })
      const callId = `call-${state.run}-${name}-${state.log.length}`
      state.log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
      let value
      let failure
      try { value = await definition.execute(args, { agent: agent(), callId, turn: 1 }) } catch (error) { failure = error }
      trace.push({ tool: name, ...(failure ? { error: failure.message } : { value }) })
      state.log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: Boolean(failure),
        content: [{ type: 'text', text: failure ? failure.message : JSON.stringify(value) }] } } })
      const post = host.handlers.get('tools/post-execute')
      if (post) {
        const downstream = { additionalContexts: [] }
        const out = await post({ agent: agent(), name, arguments: args, callId }, downstream, async () => downstream)
        for (const message of out?.additionalContexts ?? []) {
          assert.deepEqual(JSON.parse(JSON.stringify(message)), message, 'tool notice must survive host JSON finalization')
          collect(message)
        }
      }
      if (failure) throw failure
      return value
    },
    // The model registers its restatement once the request is clear (F-clarify 6b). The start brief
    // arrives in the tool result; it is kept with the hints because that is what the model reads.
    async register(request) {
      const value = await this.tool('work_start', { request })
      hints.push({ summary: 'dsh-auto-dev start brief', text: [value.tellUser, ...(value.brief ?? []), value.envLine ?? ''].filter(Boolean).join('\n') })
      return value
    },
    // The person picks one of a hard gate's two fixed options on a question card.
    async pick(label) {
      const callId = `pick-${state.log.length}`
      state.log.push({ type: 'tool/call', data: { callId, name: 'ask_user_question', arguments: { questions: [{ id: 'gate', question: '要做这一步吗？', options: [{ label: CONSENT_YES }, { label: CONSENT_NO }] }] } } })
      state.log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'gate', selected: [label] }] }) }] } } })
    },
    async say(text) {
      const message = { id: `m-${state.log.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
      state.log.push({ type: 'user/message', data: message })
      const handlers = [...host.handlers.entries()].filter(([event]) => event === 'agent/pre-step')
      for (const [, handler] of handlers) {
        const decision = await handler({ agent: agent(), messages: [message], step: 1 }, async () => ({ kind: 'continue', messages: [message] }))
        for (const extra of decision?.messages ?? []) if (extra !== message) collect(extra)
      }
    },
    async step() {
      const handlers = [...host.handlers.entries()].filter(([event]) => event === 'agent/pre-step')
      for (const [, handler] of handlers) {
        const decision = await handler({ agent: agent(), messages: [], step: 2 }, async () => ({ kind: 'continue', messages: [] }))
        for (const extra of decision?.messages ?? []) collect(extra)
      }
    },
    async exec(command) {
      const callId = `call-${state.run}-bash-${state.log.length}`
      state.log.push({ type: 'tool/call', data: { callId, name: 'bash', arguments: { command } } })
      const { NODE_TEST_CONTEXT: _workerContext, ...commandEnv } = process.env
      let output, failure
      try { output = execFileSync('/bin/sh', ['-c', command], { cwd: state.project, env: commandEnv, encoding: 'utf8', stdio: 'pipe' }) }
      catch (error) { failure = error; output = `${error.stdout ?? ''}${error.stderr ?? ''}` }
      if (failure) {
        const status = failure.signal ? `[killed by signal: ${failure.signal}]` : `[exit code: ${failure.status}]`
        output = `${output}${output.endsWith('\n') ? '' : '\n'}${status}`
      }
      state.log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: output }] } } })
      const post = host.handlers.get('tools/post-execute')
      if (post) {
        const downstream = { additionalContexts: [] }
        const out2 = await post({ agent: agent(), name: 'bash', arguments: { command }, callId }, downstream, async () => downstream)
        for (const message of out2?.additionalContexts ?? []) collect(message)
      }
      return callId
    },
    /** A file tool write (structured path), as the host reports it after it ran. */
    async write(path, content) {
      const callId = `call-${state.run}-write-${state.log.length}`
      const args = { path: join(state.project, path), content }
      state.log.push({ type: 'tool/call', data: { callId, name: 'write', arguments: args } })
      // The real host runs pre-execute first: that is where an unregistered start is registered.
      await host.handlers.get('tools/pre-execute')?.({ agent: agent(), callId, name: 'write', arguments: args }, async () => ({ kind: 'continue' }))
      writeFileSync(args.path, content)
      state.log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: 'ok' }] } } })
      const downstream = { additionalContexts: [] }
      const out = await host.handlers.get('tools/post-execute')({ agent: agent(), name: 'write', arguments: args, callId }, downstream, async () => downstream)
      for (const message of out?.additionalContexts ?? []) collect(message)
      return callId
    },
    async pre(command, name = 'bash') {
      const args = typeof command === 'string' ? { command } : command
      return host.handlers.get('tools/pre-execute')({ agent: agent(), callId: `pre-${state.log.length}`, name, arguments: args }, async () => ({ kind: 'continue' }))
    },
    async board() {
      const value = await host.tools.get('work_status').execute({ view: 'board' }, { agent: agent(), callId: `call-status-${state.log.length}`, turn: 1 })
      return value
    },
  }
}

const plan = (extra = {}) => ({
  units: [
    { id: 'b1', goal: '导出按钮', scope: ['.'], acceptance: ['点了有文件'], deliverable: '导出按钮能点', ...extra },
    { id: 'b2', goal: '列顺序', scope: ['.'], acceptance: ['和页面一致'] },
  ],
})

const scenarios = []
const add = (id, title, must, run, options = {}) => scenarios.push({ id, title, must, run, ...options })

add('S01', '接单：look 模式，没有卡片', [], async h => {
  await h.cmd('start 看看这个仓库的导出链路')
  await h.tool('work_start', { request: '看看这个仓库的导出链路', mode: 'look', scope: ['.'], acceptance: ['说清链路'] })
})
add('S02', '立主题', ['theme-open'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 't1', goal: '导出', units: [
      { id: 'b1', goal: '按钮', scope: ['.'], acceptance: ['能点'] },
      { id: 'b2', goal: '列顺序', scope: ['.'], acceptance: ['一致'] },
    ] },
  ] })
})
add('S03', '单元开始（带交付物）', ['unit-start'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: plan().units })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
})
add('S04', '单元带 kind 只是标签：激活不出关键词卡（第三条路：语义归模型）', ['unit-open'], async h => {
  await h.cmd('start 重构导出并回归')
  await h.tool('work_start', { request: '重构导出并回归', mode: 'do', scope: ['.'], acceptance: ['旧行为不变'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '重构导出', kind: 'refactor', scope: ['src/export.js'], acceptance: ['旧接口不变'] },
    { id: 'b2', goal: '回归', kind: 'verification', scope: ['.'], acceptance: ['旧接口全过'] },
  ] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  await h.tool('work_plan', { operation: 'activate', unit: 'b2' })
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').length, 0, 'kind 不触发方法卡')
})
add('S05', '完成 + 收案 + 看一眼', ['unit-done', 'review'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '导出按钮', scope: ['.'], acceptance: ['能点'], deliverable: '按钮能点' },
    { id: 'b2', goal: '列顺序', scope: ['.'], acceptance: ['一致'] },
  ] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const one = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'complete', summary: '按钮能点', next: '做列顺序', claims: [{ statement: '跑了脚本', execution: { callId: one } }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b2' })
  const two = await h.exec('node -e "console.log(2)"')
  await h.tool('work_submit', { unit: 'b2', outcome: 'complete', summary: '列顺序一致', next: '收尾', claims: [{ statement: '跑了脚本', execution: { callId: two } }] })
  await h.step()
})
add('S06', '没通过', ['unit-blocked'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出按钮', scope: ['.'], acceptance: ['能点'], deliverable: '按钮能点' }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const ran = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'blocked', summary: '按钮点了没反应', next: '查事件绑定', claims: [{ statement: '跑了一遍，界面没反应', execution: { callId: ran } }] })
  assert.equal((await h.board()).units.find(row => row.id === 'b1').state, 'blocked')
  assert.equal((await h.board()).task.state, 'active')
})
add('S07', '等你回答 + 默认开工', ['ask'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: plan().units })
  await h.tool('work_plan', { operation: 'ask', unit: 'b2', text: '导出文件放浏览器下载，还是存到项目目录？' })
})
add('S08', '记住一条业务事实', ['remember'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_control', { operation: 'remember', payload: { kind: 'fact', text: '导出文件只放仓库 outputs/' } })
})
add('S09', '记环境 + 环境更新', ['env', 'env-forget'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_env', { operation: 'propose', kind: 'fact', key: 'start', value: 'npm run dev :3000' })
  await h.say('确认 start 使用 npm run dev :3000')
  await h.tool('work_env', { operation: 'confirm', key: 'start', value: 'npm run dev :3000', note: '确认 start 使用 npm run dev :3000' })
  await h.tool('work_env', { operation: 'forget', key: 'start' })
})
add('S10', '整理提案 + 已整理', ['organize-proposed', 'organize-done'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '按钮', scope: ['.'], acceptance: ['能点'] },
    { id: 'b2', goal: '列顺序', scope: ['.'], acceptance: ['一致'] },
  ] })
  await h.cmd('organize')
  const proposal = await h.tool('work_plan', { operation: 'organize', action: 'propose' })
  const approval = `同意整理提案 ${proposal.proposalId}`
  await h.say(approval)
  await h.tool('work_plan', { operation: 'organize', action: 'apply', proposalId: proposal.proposalId, approval, steps: [{ kind: 'group', theme: 't1', label: '导出', members: ['b1', 'b2'] }] })
})
add('S11', '完成任务', ['task-done'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'], acceptanceMode: 'auto' })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能导'] }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const callId = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { outcome: 'complete', summary: '能导了', next: '收尾', claims: [{ statement: '跑了', execution: { callId } }] })
})
add('S12', '更好的做法在对话里问（F-clarify 6b）：旧的 alternative 调用照收、只记历史，不出卡、不挂等待', [], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  const told = await h.tool('work_control', { operation: 'alternative', text: '先复用现有导出器，只补两种格式' })
  assert.equal(told.waiting, null)
  assert.equal(h.receipts.some(row => row.form === 'alternative'), false)
  assert.equal(Object.values(h.host.tables.tasks)[0].alternatives.length, 1)
})
add('S15', '收案（人看了一眼说可以）', ['review-done'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能导'], deliverable: '能导出文件' }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const ran = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'complete', summary: '能导了', next: '收尾', claims: [{ statement: '跑了', execution: { callId: ran } }] })
  await h.step()
  // 人的一句话是决定：pre-step 只把它交给模型，状态由 work_control 改。
  await h.say('验收通过，收下这一版')
  await h.tool('work_control', { operation: 'accept', text: '验收通过，收下这一版' })
})

add('S16', '按意见改（人看了一眼说不对）', ['review-revise'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能导'], deliverable: '能导出文件' }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const ran = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'complete', summary: '能导了', next: '收尾', claims: [{ statement: '跑了', execution: { callId: ran } }] })
  await h.step()
  await h.say('列宽不对，按默认宽度再调一版')
  await h.tool('work_control', { operation: 'rework', text: '列宽不对，按默认宽度再调一版' })
})

add('S17', '交接（另一个会话接手）', ['handoff'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能导'] }] })
  await h.tool('work_control', { operation: 'pause', reason: '先去吃饭' })
  // Second window, same records: the person says "继续" in another session.
  const second = await open({ project: h.state.project, sessionId: 'session-other', tables: h.host.tables })
  const other = helpers(second.host, second.state)
  const said = await other.cmd('adopt')
  // The second window has its own command log; coverage is about what the plugin
  // offers, so its verbs count for this scenario too.
  for (const verb of other.state.commands) h.state.commands.push(verb)
  if (process.env.SCN_DEBUG) console.log('  S17 command →', JSON.stringify(said).slice(0, 200))
  await other.step()
  if (process.env.SCN_DEBUG) console.log('  S17 receipts →', JSON.stringify(other.receipts.map(r => r.form)))
  for (const receipt of other.receipts) h.receipts.push(receipt)
})

add('S18', '日需桶：5 个散件 + 1 个主题', ['theme-open'], async h => {
  await h.cmd('start 一小堆杂活')
  await h.tool('work_start', { request: '一小堆杂活', mode: 'do', scope: ['.'], acceptance: ['都做完'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'a1', goal: '修错别字', scope: ['.'], acceptance: ['改对'] },
    { id: 'a2', goal: '补日志', scope: ['.'], acceptance: ['有日志'] },
    { id: 'a3', goal: '换颜色', scope: ['.'], acceptance: ['看着顺'] },
    { id: 'a4', goal: '加注释', scope: ['.'], acceptance: ['能看懂'] },
    { id: 'a5', goal: '删死代码', scope: ['.'], acceptance: ['没引用报错'] },
  ] })
  await h.tool('work_plan', { operation: 'group', unit: 't1', text: '导出', members: ['a1', 'a2'] })
})

add('S19', '面板：日需桶不报未分组、主题计数只数战役', ['theme-open'], async h => {
  await h.cmd('start 一小堆杂活再加一个主题')
  await h.tool('work_start', { request: '一小堆杂活再加一个主题', mode: 'do', scope: ['.'], acceptance: ['都做完'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'a1', goal: '修错别字', scope: ['.'], acceptance: ['改对'] },
    { id: 'a2', goal: '补日志', scope: ['.'], acceptance: ['有日志'] },
    { id: 'a3', goal: '换颜色', scope: ['.'], acceptance: ['看着顺'] },
    { id: 'a4', goal: '加注释', scope: ['.'], acceptance: ['能看懂'] },
    { id: 'a5', goal: '删死代码', scope: ['.'], acceptance: ['没引用报错'] },
    { id: 'a6', goal: '补 README', scope: ['.'], acceptance: ['能跑'] },
  ] })
  await h.tool('work_plan', { operation: 'group', unit: 't1', text: '导出', members: ['a1', 'a2'] })
  const shown = await h.board()
  const daily = (shown.milestones ?? []).find(group => group.role === 'daily')
  if (!daily) throw new Error('日需桶没画出来')
  if (daily.label !== '日需') throw new Error(`日需桶的标题是 ${daily.label}`)
})

add('S20', '面板：没有主题也不报未分组（只有日需桶）', [], async h => {
  await h.cmd('start 一堆散件')
  await h.tool('work_start', { request: '一堆散件', mode: 'do', scope: ['.'], acceptance: ['都做完'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'a1', goal: '修错别字', scope: ['.'], acceptance: ['改对'] },
    { id: 'a2', goal: '补日志', scope: ['.'], acceptance: ['有日志'] },
    { id: 'a3', goal: '换颜色', scope: ['.'], acceptance: ['看着顺'] },
    { id: 'a4', goal: '加注释', scope: ['.'], acceptance: ['能看懂'] },
    { id: 'a5', goal: '删死代码', scope: ['.'], acceptance: ['没引用报错'] },
    { id: 'a6', goal: '补 README', scope: ['.'], acceptance: ['能跑'] },
  ] })
  const listed = await h.tool('work_plan', { operation: 'list' })
  const dailyRow = (listed.units ?? []).find(row => row.id === 'daily')
  if (process.env.SCN_DEBUG) console.log('  S20 plan row →', JSON.stringify(dailyRow))
  const shown = await h.board()
  const campaigns = (shown.milestones ?? []).filter(group => group.role !== 'daily')
  if (campaigns.length !== 0) throw new Error(`不该有战役主题，却有 ${campaigns.length} 个: ${JSON.stringify((shown.milestones ?? []).map(g => ({ id: g.id, role: g.role, label: g.label })))}`)
})

add('S21', '主题收束：最后一个子单元落地', ['theme-open', 'theme-seal'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 't1', goal: '导出', units: [
      { id: 'b1', goal: '按钮', scope: ['.'], acceptance: ['能点'] },
      { id: 'b2', goal: '列顺序', scope: ['.'], acceptance: ['一致'] },
    ] },
  ] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const one = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'complete', summary: '按钮能点', next: '做列顺序', claims: [{ statement: '跑了脚本', execution: { callId: one } }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b2' })
  const two = await h.exec('node -e "console.log(2)"')
  await h.tool('work_submit', { unit: 'b2', outcome: 'complete', summary: '列顺序一致', next: '收尾', claims: [{ statement: '跑了脚本', execution: { callId: two } }] })
})

add('S22', '面板：交付 / 等你 / 存档 / 回执 / 目标版本都上板', ['ask', 'remember'], async h => {
  await h.cmd('start 做一个导出，顺手记两条')
  await h.tool('work_start', { request: '做一个导出，顺手记两条', mode: 'do', goal: '做一个能导出的页面', scope: ['.'], acceptance: ['能导出'] })
  // A save needs something to save: an uncommitted edit is what a checkpoint
  // captures. Without it the plugin honestly says "nothing to capture" and the
  // marks this scenario is about never exist.
  // A tracked file, not a new one: `git stash create` ignores untracked paths,
  // and an ignored edit would make the save look like it silently did nothing.
  writeFileSync(join(h.state.project, 'README.md'), '# demo\n\nexport: draft\n')
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '导出按钮', scope: ['.'], acceptance: ['能点'], deliverable: '点一下能下载 csv' },
    { id: 'b2', goal: '列顺序', scope: ['.'], acceptance: ['和页面一致'] },
  ] })
  const act = await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  if (process.env.SCN_DEBUG) console.log('  S22 activate checkpoint →', JSON.stringify(act.checkpoint))
  await h.tool('work_control', { operation: 'receipt', text: '可以，就按这个做。' })
  await h.tool('work_control', { operation: 'goal', text: '做一个能导出、也能重新排序的页面' })
  await h.tool('work_control', { operation: 'remember', payload: { kind: 'fact', text: '导出指把当前视图的列下载成 csv' } })
  await h.tool('work_plan', { operation: 'ask', unit: 'b2', text: '列顺序按页面当前顺序，还是按字母？' })
  const board = await h.board()
  const one = (board.units ?? []).find(row => row.id === 'b1')
  const two = (board.units ?? []).find(row => row.id === 'b2')
  if (!one?.deliverable) throw new Error('b1 的交付物没上板')
  if (!two?.asked) throw new Error('b2 的“等你”没上板')
  if (!(board.marks ?? []).length) throw new Error('存档没上板')
  if (!board.task?.hasReceipt) throw new Error('回执没上板')
  if ((board.task?.goalRevision ?? 0) < 1) throw new Error(`目标版本没上板：${board.task?.goalRevision}`)
}, { checkpoints: true, git: true })

add('S24', '没有交付物的单元也有一行「开始」（老任务不哑）', ['unit-open'], async h => {
  await h.cmd('start 老任务没有交付物')
  await h.tool('work_start', { request: '老任务没有交付物', mode: 'do', scope: ['.'], acceptance: ['能接着做'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '把描述符刷新收一半', scope: ['.'], acceptance: ['两半都收完'] },
  ] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
})

add('S23', '命令面：status / tasks / plan / help / pause / resume / cancel', [], async h => {
  await h.cmd('start 命令面走一遍')
  await h.tool('work_start', { request: '命令面走一遍', mode: 'do', scope: ['.'], acceptance: ['都能跑'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '一件小事', scope: ['.'], acceptance: ['做完'] },
  ] })
  await h.cmd('status')
  await h.cmd('tasks')
  await h.cmd('plan')
  await h.cmd('help')
  await h.cmd('pause')
  await h.cmd('resume')
  await h.cmd('cancel')
  await h.cmd('new 再来一个')
})

add('S25', '读状态：四种视图 + 要一次授权', [], async h => {
  await h.cmd('start 看状态')
  await h.tool('work_start', { request: '看状态', mode: 'do', scope: ['.'], acceptance: ['能看'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '看', scope: ['.'], acceptance: ['看了'] }] })
  for (const view of ['summary', 'executions', 'board', 'tasks']) await h.tool('work_status', { view })
  await h.tool('work_extend', { kind: 'authorization', risk: 'deploy', reason: '要把这一版发到测试环境跑一遍' })
})

add('S26', '任务生命周期：暂停/继续/目标/回执/澄清/假设/复盘/导出/导入', [], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能导'] }] })
  await h.tool('work_control', { operation: 'status' })
  await h.tool('work_control', { operation: 'pause', reason: '先接个电话' })
  await h.tool('work_control', { operation: 'resume' })
  await h.tool('work_control', { operation: 'continue' })
  await h.tool('work_control', { operation: 'goal', text: '做一个可筛选的导出', why: '用户说筛选是必须的' })
  await h.tool('work_control', { operation: 'receipt', text: '目标：能筛选的导出\n验收：三种筛选都试过\n不做：不改样式\n默认：先放仓库 outputs/' })
  await h.tool('work_control', { operation: 'clarify', assumption: '先按仓库目录放，用户没说放哪' })
  await h.tool('work_control', { operation: 'alternative', text: '也可以只加一行命令参数，不做面板' })
  await h.tool('work_control', { operation: 'remember', target: 'domain', payload: { kind: 'term', key: '导出', text: '导出只放仓库 outputs/' } })
  await h.tool('work_control', { operation: 'postmortem', payload: { symptom: '导出卡住', cause: '路径写死', change: '改成相对路径', finding: '仓库外目录不存在', prevention: '先 assertDirectory' } })
  const snapshot = await h.tool('work_control', { operation: 'export' })
  const second = await open({ project: h.state.project, sessionId: 'session-import', tables: h.host.tables })
  const other = helpers(second.host, second.state)
  await other.cmd('start 导入一个任务')
  await other.tool('work_control', { operation: 'import', payload: snapshot })
  await other.step()
  for (const receipt of other.receipts) h.receipts.push(receipt)
})

add('S27', '存档与回滚：G2 先拦一次，用户点「同意」才回滚（打字不算）', [], async h => {
  await h.cmd('start 改一个文件')
  // 先把工作树弄脏：`git stash create` 只收已跟踪文件的改动，干净树什么都没有。
  writeFileSync(join(h.state.project, 'README.md'), '# first change\n')
  await h.tool('work_start', { request: '改一个文件', mode: 'do', scope: ['.'], acceptance: ['改完'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '改文件', scope: ['.'], acceptance: ['改完'] }] })
  writeFileSync(join(h.state.project, 'README.md'), '# changed\n')
  await h.tool('work_control', { operation: 'checkpoints' })
  // G2：第一次回滚被拦，说清过关办法；用户回了话，同一类操作放行。没有要模型抄的原话。
  await assert.rejects(h.tool('work_control', { operation: 'rollback', target: 'before' }), /回滚会覆盖还没提交的改动.*\n过关：用问题卡问用户，只给两个选项/s)
  await h.say('回吧')
  await assert.rejects(h.tool('work_control', { operation: 'rollback', target: 'before' }), /回滚会覆盖/, '打字不算点选')
  await h.pick(CONSENT_YES)
  await h.tool('work_control', { operation: 'rollback', target: 'before' })
}, { checkpoints: true, git: true })

add('S28', '收下：交付后等人看一眼，再关任务', [], async h => {
  await h.cmd('start 做一个能看的按钮')
  await h.tool('work_start', { request: '做一个能看的按钮', mode: 'do', scope: ['.'], acceptance: ['按钮能点'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '按钮', scope: ['.'], acceptance: ['能点'], deliverable: '页面上能点的按钮' }] })
  await h.tool('work_control', { operation: 'receipt', text: '目标：能点的按钮\n验收：点了有反应\n不做：不动样式\n默认：先放首页' })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const call = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'complete', summary: '按钮能点了', next: 'none', claims: [{ statement: '点了有反应', execution: { callId: call } }] })
  if (process.env.SCN_DEBUG) console.log('  S28 tasks →', JSON.stringify(Object.values(h.host.tables.tasks).map(t => [t.id, t.state, t.acceptanceMode])))
  await h.say('我点了一下，验收通过，收下这一版')
  if (process.env.SCN_DEBUG) console.log('  S28 after say →', JSON.stringify(Object.values(h.host.tables.tasks).map(t => [t.id, t.state])))
  await h.tool('work_control', { operation: 'accept', text: '我点了一下，验收通过，收下这一版' })
})

add('S29', '退回重做 + 另一个会话接手', [], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能导'], deliverable: '能点的导出按钮' }] })
  await h.tool('work_control', { operation: 'receipt', text: '目标：能导出的按钮\n验收：导出一次\n不做：不改样式\n默认：先放首页' })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const call = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'complete', summary: '导出能用了', next: 'none', claims: [{ statement: '导出一次', execution: { callId: call } }] })
  await h.say('导出的位置不对，再改一下')
  await h.tool('work_control', { operation: 'rework', text: '导出的位置不对，再改一下' })
  // Another window picks the same task up.
  await h.tool('work_control', { operation: 'pause', reason: '换个人接着做' })
  const second = await open({ project: h.state.project, sessionId: 'session-adopt', tables: h.host.tables })
  const other = helpers(second.host, second.state)
  await other.cmd('start 继续这个导出')
  await other.tool('work_control', { operation: 'adopt', taskId: Object.keys(h.host.tables.tasks)[0] })
  await other.step()
  for (const receipt of other.receipts) h.receipts.push(receipt)
})

const goldenFile = process.argv.includes('--golden') ? process.argv[process.argv.indexOf('--golden') + 1] : null
const golden = goldenFile ? [] : null
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',').map(s => s.trim()) : null
const rows = []
add('S30', '现场记忆 + 计划增补 + 交接/导入：一次走完剩下的分支', ['env', 'handoff'], async h => {
  await h.cmd('start 把导出接上真接口')
  await h.tool('work_start', { request: '把导出接上真接口', mode: 'build', scope: ['.'], acceptance: ['导出走真接口'] })
  // 计划：先两件，再补一件、写一行进度、关掉一件。
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '接接口', scope: ['.'], acceptance: ['能导出'] }] })
  await h.tool('work_plan', { operation: 'add', units: [{ id: 'b2', goal: '写测试', scope: ['.'], acceptance: ['跑通'] }] })
  await h.tool('work_plan', { operation: 'note', unit: 'b1', text: '接口字段对上了，还差错误码' })
  await h.tool('work_plan', { operation: 'activate', unit: 'b2' })
  const proof = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b2', outcome: 'complete', summary: '测试已通过', next: '继续接口', claims: [{ statement: '执行检查通过', execution: { callId: proof } }] })
  // 现场记忆：发现一条 → 只是候选；人确认后才是事实；再报它失效。
  await h.tool('work_env', { operation: 'propose', kind: 'fact', key: 'start', value: 'npm run dev :3000', command: 'npm run dev' })
  await h.say('确认 start 使用 npm run dev，端口 3000')
  await h.tool('work_env', { operation: 'confirm', key: 'start', note: '确认 start 使用 npm run dev，端口 3000' })
  await h.tool('work_env', { operation: 'stale', key: 'start', note: '端口被占了' })
  await h.tool('work_env', { operation: 'list' })
  // 导出 → 暂停 → 同会话导入；再交给另一个会话（adopt 分支）。
  const exported = await h.tool('work_control', { operation: 'export' })
  await h.tool('work_control', { operation: 'pause', reason: '换机器' })
  await h.tool('work_control', { operation: 'import', payload: exported })
  const second = await open({ project: h.state.project, sessionId: 'session-s30-other', tables: h.host.tables })
  const other = helpers(second.host, second.state)
  const said = await other.cmd('adopt')
  for (const verb of other.state.commands) h.state.commands.push(verb)
  await other.step()
  for (const receipt of other.receipts) h.receipts.push(receipt)
  await other.tool('work_control', { operation: 'adopt', taskId: Object.keys(h.host.tables.tasks)[0], reason: '换窗口接着做' })
  // 第二个窗口里的调用同样算这条业务路径（闸门看的是插件暴露了什么）。
  for (const call of other.calls) h.calls.push(call)
})


add('S31', '项目时间线：开新任务不盖掉旧任务，新的在上、旧的仍可展开', ['unit-open', 'task-done'], async h => {
  await h.cmd('start 先把导出目录定下来')
  await h.tool('work_start', { request: '先把导出目录定下来', mode: 'do', scope: ['.'], acceptance: ['目录固定'], acceptanceMode: 'auto' })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '定目录', scope: ['.'], acceptance: ['有 outputs 目录'] }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const one = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'complete', summary: '目录定在 outputs/', next: '收尾', claims: [{ statement: '目录可写', execution: { callId: one } }] })
  // 同一个项目里再开一个任务：上一个任务必须在时间线里，且不再被画成“当前”。
  await h.cmd('new 换成按主题交付')
  await h.tool('work_start', { request: '换成按主题交付', mode: 'do', scope: ['.'], acceptance: ['有主题'] })
  const board = await h.board()
  if (!Array.isArray(board.timeline) || board.timeline.length !== 2) throw new Error(`时间线应有 2 个任务，实际 ${JSON.stringify(board.timeline?.map(row => row.id))}`)
  if (board.timeline[0].current !== true) throw new Error('最新的任务应是当前任务')
  if (board.timeline[0].id !== board.task?.id) throw new Error('时间线第一行与看板不是同一个任务')
  const past = board.timeline[1]
  if (past.state !== 'closed') throw new Error(`上一个任务应已收束，实际 ${past.state}`)
  if (!String(past.goal).includes('导出目录')) throw new Error(`旧任务的目标丢了：${past.goal}`)
  if (!Array.isArray(past.units) || past.units.length < 1) throw new Error('旧任务展开后没有单元')
})

add('S32', '开工先理需求（F-clarify 6b）：命令后只出一张「先理需求」卡、不登记；用户回话后模型登记自己的复述，原话与回话原文插件自己存；没登记就写文件，写之前兜底登记', ['read-doc'], async h => {
  const request = '把登录按钮改成进度条'
  await h.cmd(`start ${request}`, { deliverFollowup: true })
  const granted = h.hints.find(hint => hint.summary === 'dsh-auto-dev start granted')
  if (!granted?.text.includes('先弄清要什么再动手') || !granted.text.includes(request)) throw new Error('命令后没有出「先理需求」卡')
  if (/直接开工|已经登记/.test(granted.text)) throw new Error('开工卡还在说已登记、直接开工')
  if (/work_start|scope|acceptance/.test(granted.text)) throw new Error('开工提示还在教模型调用登记、填参数')
  if (!h.receipts.some(row => row.form === 'read-doc' && row.title === '先理需求')) throw new Error('「先理需求」不是胶囊')
  if (h.hints.some(hint => /standing hint|resume hint/.test(hint.summary))) throw new Error('有效授权被未开工或续接提示覆盖')
  if (Object.keys(h.host.tables.tasks ?? {}).length !== 0) throw new Error('开工那一刻不该登记')
  // 模型复述、问一个问题，回合结束；用户回话；模型登记自己的复述。
  await h.say('只改首页那个')
  await h.step()
  if (h.hints.filter(hint => hint.summary === 'dsh-auto-dev start granted').length !== 1) throw new Error('「先理需求」只说一次')
  const opened = await h.tool('work_start', { request: '首页登录按钮：点下后显示进度条，登录返回后消失' })
  const task = h.host.tables.tasks[opened.taskId]
  assert.equal(task.request, request)
  assert.equal(task.goal, '首页登录按钮：点下后显示进度条，登录返回后消失')
  assert.deepEqual(task.replies.map(reply => reply.text), ['只改首页那个'])
  const board = await h.board()
  if (board.task?.request !== request) throw new Error('看板缺少命令中的原始目标')
  if (board.timeline?.length !== 1 || !board.timeline[0].current) throw new Error('登记后看板仍为空')
  // 登记过的任务第一次写文件：不再带复述句（复述过了）。
  await h.write('a.js', 'export const a = 1\n')
  const first = h.hints.find(hint => hint.summary === 'dsh-auto-dev first write')
  assert.doesNotMatch(first.text, /复述/)
}, { git: true })

add('S70', '兜底登记（F-clarify 6b）：开工后没登记就用文件工具写 → 写之前按用户原话登记、开工前档在写之前；首写卡带复述句；有授权不提示开工', ['read-doc'], async h => {
  await h.cmd('start 给 a.js 加一个导出', { deliverFollowup: true })
  await h.write('a.js', 'export const a = 2\n')
  const fallback = h.hints.find(hint => hint.summary === 'dsh-auto-dev start fallback')
  assert.match(fallback?.text ?? '', /改文件前还没登记，已按用户原话登记/)
  const auto = Object.values(h.host.tables.tasks)[0]
  assert.equal(auto.request, '给 a.js 加一个导出')
  assert.equal(auto.registeredBy, 'plugin')
  assert.match(h.hints.find(hint => hint.summary === 'dsh-auto-dev first write')?.text ?? '', /先停下，对用户复述/)
  if (h.hints.some(hint => hint.summary === 'dsh-auto-dev start hint')) throw new Error('有授权还在提示开工')
}, { git: true })

add('S71', '兜底登记看磁盘（F-clarify 6b 第 2 轮）：开工后只读不登记；没登记就用 shell 改了文件 → 树一变就按原话登记，开工前档是开工那一刻的树，登记时的复述补进 goal', ['read-doc', 'notice'], async h => {
  writeFileSync(join(h.state.project, 'a.js'), 'export const a = 1\n')
  execFileSync('git', ['add', 'a.js'], { cwd: h.state.project })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a'], { cwd: h.state.project })
  writeFileSync(join(h.state.project, 'a.js'), 'export const a = 1 // 开工前没提交的改动\n')
  await h.cmd('start 给 a.js 加一个导出', { deliverFollowup: true })
  if (JSON.stringify(h.receipts).includes('任务已登记')) throw new Error('开工回执说已登记')
  assert.match(h.hints.find(hint => hint.summary === 'dsh-auto-dev start granted')?.text ?? '', /登记前只读，不改不删/)
  await h.exec('cat a.js')
  if (Object.keys(h.host.tables.tasks ?? {}).length) throw new Error('只读也登记了')
  await h.exec("echo 'export const b = 2' >> a.js")
  assert.match(h.hints.find(hint => hint.summary === 'dsh-auto-dev start fallback')?.text ?? '', /已按用户原话登记/)
  const auto = Object.values(h.host.tables.tasks)[0]
  assert.equal(auto.registeredBy, 'plugin')
  const before = auto.checkpoints?.find(point => point.label === '开工前')
  assert.ok(before, '没有开工前档')
  assert.equal(execFileSync('git', ['show', `${before.commit}:a.js`], { cwd: h.state.project, encoding: 'utf8' }), 'export const a = 1 // 开工前没提交的改动\n')
  await h.tool('work_start', { request: '在 a.js 新增导出 b，保留 a' })
  assert.equal(h.host.tables.tasks[auto.id].goal, '在 a.js 新增导出 b，保留 a')
}, { checkpoints: true, git: true })

add('S72', '登记不因形状丢授权（v44 feature/hotfix）：work_start 带一个相对的项目名 → 按会话目录解析或忽略，照样登记；登记失败也不把用户的开工用掉', ['read-doc'], async h => {
  await h.cmd('start 给 a.js 加一个导出', { deliverFollowup: true })
  const started = await h.tool('work_start', { request: '在 a.js 新增导出 b', project: 'no-such-dir' })
  assert.notEqual(started?.started, false, JSON.stringify(started))
  const task = Object.values(h.host.tables.tasks ?? {})[0]
  assert.ok(task, '没登记')
  assert.equal(task.project, h.state.project)
  if (/nobody has run|由用户自己开/.test(JSON.stringify(h.hints) + JSON.stringify(started))) throw new Error('说用户没开过工')
})

add('S33', 'P0：G1 由插件交付时自己在项目里跑检查——红就退回不落账（只给人一行「拦下」），吞退出码的写法骗不过，修好后只完成一次', ['unit-open', 'blocked-call', 'task-done'], async h => {
  await h.cmd('start 实际运行界面逻辑检查')
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.tool('work_start', { request: '实际运行界面逻辑检查', mode: 'do', acceptanceMode: 'auto', scope: ['.'], acceptance: ['项目测试通过'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'ui', goal: '验证界面逻辑', scope: ['.'], acceptance: ['检查通过'], ui: 'logic' }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'ui' })
  const G1 = /交付前插件在项目里跑了 `npm test`，没通过[\s\S]*过关：修好让它通过，再交/
  const args = { unit: 'ui', outcome: 'complete', summary: '检查通过' }
  const failed = await h.exec('npm test')
  const before = structuredClone(h.host.tables), count = h.receipts.length
  // 插件自己跑的检查是红的：G1，模型引用什么都一样。
  await assert.rejects(h.tool('work_submit', { ...args, claims: [{ statement: 'npm test 通过', execution: { callId: failed } }] }), G1)
  assert.deepEqual(h.host.tables, before)
  assert.equal(h.receipts.length, count + 1)
  assert.equal(h.receipts.at(-1).form, 'blocked-call')
  assert.match(h.receipts.at(-1).title, /拦下 · 交付退回/)
  await assert.rejects(h.tool('work_submit', args), G1)
  // 吞掉退出码的写法骗不过：插件跑的是自己那一次。
  await h.exec('npm test; echo "[exit code: $?]"')
  await assert.rejects(h.tool('work_submit', args), G1)
  assert.deepEqual(h.host.tables, before)
  assert.equal(h.receipts.length, count + 1, '同一单元反复退回只说一次')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.exec('npm test')
  await h.tool('work_control', { operation: 'remember', payload: { kind: 'incident', symptom: '项目测试失败', ruledOut: ['不是界面档问题'] } })
  await h.tool('work_submit', args)
  assert.equal(Object.values(h.host.tables.tasks)[0].ledger.length, 1)
  assert.equal(h.receipts.filter(row => row.form === 'task-done').length, 1)
})

add('S34', 'P0：写成完成的单元一律回到待做（只有交付能完成），删掉没做完的单元会留下并告诉用户，阻塞单元保持可见', ['unit-open', 'unit-done'], async h => {
  await h.cmd('start 检查计划完成边界')
  const a = { id: 'a', goal: '先做检查', scope: ['.'], acceptance: ['检查通过'] }
  await h.tool('work_start', { request: '检查计划完成边界', mode: 'do', acceptanceMode: 'auto', scope: ['.'], acceptance: ['全部完成'], plan: { units: [{ ...a, state: 'done' }] } })
  const unitState = id => Object.values(h.host.tables.plans)[0].units.find(row => row.id === id)?.state
  assert.equal(unitState('a'), 'pending')
  assert.deepEqual((await h.tool('work_plan', { operation: 'set', units: [{ ...a, state: 'done' }, { id: 'b', goal: '等待外部条件', state: 'blocked', scope: ['.'], acceptance: ['条件满足'] }] })).reopened, ['a'])
  assert.deepEqual((await h.tool('work_plan', { operation: 'add', units: [{ ...a, id: 'c', state: 'done' }] })).reopened, ['c'])
  // 重写计划时拿掉没做完的 c：它留下、记为不做，并要模型跟用户说一声。
  const shrunk = await h.tool('work_plan', { operation: 'set', units: [a, { id: 'b', goal: '等待外部条件', state: 'blocked', scope: ['.'], acceptance: ['条件满足'] }] })
  assert.deepEqual(shrunk.dropped, ['c'])
  assert.match(shrunk.tellUser, /为什么不做/)
  assert.equal(unitState('c'), 'dropped')
  // 写回来就回到待做。
  await h.tool('work_plan', { operation: 'set', units: [a, { id: 'b', goal: '等待外部条件', state: 'blocked', scope: ['.'], acceptance: ['条件满足'] }, { id: 'c', goal: '最后检查', scope: ['.'], acceptance: ['检查通过'] }] })
  assert.equal(unitState('c'), 'pending')
  await h.tool('work_plan', { operation: 'state', unit: 'b', state: 'blocked' })
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  const proof = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'a', outcome: 'complete', summary: '检查通过', next: '处理阻塞', claims: [{ statement: '检查通过', execution: { callId: proof } }] })
  const board = await h.board()
  assert.equal(board.task.state, 'active')
  assert.deepEqual(board.task.acceptance, ['全部完成'])
  // 阻塞的单元在分步里看得见（不再在「没做的」里重复一遍）。
  assert.ok(board.units.some(row => row.id === 'b' && row.state === 'blocked'))
  assert.equal(board.task.unverified.some(text => text.includes('b')), false)
  assert.equal(h.receipts.some(row => ['task-done', 'review'].includes(row.form)), false)
  const done = Object.values(h.host.tables.plans)[0].units.find(row => row.id === 'a')
  const evidenceWindow = done.startedSeq
  const ledger = structuredClone(Object.values(h.host.tables.tasks)[0].ledger)
  const completed = () => h.receipts.filter(row => ['unit-done', 'task-done', 'review'].includes(row.form)).length
  const completedCount = completed()
  await h.tool('work_plan', { operation: 'group', unit: 'checked', text: '已检查工作', members: ['a'] })
  const proposal = await h.tool('work_plan', { operation: 'organize', action: 'propose' })
  await h.say(`同意 ${proposal.proposalId}`)
  await h.tool('work_plan', { operation: 'organize', action: 'apply', proposalId: proposal.proposalId,
    approval: `同意 ${proposal.proposalId}`, steps: [{ kind: 'ungroup', unit: 'checked' }] })
  const regrouped = Object.values(h.host.tables.plans)[0].units.find(row => row.id === 'a')
  assert.equal(regrouped.state, 'done')
  assert.equal(regrouped.startedSeq, evidenceWindow)
  assert.deepEqual(Object.values(h.host.tables.tasks)[0].ledger, ledger)
  assert.equal(completed(), completedCount)
  await h.say('同意取消 b，移出本次范围')
  await h.tool('work_plan', { operation: 'state', unit: 'b', state: 'dropped', approval: '同意取消 b，移出本次范围' })
  const retained = Object.values(h.host.tables.plans)[0].units
  await h.tool('work_plan', { operation: 'set', units: structuredClone(retained) })
  const finalProof = await h.exec('node -e "console.log(2)"')
  await h.tool('work_submit', { unit: 'c', outcome: 'complete', summary: '最后检查通过', next: '查看结果', claims: [{ statement: '检查通过', execution: { callId: finalProof } }] })
  const settled = await h.board()
  assert.equal(settled.task.state, 'closed')
  assert.ok(settled.task.unverified.some(row => row.includes('b') && row.includes('未完成')))
})

add('S35', 'P0：环境禁令在用户回话后确认（是不是同意由模型读）；撤销是硬门，用户点「同意」才撤（G3 先拦一次），其他禁令保留', ['env'], async h => {
  await h.cmd('start 检查环境禁令')
  await h.tool('work_start', { request: '检查环境禁令', mode: 'do', scope: ['.'], acceptance: ['禁令来源可查'] })
  for (const key of ['migrations', 'secrets']) {
    await h.tool('work_env', { operation: 'propose', kind: 'blocked', key, value: `不得修改 ${key}/` })
    if (key === 'migrations') {
      const before = await readEnv(h.state.project), count = h.receipts.length
      assert.match((await h.tool('work_env', { operation: 'confirm', key })).tellUser, /问用户一句/)
      assert.deepEqual(await readEnv(h.state.project), before)
      assert.equal(h.receipts.slice(count).some(row => row.form === 'env'), false)
    }
    await h.say(`确认 ${key} 禁令`)
    await h.tool('work_env', { operation: 'confirm', key })
  }
  // G3 看文件工具自己的路径参数；命令文本不猜。
  assert.equal((await h.pre('cat migrations/old.sql')).kind, 'continue')
  assert.equal((await h.pre({ path: 'migrations/old.sql', content: 'x' }, 'write')).kind, 'deny')
  await assert.rejects(h.tool('work_env', { operation: 'forget', key: 'migrations' }), /是用户定的规则\n过关：用问题卡问用户，只给两个选项/)
  await h.pick(CONSENT_NO)
  await assert.rejects(h.tool('work_env', { operation: 'forget', key: 'migrations' }), /是用户定的规则/)
  await h.pick(CONSENT_YES)
  await h.tool('work_env', { operation: 'forget', key: 'migrations' })
  const receipt = h.receipts.findLast(row => row.form === 'env-forget')
  assert.match(receipt.line, /migrations/)
  assert.doesNotMatch(JSON.stringify(receipt), /已删/)
  const env = await readEnv(h.state.project)
  assert.equal(env.blocked.find(row => row.key === 'migrations').status, 'stale')
  assert.equal(env.blocked.find(row => row.key === 'migrations').history.length, 1)
  assert.equal((await h.pre({ path: 'migrations/old.sql', content: 'x' }, 'write')).kind, 'continue')
  assert.equal((await h.pre({ path: 'secrets/token.txt', content: 'x' }, 'write')).kind, 'deny')
})

add('S36', 'P0：真实验收与重做建立新证据窗口', ['unit-done', 'review-revise', 'review-done'], async h => {
  await h.cmd('start 检查真人验收')
  await h.tool('work_start', { request: '检查真人验收', mode: 'do', acceptanceMode: 'pm', scope: ['.'], acceptance: ['项目测试通过'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'a', goal: '项目检查', scope: ['.'], acceptance: [] }] })
  const old = await h.exec('node -e "console.log(1)"')
  const args = { unit: 'a', outcome: 'complete', summary: '项目检查通过', next: '等待验收', claims: [{ statement: '项目检查通过', execution: { callId: old } }] }
  await h.tool('work_submit', args)
  assert.equal((await h.tool('work_control', { operation: 'resume' })).unchanged, true)
  await h.say('不通过，需要修改')
  // 是不是同意由模型读；它读成不同意，退回。
  await h.tool('work_control', { operation: 'rework' })
  // 重做之后改了东西：旧的检查不算。检查是红的就退回；插件交付时自己跑，模型引用哪次都一样。
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.exec('echo "export const a = 2" > a.js')
  await assert.rejects(h.tool('work_submit', args), /交付前插件在项目里跑了 `npm test`，没通过/)
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  const fresh = await h.exec('npm test')
  await h.tool('work_submit', { ...args, claims: [{ statement: '重新检查通过', execution: { callId: fresh } }] })
  await h.say('验收通过，这一版收下')
  await h.tool('work_control', { operation: 'accept', text: '验收通过，这一版收下' })
  const count = h.receipts.length
  assert.equal((await h.tool('work_control', { operation: 'accept', text: '验收通过，这一版收下' })).unchanged, true)
  assert.equal(h.receipts.length, count)
  assert.equal((await h.board()).task.state, 'closed')
})

add('S37', 'P1：统一记录五种信息，真实未决才等待', ['ask', 'postmortem'], async h => {
  await h.cmd('start 交付探针')
  await h.tool('work_start', { request: '交付探针', mode: 'do', scope: ['.'], acceptance: ['探针可执行'] })
  const long = '说明'.repeat(250)
  const batch = await h.tool('work_control', { operation: 'record', payload: { entries: [
    { kind: 'goal', text: '交付可见探针' }, { kind: 'receipt', text: long },
    { kind: 'clarify', asked: [{ question: '输出位置？' }] }, { kind: 'alternative', text: '复用现有探针' },
    { kind: 'learning', text: '观察到工具输出，根因未知' },
  ] } })
  assert.equal(batch.entries.length, 5)
  assert.equal(batch.waiting, 'user-answer')
  assert.equal(batch.continueAuthorized, false)
  assert.ok(h.receipts.some(row => row.form === 'ask' && row.line.includes('输出位置？')))
  const task = Object.values(h.host.tables.tasks)[0]
  assert.equal(task.receipt.text, long)
  assert.equal(task.clarify.asked.length, 1)
  assert.equal(task.alternatives.length, 1)
  assert.equal((await h.board()).task.hasReceipt, true)
  const resolved = await h.tool('work_control', { operation: 'clarify', answers: [{ q: '输出位置？', answer: '根目录' }] })
  assert.equal(resolved.waiting, null)
  assert.equal(resolved.continueAuthorized, true)
  await h.tool('work_control', { operation: 'goal', text: '旧入口仍可修订目标' })
  // An empty, unknown entry is dropped; the rest of the batch lands.
  await h.tool('work_control', { operation: 'record', entries: [{ kind: 'goal', text: '照样落盘' }, { kind: 'invalid' }] })
  assert.equal((await h.board()).task?.goalRevision, 3)
})
add('S38', 'P1：真实环境观测直接可用，失效后需要新证据', ['env'], async h => {
  await h.cmd('start 检查环境')
  await h.tool('work_start', { request: '检查环境', mode: 'look', scope: ['.'], acceptance: [] })
  const command = 'node -e "console.log(4321)"'
  const args = { operation: 'observe', kind: 'fact', key: 'port', value: '4321', callId: await h.exec(command) }
  const first = await h.tool('work_env', args)
  assert.equal(first.source.by, 'execution')
  assert.equal(first.digest.usable, 1)
  const count = h.receipts.length
  assert.equal((await h.tool('work_env', args)).unchanged, true)
  assert.equal(h.receipts.length, count)
  await h.tool('work_env', { operation: 'stale', key: 'port' })
  assert.equal((await h.tool('work_env', { operation: 'list' })).digest.usable, 0)
  // A stale fact cited again is kept as a candidate until fresh proof arrives.
  assert.match((await h.tool('work_env', args)).tellUser, /过期.*先记成候选/)
  await h.tool('work_env', { ...args, callId: await h.exec(command) })
  assert.match((await h.tool('work_env', { ...args, kind: 'blocked' })).tellUser, /规则要用户确认/)
  await h.say('预览地址 http://localhost:4321')
  await h.tool('work_env', { operation: 'observe', kind: 'gui', key: 'preview', value: 'http://localhost:4321', quote: '预览地址 http://localhost:4321' })
  const env = await readEnv(h.state.project)
  assert.equal(env.gui[0].source.by, 'user')
  assert.match((await h.tool('work_env', { operation: 'list' })).digest.gui[0], /observed; user;/)
})
add('S40', 'P2：新 build 按 do 无计划交付，已有叶子与 PM 仍约束收尾', ['task-done', 'unit-done', 'review-done'], async h => {
  await h.cmd('start 执行无计划探针')
  const started = await h.tool('work_start', { request: '执行无计划探针', mode: 'build', acceptanceMode: 'auto', scope: ['.'], acceptance: ['探针通过'] })
  assert.equal(started.mode, 'do')
  assert.equal(started.gates.plan, false)
  const args = async unit => ({ ...(unit ? { unit } : {}), outcome: 'complete', summary: '探针通过', next: '查看结果',
    claims: [{ statement: '探针通过', execution: { callId: await h.exec('node -e "console.log(1)"') } }] })
  await h.tool('work_submit', await args())
  assert.equal((await h.board()).task.state, 'closed')
  await h.cmd('new 分两步交付探针')
  await h.tool('work_start', { request: '分两步交付探针', mode: 'do', acceptanceMode: 'pm', scope: ['.'], acceptance: ['探针通过'],
    plan: { units: ['a', 'b'].map(id => ({ id, goal: `探针 ${id}`, scope: ['.'], acceptance: ['探针通过'] })) } })
  for (const id of ['a', 'b']) {
    await h.tool('work_plan', { operation: 'activate', unit: id })
    await h.tool('work_submit', await args(id))
    assert.equal((await h.board()).task.state, id === 'a' ? 'active' : 'review_ready')
  }
  await h.say('验收通过')
  await h.tool('work_control', { operation: 'accept', text: '验收通过' })
  assert.equal((await h.board()).task.state, 'closed')
})
add('S41', 'P2：历史 build 与分组叶子在工具、命令、右栏共享真值', ['theme-open', 'ask'], async h => {
  await h.cmd('start 查看历史任务进度')
  const started = await h.tool('work_start', { request: '查看历史任务进度', mode: 'do', acceptanceMode: 'auto', scope: ['.'], acceptance: [],
    plan: { units: ['a', 'b'].map(id => ({ id, goal: `历史探针 ${id}`, scope: ['.'], acceptance: [], ...(id === 'b' ? { state: 'blocked' } : {}) })) } })
  h.host.tables.tasks[started.taskId].mode = 'build' // serialized pre-P2 task; history is not rewritten
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  const callId = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'a', outcome: 'complete', summary: '探针通过', next: '等待 b 的条件', claims: [{ statement: '探针通过', execution: { callId } }] })
  await h.tool('work_plan', { operation: 'group', unit: 'g', text: '历史组', members: ['a', 'b'] })
  await h.tool('work_control', { operation: 'record', payload: { kind: 'clarify', asked: [{ question: '谁提供 b 的条件？' }] } })
  const status = await h.tool('work_status')
  const legacy = await h.tool('work_control', { operation: 'status' })
  const board = await h.board()
  assert.equal(status.task.mode, 'build')
  assert.equal(status.task.effectiveMode, 'do')
  assert.equal(status.progress.label, '1/2')
  assert.deepEqual(board.progress, status.progress)
  assert.deepEqual(legacy.progress, status.progress)
  assert.deepEqual(legacy.pending, status.pending)
  assert.equal(legacy.units, 2)
  assert.equal(legacy.unitRows.length, 3)
  assert.equal(status.pending.waiting, 'user-answer')
  assert.equal(board.units.find(row => row.id === 'b').state, 'blocked')
  assert.match(JSON.stringify(await h.cmd('status')), /1\/2/)
})
add('S42', 'P2：新复盘进入工程记忆，旧历史只读，后续开工取相关摘要', ['postmortem', 'remember'], async h => {
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true })
  const legacy = '旧复盘仅作历史。'
  writeFileSync(join(h.state.project, '.auto-dev/postmortem.md'), legacy)
  await h.cmd('start 调查缓存账期')
  await h.tool('work_start', { request: '调查缓存账期', mode: 'look', scope: ['.'], acceptance: [] })
  await h.tool('work_control', { operation: 'record', entries: [
    { kind: 'learning', symptom: '缓存偶发为空', cause: '未知，仍在排查', finding: '真实探针复现一次' },
    { kind: 'receipt', text: '本次只核对缓存' },
  ] })
  await h.tool('work_control', { operation: 'postmortem', symptom: '缓存偶发为空', change: '增加诊断日志' })
  await h.tool('work_control', { operation: 'remember', target: 'domain', payload: { kind: 'term', key: '缓存账期', text: '按自然日结算', quote: '按自然日结算' } })
  const memory = readMemory(h.state.project)
  assert.equal(memory.incidents.length, 1)
  assert.equal(memory.incidents[0].status, 'observation')
  assert.equal(memory.incidents[0].mechanism, undefined)
  assert.equal(JSON.stringify(memory).includes('本次只核对缓存'), false)
  assert.equal(readFileSync(join(h.state.project, '.auto-dev/postmortem.md'), 'utf8'), legacy)
  await h.cmd('new 继续核对缓存账期')
  const next = await h.tool('work_start', { request: '继续核对缓存账期', mode: 'do', scope: ['.'], acceptance: [] })
  assert.match(JSON.stringify(next), /缓存偶发为空/)
  assert.match(JSON.stringify(next), /observation/)
  assert.match(JSON.stringify(next), /缓存账期/)
  assert.match(JSON.stringify(next), /legacy-unverified/)
})

// 真模型（实跑会话 949cce92）跑测试的原样写法：带 cd 前缀、管道截尾、echo 退出码。
// 退出码被 tail / echo 吞掉，失败只留在输出里。
const readmeTest = h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }))
  mkdirSync(join(h.state.project, 'test'), { recursive: true })
  writeFileSync(join(h.state.project, 'test', 'readme.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\ntest('readme says fixed', () => assert.match(readFileSync('README.md', 'utf8'), /fixed/))\n")
}

add('S73', '用户同意留红（v45 test）：模型已交 partial、磁盘没再变 → 回合结束不再自动交付、不跑 G1；计划写成 todo 形状（step/status）照收', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.cmd('start 只加测试，不改 src', { deliverFollowup: true })
  await h.tool('work_start', { request: '补回归测试，src 不动', plan: [{ step: '写回归测试', status: 'in_progress' }, { step: '跑检查', status: 'pending' }] })
  const units = (await h.board()).units
  assert.ok(units.some(row => row.goal === '写回归测试' && row.state === 'active'), JSON.stringify(units))
  await h.exec('echo "test" > a.test.js')
  await h.tool('work_submit', { outcome: 'partial', summary: '测试已加，检查按用户同意留红' })
  await h.stop('测试加好了，npm test 按你同意的留着红。')
  await h.stop('测试加好了，npm test 按你同意的留着红。')
  if (h.hints.some(hint => /交付诚实/.test(hint.text))) throw new Error('交了 partial 又在收尾跑 G1')
})

add('S74', '收案之后不再说「还没登记」（v46 handoff #147）：任务交付关闭后再写文件 → 不出开工提示；问答卡的回话按用户选的字存，不存宿主的 JSON', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.cmd('start 整理一下 list', { deliverFollowup: true })
  h.state.log.push({ type: 'tool/call', data: { callId: 'q-scope', name: 'ask_user_question', arguments: { questions: [{ id: 'scope', question: '整理到什么程度？' }] } } })
  h.state.log.push({ type: 'tool/result', data: { message: { toolCallId: 'q-scope', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'scope', selected: [], custom: '按你推荐的来。' }] }) }] } } })
  const opened = await h.tool('work_start', { request: 'list 按时间倒序，加 --limit' })
  assert.deepEqual(h.host.tables.tasks[opened.taskId].replies.map(reply => reply.text), ['按你推荐的来。'])
  await h.exec('echo "export const a = 1" > a.js')
  await h.exec('npm test')
  await h.tool('work_submit', { outcome: 'complete', summary: '好了' })
  await h.say('收下')
  await h.tool('work_control', { operation: 'accept', text: '收下' })
  assert.equal((await h.board()).task.state, 'closed')
  await h.write('NOTES.md', '# 口径\n')
  if (h.hints.some(hint => hint.summary === 'dsh-auto-dev start hint')) throw new Error('收案后写文件又说还没登记')
})

add('S75', '用掉的开工不是没开过工（v47 survey #133）：任务收案后同一会话再登记 → 回执说这次 start 已经登记过哪件，不说 nobody has run', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.cmd('start 看看 list 为什么慢', { deliverFollowup: true })
  const opened = await h.tool('work_start', { request: '查 list 慢的原因，只看不改' })
  await h.tool('work_submit', { outcome: 'complete', summary: '结论：每次全量读盘' })
  // 交付后在等用户看（review_ready）：说已登记过哪件；用户收下关掉之后（survey #109 收案）也一样。
  let again = await h.tool('work_start', { request: '再开一次' })
  assert.match(again.tellUser, new RegExp(opened.taskId))
  h.host.tables.tasks[opened.taskId].state = 'closed'
  again = await h.tool('work_start', { request: '再开一次' })
  assert.equal(again.started, false)
  assert.doesNotMatch(again.tellUser, /nobody has run|由用户自己开/)
  assert.match(again.tellUser, new RegExp(opened.taskId))
  await h.write('NOTES.md', '# 口径\n')
  if (h.hints.some(hint => hint.summary === 'dsh-auto-dev start hint')) throw new Error('用掉开工后写文件又说还没登记')
})

add('S53', '插件收尾：改完说做完了就是交付，G1 由插件自己跑检查把关；模型不用记得调交付工具', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.cmd('start 给 a.js 加一个导出', { deliverFollowup: true })
  await h.register('给 a.js 加一个导出')
  // 计划写成 steps 也是计划（v27 写成 steps 被悄悄清空，面板与对话对不上）。
  await h.tool('work_plan', { operation: 'set', steps: [{ id: 'u1', title: '加导出' }] })
  assert.ok((await h.board()).units.some(row => row.id === 'u1' && row.goal === '加导出'))
  // 宿主在执行前拒掉的编辑什么都没改：磁盘没变，说「改好了」也不算交付（v27 #90–#108）。
  h.state.log.push({ type: 'tool/call', data: { callId: 'edit-refused', name: 'edit', arguments: { path: 'a.js' } } })
  h.state.log.push({ type: 'tool/result', data: { message: { toolCallId: 'edit-refused', isError: true, content: [{ type: 'text', text: 'cannot modify a.js: file has not been read' }] } } })
  assert.equal((await h.stop('改好了。')).length, 0)
  assert.equal((await h.board()).task.state, 'active')
  await h.exec('echo "export const a = 1" > a.js')
  // 磁盘变了、说做完：先给一次交付条件句（回合自己结束时看不到工具结果，v33 perf/refactor），
  const told = await h.stop('改好了。')
  assert.equal(told.length, 1)
  assert.match(told[0].content[0].text, /交付前对照一下/)
  assert.doesNotMatch(told[0].content[0].text, /如果是重构|如果这次是提速/, '交付卡不再带提速、重构两句')
  // 用户也要看得到：胶囊，不是隐形的 notice（v34 违反 1）。
  assert.equal(told[0].source?.form, 'read-doc', JSON.stringify(told[0].source))
  // 再说做完：插件自己跑检查，红就让回合接着走一次，一条规则 + 一个过关动作。
  const first = await h.stop('改好了。')
  assert.equal(first.length, 1)
  assert.match(first[0].content[0].text, /交付诚实.*没通过[\s\S]*过关：修好让它通过，再交/)
  assert.doesNotMatch(first[0].content[0].text, /work_\w+|operation/)
  assert.equal((await h.board()).task.state, 'active')
  assert.equal((await h.stop('改好了。')).length, 0, '同一份磁盘只提醒一次，不拖住回合')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  // 结尾在问用户：是在等人，不是交付。
  assert.equal((await h.stop('导出名用 a 还是 value？')).length, 0)
  assert.equal((await h.board()).task.state, 'active')
  const before = h.receipts.length
  assert.equal((await h.stop('改好了。')).length, 0)
  assert.equal((await h.board()).task.state, 'review_ready')
  assert.equal(h.calls.some(call => call.name === 'work_submit'), false)
  // 收尾交付当场进对话，面板也认（v28：dock 停在「未开始」，交付卡等一个不会来的下一步）。
  assert.ok(h.receipts.slice(before).some(row => row.form === 'review' || row.form === 'task-done' || row.form === 'unit-done'), JSON.stringify(h.receipts.slice(before).map(row => row.form)))
  const status = await h.board()
  const panel = boardOf(syncState({ ...h.state.log.reduce(foldBoard, null), sessionId: h.state.sessionId },
    { taskFor: () => ({ task: status.task, plan: { units: [] } }) }))
  assert.equal(panel.counting.label, '已交付')
}, { git: true })

add('S58', '没建计划的小改动：插件收尾交付当场问「要不要看一眼」，回合在这里结束也看得到（v30 fix：静默交付）', ['review'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.cmd('start 给 a.js 加一个导出', { deliverFollowup: true })
  await h.register('给 a.js 加一个导出')
  await h.exec('echo "export const a = 1" > a.js')
  const before = h.receipts.length
  assert.equal((await h.stop('改好了。')).length, 1, '交付条件句先说一次')
  assert.equal((await h.stop('改好了。')).length, 0)
  assert.equal((await h.board()).task.state, 'review_ready')
  const forms = h.receipts.slice(before).map(row => row.form)
  assert.equal(forms.filter(form => form === 'review').length, 1, JSON.stringify(forms))
}, { git: true })

add('S59', '第一次写文件：「动手前」的条件句此刻出一次（不在开工堆着）；用户开工后说过话就不再提「先复述」（v30 clarify）', [], async h => {
  await h.cmd('start 列表要能按标签过滤，删除要二次确认，导出加日期，顺便改下帮助文案', { deliverFollowup: true })
  const before = h.hints.length
  await h.write('a.js', 'export const a = 1\n')
  const first = h.hints.slice(before).filter(row => row.summary === 'dsh-auto-dev first write')
  assert.equal(first.length, 1)
  assert.match(first[0].text, /先停下，对用户复述/)
  // 复述的格式是约定，不校验：固定开头、更省事的做法、只问一个、停下（v36 clarify 没停）。
  assert.match(first[0].text, /「\*\*我理解的要求：\*\*」[\s\S]*更好的做法[\s\S]*只问一个[\s\S]*结束这一回合/)
  assert.match(first[0].text, /一次只改一处/)
  await h.write('b.js', 'export const b = 1\n')
  assert.equal(h.hints.filter(row => row.summary === 'dsh-auto-dev first write').length, 1, '每个任务只说一次')
}, { git: true })

add('S60', '交付条件句不论哪条路交付都是一张胶囊、每任务一次；只写插件自己的 .auto-dev/ 文件不算改了项目（v36 feature / survey）', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.cmd('start 先帮我看懂这个项目，结论记下来', { deliverFollowup: true })
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true })
  await h.write('.auto-dev/project-domain.md', '# 摸底\n- 数据存在 notes.json\n')
  assert.equal(h.hints.filter(row => row.summary === 'dsh-auto-dev first write').length, 0, '插件自己的文件不是「改了第一个文件」')
  await h.tool('work_submit', { outcome: 'complete', summary: '看完了，结论写进 domain' })
  assert.equal(h.hints.filter(row => row.summary === 'dsh-auto-dev delivery').length, 0, '磁盘上项目没变，就没有交付条件句')
}, { git: true })

add('S61', '模型自己调工具交付：交付条件句也是胶囊（不是只塞进工具结果），之后回合结束不再说第二次', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.cmd('start 给 a.js 加一个导出', { deliverFollowup: true })
  await h.write('a.js', 'export const a = 1\n')
  const result = await h.tool('work_submit', { outcome: 'complete', summary: '加好了' })
  assert.equal((result.warnings ?? []).some(line => /如果是重构/.test(line)), false, '条件句不再藏在工具结果里')
  await h.step()
  const told = h.receipts.filter(row => row.form === 'read-doc' && /交付前对照一下/.test(JSON.stringify(row)))
  assert.equal(told.length, 1, JSON.stringify(h.receipts.map(row => row.form)))
  assert.equal((await h.stop('改好了。')).length, 0, '回合结束不再说第二次')
}, { git: true })

add('S76', '一次修通（用户 2026-11-04）：原样项目检查红一次就转绿 → 给人一张「一次修通」胶囊，模型那一行只说不用回应；连红两次才走排查（不出这张）；每个任务一次', ['read-doc'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.cmd('start 修一下 add 的重复 id', { deliverFollowup: true })
  await h.register('修一下 add 的重复 id')
  await h.exec('npm test')
  await h.step()
  assert.equal(h.receipts.filter(row => row.title === '一次修通').length, 0, '红着不说')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.exec('npm test')
  await h.step()
  const quick = h.receipts.filter(row => row.title === '一次修通')
  assert.equal(quick.length, 1)
  assert.match(quick[0].line, /`npm test` 红一次后转绿/)
  assert.match(quick[0].text, /给用户看的回执.*不用回应/)
  assert.equal(h.receipts.some(row => row.title === '修 bug · 排查'), false)
  // 再红一次、再绿：同一任务不再说。
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n'); await h.exec('npm test'); await h.step()
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n'); await h.exec('npm test'); await h.step()
  assert.equal(h.receipts.filter(row => row.title === '一次修通').length, 1, '每个任务一次')
})

add('S77', '看结果不看动作形状（用户 2026-11-04）：bash 改文件也出「动手前」；没改代码只把调查单元标 done 不跑 G1；同一单元交两次只出一张完成卡；登记前 G2 照拦', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  writeFileSync(join(h.state.project, 'a.js'), 'export const a = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: h.state.project }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: h.state.project })
  await h.cmd('start 修一下 a 的导出', { deliverFollowup: true })
  // 登记前：G2 精确词表里的命令照样先问。
  assert.equal((await h.pre('git reset --hard HEAD~1')).kind, 'deny', '登记前 G2 失效')
  await h.register('修一下 a 的导出')
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'find', goal: '定位根因' }, { id: 'fix', goal: '修好' }] })
  // 只读调查，检查还红，把调查单元标完成：磁盘没动，不跑 G1、不打回。
  await h.exec('npm test')
  const marked = await h.tool('work_plan', { operation: 'state', unit: 'find', state: 'done', text: '根因在 a.js' })
  assert.notEqual(marked?.started, false)
  if (h.receipts.some(row => row.form === 'blocked-call' && /交付/.test(row.title))) throw new Error('没改代码也被 G1 打回')
  // 同一单元再标一次 done：不再出第二张完成卡。
  await h.tool('work_plan', { operation: 'state', unit: 'find', state: 'done', text: '根因在 a.js' })
  assert.equal(h.receipts.filter(row => row.form === 'unit-done' && row.title === '第 1 步完成').length, 1, '同一单元两张完成卡')
  // 用 bash heredoc 改文件：「动手前」照出。
  await h.exec("cat > a.js <<'EOF'\nexport const a = 2\nEOF")
  assert.equal(h.hints.filter(hint => hint.summary === 'dsh-auto-dev first write').length, 1, 'bash 写文件没出动手前')
}, { git: true })

add('S78', '自动驾驶开关（用户 2026-11-04）：start --auto 开、auto off 关；开着时先理需求不等人、硬门照拦并改走可逆做法、交付列出没等确认的决定；关着且宿主有审批卡时硬门走原生是/否卡', ['read-doc', 'blocked-call'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  writeFileSync(join(h.state.project, 'a.js'), 'export const a = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: h.state.project }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: h.state.project })
  await h.cmd('start --auto 整理一下 a 的导出', { deliverFollowup: true })
  assert.ok(h.receipts.some(row => row.title === '自动驾驶 · 开'), '开关要有胶囊')
  const clarify = h.hints.find(hint => hint.summary === 'dsh-auto-dev start granted')
  assert.match(clarify.text, /原话逐字：「整理一下 a 的导出」/)
  assert.match(clarify.text, /自动驾驶开着：用户不会回话/)
  assert.doesNotMatch(clarify.text, /结束这一回合等他回/)
  await h.register('a.js 导出整理成具名导出')
  assert.equal((await h.board()).task.auto, true)
  // 硬门照拦，不让模型去问人：换可逆的做法，交付时列出来。
  const stopped = await h.pre('git reset --hard HEAD~1')
  assert.equal(stopped.kind, 'deny')
  assert.match(stopped.reason, /自动驾驶开着，用户不在：这一步不做，换一个可逆的做法继续/)
  await h.pick(CONSENT_YES)
  assert.equal((await h.pre('git reset --hard HEAD~1')).kind, 'deny', '自动驾驶下点选也不放行收不回的事')
  await h.exec("echo 'export const b = 2' >> a.js")
  await h.exec('npm test')
  const told = await h.stop('改好了。')
  assert.match(told[0]?.content?.[0]?.text ?? '', /自动驾驶开着：把没等用户确认就做的决定/)
  // 关掉之后：宿主有审批服务、会话策略是 ask，硬门走原生是/否卡。
  await h.cmd('auto off')
  await h.step()
  assert.equal((await h.board()).task.auto, false)
  assert.ok(h.receipts.some(row => row.title === '自动驾驶 · 关'))
  h.host.ctx.get = name => (name === 'approval' ? { request: async () => 'allowed-once' } : undefined)
  const ask = await h.pre('git push --force origin main')
  assert.equal(ask.kind, 'ask')
  assert.match(ask.displayReason.zh, /跑了就回不来.*要跑吗/)
  // 会话策略是 never：宿主不会弹卡，退回两个固定选项。
  h.state.log.push({ type: 'approval/policy', data: { policy: 'never' } })
  assert.equal((await h.pre('git push --force origin main')).kind, 'deny')
}, { git: true })

add('S79', '宿主重启（v50 clarify/test）：内存清空后，开工授权从日志里的 start 命令恢复，不说「只由用户手动启动」；「先理需求」「动手前」不重复', ['read-doc'], async h => {
  writeFileSync(join(h.state.project, 'a.js'), 'export const a = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: h.state.project }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: h.state.project })
  // 宿主日志里的命令与卡：真宿主写 command/run，插件卡进对话（spliced）。
  h.state.log.push({ type: 'command/run', data: { name: 'dsh-auto-dev', args: 'start --auto 给 a.js 加一个导出' } })
  await h.cmd('start --auto 给 a.js 加一个导出', { deliverFollowup: true })
  const said = summary => ({ type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user', source: { kind: 'dsh-auto-dev', summary }, content: [{ type: 'text', text: '…' }] }] } })
  h.state.log.push(said('dsh-auto-dev start granted'))
  // 重启：同一份日志和记录，插件内存全新。
  const second = await open({ project: h.state.project, sessionId: h.state.sessionId, tables: h.host.tables })
  second.state.log = h.state.log
  await second.host.handlers.get('agent/created')?.({ agent: agentFor(second.state) })
  const r = helpers(second.host, second.state)
  await r.say('继续')
  if (r.hints.some(hint => /只由用户手动启动|standing hint/.test(hint.text + hint.summary))) throw new Error('重启后说用户没开过工')
  if (r.hints.some(hint => hint.summary === 'dsh-auto-dev start granted')) throw new Error('重启后先理需求又说一遍')
  const opened = await r.tool('work_start', { request: 'a.js 新增导出 b' })
  assert.ok(opened.taskId, JSON.stringify(opened))
  assert.equal(r.host.tables.tasks[opened.taskId].auto, true, '自动驾驶从命令原文恢复')
  await r.exec("echo 'export const b = 2' >> a.js")
  assert.equal(r.hints.filter(hint => hint.summary === 'dsh-auto-dev first write').length, 1)
  h.state.log.push(said('dsh-auto-dev first write'))
  // 再重启一次：「动手前」不再说。
  setMarks(opened.taskId, {})   // 进程内的开工树也随重启没了
  const third = await open({ project: h.state.project, sessionId: h.state.sessionId, tables: h.host.tables })
  third.state.log = h.state.log
  await third.host.handlers.get('agent/created')?.({ agent: agentFor(third.state) })
  const t = helpers(third.host, third.state)
  await t.exec("echo 'export const c = 3' >> a.js")
  assert.equal(t.hints.filter(hint => hint.summary === 'dsh-auto-dev first write').length, 0, '重启后动手前又说一遍')
  // 重启前后都改过 a.js：开工树从任务记录还原，交付前对照照出，自动驾驶那句也在（v51 rt-auto 丢了这张）。
  const told = await t.stop('改好了。')
  assert.match(told[0]?.content?.[0]?.text ?? '', /交付前对照一下[\s\S]*自动驾驶开着/)
}, { git: true })

add('S80', '单元完成卡对得上号（v52）：里程碑标 done 关掉它下面所有没完成的叶子、各出一张；卡面写这个单元的目标，不写整件的总结', ['unit-done'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  await h.cmd('start 补测试', { deliverFollowup: true })
  await h.register('补 rm 的三条测试')
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'u1', goal: '补测试', units: [
    { id: 'u3', goal: '正常删除' }, { id: 'u4', goal: '删不存在的 id' }, { id: 'u5', goal: '删完再 add' }] }, { id: 'u2', goal: '跑检查' }] })
  await h.exec("echo 'x' > t.js")
  await h.exec('npm test')
  await h.tool('work_plan', { operation: 'state', unit: 'u1', state: 'done', text: '三条测试都加好了，整件做完' })
  const done = h.receipts.filter(row => row.form === 'unit-done')
  // 卡面不出编号：主题名 + 第几步。
  assert.deepEqual(done.map(row => row.title), ['补测试 · 第 1 步完成', '补测试 · 第 2 步完成', '补测试 · 第 3 步完成'])
  assert.deepEqual(done.map(row => row.line), ['正常删除', '删不存在的 id', '删完再 add'])
}, { git: true })

add('S81', '产物写进被 git 忽略的目录（v53 key_reverse outputs/）也算改动：动手前照出、收尾交付照走；交付卡列出还没标完成的步骤；卡面不出单元编号', ['read-doc'], async h => {
  writeFileSync(join(h.state.project, '.gitignore'), 'outputs/*\n')
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  execFileSync('git', ['add', '-A'], { cwd: h.state.project }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: h.state.project })
  mkdirSync(join(h.state.project, 'outputs'), { recursive: true })
  await h.cmd('start 调研输入法内存，出一份报告', { deliverFollowup: true })
  // 模型自报 look：只是展示用，不决定插件开不开口（v54 两次复现都是 look）。
  await h.tool('work_start', { request: '调研 iOS 键盘内存并出报告', mode: 'look', acceptanceMode: 'auto', plan: ['静态取证', '检索上限数值', '撰写报告'] })
  await h.write('outputs/REPORT.md', '# 报告\n')
  assert.equal(h.hints.filter(hint => hint.summary === 'dsh-auto-dev first write').length, 1, '写进被忽略目录也算第一次改动')
  // 模型没回报任何一步就说做完了：收尾时插件开口，把没标完成的步骤按名字摆出来。
  const told = await h.stop('报告已完成，写在 outputs/REPORT.md。')
  const text = told[0]?.content?.[0]?.text ?? ''
  assert.match(text, /还没标完成的步骤：第 1 步「静态取证」；第 2 步「检索上限数值」；第 3 步「撰写报告」——如果其中有已经做完的，交付时说出来；没做的说明原因/)
  assert.doesNotMatch(text, /\bu\d+\b|标成完成/, '不带编号、不教调工具')
  // 再结束一次：插件代交是任务级的，不替模型把任何一步标成完成；有改动就停在待验收，没标完的步骤写进提醒。
  await h.stop('报告已完成，写在 outputs/REPORT.md。')
  const board = await h.board()
  assert.equal(board.task.state, 'review_ready')
  assert.deepEqual(board.units.map(row => row.state), ['pending', 'pending', 'pending'])
  assert.ok(JSON.stringify(h.receipts).includes('这几步没标完成：静态取证、检索上限数值、撰写报告'))
  for (const row of h.receipts) assert.doesNotMatch(`${row.title} ${row.line} ${row.tag}`, /\bu\d+\b|task-[a-z0-9]+-|\bdaily\b/, `卡面露出编号：${row.title} ${row.line}`)
}, { git: true })

add('S82', '换步不切断红绿（v56 clarify）：红一次、换一步、再红 → 出排查卡、不出「一次修通」；没写目标的步骤在面板上按位置叫「第 N 步」，不用编号', ['read-doc'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.cmd('start 修 list', { deliverFollowup: true })
  await h.register('修 list')
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'u1', steps: [{}, { goal: '补测试' }] }, { id: 'u2', goal: '更新 usage' }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'u1' })
  await h.exec('npm test'); await h.step()
  await h.tool('work_plan', { operation: 'activate', unit: 'u2' })
  await h.exec('npm test'); await h.step()
  assert.ok(h.receipts.some(row => row.title === '修 bug · 排查'), '换了一步，第 2 次红照样出排查卡')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.exec('npm test'); await h.step()
  assert.equal(h.receipts.some(row => row.title === '一次修通'), false, '红了两次不是一次修通')
  const status = await h.board()
  const panel = boardOf(syncState({ ...h.state.log.reduce(foldBoard, null), sessionId: h.state.sessionId },
    { taskFor: () => ({ task: status.task, plan: { units: Object.values(h.host.tables.plans)[0].units } }) }))
  const goals = (panel.units ?? []).map(row => row.goal)
  for (const goal of goals) assert.doesNotMatch(goal, /\bu\d+(\.\d+)?\b|^单元 /, `面板露出编号：${goal}`)
  assert.ok(goals.includes('补测试') && goals.includes('更新 usage'), JSON.stringify(goals))
})

add('S83', '主题与 G1 的事实（v57 feature/clarify）：带名字的父项 + 没 id 的 steps → 父项是主题、面板按主题分组、「主题完成」排在最后一步之后；插件 G1 已跑绿的树再交，不说「还红着」', ['theme-seal'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  writeFileSync(join(h.state.project, 'a.js'), 'export const a = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: h.state.project }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: h.state.project })
  await h.cmd('start 加 search', { deliverFollowup: true })
  await h.register('加 search')
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'search-store', goal: '存储层', steps: [{ goal: '写 search()' }, { goal: '补单测' }] },
    { id: 'search-cli', goal: '命令行', steps: [{ goal: '接入命令' }] }] })
  assert.deepEqual(h.receipts.filter(row => row.form === 'theme-open').map(row => row.title || row.line).length, 2)
  const status = await h.board()
  const panel = boardOf(syncState({ ...h.state.log.reduce(foldBoard, null), sessionId: h.state.sessionId },
    { taskFor: () => ({ task: status.task, plan: Object.values(h.host.tables.plans)[0] }) }))
  assert.deepEqual((panel.milestones ?? []).filter(row => row.role !== 'daily').map(row => row.label), ['存储层', '命令行'], JSON.stringify(panel.milestones))
  assert.equal(Object.values(h.host.tables.plans)[0].units.find(row => row.id === 'search-store').parent, undefined, '主题不挂进日需')
  await h.exec("echo 'export const b = 2' >> a.js")
  await h.tool('work_submit', { unit: 'search-store.1', outcome: 'complete', summary: 'search 写好' }).catch(() => {})
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.tool('work_submit', { unit: 'search-store.1', outcome: 'complete', summary: 'search 写好' })
  const before = h.receipts.length
  await h.tool('work_submit', { unit: 'search-store.2', outcome: 'complete', summary: '单测补上' })
  const forms = h.receipts.slice(before).map(row => row.form)
  assert.ok(forms.indexOf('unit-done') >= 0 && forms.indexOf('unit-done') < forms.indexOf('theme-seal'), JSON.stringify(forms))
  // 时间线和看板用同一条推导：步骤都做完的主题，两边都是完成（v58 时间线 ○ 压着 ✓✓）。
  const timelineUnits = (await h.board()).timeline?.[0]?.units ?? []
  assert.equal(timelineUnits.find(row => row.id === 'search-store')?.state, 'done', JSON.stringify(timelineUnits))
  // 红过、插件 G1 已在这棵树上跑绿：再交不该说「还红着」。
  await h.exec('npm test').catch?.(() => {})
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n'); await h.exec('npm test'); await h.exec('npm test')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.exec("echo 'export const c = 3' >> a.js")
  await h.tool('work_submit', { unit: 'search-cli.1', outcome: 'complete', summary: '接上了' }).catch(() => {})
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true }); writeFileSync(join(h.state.project, '.auto-dev/incidents.md'), '## x\n根因：…\n')
  await h.tool('work_submit', { unit: 'search-cli.1', outcome: 'complete', summary: '接上了' })
  assert.equal(JSON.stringify(h.receipts.slice(-4)).includes('还红着'), false, '插件自己跑绿过的树不说还红着')
}, { git: true })

add('S62', '检查的截短写法：带 set -o pipefail 的 tail 照样记红绿；不带 pipefail 的 tail 退出码是 tail 的，不算（v36 模型总接 | tail）', ['read-doc', 'save'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.cmd('start 修一下 add 的重复 id', { deliverFollowup: true })
  await h.register('修一下 add 的重复 id')
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'f', goal: '修 add' }] })
  await h.exec('set -o pipefail; npm test 2>&1 | tail -5')
  await h.step()
  // 不带 pipefail：这一次的「绿」是 tail 的，插件不认，不能把红记成绿打断连续红。
  await h.exec('npm test 2>&1 | tail -5')
  await h.step()
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').length, 0, '第 1 次红不说话')
  await h.exec('set -o pipefail; npm test 2>&1 | tail -20')
  await h.step()
  const fix = h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求')
  assert.equal(fix.length, 1, '约定的截短写法连续第 2 次红出排查卡')
  assert.equal(fix[0].title, '修 bug · 排查')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.exec('set -o pipefail; npm test 2>&1 | tail -20')
  await h.step()
  assert.ok(h.receipts.some(row => row.form === 'save' && /修通/.test(row.line)), '截短写法转绿也存修通')
})

add('S63', 'F-fix：模型红两次后改用组合命令验证、自己没再原样跑检查；交付时插件 G1 自跑转绿，这次也算修通，没写复盘照样 G4 拦一次（v37 fix）', ['read-doc', 'save', 'blocked-call'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.cmd('start 修一下 add 的重复 id', { deliverFollowup: true })
  await h.register('修一下 add 的重复 id')
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'f', goal: '修 add' }] })
  for (let i = 0; i < 2; i++) { await h.exec('set -o pipefail; npm test 2>&1 | tail -40'); await h.step() }
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').at(-1)?.title, '修 bug · 排查')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.exec('cd . && W=$(mktemp -d) && npm test')
  await h.step()
  const args = { unit: 'f', outcome: 'complete', summary: '修好了' }
  await assert.rejects(h.tool('work_submit', args), /incidents\.md 没有变化/)
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true })
  writeFileSync(join(h.state.project, '.auto-dev/incidents.md'), '## add 重复 id\n根因：…\n')
  await h.tool('work_submit', args)
  assert.equal(h.receipts.filter(row => row.form === 'blocked-call').length, 1, '写了复盘就过，只拦一次')
}, { checkpoints: true, git: true })

add('S64', '第一次写文件：开工原话有 3 句以上、用户还没说过话 → 卡上逐字带出这几句（不判哪句是要求）；用户回过话后的新任务不带（v37 clarify 没复述）', [], async h => {
  await h.cmd('start notes 想加几个东西：list 能按关键词过滤；rm 删不存在的 id 不该说 removed；add 空文本应该拒绝。验收：npm test 全过', { deliverFollowup: true })
  const before = h.hints.length
  await h.write('a.js', 'export const a = 1\n')
  const first = h.hints.slice(before).find(row => row.summary === 'dsh-auto-dev first write')
  assert.match(first.text, /事实：开工原话断开是 3 句[\s\S]*「rm 删不存在的 id 不该说 removed」/)
  assert.doesNotMatch(first.text, /「验收/, '验收那句不算')
}, { git: true })

add('S66', 'D2 跨项目：项目 A 交付时复盘原文拷进 ~/.dsh-auto-dev（测试里是临时目录）；项目 B 开工卡带出 A 的最新一条，标明来自哪个项目；A 自己开工不带自己的那份', [], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true })
  writeFileSync(join(h.state.project, '.auto-dev/incidents.md'), '## 旧的一条\n根因：甲\n\n## rm 后 add 重复 id\n根因：id 取了数组长度\n')
  await h.cmd('start 修一下 add 的重复 id', { deliverFollowup: true })
  await h.register('修一下 add 的重复 id')
  await h.write('a.js', 'export const a = 1\n')
  await h.exec('npm test')
  await h.step()
  await h.tool('work_submit', { outcome: 'complete', summary: '修好了' })
  const shared = readdirSync(join(process.env.DSH_AUTO_DEV_HOME, 'incidents'))
  assert.ok(shared.length >= 1, '交付后团队目录里有这份复盘')
  const other = join(h.state.project, '..', 'project-b')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  const second = await open({ project: other, sessionId: 'session-s66-b' })
  const b = helpers(second.host, second.state)
  await b.cmd('start 给 notes 加 search', { deliverFollowup: true })
  await b.register('给 notes 加 search')
  const brief = b.hints.map(row => row.text).join('\n')
  assert.match(brief, /别的项目留下的复盘[\s\S]*project\][\s\S]*rm 后 add 重复 id/, 'B 的开工卡带 A 的最新一条，标项目路径')
  assert.doesNotMatch(brief, /旧的一条/, '每个项目只带最新一条')
  for (const verb of b.state.commands) h.state.commands.push(verb)
}, { git: true })

add('S65', '交接：另一个会话接手时，接手卡读回任务记录里的硬事实——开工原话、之后用户的话、最后一次原样检查与退出码、开工以来改过的文件、存档；模型不填任何东西', ['handoff'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'console.log("not ok 2 - search milk")\nprocess.exit(1)\n')
  await h.cmd('start 给 notes 加 search 命令', { deliverFollowup: true })
  await h.register('给 notes 加 search 命令')
  await h.say('搜索不区分大小写')
  await h.write('a.js', 'export const search = () => []\n')
  await h.exec('npm test')
  await h.step()
  await h.tool('work_control', { operation: 'pause', reason: '换窗口' })
  const second = await open({ project: h.state.project, sessionId: 'session-s65', tables: h.host.tables })
  const other = helpers(second.host, second.state)
  await other.cmd('adopt')
  for (const verb of other.state.commands) h.state.commands.push(verb)
  await other.step()
  for (const receipt of other.receipts) h.receipts.push(receipt)
  const card = other.hints.find(row => row.summary.startsWith('dsh-auto-dev handoff'))
  assert.ok(card, '接手卡到了模型')
  assert.match(card.text, /事实：开工原话：「给 notes 加 search 命令」/)
  assert.match(card.text, /事实：之后用户说过：「搜索不区分大小写」/)
  assert.match(card.text, /事实：最后一次项目检查 `npm test`：退出码非 0，输出末尾：[\s\S]*not ok 2 - search milk/)
  assert.match(card.text, /事实：开工以来改过的文件：.*a\.js/)
  assert.doesNotMatch(card.text, /继续 task-/, '插件自己的「继续」不算用户的话')
  assert.doesNotMatch(card.text, /operation:|work_\w+/)
}, { checkpoints: true, git: true })

add('S69', '团队约定：~/.dsh-auto-dev/conventions.md（用户自己写）开工卡原样带出，标明项目约定优先；没有这个文件就没有这一行', [], async h => {
  const file = join(process.env.DSH_AUTO_DEV_HOME, 'conventions.md')
  writeFileSync(file, '- 实跑配置一律 rig- 开头，业务名不带前缀\n')
  try {
    await h.cmd('start 给 notes 加 search', { deliverFollowup: true })
    await h.register('给 notes 加 search')
    const brief = h.hints.map(row => row.text).join('\n')
    assert.match(brief, /团队约定（用户写的原文；跟这个项目自己的约定冲突时，以项目为准）：\n- 实跑配置一律 rig- 开头/)
  } finally { rmSync(file, { force: true }) }
}, { git: true })

add('S68', '两次运行：项目里已有上次写的复盘，这次原样红两次 → 排查卡带 incidents.md 原文（实跑里模型常带 `cd … &&`，走不到，改由场景验）', ['read-doc'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true })
  writeFileSync(join(h.state.project, '.auto-dev/incidents.md'), '## rm 后 add 重复 id\n根因：id 取了数组长度\n')
  await h.cmd('start 修一下 add 的重复 id', { deliverFollowup: true })
  await h.register('修一下 add 的重复 id')
  for (let i = 0; i < 2; i++) { await h.exec('npm test'); await h.step() }
  const card = h.hints.find(row => /连续第 2 次退出码非 0/.test(row.text))
  assert.ok(card, '第 2 次红出排查卡')
  assert.match(card.text, /incidents\.md 最近几条（原文）：[\s\S]*根因：id 取了数组长度/)
}, { git: true })

add('S67','交接缺事实就不出那一行：检查跑在 `cd … && npm test` 里（不是原样命令，记录里没有）→ 接手卡不写「还没有跑过项目检查」（v40）', ['handoff'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  await h.cmd('start 给 notes 加 search 命令', { deliverFollowup: true })
  await h.write('a.js', 'export const search = () => []\n')
  await h.exec(`cd ${h.state.project} && npm test`)
  await h.step()
  await h.tool('work_control', { operation: 'pause', reason: '换窗口' })
  const second = await open({ project: h.state.project, sessionId: 'session-s67', tables: h.host.tables })
  const other = helpers(second.host, second.state)
  await other.cmd('adopt')
  for (const verb of other.state.commands) h.state.commands.push(verb)
  await other.step()
  for (const receipt of other.receipts) h.receipts.push(receipt)
  const card = other.hints.find(row => row.summary.startsWith('dsh-auto-dev handoff'))
  assert.ok(card, '接手卡到了模型')
  assert.doesNotMatch(card.text, /项目检查/, '记录里没有原样检查：整行不出，不写否定句')
  assert.match(card.text, /事实：开工以来改过的文件：.*a\.js/)
}, { checkpoints: true, git: true })

add('S55', 'F-fix（第三条路）：只认一字不差的检查与退出码；第 2 次红出排查卡并存修前，转绿存修通并提醒落盘，没写复盘交付被 G4 拦一次', ['read-doc', 'save', 'blocked-call'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.cmd('start 修一下 add 的重复 id', { deliverFollowup: true })
  await h.register('修一下 add 的重复 id')
  const brief = h.hints.map(row => row.text).join('\n')
  assert.match(brief, /项目检查是 `npm test`：跑就写 `npm test`；要截短输出就写 `set -o pipefail; npm test/, '开工约定检查写法')
  assert.match(brief, /如果用户要的是紧急止血/, '条件句由模型判断是否适用')
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'f', goal: '修 add' }] })
  await h.exec('npm test')
  await h.step()
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').length, 0, '第 1 次红不说话')
  // 包了管道的不是项目检查：插件看不见，宁可漏也不猜。
  await h.exec('npm test | tail -3')
  await h.step()
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').length, 0, '管道写法不算')
  // 临时副本里看新测试红（F-test）：不是项目检查，红两次也不出排查卡（v35 实跑走不到，移到这里验）。
  const copy = mkdtempSync(join(tmpdir(), 'dsh-copy-'))
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }))
  for (let i = 0; i < 2; i++) { await h.exec(`cd ${copy} && npm test`); await h.step() }
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').length, 0, '临时副本的红不算项目检查')
  await h.exec('npm test')
  await h.step()
  const fix = h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求')
  assert.equal(fix.length, 1)
  assert.equal(fix[0].title, '修 bug · 排查')
  assert.match(fix[0].text, /`npm test` 连续第 2 次退出码非 0/)
  assert.match(fix[0].text, /按可能性排序/)
  assert.ok(h.receipts.some(row => row.form === 'save' && /修之前/.test(row.line)), '修前存档')
  await h.exec('npm test')
  await h.step()
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').length, 1, '同一段红只出一次')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  await h.exec('npm test')
  await h.step()
  const fixed = h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').at(-1)
  assert.equal(fixed.title, '修通 · 记一笔')
  assert.match(fixed.text, /红了 3 次之后退出码 0/)
  assert.ok(h.receipts.some(row => row.form === 'save' && /修通/.test(row.line)), '修通存档')
  const args = { unit: 'f', outcome: 'complete', summary: '修好了' }
  await assert.rejects(h.tool('work_submit', args), /复盘落盘|incidents\.md 没有变化[\s\S]*过关：把这次写进/)
  assert.equal(h.receipts.at(-1).form, 'blocked-call')
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true })
  writeFileSync(join(h.state.project, '.auto-dev/incidents.md'), '## add 重复 id\n症状：…\n根因：…\n')
  await h.tool('work_submit', args)
  assert.equal(h.receipts.filter(row => row.form === 'blocked-call').length, 1, '写了复盘就过，只拦一次')
}, { checkpoints: true, git: true })

add('S56', '删除 · 还有引用：磁盘上消失的文件仍被引用才出卡（读磁盘，不读 rm 文本）；被测程序的 rm 子命令不算', ['read-doc'], async h => {
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 1' } }))
  writeFileSync(join(h.state.project, 'store.js'), 'export const load = () => 1\n')
  writeFileSync(join(h.state.project, 'cli.js'), "import { load } from './store.js'\nconsole.log(load())\n")
  execFileSync('git', ['add', '-A'], { cwd: h.state.project }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: h.state.project })
  await h.cmd('start 整理存储层', { deliverFollowup: true })
  await h.register('整理存储层')
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'r', goal: '整理' }] })
  await h.exec('node -e "console.log(\'rm 999\')"')
  await h.exec('npm test')
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title === '删除 · 还有引用').length, 0, '没东西消失就不说话')
  await h.exec('node -e "require(\'fs\').unlinkSync(\'store.js\')"')
  await h.exec('npm test')
  const card = h.receipts.filter(row => row.form === 'read-doc' && row.title === '删除 · 还有引用')
  assert.equal(card.length, 1)
  assert.equal(card[0].title, '删除 · 还有引用')
  assert.match(card[0].text, /这些文件里还出现「store」：cli\.js/)
  await h.exec('npm test')
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title === '删除 · 还有引用').length, 1, '同一个文件只说一次')
}, { git: true })

add('S57', '开工只给条件句和这个项目的原文：复盘与口径逐字带出，不按关键词出方法卡', [], async h => {
  mkdirSync(join(h.state.project, '.auto-dev'), { recursive: true })
  writeFileSync(join(h.state.project, '.auto-dev/incidents.md'), '## 导出乱码\n根因：没写 BOM\n')
  writeFileSync(join(h.state.project, '.auto-dev/project-domain.md'), '# 口径\n- 金额一律分为单位\n')
  await h.cmd('start 这个导出很慢，顺便重构一下，再补点测试', { deliverFollowup: true })
  await h.register('这个导出很慢，顺便重构一下，再补点测试')
  const brief = h.hints.map(row => row.text).join('\n')
  assert.match(brief, /根因：没写 BOM/)
  assert.match(brief, /金额一律分为单位/)
  assert.match(brief, /如果用户要的是紧急止血/)
  assert.equal(h.receipts.filter(row => row.form === 'read-doc' && row.title !== '先理需求').length, 0, '说慢、说重构都不出关键词卡')
  await h.say('先不做了')
  await h.tool('work_control', { operation: 'cancel', reason: '用户说先不做了' })
  assert.equal((await h.board()).task?.state ?? 'cancelled', 'cancelled')
})

add('S47', 'G2 只认精确词表：删临时目录、删项目目录都不弹授权（存档与删除卡兜底）；git reset --hard 要问，人点「同意」才放行', ['blocked-call'], async h => {
  await h.cmd('start 手动验证 CLI')
  await h.tool('work_start', { request: '手动验证 CLI', mode: 'do', scope: ['.'], acceptance: ['CLI 能跑'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'v1', goal: '验证', scope: ['.'], acceptance: ['能跑'] }] })
  // 实测会话 c9588d6f 里被拦下的原命令：只删 mktemp 建的目录和其中一个文件。
  const verify = 'tmp=$(mktemp -d); export NOTES_FILE="$tmp/notes.json"\necho one > "$tmp/notes.json"\nrm -f "$tmp/.notes-seq"; ls "$tmp"\nrm -rf "$tmp"'
  assert.equal((await h.pre(verify)).kind, 'continue', '清理 mktemp 临时目录不该要授权')
  assert.equal((await h.pre('rm -rf "docs/old build"')).kind, 'continue', '插件不猜 rm 删的是什么')
  assert.equal((await h.pre('echo "git reset --hard"')).kind, 'continue', '引号里的字是数据')
  const action = 'git reset --hard HEAD~1'
  assert.equal((await h.pre(action)).kind, 'deny', '精确词表里的要先问')
  await h.tool('work_plan', { operation: 'list' })
  assert.match(h.receipts.findLast(row => row.form === 'blocked-call')?.title ?? '', /不可逆/)
  await h.pick(CONSENT_NO)
  assert.equal((await h.pre(action)).kind, 'deny', '点了「不同意」照拦')
  await h.pick(CONSENT_YES)
  assert.equal((await h.pre(action)).kind, 'continue', '点了「同意」之后放行')
})

for (const scenario of scenarios) {
  if (only && !only.includes(scenario.id)) continue
  const dir = mkdtempSync(join(tmpdir(), `v3-scn-${scenario.id}-`))
  const project = join(dir, 'project')
  mkdirSync(project, { recursive: true })
  if (scenario.git) {
    // A checkpoint needs a repository with a commit to compare against; without
    // one the plugin honestly reports "nothing to capture", and the marks never
    // reach the board this scenario is about.
    const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
    git('init', '-q')
    writeFileSync(join(project, 'README.md'), '# demo\n')
    git('add', '.')
    git('-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', 'init')
  }
  const { host, state } = await open({ project, sessionId: `session-${scenario.id}`, checkpoints: Boolean(scenario.checkpoints) })
  const h = helpers(host, state)
  let error
  try { await scenario.run(h) } catch (cause) { error = String(cause?.message ?? cause) }
  const forms = h.receipts.map(row => row.form)
  const missing = scenario.must.filter(form => !forms.includes(form))
  const board = error ? null : await h.board().catch(() => null)
  // 一次调用可能同时带 operation 和 action（organize 就是这样）：两个都记，否则
  // 覆盖闸门会把真走过的分支报成缺口。
  const operations = h.calls.flatMap(call => {
    const found = []
    if (typeof call.args.operation === 'string') found.push(`${call.name}:${call.args.operation}`)
    if (typeof call.args.view === 'string') found.push(`${call.name}:view:${call.args.view}`)
    if (typeof call.args.action === 'string') found.push(`${call.name}:${call.args.action}`)
    return found
  })
  const panel = board ? {
    units: (board.units ?? []).length,
    milestones: (board.milestones ?? []).length,
    marks: (board.marks ?? []).length,
    deliverables: (board.units ?? []).filter(row => row.deliverable).length,
    asked: (board.units ?? []).filter(row => row.asked).length,
    hasReceipt: Boolean(board.task?.hasReceipt ?? board.hasReceipt),
    goalRevision: board.task?.goalRevision ?? board.goalRevision ?? 0,
  } : null
  if (golden) golden.push({ id: scenario.id, trace: h.trace, board, tables: state.tables, error })
  const cards = h.trace.map(({ message }) => message).filter(message => message?.source?.summary?.startsWith?.('dsh-auto-dev'))
    .map(message => ({ summary: message.source.summary, text: Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('') : String(message.content ?? '') }))
  rows.push({ cards, id: scenario.id, title: scenario.title, must: scenario.must, forms, commands: state.commands, operations, tools: h.calls.map(call => call.name), receipts: h.receipts, ...(h.hints.length ? { hints: h.hints } : {}), panel, panelKeys: board ? Object.keys(board) : [], missing, ...(error ? { error } : {}) })
  const mark = error ? 'ERR' : missing.length ? 'MISS' : 'ok'
  console.log(`${mark.padEnd(4)} ${scenario.id} ${scenario.title} → ${forms.join(', ') || '(none)'}${missing.length ? `  缺 ${missing.join(',')}` : ''}${error ? `  ✗ ${error}` : ''}`)
}

/**
 * Strip what changes between two runs of unchanged code: the per-run temp dir,
 * clock values and random ids. `name` maps an id to its stand-in; ids are numbered
 * in order of first appearance, so the same run always reads the same.
 */
function stabilise(text, name = (id, n) => `<id${n}>`) {
  const ids = new Map()
  const stable = id => { if (!ids.has(id)) ids.set(id, name(id, ids.size)); return ids.get(id) }
  return text
    .replace(/\/(private\/)?(var|tmp)\/[^"\s]*?v3-scn-S\d+-[A-Za-z0-9]+/g, '<dir>')
    .replace(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z\b/g, '<iso>')
    .replace(/"(\w*(?:[aA]t|[tT]ime|ts|[sS]ince|ms|Ms))": \d{9,}/g, '"$1": <n>')
    .replace(/\b(?:[a-z]+-)?[a-z0-9]{8}-[a-z0-9]{6}\b/g, stable)
    .replace(/\b[0-9a-f]{40}\b/g, stable)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, stable)
}

if (goldenFile) {
  // Equivalence capture (`--golden <file>`): every message, tool value and the
  // full board, with the per-run temp dir, clock values and random ids normalised
  // away so two runs of unchanged code are byte-identical.
  writeFileSync(goldenFile, stabilise(JSON.stringify(golden, null, 2)))
}

const outIndex = process.argv.indexOf('--out')
const outFile = outIndex > -1 ? process.argv[outIndex + 1] : 'design/scenarios.json'
mkdirSync(outFile.includes('/') ? outFile.slice(0, outFile.lastIndexOf('/')) : '.', { recursive: true })
// Committed output: stand-ins keep the kind (`task-3`), so the file still reads
// like the run it came from, and an unchanged run leaves nothing to commit.
writeFileSync(outFile, stabilise(JSON.stringify(rows, null, 2), (id, n) => `${/^[a-z]+-/.exec(id)?.[0] ?? 'id-'}${n}`))
const bad = rows.filter(row => row.missing.length || row.error)

// ——— 教填参数闸 ———
// Every card the plugin put in front of the model, in every scenario: none may
// teach a tool call or a field (设计约定「绝对禁忌」). Same words the replay counts.
const teaching = rows.flatMap(row => (row.cards ?? []).map(card => ({ id: row.id, summary: card.summary, fills: fillsIn(card.text) })))
  .filter(row => row.fills.length)
if (teaching.length) {
  console.log('\n教填参数的卡 → 卡片只说发生了什么和一句做法，参数归工具描述：')
  for (const row of teaching) console.log(`  ${row.id} ${row.summary}：${row.fills.join('、')}`)
}

// ——— 卡面编号闸 ———
// What a person reads on a card never names an internal id (用户 2026-11-04: 右侧面板给非技术人用).
const FACE_ID = /\bu\d+\b|\btask-[a-z0-9]+-[a-z0-9]+\b|\bproposal-[a-z0-9]+|\bdaily\b/
const faceIds = rows.flatMap(row => (row.receipts ?? []).map(card => ({ id: row.id, face: [card.title, card.line, card.tag, ...(card.warnings ?? [])].filter(Boolean).join(' · ') })))
  .filter(row => FACE_ID.test(row.face))
if (faceIds.length) {
  console.log('\n卡面露出内部编号 → 给人看的地方用「第 N 步」、任务名：')
  for (const row of faceIds) console.log(`  ${row.id} ${row.face}`)
}

// ——— 覆盖闸门 ———
// The bench is the only thing that sees the products of the control plane, so a
// path that exists in the code and not here is a path nobody checks. The lists
// are derived from the source (tools/inventory.mjs) instead of being kept by
// hand: a new form, verb, tool or enum value fails this gate until a scenario
// exercises it, which is what makes "add a path, add a scenario" a rule.
const formsSeen = new Set(rows.flatMap(row => row.forms))
const verbsSeen = new Set(rows.flatMap(row => row.commands))
const toolsSeen = new Set(rows.flatMap(row => row.tools))
const operationsSeen = new Set(rows.flatMap(row => row.operations))
const panelSeen = new Set(rows.flatMap(row => row.panelKeys))

// `notice` is the generic fallback a nudge uses when a form is not named: prose
// for the model, not a product; the unit tests cover it.
const INVENTORY = inventory()
const FORM_EXEMPT = new Set(['notice'])
const formGaps = INVENTORY.forms.filter(form => !FORM_EXEMPT.has(form) && !formsSeen.has(form))
const formStale = [...formsSeen].filter(form => !INVENTORY.forms.includes(form))
const verbGaps = INVENTORY.verbs.filter(verb => !verbsSeen.has(verb))
const toolGaps = INVENTORY.tools.filter(tool => !toolsSeen.has(tool))
const operationGaps = INVENTORY.operations.filter(operation => !operationsSeen.has(operation))
const panelMissing = PANEL_KEYS.filter(key => !panelSeen.has(key))
const panelUndeclared = [...panelSeen].filter(key => !PANEL_KEYS.includes(key))

if (!only) {
  const report = (title, gaps, hint) => {
    if (!gaps.length) return
    console.log(`\n${title} → ${gaps.join(', ')}`)
    console.log(`  ${hint}`)
  }
  report('覆盖缺口：代码里有、但没有场景产出的回执 form', formGaps, '在 tools/scenarios.mjs 加一个场景，并把 form 写进它的 must')
  report('多余断言：场景还在等、代码已不再发出的 form', formStale, '删掉场景 must 里过时的 form')
  report('命令缺口：这些命令动词没有任何场景跑过', verbGaps, '在场景里真的 h.cmd(…) 一次')
  report('工具缺口：这些工具没有任何场景调用过', toolGaps, '加一个场景真的 h.tool(…) 一次')
  report('分支缺口：这些操作分支没有任何场景走到', operationGaps, '覆盖每个 operation/view/action 值')
  report('面板缺口：面板视图里没有这些字段', panelMissing, '确认 boardOf/planView 仍然透出，或更新 PANEL_KEYS')
  report('面板新字段：这些字段面板有了，但覆盖清单没登记', panelUndeclared, '在 tools/inventory.mjs 的 PANEL_KEYS 里登记，并让某个场景断言它')
}

const coverageBad = !only && (formGaps.length + formStale.length + verbGaps.length + toolGaps.length
  + operationGaps.length + panelMissing.length + panelUndeclared.length) > 0
const covered = INVENTORY.forms.filter(form => FORM_EXEMPT.has(form) || formsSeen.has(form)).length
console.log(`\n${rows.length} 个场景，${bad.length} 个未达预期 → ${outFile}`)
const counts = {
  forms: [covered, INVENTORY.forms.length],
  verbs: [INVENTORY.verbs.length - verbGaps.length, INVENTORY.verbs.length],
  tools: [INVENTORY.tools.length - toolGaps.length, INVENTORY.tools.length],
  operations: [INVENTORY.operations.length - operationGaps.length, INVENTORY.operations.length],
  panel: [PANEL_KEYS.length - panelMissing.length, PANEL_KEYS.length],
}
console.log(`覆盖：${counts.forms[0]}/${counts.forms[1]} form · ${counts.verbs[0]}/${counts.verbs[1]} 命令 · `
  + `${counts.tools[0]}/${counts.tools[1]} 工具 · `
  + `${counts.operations[0]}/${counts.operations[1]} 分支 · `
  + `${counts.panel[0]}/${counts.panel[1]} 面板字段${coverageBad ? '（有缺口）' : ''}`)
process.exit(bad.length || coverageBad || (!only && (teaching.length || faceIds.length)) ? 1 : 0)

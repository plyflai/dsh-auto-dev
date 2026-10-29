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
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { inventory, PANEL_KEYS } from './inventory.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { stubHost } from './flow.mjs'
import { readEnv } from '../src/env.mjs'
import { readMemory } from '../src/memory.mjs'

const formsOf = message => message?.source?.form

function agentFor(state) {
  return {
    id: `agent-${state.sessionId}`,
    session: {
      id: state.sessionId,
      header: { id: state.sessionId },
      get seq() { return state.log.length },
      eventAt: index => state.log[index],
      append: async event => { state.log.push(event); return event },
    },
    followup: async message => { state.log.push({ type: 'user/message', data: { message } }); return {} },
  }
}

async function open({ project, sessionId, checkpoints = false, tables }) {
  const host = stubHost({ cwd: project, ...(tables ? { tables } : {}) })
  await apply(host.ctx, { checkpoints })
  const state = { project, sessionId, log: [], tables: host.tables, grants: [], commands: [] }
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
    if (message.source?.summary?.startsWith('auto-dev-v3')) hints.push({
      summary: message.source.summary,
      text: (message.content ?? []).map(part => part.text ?? '').join(''),
    })
    if (!form) return
    receipts.push({ form, title: message.source.data?.title ?? '', line: message.source.data?.line ?? '', tag: message.source.data?.tag ?? '', ...(message.source.data?.warnings ? { warnings: message.source.data.warnings } : {}), text: Array.isArray(message.content) ? message.content.map(p => p.text ?? '').join('') : String(message.content ?? '') })
  }
  const agent = () => agentFor(state)
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
      if (/^(start|new)\b/.test(String(rawInput).trim())) state.grants.push(rawInput)
      return result
    },
    async tool(name, args = {}) {
      const definition = host.tools.get(name)
      if (!definition) throw new Error(`tool ${name} is not offered (not opted in?)`)
      calls.push({ name, args })
      const callId = `call-${name}-${state.log.length}`
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
      const callId = `call-bash-${state.log.length}`
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
    async pre(command) {
      return host.handlers.get('tools/pre-execute')({ agent: agent(), callId: `pre-${state.log.length}`, name: 'bash', arguments: { command } }, async () => ({ kind: 'continue' }))
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
add('S04', '载入模式 + 进入测试（refactor/verification 单元）', ['read-doc', 'verify-start'], async h => {
  await h.cmd('start 重构导出并回归')
  await h.tool('work_start', { request: '重构导出并回归', mode: 'do', scope: ['.'], acceptance: ['旧行为不变'] })
  await h.tool('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '重构导出', kind: 'refactor', scope: ['src/export.js'], acceptance: ['旧接口不变'] },
    { id: 'b2', goal: '回归', kind: 'verification', scope: ['.'], acceptance: ['旧接口全过'] },
  ] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  await h.tool('work_plan', { operation: 'activate', unit: 'b2' })
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
add('S12', '换个更省事的做法', ['alternative'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_control', { operation: 'alternative', text: '先复用现有导出器，只补两种格式' })
})
add('S13', '真实失败给排查方法，分段进展不触发停工', ['read-doc'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  for (let i = 0; i < 3; i += 1) {
    const ran = await h.exec('node -e "console.log(1)"')
    await h.tool('work_submit', { outcome: 'partial', summary: `发现 ${i + 1}`, next: '继续排查', claims: [{ statement: '实际探针完成', execution: { callId: ran } }] })
  }
  await h.step()
  assert.equal(h.hints.some(row => /method debug/.test(row.summary)), false)
  const fail = 'node -e "process.exit(1)"'
  await h.exec(fail)
  await h.exec(fail)
  await h.step()
  assert.match(h.hints.find(row => /method debug/.test(row.summary))?.text ?? '', /最小复现/)
  assert.equal(h.receipts.some(row => row.form === 'halt'), false)
  assert.equal((await h.board()).task.state, 'active')
})
add('S14', 'postmortem（带失败关掉）', ['postmortem'], async h => {
  await h.cmd('start 做一个导出')
  await h.tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能导'] }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'b1' })
  const ran = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'b1', outcome: 'blocked', summary: '跑了三次都空表', next: '再看', claims: [{ statement: '跑了一遍，空表', execution: { callId: ran } }] })
  await h.tool('work_control', { operation: 'cancel', reason: '先放下' })
  await h.step()
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

add('S27', '存档与回滚', [], async h => {
  await h.cmd('start 改一个文件')
  // 先把工作树弄脏：`git stash create` 只收已跟踪文件的改动，干净树什么都没有。
  writeFileSync(join(h.state.project, 'README.md'), '# first change\n')
  await h.tool('work_start', { request: '改一个文件', mode: 'do', scope: ['.'], acceptance: ['改完'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '改文件', scope: ['.'], acceptance: ['改完'] }] })
  writeFileSync(join(h.state.project, 'README.md'), '# changed\n')
  const saved = await h.tool('work_control', { operation: 'checkpoints' })
  // The grant needs the person's own words on file: they say it first, then the
  // model asks for permission quoting them.
  const action = `rollback ${saved.recorded.before.ref ?? saved.recorded.before.commit}`
  await h.tool('work_extend', { kind: 'authorization', risk: 'rollback', action, reason: '要撤回到改动前' })
  const authorization = `允许 ${action}`
  await h.say(authorization)
  await h.tool('work_extend', { kind: 'authorization', risk: 'rollback', action, reason: '要撤回到改动前', authorization })
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

add('S32', '命令已授权：提示登记任务，写文件不再要求重输命令，看板出现目标', [], async h => {
  const request = '把登录按钮改成进度条'
  await h.cmd(`start ${request}`, { deliverFollowup: true })
  const granted = h.hints.find(hint => hint.summary === 'auto-dev-v3 start granted')
  if (!granted?.text.includes('work_start 登记任务') || !granted.text.includes(request)) throw new Error('命令后的真实 pre-step 没有提示登记原始请求')
  if (h.hints.some(hint => /standing hint|resume hint/.test(hint.summary))) throw new Error('有效授权被未开工或续接提示覆盖')
  await h.exec('printf draft > draft.txt')
  const writeHint = h.hints.find(hint => hint.summary === 'auto-dev-v3 start hint')
  if (writeHint?.text !== granted.text) throw new Error('登记前写文件仍要求用户重输命令')
  if (Object.keys(h.host.tables.tasks).length !== 0) throw new Error('提示不应自动创建任务')
  await h.tool('work_start', { request: '模型缩写', mode: 'do', scope: ['.'], acceptance: ['按钮显示进度'] })
  const board = await h.board()
  if (board.task?.request !== request) throw new Error('看板缺少命令中的原始目标')
  if (board.timeline?.length !== 1 || !board.timeline[0].current) throw new Error('登记后看板仍为空')
})

add('S33', 'P0：界面检查拒绝不落账（只给人一行「拦下」），修复后只完成一次', ['unit-open', 'blocked-call', 'task-done'], async h => {
  await h.cmd('start 实际运行界面逻辑检查')
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }))
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(1)\n')
  await h.tool('work_start', { request: '实际运行界面逻辑检查', mode: 'do', acceptanceMode: 'auto', scope: ['.'], acceptance: ['项目测试通过'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'ui', goal: '验证界面逻辑', scope: ['.'], acceptance: ['检查通过'], ui: 'logic' }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'ui' })
  const proof = await h.exec('node -e "console.log(1)"')
  const args = { unit: 'ui', outcome: 'complete', summary: '检查通过', next: '查看结果', claims: [{ statement: '检查通过', execution: { callId: proof } }] }
  const before = structuredClone(h.host.tables), count = h.receipts.length
  await assert.rejects(h.tool('work_submit', args), /logic|界面|UI/)
  assert.deepEqual(h.host.tables, before)
  assert.equal(h.receipts.length, count + 1)
  assert.equal(h.receipts.at(-1).form, 'blocked-call')
  assert.match(h.receipts.at(-1).title, /拦下 · 交付退回/)
  const failed = await h.exec('npm test')
  await assert.rejects(h.tool('work_submit', { ...args, claims: [{ statement: 'npm test 通过', execution: { callId: failed } }] }), /failed/)
  await assert.rejects(h.tool('work_submit', args), /logic|界面|UI/)
  assert.deepEqual(h.host.tables, before)
  const masked = await h.exec('npm test; echo "[exit code: $?]"')
  await assert.rejects(h.tool('work_submit', { ...args, claims: [{ statement: 'npm test 通过', execution: { callId: masked } }] }), /mask a check.s failure/)
  assert.deepEqual(h.host.tables, before)
  assert.equal(h.receipts.length, count + 1, '同一单元反复退回只说一次')
  writeFileSync(join(h.state.project, 'check.mjs'), 'process.exit(0)\n')
  const passed = await h.exec('npm test')
  await h.tool('work_submit', { ...args, claims: [{ statement: '项目测试通过', execution: { callId: passed } }] })
  assert.equal(Object.values(h.host.tables.tasks)[0].ledger.length, 1)
  assert.equal(h.receipts.filter(row => row.form === 'task-done').length, 1)
})

add('S34', 'P0：全部计划入口拒绝伪完成，阻塞单元保持可见', ['unit-open', 'unit-done'], async h => {
  await h.cmd('start 检查计划完成边界')
  const a = { id: 'a', goal: '先做检查', scope: ['.'], acceptance: ['检查通过'] }
  await assert.rejects(h.tool('work_start', { request: '检查计划完成边界', mode: 'do', scope: ['.'], acceptance: ['全部完成'], plan: { units: [{ ...a, state: 'done' }] } }), /done|work_submit/)
  await h.cmd('start 检查计划完成边界')
  await h.tool('work_start', { request: '检查计划完成边界', mode: 'do', acceptanceMode: 'auto', scope: ['.'], acceptance: ['全部完成'] })
  await assert.rejects(h.tool('work_plan', { operation: 'set', units: [{ ...a, state: 'done' }] }), /done|work_submit/)
  await h.tool('work_plan', { operation: 'set', units: [a, { id: 'b', goal: '等待外部条件', state: 'blocked', scope: ['.'], acceptance: ['条件满足'] }] })
  await assert.rejects(h.tool('work_plan', { operation: 'add', units: [{ ...a, id: 'c', state: 'done' }] }), /done|work_submit/)
  await assert.rejects(h.tool('work_plan', { operation: 'state', unit: 'a', state: 'done' }), /work_submit/)
  await h.tool('work_plan', { operation: 'state', unit: 'b', state: 'blocked' })
  for (const state of ['pending', 'active', 'blocked', 'dropped']) {
    await h.tool('work_plan', { operation: 'state', unit: 'b', state })
    const before = structuredClone(h.host.tables), count = h.receipts.length
    for (const units of [[a], [a, { id: 'b', goal: '不能隐藏原工作', units: [{ id: 'c', goal: '新子项', scope: ['.'], acceptance: [] }] }]]) {
      await assert.rejects(h.tool('work_plan', { operation: 'set', units }), /cannot remove unfinished leaf b/)
      assert.deepEqual(h.host.tables, before)
      assert.equal(h.receipts.length, count)
    }
  }
  await h.tool('work_plan', { operation: 'state', unit: 'b', state: 'blocked' })
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  const proof = await h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', { unit: 'a', outcome: 'complete', summary: '检查通过', next: '处理阻塞', claims: [{ statement: '检查通过', execution: { callId: proof } }] })
  const board = await h.board()
  assert.equal(board.task.state, 'active')
  assert.deepEqual(board.task.acceptance, ['全部完成'])
  assert.ok(board.task.unverified.some(text => text.includes('b')))
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
  await h.tool('work_plan', { operation: 'add', units: [{ id: 'c', goal: '最后检查', scope: ['.'], acceptance: ['检查通过'] }] })
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

add('S35', 'P0：环境禁令可按真实决定撤销，其他禁令保留', ['env'], async h => {
  await h.cmd('start 检查环境禁令')
  await h.tool('work_start', { request: '检查环境禁令', mode: 'do', scope: ['.'], acceptance: ['禁令来源可查'] })
  for (const key of ['migrations', 'secrets']) {
    await h.tool('work_env', { operation: 'propose', kind: 'blocked', key, value: `不得修改 ${key}/` })
    if (key === 'migrations') for (const note of ['migrations 禁令有问题', '之后再说 migrations']) {
      const before = await readEnv(h.state.project)
      await h.say(note)
      const count = h.receipts.length
      await assert.rejects(h.tool('work_env', { operation: 'confirm', key, note }), /explicitly confirm/)
      assert.deepEqual(await readEnv(h.state.project), before)
      assert.equal(h.receipts.length, count)
    }
    if (key === 'migrations') {
      const before = await readEnv(h.state.project), count = h.receipts.length
      h.state.log.push({ type: 'tool/call', data: { callId: 'env-defer', name: 'ask_user_question', arguments: {
        questions: [{ question: '确认 migrations 禁令吗？', options: ['采用候选', '之后再说'] }] } } })
      h.state.log.push({ type: 'tool/result', data: { message: { toolCallId: 'env-defer',
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ answer: '之后再说' }] }) }] } } })
      await assert.rejects(h.tool('work_env', { operation: 'confirm', key, note: '之后再说' }), /explicitly confirm/)
      assert.deepEqual(await readEnv(h.state.project), before)
      assert.equal(h.receipts.length, count)
    }
    await h.say(`确认 ${key} 禁令`)
    await h.tool('work_env', { operation: 'confirm', key, note: `确认 ${key} 禁令` })
  }
  assert.equal((await h.pre('cat migrations/old.sql')).kind, 'deny')
  await h.say('不要撤销 migrations 禁令')
  await assert.rejects(h.tool('work_env', { operation: 'forget', key: 'migrations', note: '不要撤销 migrations 禁令' }), /refuses/)
  await h.say('撤销 migrations 禁令')
  await h.tool('work_env', { operation: 'forget', key: 'migrations', note: '撤销 migrations 禁令' })
  const receipt = h.receipts.findLast(row => row.form === 'env-forget')
  assert.match(receipt.line, /用户已撤销规则 migrations/)
  assert.doesNotMatch(JSON.stringify(receipt), /已删/)
  const env = await readEnv(h.state.project)
  assert.equal(env.blocked.find(row => row.key === 'migrations').status, 'stale')
  assert.equal(env.blocked.find(row => row.key === 'migrations').history.length, 1)
  assert.equal((await h.pre('cat migrations/old.sql')).kind, 'continue')
  assert.equal((await h.pre('cat secrets/token.txt')).kind, 'deny')
})

add('S36', 'P0：真实验收与重做建立新证据窗口', ['unit-done', 'review-revise', 'review-done'], async h => {
  await h.cmd('start 检查真人验收')
  await h.tool('work_start', { request: '检查真人验收', mode: 'do', acceptanceMode: 'pm', scope: ['.'], acceptance: ['项目测试通过'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'a', goal: '项目检查', scope: ['.'], acceptance: [] }] })
  const old = await h.exec('node -e "console.log(1)"')
  const args = { unit: 'a', outcome: 'complete', summary: '项目检查通过', next: '等待验收', claims: [{ statement: '项目检查通过', execution: { callId: old } }] }
  await h.tool('work_submit', args)
  await assert.rejects(h.tool('work_control', { operation: 'resume' }), /refuses/)
  await h.say('不通过，需要修改')
  await assert.rejects(h.tool('work_control', { operation: 'accept', text: '不通过，需要修改' }), /refuses|rework/)
  await h.tool('work_control', { operation: 'rework', text: '不通过，需要修改' })
  await assert.rejects(h.tool('work_submit', args), /window|before|recorded|evidence/)
  const fresh = await h.exec('node -e "console.log(2)"')
  await h.tool('work_submit', { ...args, claims: [{ statement: '重新检查通过', execution: { callId: fresh } }] })
  await h.say('验收通过，这一版收下')
  await h.tool('work_control', { operation: 'accept', text: '验收通过，这一版收下' })
  const count = h.receipts.length
  assert.equal((await h.tool('work_control', { operation: 'accept', text: '验收通过，这一版收下' })).unchanged, true)
  assert.equal(h.receipts.length, count)
  assert.equal((await h.board()).task.state, 'closed')
})

add('S37', 'P1：统一记录五种信息，真实未决才等待', ['ask', 'alternative', 'postmortem'], async h => {
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
  assert.equal((await h.tool('work_control', { operation: 'clarify', answers: [{ q: '输出位置？', answer: '根目录' }] })).waiting, 'user-choice')
  const resolved = await h.tool('work_control', { operation: 'alternative', text: '复用现有探针', verdict: 'kept' })
  assert.equal(resolved.waiting, null)
  assert.equal(resolved.continueAuthorized, true)
  await h.tool('work_control', { operation: 'goal', text: '旧入口仍可修订目标' })
  const before = JSON.stringify(h.host.tables)
  await assert.rejects(h.tool('work_control', { operation: 'record', entries: [{ kind: 'goal', text: '不得落盘' }, { kind: 'invalid' }] }), /record kind/)
  assert.equal(JSON.stringify(h.host.tables), before)
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
  await assert.rejects(h.tool('work_env', args), /fresh observation/)
  await h.tool('work_env', { ...args, callId: await h.exec(command) })
  await assert.rejects(h.tool('work_env', { ...args, kind: 'blocked' }), /protected rules/)
  await h.say('预览地址 http://localhost:4321')
  await h.tool('work_env', { operation: 'observe', kind: 'gui', key: 'preview', value: 'http://localhost:4321', quote: '预览地址 http://localhost:4321' })
  const env = await readEnv(h.state.project)
  assert.equal(env.gui[0].source.by, 'user')
  assert.match((await h.tool('work_env', { operation: 'list' })).digest.gui[0], /observed; user;/)
})
add('S39', 'P1：无计划也有独立方法，无二十次调用催账', ['read-doc'], async h => {
  await h.cmd('start 优化一下并交接探针')
  await h.tool('work_start', { request: '优化一下并交接探针', mode: 'do', scope: ['.'], acceptance: ['能运行'] })
  await h.step()
  for (const event of ['ambiguity', 'impact', 'release']) assert.ok(h.hints.some(row => row.summary === `auto-dev-v3 method ${event}`))
  const count = h.hints.filter(row => /method /.test(row.summary)).length
  await h.step()
  assert.equal(h.hints.filter(row => /method /.test(row.summary)).length, count)
  for (let i = 0; i < 21; i++) await h.exec('node -e "console.log(1)"')
  await h.step()
  assert.equal(h.hints.some(row => /settle-up|no-active-unit/.test(row.summary)), false)
  assert.equal((await h.board()).task.state, 'active')
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

add('S44', '交付带人话提醒：没跑项目检查的完成回执自带那一句，记录里也留着', ['unit-done'], async h => {
  await h.cmd('start 改报告标题')
  writeFileSync(join(h.state.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  await h.tool('work_start', { request: '改报告标题', mode: 'do', acceptanceMode: 'auto', scope: ['.'], acceptance: ['标题已改'] })
  await h.tool('work_plan', { operation: 'set', units: [{ id: 'a', goal: '改标题', scope: ['.'], acceptance: ['标题已改'] }, { id: 'b', goal: '改正文', scope: ['.'], acceptance: ['正文已改'] }] })
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  await h.exec('echo title > report.md')
  const look = await h.exec('cat report.md')
  await h.tool('work_submit', { unit: 'a', outcome: 'complete', summary: '标题改好了', next: '改正文', claims: [{ statement: '标题已改', execution: { callId: look } }] })
  const done = h.receipts.find(row => row.form === 'unit-done')
  assert.match(done.warnings?.[0] ?? '', /^没跑项目检查/)
  const entry = Object.values(h.host.tables.tasks)[0].ledger.at(-1)
  assert.deepEqual(entry.reminders, done.warnings)
  assert.equal(entry.claims[0].execution.callId, look)
})

add('S43', '方法提示不刷屏：连续改文件只提醒一次验证，同一命令反复失败只提醒一次排查', ['read-doc'], async h => {
  await h.cmd('start 整理报告')
  await h.tool('work_start', { request: '整理报告', mode: 'do', scope: ['.'], acceptance: ['报告可读'] })
  const count = key => h.hints.filter(row => row.summary === `auto-dev-v3 method ${key}`).length
  // 研究会话里常见的节奏：一条 sed、一次重定向、一次脚本写文件，中间夹着检查。
  for (const command of ['echo a > report.md', 'sed -i.bak s/a/b/ report.md', 'node -e "require(\'fs\').writeFileSync(\'x.txt\',\'1\')" > log.txt']) {
    await h.exec(command)
    await h.step()
    await h.exec('cat report.md')
    await h.step()
  }
  assert.equal(count('verification'), 1, '提交前的连续写只该提醒一次验证')
  const check = await h.exec('cat report.md')
  await h.tool('work_submit', { outcome: 'partial', summary: '报告初稿', next: '补结论', claims: [{ statement: '报告已写出', execution: { callId: check } }] })
  await h.step()
  assert.equal(count('verification'), 1, '提交已经覆盖了之前的改动，提交后不该再提醒')
  await h.exec('echo c >> report.md')
  await h.step()
  assert.equal(count('verification'), 2, '提交之后再改文件是新的一段，要再提醒')
  const probe = 'node probe.cjs'
  writeFileSync(join(h.state.project, 'probe.cjs'), 'process.exit(1)')
  for (let i = 0; i < 4; i += 1) { await h.exec(probe); await h.step() }
  assert.equal(count('debug'), 1, '同一条命令连续失败只提醒一次排查')
  writeFileSync(join(h.state.project, 'probe.cjs'), 'process.exit(0)')
  await h.exec(probe)
  writeFileSync(join(h.state.project, 'probe.cjs'), 'process.exit(1)')
  await h.exec(probe)
  await h.step()
  assert.equal(count('debug'), 2, '这条命令跑通过之后再失败，是新问题，要再提醒')
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
  rows.push({ id: scenario.id, title: scenario.title, must: scenario.must, forms, commands: state.commands, operations, tools: h.calls.map(call => call.name), receipts: h.receipts, ...(h.hints.length ? { hints: h.hints } : {}), panel, panelKeys: board ? Object.keys(board) : [], missing, ...(error ? { error } : {}) })
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
process.exit(bad.length || coverageBad ? 1 : 0)

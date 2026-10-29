/**
 * Drive one Auto Dev v3 task end to end against the real plugin, with a stub
 * host. Every step of the workflow has to be demonstrable here —
 * unit tests prove functions, this proves the workflow a person and a model
 * actually go through.
 *
 *   node tools/flow.mjs             # 打印一次完整流程
 *   node tools/flow.mjs --json      # 机器可读
 *
 * It is also the stub host the workflow test reuses, so the stub lives in one
 * place instead of drifting between a script and a test.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'

/**
 * A stub host: enough of the cordis surface for `apply`, plus the tables the
 * plugin's record layer reads. Storage is in memory, so a run never touches
 * the real `storages/auto_dev_v3`.
 */
export function stubHost({ cwd = '/repo/example', tables = null } = {}) {
  const tools = new Map()
  const handlers = new Map()
  const commands = []
  const projections = []
  const effects = []
  const subContexts = {
    sessionProjections: {
      sessionProjections: {
        register: spec => {
          projections.push(spec)
          return () => {}
        },
      },
    },
    skills: {
      skills: {
        registerProvider: factory => {
          subContexts.__skills = factory
          return () => {}
        },
      },
    },
    commands: {
      commands: {
        register: command => {
          commands.push(command)
          return () => {}
        },
      },
    },
    sessions: { sessions: { flush: async () => true } },
  }
  const store = tables ?? { tasks: {}, plans: {}, decisions: {}, sessions: {} }
  const backend = {
    kv: {
      open: () => ({
        loadAll: async () => ({ tables: store }),
        putRecord: async () => {},
        deleteRecord: async () => {},
        close: async () => {},
      }),
    },
  }
  const ctx = {
    tools: {
      register: definition => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    storage: { backend: { get: () => backend } },
    workingDirectory: { get: () => cwd },
    inject: (services, run) => {
      if (services.every(service => subContexts[service])) run({ ...subContexts[services[0]] })
    },
    on: (event, handler) => {
      // The real host runs every listener as a middleware chain. The stub used to
      // keep only the last one, which silently hid every earlier notice — the
      // bench then "verified" behaviour the host never produces.
      const previous = handlers.get(event)
      handlers.set(event, previous
        ? (payload, next) => previous(payload, () => handler(payload, next))
        : handler)
      return () => {}
    },
    effect: factory => {
      effects.push(factory())
      return () => {}
    },
  }
  return { ctx, tools, handlers, commands, projections, effects, tables: store }
}

/**
 * A person's conversation, as the plugin sees it: an id, a log that only grows,
 * and a way to hand the model a message.
 */
export function stubAgent({ id = 'agent-1', sessionId = 'session-1', seq = 0, turn = () => 1 } = {}) {
  const handed = []
  const log = []
  const agent = {
    id,
    session: {
      id: sessionId,
      header: { id: sessionId },
      get seq() {
        return log.length + seq
      },
      eventAt: index => log[index],
      append: async event => {
        log.push(event)
        return event
      },
    },
    followup: async message => {
      handed.push(message)
      log.push({ type: 'user/message', seq: message.eventSeq })
      return {}
    },
  }
  return { agent, handed, log, nextTurn: turn }
}

/**
 * The workflow, in the order a person and their model actually live it:
 * 起任务 → 登记 → 立计划 → 开工第一个单元 → 交付 → 收尾。
 *
 * Each step records what the person saw and what the model got back, which is
 * the only way to tell "it works" from "the function returned an object".
 */
export async function runFlow({ quiet = false, project = mkdtempSync(join(tmpdir(), 'v3-flow-')) } = {}) {
  const host = stubHost({ cwd: project })
  await apply(host.ctx, { checkpoints: false })
  const { agent, handed, log } = stubAgent({ sessionId: 'session-flow' })
  const steps = []
  const say = line => {
    steps.push(line)
    if (!quiet) console.log(line)
  }

  const tool = name => {
    const definition = host.tools.get(name)
    if (!definition) throw new Error(`flow: ${name} is not registered`)
    return definition
  }
  const call = async (name, args, extra = {}) => {
    const exec = { agent, callId: `call-${name}-${steps.length}`, turn: 1, signal: undefined, ...extra }
    // A real tool call is a log record; the plugin counts on the log order.
    log.push({ type: 'tool/call', data: { callId: exec.callId, name, arguments: args } })
    try {
      const value = await tool(name).execute(args, exec)
      log.push({ type: 'tool/result', data: { message: { toolCallId: exec.callId, isError: false,
        content: [{ type: 'text', text: JSON.stringify(value) }] } } })
      return value
    } catch (error) {
      log.push({ type: 'tool/result', data: { message: { toolCallId: exec.callId, isError: true,
        content: [{ type: 'text', text: error.message }] } } })
      throw error
    }
  }

  // A run the submission can point at: the plugin only accepts a claim that
  // names a tool call the session actually made, so the flow has to make one.
  const ran = (callId, command, text = 'ok') => {
    log.push({ type: 'tool/call', data: { callId, name: 'bash', arguments: { command } } })
    log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text }] } } })
    return callId
  }

  // 1. 人起任务：这是唯一入口，也是 opt-in 的地方。
  const command = host.commands[0]
  const started = await command.handler({ agent, rawInput: 'start 帮我搞一下导出' })
  say(`人  → /dsh-auto-dev start …`)
  say(`      ${started?.text ?? started}`)
  say(`模型← ${handed.at(-1)?.content?.at(-1)?.text?.split('\n')[0] ?? '（没有收到消息）'}`)
  if (!host.tools.has('work_start')) throw new Error('flow: opting in did not install the tools')

  // 2. 模型登记任务（命令给了它一次性授权）。
  const task = await call('work_start', {
    request: '帮我搞一下导出',
    mode: 'do',
    goal: '导出功能可用',
    scope: [project],
    acceptance: ['三种格式都能打开'],
  })
  say(`模型← work_start → ${task.taskId} ${task.mode} · 判完成：${task.acceptanceMode} · 要回执：${task.needsReceipt ? '是' : '否'}`)
  if (task.needsClarify) {
    say(`模型← 需求糊：先问 ${task.needsClarify.limit} 个业务问题（${task.needsClarify.reasons.join('；')}）`)
    // 人回了一句，模型先把回答落账；不说话时就写 assumption 继续。
    const clarified = await call('work_control', {
      taskId: task.taskId, operation: 'clarify',
      assumption: '导出先只做当前筛选，三种格式都要',
    })
    say(`模型← clarify → 用了默认（${clarified.clarify.assumption}）`)
  }
  // 2. 回执：四行一屏，人一句"可以"。不写也不挡，但收尾时会再问一次。
  const receipt = await call('work_control', {
    taskId: task.taskId, operation: 'receipt',
    text: '目标：导出 Excel\n验收：三种格式都能打开\n不做：筛选联动\n默认：只支持当前筛选',
  })
  say(`模型← receipt → 四行已写（firstAt ${String(receipt.receipt.firstAt).slice(11, 19)}）`)
  // 业务事实：一句话记进项目里；下一个会话开工时拿到的是路径，不是模型记忆。
  const remembered = await call('work_control', {
    operation: 'remember', target: 'domain',
    payload: { kind: 'term', key: '导出', text: '把当前筛选的行写成 Excel / CSV / TSV' },
  })
  const facts = Object.values(remembered.entries ?? {}).flat().length
  say(`模型← remember → ${remembered.path.replace(project, '.')}${remembered.replaced ? '（改写）' : '（新增）'} · ${facts} 条`)
  // 目标改了：旧的留着，版本号是数组长度，不用谁去维护 revision。
  const goal = await call('work_control', {
    operation: 'goal', text: '导出三种格式，列顺序跟页面一致', why: '用户说列顺序也要跟页面一致',
  })
  say(`模型← goal → 第 ${goal.goalRevision} 版`)
  log.push({ type: 'tool/result', data: { message: { toolCallId: `call-work_start-1`, content: [{ type: 'text', text: JSON.stringify(task) }] } } })

  // 3. 现场事实：先记成候选，用户点头后才算数。
  const proposed = await call('work_env', { operation: 'propose', kind: 'fact', key: '启动', value: 'pnpm dev', command: 'pnpm dev' })
  say(`模型← env propose → 候选 ${proposed.pending} 条（未确认，不进摘要）`)
  log.push({ type: 'user/message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '确认启动' }] } } })
  const envFacts = await call('work_env', { operation: 'confirm', kind: 'fact', key: '启动', note: '确认启动' })
  say(`模型← env confirm → 已确认 ${envFacts.total} 条`)

  // 4. 立计划：一个交付单元 + 一个收尾单元。
  const planned = await call('work_plan', {
    operation: 'set',
    taskId: task.taskId,
    units: [
      { id: 'b1', goal: '导出按钮', scope: [project], acceptance: ['点了能导出'], deliverable: '一个能点的导出按钮' },
      { id: 'b2', goal: '三种格式', scope: [project], acceptance: ['xlsx/csv/pdf 都能打开'] },
    ],
  })
  say(`模型← work_plan → ${planned.units.length} 个单元`)

  // 4. 开工第一个单元（宿主拍 before 存档；这里关掉了 checkpoints）。
  const opened = await call('work_plan', { operation: 'activate', taskId: task.taskId, unit: 'b1' })
  say(`模型← activate b1 → ${opened.tellUser ?? ''}`)

  // 5. 交付第一个单元：先跑一次检查，再用它的 callId 作证。
  ran('ex-b1', 'npm test -- export', 'pass 1')
  const executions = await call('work_status', { view: 'executions' })
  const b1Proof = executions.executions.find(row => row.callId === 'ex-b1')
  if (!b1Proof) throw new Error('flow: the run did not show up in view="executions"')
  say(`模型← work_status executions → ${executions.total} 次执行，最新 ${b1Proof.callId}`)
  const first = await call('work_submit', {
    taskId: task.taskId,
    unit: 'b1',
    outcome: 'complete',
    summary: '导出按钮接上了，点一下能出 xlsx',
    next: '接三种格式',
    claims: [{ statement: '导出按钮可用', case: 'happy', assert: '点击后有文件', expected: 'xlsx', actual: 'xlsx', execution: { callId: b1Proof.callId } }],
  })
  say(`模型← submit b1 → ${first.outcome} · ${first.state ?? ''}`)

  // 6. 交付最后一个单元（收尾判定在这里发生）：同样先跑一次。
  ran('ex-b2', 'npm test -- export --formats', 'pass 3')
  const last = await call('work_submit', {
    taskId: task.taskId,
    unit: 'b2',
    outcome: 'complete',
    summary: '三种格式都能打开',
    next: '收尾',
    claims: [{ statement: '三种格式都能打开', case: 'visible', assert: '打开文件', expected: '三份可读', actual: '三份可读', execution: { callId: 'ex-b2' } }],
  })
  say(`模型← submit b2 → ${last.outcome} · 任务 ${last.state ?? '?'}`)

  // 7. 人看面板：这是 boardView 的视角，和右栏用同一份数据。
  // 收案：最后一单交完，任务停在“等你用过”；人一句“可以”才收。
  const afterSubmit = host.tables.tasks[task.taskId]
  if (afterSubmit?.state === 'review_ready') {
    // 人的一句话是决定，不是状态变更：模型看到它之后调 accept，状态才动。
    const said = '可以，就这样'
    say(`人← 看过并说：「${said}」`)
    // 人的这句话在真宿主里是一条会话事件——先落进日志，pre-step 才拿得到它的序号。
    log.push({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: said }], source: { kind: 'user' } } } })
    const preStep = host.handlers.get('agent/pre-step')
    if (preStep) {
      await preStep({ agent, messages: [{ role: 'user', content: [{ type: 'text', text: said }], source: { kind: 'user' } }], step: 1 }, async () => ({ kind: 'continue', messages: [] }))
    }
    await call('work_control', { operation: 'accept', text: said })
    say(`宿主← 收案：${host.tables.tasks[task.taskId].state}`)
  }
  const status = await call('work_status', { view: 'board' })
  const progress = status.progress ?? {}
  say(`面板→ ${progress.done ?? '?'}/${progress.total ?? '?'} · ${status.task?.state ?? '?'} · ${progress.label ?? ''}`)

  // 8. 对照：同一个动作，声明"由检查判完成"，就不欠回执。
  const automatic = await runAutomatic({ quiet })
  say(`对照→ 自动收：判完成 ${automatic.acceptanceMode} · 要回执 ${automatic.needsReceipt ? '是' : '否'}`)

  // 9. 界面：开局说清默认动作，动手时提醒一次，真跑过就不再提。
  const screen = await runScreen({ quiet })
  say(`界面→ 开局提示：${screen.uiTest}`)
  say(`界面→ 动手时提醒：${screen.nudged ? '提了一次' : '没有提'} · 跑过浏览器之后：${screen.stillNudged ? '还在提' : '不再提'}`)
  say(`界面→ 提交时：${screen.warned ? '要浏览器证据（warning）' : '没有提浏览器证据'}`)

  const state = host.tables.tasks[task.taskId]
  return { taskId: task.taskId, steps, task: state, plan: host.tables.plans[state.planId], status, log, host, automatic }
}

/**
 * The other branch of the same decision: a project whose own checks decide.
 * It only has to register a task; the point is what `work_start` hands back.
 */
async function runAutomatic({ quiet = false } = {}) {
  const host = stubHost({ cwd: '/repo/example' })
  await apply(host.ctx, { checkpoints: false })
  const { agent } = stubAgent({ sessionId: 'session-auto', seq: 1000 })
  await host.commands[0].handler({ agent, rawInput: 'start 整理 README' })
  const exec = { agent, callId: 'call-auto', turn: 1, signal: undefined }
  const started = await host.tools.get('work_start').execute(
    { request: '整理 README', mode: 'do', scope: ['/repo/example'], acceptanceMode: 'auto' },
    exec,
  )
  if (!quiet) {
    // Nothing to print here: the caller says one line so the pair reads together.
  }
  return started
}

/**
 * The screen branch: what a model is told at three moments, and what turns the
 * nagging off. A person would only see the last of these, so it is printed here.
 */
async function runScreen({ quiet = false } = {}) {
  const host = stubHost({ cwd: '/repo/screen' })
  await apply(host.ctx, { checkpoints: false })
  const { agent, log } = stubAgent({ sessionId: 'session-screen' })
  const pre = host.handlers.get('agent/pre-step')
  const post = host.handlers.get('tools/post-execute')
  const say = async () => pre(
    { agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }], step: 2 },
    async () => ({ kind: 'allow', messages: [] }),
  )
  const tool = name => host.tools.get(name)
  const call = async (name, args) => {
    const callId = `screen-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
    return tool(name).execute(args, { agent, callId, turn: 1 })
  }

  await host.commands[0].handler({ agent, rawInput: 'start 给导出页加一个按钮' })
  const started = await call('work_start', {
    request: '给导出页加一个按钮', mode: 'do',
    scope: ['src/App.tsx'], acceptance: ['点了能导出'],
  })
  await call('work_plan', { taskId: started.taskId, operation: 'set', units: [
    { id: 'b1', goal: '加按钮', scope: ['src/App.tsx'], acceptance: ['点了能导出'] },
  ] })
  await call('work_plan', { taskId: started.taskId, operation: 'activate', unit: 'b1' })
  const first = await say()
  const nudged = (first.messages ?? []).some(message => message.source?.summary === 'auto-dev-v3 ui test')

  // One real browser run, then the same step again.
  await post(
    { agent, name: 'bash', arguments: { command: 'npx playwright test --headed' }, callId: `screen-${log.length}` },
    { additionalContexts: [] },
    async () => ({ additionalContexts: [] }),
  )
  const second = await say()
  const stillNudged = (second.messages ?? []).some(message => message.source?.summary === 'auto-dev-v3 ui test')

  // A type check is real evidence, just not browser evidence: the submit should
  // still say what is missing.
  log.push({ type: 'tool/call', data: { callId: 'screen-tsc', name: 'bash', arguments: { command: 'npx tsc --noEmit' } } })
  log.push({ type: 'tool/result', data: { message: { toolCallId: 'screen-tsc', isError: false, content: [{ type: 'text', text: 'ok' }] } } })
  const submitted = await call('work_submit', {
    unit: 'b1', outcome: 'complete', summary: '按钮加好了', next: '收',
    claims: [{ statement: 'npx tsc --noEmit', case: 'command', assert: '没有类型错误', expected: '0', actual: '0', execution: { callId: 'screen-tsc' } }],
  })
  const warned = (submitted.warnings ?? []).some(line => /浏览器/.test(line))
  if (!quiet) {
    // The caller prints the three lines; nothing else belongs here.
  }
  return { uiTest: String(started.uiTest ?? '').slice(0, 42) + '…', nudged, stillNudged, warned }
}

async function main() {
  const result = await runFlow({ quiet: process.argv.includes('--json') })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ taskId: result.taskId, steps: result.steps, task: result.task, plan: result.plan }, null, 2))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

#!/usr/bin/env node
/**
 * A bench for driving one task through the real plugin from a shell, so a model
 * (or a person) can be the one calling the tools. State lives on disk between
 * invocations: one CLI call = one step of a conversation.
 *
 *   node tools/bench.mjs init --dir runs/case-1 --project /tmp/case-1/project
 *   node tools/bench.mjs cmd "start 给这个项目加一个 hello 命令"
 *   node tools/bench.mjs say "就按你说的来"
 *   node tools/bench.mjs call work_plan '{...}'
 *   node tools/bench.mjs board
 *   node tools/bench.mjs show
 *
 * Everything it prints is what that side would see: `call` prints the tool
 * result (or the error text the model would get), `say` prints the lines the
 * plugin would inject into the model's next step.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from '../src/index.js'
import { stubHost } from './flow.mjs'

const argv = process.argv.slice(2)
const verb = argv[0]
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}

const FLAGS = new Set(['dir', 'project', 'session', 'checkpoints', 'tables'])
const positional = argv.filter((token, index) => {
  if (FLAGS.has(token.replace(/^--/, '')) && token.startsWith('--')) return false
  return !(index > 0 && FLAGS.has(argv[index - 1]?.replace(/^--/, '')) && argv[index - 1].startsWith('--'))
})
const dir = resolve(flag('dir', 'runs/bench'))
const statePath = join(dir, 'state.json')

// A second conversation on the same storage: `--tables <file>` keeps the records
// outside the per-session state file, which is exactly what two windows in one
// profile share.
const EMPTY_TABLES = () => ({ tasks: {}, plans: {}, decisions: {}, sessions: {} })

function load() {
  if (!existsSync(statePath)) throw new Error(`bench: no state at ${statePath} — run "init" first`)
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  if (state.tablesPath) {
    state.tables = existsSync(state.tablesPath) ? JSON.parse(readFileSync(state.tablesPath, 'utf8')) : EMPTY_TABLES()
  }
  return state
}
function save(state) {
  if (state.tablesPath) {
    writeFileSync(state.tablesPath, JSON.stringify(state.tables, null, 2))
    const { tables, ...rest } = state
    writeFileSync(statePath, JSON.stringify(rest, null, 2))
    return
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function stubAgent(state) {
  return {
    id: `agent-${state.sessionId}`,
    session: {
      id: state.sessionId,
      header: { id: state.sessionId },
      get seq() { return state.log.length },
      eventAt: index => state.log[index],
      append: async event => { state.log.push(event); return event },
    },
    followup: async message => {
      state.log.push({ type: 'user/message', data: { message } })
      state.handed = [...(state.handed ?? []), String(message?.content?.[0]?.text ?? '')]
      return {}
    },
  }
}

async function open(state) {
  const project = state.project
  const host = stubHost({ cwd: project, tables: state.tables })
  await apply(host.ctx, { checkpoints: state.checkpoints === true })
  const agent = stubAgent(state)
  // A new process is a new host: replay the "this session already opted in" check.
  const created = host.handlers.get('agent/created')
  if (created) await created({ agent })
  // The start grant is memory, and a new process is a new memory: replay the
  // `start` the person typed so the model's first call lands the same way.
  // The person's words live in memory too (the plugin stamps "user spoke at"
  // for gates that wait on them). Replay them so a fresh process sees the same.
  const preStep = host.handlers.get('agent/pre-step')
  if (preStep) {
    for (const said of state.said ?? []) {
      const message = { id: `replay-${said.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: said }] }
      await preStep({ agent, messages: [message], step: 1 }, async () => ({ kind: 'continue', messages: [message] }))
    }
  }
  const command = host.commands.find(entry => entry.name === 'dsh-auto-dev')
  if (command) {
    const quiet = { ...agent, followup: async () => ({}) }
    for (const rawInput of state.grants ?? []) await command.handler({ agent: quiet, rawInput })
  }
  return { host, agent }
}

const names = ['init', 'cmd', 'say', 'exec', 'call', 'board', 'show', 'tools']

if (verb === 'init') {
  const project = resolve(flag('project', join(dir, 'project')))
  mkdirSync(project, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const tablesFlag = flag('tables', null)
  const tablesPath = tablesFlag ? resolve(dir, tablesFlag) : null
  // Joining a shared store must not wipe it: a second window starts from whatever
  // the first one already wrote.
  const shared = tablesPath && existsSync(tablesPath) ? JSON.parse(readFileSync(tablesPath, 'utf8')) : null
  const state = {
    project,
    sessionId: flag('session', `session-bench-${process.pid}-${Date.now()}`),
    checkpoints: flag('checkpoints', 'off') === 'on',
    log: [],
    tables: shared ?? EMPTY_TABLES(),
    ...(tablesPath ? { tablesPath } : {}),
  }
  save(state)
  console.log(`bench: ${dir}\nproject: ${project}\nsession: ${state.sessionId}\ncheckpoints: ${state.checkpoints ? 'on' : 'off'}`)
} else if (verb === 'cmd') {
  const state = load()
  const { host, agent } = await open(state)
  const rawInput = positional.slice(1).join(' ')
  const command = host.commands.find(entry => entry.name === 'dsh-auto-dev')
  if (!command) throw new Error('bench: the command is not registered')
  const result = await command.handler({ agent, rawInput })
  if (/^(start|new)\b/.test(rawInput.trim())) state.grants = [rawInput]
  save(state)
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
} else if (verb === 'say') {
  const state = load()
  const { host, agent } = await open(state)
  const text = positional.slice(1).join(' ')
  const message = { id: `m-${state.log.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
  state.log.push({ type: 'user/message', data: { message } })
  state.said = [...(state.said ?? []), text]
  const handlers = [...host.handlers.entries()].filter(([event]) => event === 'agent/pre-step')
  const seen = []
  for (const [, handler] of handlers) {
    const decision = await handler({ agent, messages: [message], step: 1 }, async () => ({ kind: 'continue', messages: [message] }))
    for (const extra of decision?.messages ?? []) if (!(decision.messages ?? []).includes(extra) || !seen.includes(extra)) seen.push(extra)
  }
  const fresh = seen.filter(entry => entry && entry !== message && !(state.log.some(row => row.type === 'user/message' && row.data?.message === entry)))
  save(state)
  if (fresh.length === 0) console.log('（模型侧没有收到任何注入）')
  for (const entry of fresh) {
    const text = Array.isArray(entry.content) ? entry.content.map(part => part.text ?? '').join('') : String(entry.content ?? '')
    console.log(`注入 → ${text}`)
  }
} else if (verb === 'exec') {
  // A command the model ran, as the host would have recorded it. Without this
  // the session log has no executions and every "I ran it" claim is unprovable.
  const state = load()
  const command = flag('command', '')
  if (command === '') throw new Error('bench: exec needs --command "<the command>"')
  const exitCode = Number(flag('exit', '0'))
  const output = flag('out', exitCode === 0 ? 'ok' : 'failed')
  const callId = flag('callId', `call-bash-${state.log.length}`)
  state.log.push({ type: 'tool/call', data: { callId, name: 'bash', arguments: { command } } })
  state.log.push({
    type: 'tool/result',
    data: { message: { toolCallId: callId, isError: exitCode !== 0, content: [{ type: 'text', text: output }] } },
  })
  // Run the observation the way the host does, otherwise a bench session never
  // counts browser runs and the "it stops nagging" claim cannot be seen here.
  const { host } = await open(state)
  const post = host.handlers.get('tools/post-execute')
  if (post) {
    const downstream = { additionalContexts: [] }
    await post({ agent: stubAgent(state), name: 'bash', arguments: { command }, callId }, downstream, async () => downstream)
  }
  save(state)
  console.log(JSON.stringify({ callId, command, exitCode, output }, null, 2))
} else if (verb === 'call') {
  const state = load()
  const { host } = await open(state)
  const name = positional[1]
  const args = positional[2] ? JSON.parse(positional[2]) : {}
  const agent = stubAgent(state)
  const definition = host.tools.get(name)
  if (!definition) throw new Error(`bench: ${name} is not registered — is this session opted in? try "cmd" first`)
  const callId = `call-${state.log.length}`
  state.log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
  const turn = 1
  try {
    const value = await definition.execute(args, { agent, callId, turn })
    state.log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
    // The start grant is one-shot in the real host: a registered task spends it.
    if (name === 'work_start' && value?.taskId) state.grants = []
    save(state)
    console.log(JSON.stringify(value, null, 2))
  } catch (error) {
    state.log.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] } } })
    save(state)
    console.error(`ERROR: ${error?.message ?? error}`)
    process.exitCode = 1
  }
} else if (verb === 'board') {
  const state = load()
  const { host } = await open(state)
  const agent = stubAgent(state)
  const definition = host.tools.get('work_status')
  if (!definition) {
    console.error('work_status is not registered — is this session opted in? try "cmd" first')
    process.exitCode = 1
  } else {
  const value = await definition.execute({ view: 'board' }, { agent, callId: 'board', turn: 1 })
  save(state)
  console.log(JSON.stringify(value, null, 2))
  }
} else if (verb === 'show') {
  const state = load()
  const tasks = Object.values(state.tables.tasks)
  console.log(JSON.stringify({ tasks: tasks.map(row => ({ id: row.id, state: row.state, mode: row.mode, acceptanceMode: row.acceptanceMode, receipt: row.receipt ?? null, alternatives: row.alternatives?.length ?? 0 })), plans: Object.values(state.tables.plans).map(row => ({ id: row.id, units: row.units?.length ?? 0 })), sessions: Object.keys(state.tables.sessions) }, null, 2))
} else if (verb === 'tools') {
  const state = load()
  const { host } = await open(state)
  console.log([...host.tools.keys()].sort().join('\n') || '（没有任何工具：这个会话还没 opt-in）')
} else {
  console.log('usage: bench.mjs init|cmd|say|exec|call|board|show|tools')
  process.exitCode = 1
}

// 性能跑台（`npm run perf`）：用真插件走一条很长的合成会话，给热路径计时
// （pre-step、pre/post-execute、面板投影 apply+view）。每次调用的开销应当与会话
// 长度无关——`node tools/perf.mjs 200 400 800` 三档的总时长应近似线性增长。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { apply } from '../src/index.js'
import { stubHost } from './flow.mjs'

const sizes = process.argv.slice(2).map(Number).filter(Boolean)
for (const N of sizes.length ? sizes : [200, 400, 800]) await run(N)
process.exit(0)

async function run(N) {

  const project = mkdtempSync(join(tmpdir(), 'perf-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src/a.js'), 'x')
  const host = stubHost({ cwd: project })
  await apply(host.ctx, {})
  const log = []
  const sid = 'session-perf'
  const agent = () => ({ id: `agent-${sid}`, cwd: project, session: { id: sid, header: { id: sid }, get seq() { return log.length }, eventAt: i => log[i], append: async e => { log.push(e); return e } }, followup: async () => ({}) })

  const proj = host.projections[0]
  let pstate = proj.init({ id: sid })
  const t = { preStep: 0, pre: 0, post: 0, proj: 0, view: 0, tool: 0 }
  const push = e => { log.push(e); const s = performance.now(); pstate = proj.apply(pstate, e); t.proj += performance.now() - s }
  const time = async (k, fn) => { const s = performance.now(); try { return await fn() } finally { t[k] += performance.now() - s } }

  async function tool(name, args) {
    const callId = `call-${name}-${log.length}`
    push({ type: 'tool/call', data: { callId, name, arguments: args } })
    const def = host.tools.get(name)
    let value, err
    try { value = await time('tool', () => def.execute(args, { agent: agent(), callId, turn: 1 })) } catch (e) { err = e }
    push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: !!err, content: [{ type: 'text', text: err ? err.message : JSON.stringify(value) }] } } })
    if (err) throw err
    return value
}
  async function exec(name, args, text) {
    const callId = `call-${name}-${log.length}`
    const pre = host.handlers.get('tools/pre-execute')
    await time('pre', () => pre({ agent: agent(), name, arguments: args, callId }, async () => ({ kind: 'continue' })))
    push({ type: 'tool/call', data: { callId, name, arguments: args } })
    push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: text + '\n[exit code: 0]' }] } } })
    const post = host.handlers.get('tools/post-execute')
    const d = { additionalContexts: [] }
    await time('post', () => post({ agent: agent(), name, arguments: args, callId }, d, async () => d))
    return callId
}
  async function step(text) {
    const msg = text ? { id: `m-${log.length}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } : null
    if (msg) push({ type: 'user/message', data: msg })
    const h = host.handlers.get('agent/pre-step')
    await time('preStep', () => h({ agent: agent(), messages: msg ? [msg] : [], step: 2 }, async () => ({ kind: 'continue', messages: msg ? [msg] : [] })))
}

  const cmd = host.commands.find(c => c.name === 'dsh-auto-dev')
  await cmd.handler({ agent: { ...agent(), followup: async () => ({}) }, rawInput: 'start 做一个导出' })
  await step('start 做一个导出')
  await tool('work_start', { request: '做一个导出', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  await tool('work_plan', { operation: 'set', units: [{ id: 'b1', goal: '导出', scope: ['.'], acceptance: ['能点'] }, { id: 'b2', goal: '列', scope: ['.'], acceptance: ['一致'] }] })
  await tool('work_plan', { operation: 'activate', unit: 'b1' })

  const big = 'line of output '.repeat(200)
  const wall = performance.now()
  let last
  for (let i = 0; i < N; i++) {
    if (i % 5 === 4) await exec('write', { path: join(project, 'src/a.js'), content: 'y' + i }, 'ok')
    else last = await exec('bash', { command: `echo ${i}` }, big)
    if (i % 3 === 0) await step()
    if (i % 10 === 0) { const s = performance.now(); proj.wire.view(pstate); t.view += performance.now() - s }
}
  await tool('work_submit', { unit: 'b1', outcome: 'complete', summary: 'ok', next: 'b2', claims: [{ statement: 'ran', execution: { callId: last } }] }).catch(() => {}) // 最后一步是写操作时会被判过期，与计时无关
  const total = Math.round(performance.now() - wall)
  const ms = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)]))
  console.log(`N=${String(N).padEnd(5)} ${String(log.length).padStart(5)} 事件  共 ${String(total).padStart(5)}ms  ${Object.entries(ms).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
}

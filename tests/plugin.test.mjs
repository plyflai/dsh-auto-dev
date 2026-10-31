import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject as pluginInject, name, DSH_AUTO_DEV_SCHEMA } from '../src/index.js'

function human(log, text) {
  log.push({ type: 'user/message', data: { message: { id: `human-${log.length}`, role: 'user',
    source: { kind: 'user' }, content: [{ type: 'text', text }] } } })
}

/**
 * Tests drive the tools directly instead of going through a person's
 * `/dsh-auto-dev start`, so they opt out of the user-start gate the way a
 * profile would. The gate itself is exercised at the bottom of this file with a
 * real command invocation.
 */
const testApply = (stub, config = {}) => apply(stub.ctx, { requireUserStart: false, ...config })

/**
 * A stub host good enough to prove the plugin registers what it claims.
 *
 * This is the regression test for a real defect: the first version of `apply`
 * accidentally returned the records object, and the cordis loader refused the
 * effect with "Invalid effect". Nothing short of running `apply` against a
 * context catches that class of mistake, and no unit test of the pure modules
 * can.
 */
function stubContext(cwd = '/repo/example', seedTables = null) {
  const tools = []
  const settings = []
  const projections = []
  const commands = []
  const skinProviders = []
  const handlers = new Map()
  const effects = []
  const subContexts = {
    settings: { settings: { register: (ns, schema) => { settings.push({ ns, schema }); return () => {} } } },
    sessionProjections: { sessionProjections: { register: spec => { projections.push(spec); return () => {} } } },
    skills: { skills: { registerProvider: factory => { skinProviders.push(factory); return () => {} } } },
    commands: { commands: { register: command => { commands.push(command); return () => {} } } },
  }
  let closed = false
  const records = new Map()
  // The store Records actually reads. Exposed so a test can put the plugin in a
  // state a tool cannot reach on its own (a task that is already closed).
  // A second stub can be handed the tables of the first: that is what a host
  // restart looks like to the plugin (storage survives, memory does not).
  const tables = seedTables ?? { tasks: {}, plans: {}, decisions: {}, sessions: {} }
  const backend = {
    kv: {
      open: () => ({
        loadAll: async () => ({ tables }),
        putRecord: async (table, id, row) => { records.set(`${table}/${id}`, row) },
        deleteRecord: async (table, id) => { records.delete(`${table}/${id}`) },
        close: async () => { closed = true },
      }),
    },
  }
  const ctx = {
    tools: {
      // A registration goes away when its disposer runs, like the host's does.
      register: definition => {
        tools.push(definition)
        return () => { const at = tools.indexOf(definition); if (at >= 0) tools.splice(at, 1) }
      },
    },
    storage: { backend: { get: () => backend } },
    workingDirectory: { get: () => cwd },
    inject: (services, run) => {
      const available = services.every(service => subContexts[service])
      if (available) run({ ...subContexts[services[0]] })
    },
    on: (event, handler) => { handlers.set(event, handler); return () => {} },
    effect: factory => {
      const result = factory()
      effects.push(result)
      return () => {}
    },
  }
  return { ctx, tools, settings, projections, commands, skinProviders, handlers, effects, records, tables, isClosed: () => closed }
}

test('apply registers six tools, a settings section, a projection, a command and a skill provider', async () => {
  const stub = stubContext()
  const returned = await (testApply(stub))
  // Returning anything but undefined makes the cordis loader treat the call as
  // a malformed effect — this exact mistake shipped once.
  assert.equal(returned, undefined)

  assert.deepEqual(pluginInject, ['tools', 'storage', 'storage.backend.json', 'workingDirectory'])
  assert.equal(name, 'dsh-auto-dev')

  const names = stub.tools.map(tool => tool.name).sort()
  assert.deepEqual(names, ['work_control', 'work_env', 'work_extend', 'work_plan', 'work_start', 'work_status', 'work_submit'])
  for (const tool of stub.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`)
  }

  // The settings dialog reads the entry Config, not a runtime registration:
  // `settings.register` does not exist on the service and calling it is what
  // left the section missing from the dialog.
  assert.equal(stub.settings.length, 0)
  assert.equal(typeof (await import('../src/index.js')).Config.toJSON, 'function')
  assert.equal(stub.projections[0].key, 'dshAutoDev')
  assert.equal(stub.commands[0].name, 'dsh-auto-dev')
  assert.equal(stub.skinProviders.length, 1)

  assert.ok(stub.handlers.has('agent/pre-step'))
  assert.ok(stub.handlers.has('tools/post-execute'))
})

test('an absolute scope that exists is not reported as missing', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-abs-'))
  writeFileSync(join(project, 'App.tsx'), 'x\n')
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const agent = { id: 'agent-c', session: { id: 'sess-c', header: {}, get seq() { return log.length }, eventAt: index => log[index] } }
  const started = await stub.tools.find(row => row.name === 'work_start').execute(
    { request: '给导出页加按钮', mode: 'do', scope: [join(project, 'App.tsx')], acceptance: ['能导出'] },
    { agent, callId: 'a1', turn: 1 },
  )
  assert.ok(!(started.warnings ?? []).some(line => /none of the declared scope exists/.test(line)), 'an absolute path is not missing')
})

test('a blocked rule that names a directory holds for file writes, not just for the shell', async () => {
  const project = mkdtempSync(join(tmpdir(), 'dsh-auto-dev-blocked-'))
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const agent = { id: 'agent-1', session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] } }
  const tools = new Map(stub.tools.map(tool => [tool.name, tool]))
  await tools.get('work_start').execute({ request: '收拾一下导出', mode: 'do', scope: ['.'] }, { agent, callId: 'c1', turn: 1 })
  await tools.get('work_env').execute({ operation: 'propose', kind: 'blocked', key: 'migrations', value: '不许改 migrations/ 下的历史文件' }, { agent, callId: 'c2', turn: 1 })
  human(log, '确认 migrations')
  await tools.get('work_env').execute({ operation: 'confirm', kind: 'blocked', key: 'migrations', note: '确认 migrations' }, { agent, callId: 'c3', turn: 1 })

  const pre = stub.handlers.get('tools/pre-execute')
  // A promise about a directory that only bash honours is a promise with a hole:
  // every editor writes files without ever touching a command line.
  const write = await pre({ agent, callId: 'c4', name: 'write', arguments: { file_path: 'migrations/0001_init.sql' } }, async () => ({ kind: 'continue' }))
  assert.equal(write.kind, 'deny')
  assert.match(write.reason, /migrations/)
  const elsewhere = await pre({ agent, callId: 'c5', name: 'write', arguments: { file_path: 'src/export.mjs' } }, async () => ({ kind: 'continue' }))
  assert.equal(elsewhere.kind, 'continue')
})

test('a runtime fact is a candidate until the person confirms it, and a blocked entry refuses the call', async () => {
  const project = mkdtempSync(join(tmpdir(), 'dsh-auto-dev-env-'))
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const agent = { id: 'agent-1', session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] } }
  const tools = new Map(stub.tools.map(tool => [tool.name, tool]))
  const started = await tools.get('work_start').execute({ request: '把导出做完', mode: 'do', scope: ['.'] }, { agent, callId: 'c1', turn: 1 })

  const proposed = await tools.get('work_env').execute({ operation: 'propose', kind: 'fact', key: '启动', value: 'pnpm dev', command: 'pnpm dev' }, { agent, callId: 'c2', turn: 1 })
  assert.equal(proposed.pending, 1)
  // A candidate does not reach the digest: only a confirmed fact is worth handing over.
  const before = await tools.get('work_env').execute({ operation: 'list' }, { agent, callId: 'c3', turn: 1 })
  assert.equal(before.digest.confirmed, 0)
  assert.equal(before.line, '')

  human(log, '确认 启动')
  const confirmed = await tools.get('work_env').execute({ operation: 'confirm', kind: 'fact', key: '启动', note: '确认 启动' }, { agent, callId: 'c4', turn: 1 })
  assert.equal(confirmed.total, 1)
  const after = await tools.get('work_env').execute({ operation: 'list' }, { agent, callId: 'c5', turn: 1 })
  assert.equal(after.digest.confirmed, 1)
  assert.match(after.line, /pnpm dev/)

  // The blocked section is a promise, and the gate honours it.
  await tools.get('work_env').execute({ operation: 'propose', kind: 'blocked', key: '生产库', value: 'psql prod' }, { agent, callId: 'c6', turn: 1 })
  human(log, '确认 生产库')
  await tools.get('work_env').execute({ operation: 'confirm', kind: 'blocked', key: '生产库', note: '确认 生产库' }, { agent, callId: 'c7', turn: 1 })
  const pre = stub.handlers.get('tools/pre-execute')
  const refused = await pre({ agent, callId: 'c8', name: 'bash', arguments: { command: 'psql prod -c "drop table users"' } }, async () => ({ kind: 'continue' }))
  assert.equal(refused.kind, 'deny')
  assert.match(refused.reason, /生产库/)
  const allowed = await pre({ agent, callId: 'c9', name: 'bash', arguments: { command: 'ls' } }, async () => ({ kind: 'continue' }))
  assert.equal(allowed.kind, 'continue')

  // Shipping and the screen are the same mechanism as a start command: a command
  // somebody ran, and where the screen is opened.
  await tools.get('work_env').execute({ operation: 'propose', kind: 'release', key: '发布', value: 'npm run release -- --to staging' }, { agent, callId: 'c10', turn: 1 })
  human(log, '确认 发布')
  await tools.get('work_env').execute({ operation: 'confirm', kind: 'release', key: '发布', note: '确认 发布' }, { agent, callId: 'c11', turn: 1 })
  await tools.get('work_env').execute({ operation: 'propose', kind: 'gui', key: '界面', value: 'http://localhost:3000/export' }, { agent, callId: 'c12', turn: 1 })
  human(log, '确认 界面')
  await tools.get('work_env').execute({ operation: 'confirm', kind: 'gui', key: '界面', note: '确认 界面' }, { agent, callId: 'c13', turn: 1 })
  const withShipping = await tools.get('work_env').execute({ operation: 'list' }, { agent, callId: 'c14', turn: 1 })
  assert.equal(withShipping.release, 1)
  assert.equal(withShipping.gui, 1)
  assert.match(withShipping.digest.release[0], /npm run release/)
  assert.equal(started.taskId.length > 0, true)
})

test('postmortem writes engineering memory, preserves legacy notes, and keeps the memory ceiling', async () => {
  const project = mkdtempSync(join(tmpdir(), 'dsh-auto-dev-post-'))
  mkdirSync(join(project, '.auto-dev'), { recursive: true })
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const agent = { id: 'agent-1', session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] } }
  const tools = new Map(stub.tools.map(tool => [tool.name, tool]))
  const started = await tools.get('work_start').execute({ request: '修好导出偶发失败', mode: 'do', scope: ['/tmp/fake'] }, { agent, callId: 'c1', turn: 1 })

  const legacy = '历史复盘，未经本轮验证\n'
  writeFileSync(join(project, '.auto-dev/postmortem.md'), legacy)
  const partial = { taskId: started.taskId, symptom: '导出偶发失败', cause: '并发写同一个临时文件' }
  await tools.get('work_control').execute({ operation: 'postmortem', payload: partial }, { agent, callId: 'c2', turn: 1 })
  await tools.get('work_control').execute({
    operation: 'postmortem',
    payload: { ...partial, change: '每个任务一个临时目录', finding: '日志里有两次同名 rename', prevention: '提交前跑并发用例' },
  }, { agent, callId: 'c3', turn: 1 })
  assert.equal(readFileSync(join(project, '.auto-dev/postmortem.md'), 'utf8'), legacy)
  const written = JSON.parse(readFileSync(join(project, '.auto-dev/memory.json'), 'utf8'))
  assert.equal(written.incidents.length, 1)
  assert.equal(written.incidents[0].symptom, '导出偶发失败')
  assert.equal(written.incidents[0].prevention, '提交前跑并发用例')

  // At the ceiling the oldest of that kind makes room; nobody is asked to prune.
  const full = { version: 1, facts: Array.from({ length: 60 }, (_, i) => ({ id: `f${i}`, text: `事实 ${i}` })), incidents: Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, symptom: `毛病 ${i}` })) }
  writeFileSync(join(project, '.auto-dev/memory.json'), JSON.stringify(full))
  const more = await tools.get('work_control').execute({ operation: 'remember', payload: { kind: 'fact', text: '再来一条' } }, { agent, callId: 'c4', turn: 1 })
  assert.equal(more.evicted, '事实 0')
  const after = JSON.parse(readFileSync(join(project, '.auto-dev/memory.json'), 'utf8'))
  assert.equal(after.facts.length + after.incidents.length, 120)
  assert.equal(after.facts.at(-1).text, '再来一条')
})

test('a cheaper way is said once, and what the person answered is kept', async () => {
  const project = mkdtempSync(join(tmpdir(), 'dsh-auto-dev-alt-'))
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const agent = { id: 'agent-1', session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] } }
  const tools = new Map(stub.tools.map(tool => [tool.name, tool]))
  const started = await tools.get('work_start').execute({ request: '把导出重写成三条命令', mode: 'do', scope: [project] }, { agent, callId: 'c1', turn: 1 })
  assert.equal(started.alternativeHint, undefined)

  const told = await tools.get('work_control').execute({ operation: 'alternative', text: '三条命令改成一条，导出格式不变' }, { agent, callId: 'c2', turn: 1 })
  assert.equal(told.alternatives, 1)
  assert.equal(stub.tables.tasks[started.taskId].alternatives[0].text, '三条命令改成一条，导出格式不变')

  await tools.get('work_control').execute({ operation: 'alternative', text: '三条命令改成一条，导出格式不变', verdict: 'kept', quote: '不用，就按三条来' }, { agent, callId: 'c3', turn: 1 })
  const rows = stub.tables.tasks[started.taskId].alternatives
  assert.equal(rows.length, 2)
  assert.equal(rows[1].verdict, 'kept')
  assert.equal(rows[1].quote, '不用，就按三条来')
})

test('an irreversible call is refused before it runs, not reported after', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const workStart = stub.tools.find(tool => tool.name === 'work_start')
  const agent = { id: 'agent-gate', session: { id: 'session-gate' } }
  const exec = { agent, callId: 'call-1', signal: undefined }
  const pre = stub.handlers.get('tools/pre-execute')
  assert.ok(pre, 'a gate that only fires after the effect is a diary, not a gate')
  const next = async () => ({ kind: 'allow' })

  // No task yet: nothing to authorize against, the call passes and gets enrolled.
  assert.equal((await pre({ name: 'bash', arguments: { command: 'git reset --hard' }, agent, callId: 'c0' }, next)).kind, 'allow')

  await workStart.execute({ request: 'refactor the slug module', mode: 'do', scope: ['.'] }, exec)
  const denied = await pre({ name: 'bash', arguments: { command: 'git reset --hard' }, agent, callId: 'c1' }, next)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /破坏性操作.*\n过关：先问用户/s)
  assert.doesNotMatch(denied.reason, /work_extend|forced-git-reset/)

  // A check the task is allowed to run is not refused.
  assert.equal((await pre({ name: 'bash', arguments: { command: 'npm test' }, agent, callId: 'c2' }, next)).kind, 'allow')
  // Nor is the plugin's own tool.
  assert.equal((await pre({ name: 'work_extend', arguments: {}, agent, callId: 'c3' }, next)).kind, 'allow')
})

test('a closed task is still findable, and says so instead of "call work_start first"', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const tools = Object.fromEntries(stub.tools.map(tool => [tool.name, tool]))
  const agent = { id: 'agent-closed', session: { id: 'session-closed', seq: 10 } }
  const exec = { agent, callId: 'call-1', signal: undefined }
  const started = await tools.work_start.execute({ request: 'add one function', mode: 'do', scope: ['.'] }, exec)
  // Closing the task by hand keeps this test about resolution, not about evidence.
  stub.tables.tasks[started.taskId] = { ...stub.tables.tasks[started.taskId], state: 'closed' }

  // Reading what happened last is not the same question as "may I change code now".
  const plan = await tools.work_plan.execute({ operation: 'list' }, exec)
  assert.equal(plan.taskId, started.taskId)
  const status = await tools.work_status.execute({ view: 'summary' }, exec)
  assert.equal(status.task.id, started.taskId)

  // Changing a finished plan, or handing in more work, changes nothing and says how to reopen.
  const added = await tools.work_plan.execute({ operation: 'add', units: [{ id: 'u9', goal: 'more' }] }, exec)
  assert.equal(added.unchanged, true)
  assert.match(added.tellUser, /adopt/)
  assert.match((await tools.work_submit.execute({ outcome: 'complete', summary: 'x' }, exec)).tellUser, /adopt/)

  // Reopening is the documented way back.
  assert.match((await tools.work_control.execute({ operation: 'continue' }, exec)).tellUser, /已经收案.*adopt/)
  const reopened = await tools.work_control.execute({ operation: 'adopt', taskId: started.taskId }, exec)
  assert.equal(reopened.state, 'active')
  assert.equal(reopened.taskId, started.taskId)
})

test('the settings schema rejects what the gates would not be able to honour', () => {
  assert.equal('scopeEnforcement' in DSH_AUTO_DEV_SCHEMA({ scopeEnforcement: 'blocking' }), false, 'a switch nothing reads is gone; an old stored value is ignored')
  assert.throws(() => DSH_AUTO_DEV_SCHEMA({ protectedPaths: '.dsh/' }), /protectedPaths must be an array/)
  assert.throws(() => DSH_AUTO_DEV_SCHEMA({ autoEnroll: 'yes' }), /autoEnroll must be boolean/)
  assert.equal(typeof DSH_AUTO_DEV_SCHEMA.toJSON, 'function')
})

test('work_start records a real task', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const workStart = stub.tools.find(tool => tool.name === 'work_start')
  const exec = { agent: { id: 'agent-1', session: { id: 'session-1' } }, callId: 'call-1', signal: undefined }

  const value = await workStart.execute({ request: 'add a subtract function', mode: 'do', scope: ['.'] }, exec)
  assert.match(value.taskId, /^task-/)
  assert.equal(value.mode, 'do')
  assert.equal(stub.records.size, 1)
  const saved = [...stub.records.values()][0]
  assert.equal(saved.request, 'add a subtract function')
  assert.equal(saved.mode, 'do')
})

test('the dialog schema and the validator agree on every field', async () => {
  const { Config, DEFAULT_CONFIG } = await import('../src/index.js')
  const json = Config.toJSON()
  const fields = Object.values(json.refs).filter(ref => ref.meta?.volatile).map(ref => ref.meta)
  assert.equal(fields.length, Object.keys(DEFAULT_CONFIG).length, 'every config field must be editable in the dialog')
  const names = Object.keys(json.refs[json.uid].dict).sort()
  assert.deepEqual(names, Object.keys(DEFAULT_CONFIG).sort())
})

test('every reachable dialog schema node is independently consumable by the host', async () => {
  const { Config } = await import('../src/index.js')
  const seen = new Set()
  const visit = node => {
    assert.equal(typeof node?.toJSON, 'function')
    const json = node.toJSON()
    assert.equal(typeof json.uid, 'number')
    assert.ok(json.refs && Object.keys(json.refs).length >= 1)
    if (seen.has(node)) return
    seen.add(node)
    for (const child of Object.values(node.dict ?? {})) visit(child)
    if (node.inner) visit(node.inner)
    if (node.sKey) visit(node.sKey)
    for (const child of node.list ?? []) visit(child)
  }
  visit(Config)
  assert.ok(seen.size >= 7, `expected the complete schema graph, saw ${seen.size} nodes`)
})

test('readConfig unwraps volatile wrappers instead of dropping settings', async () => {
  const { readConfig, DEFAULT_CONFIG } = await import('../src/index.js')
  assert.deepEqual(readConfig(undefined), DEFAULT_CONFIG)
  // schemastery volatile fields answer get() and must be unwrapped
  const wrapped = { checkpoints: { get: () => false }, autoEnroll: { get: () => false } }
  const value = readConfig(wrapped)
  assert.equal(value.checkpoints, false)
  assert.equal(value.autoEnroll, false)
  assert.deepEqual(value.protectedPaths, DEFAULT_CONFIG.protectedPaths)
})

test('every tool output survives JSON round-tripping', async () => {
  const { lossless } = await import('../src/index.js')
  const roundTrip = value => JSON.parse(JSON.stringify(value))
  const withHoles = {
    taskId: 'task-1',
    unit: { id: 'u-1', goal: 'g', deliverable: undefined, acceptance: ['a'] },
    nextUnit: undefined,
    numbers: [1, Number.NaN, Number.POSITIVE_INFINITY],
  }
  const fixed = lossless(withHoles)
  assert.equal(JSON.stringify(roundTrip(fixed)), JSON.stringify(fixed))
  assert.equal('nextUnit' in fixed, false)
  assert.deepEqual(fixed.numbers, [1, null, null])
})

test('a plan unit without optional fields still returns valid output', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const workStart = stub.tools.find(tool => tool.name === 'work_start')
  const exec = { agent: { id: 'a', session: { id: 's' } }, callId: 'c', signal: undefined }
  const value = await workStart.execute({
    request: 'add subtract and multiply',
    mode: 'build',
    plan: [
      { id: 'u-subtract', goal: 'subtract works', scope: ['calc.mjs'], acceptance: ['npm test passes'], dependsOn: [] },
      { id: 'u-multiply', goal: 'multiply works', scope: ['calc.mjs'], acceptance: ['npm test passes'], dependsOn: ['u-subtract'] },
    ],
  }, exec)
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(value))), JSON.stringify(value))
  assert.equal(value.nextUnit.id, 'u-subtract')
})

test('export carries the record out without pretending the callIds travel', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const workStart = stub.tools.find(tool => tool.name === 'work_start')
  const workControl = stub.tools.find(tool => tool.name === 'work_control')
  const exec = { agent: { id: 'a', session: { id: 's' } }, callId: 'c', signal: undefined }
  await workStart.execute({ request: 'add subtract', mode: 'build', plan: [{ id: 'u1', goal: 'subtract works', scope: ['calc.mjs'], acceptance: ['npm test'], dependsOn: [] }] }, exec)
  const snapshot = await workControl.execute({ operation: 'export' }, exec)
  assert.equal(snapshot.format, 'dsh-auto-dev/export@1')
  assert.equal(snapshot.task.units.length, 1)
  assert.match(snapshot.note, /host-local history/)
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(snapshot))), JSON.stringify(snapshot))
})

test('import arrives unverified: units land pending and history is marked', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const workControl = stub.tools.find(tool => tool.name === 'work_control')
  const workPlan = stub.tools.find(tool => tool.name === 'work_plan')
  const exec = { agent: { id: 'a', session: { id: 's', seq: 7 } }, callId: 'c', signal: undefined }
  const payload = {
    format: 'dsh-auto-dev/export@1',
    task: {
      id: 'task-elsewhere', project: '/repo/other', mode: 'build', request: 'do the thing',
      scope: ['.'], acceptance: ['tests pass'], units: [{ id: 'u1', goal: 'first', scope: ['a.js'], acceptance: ['x'], dependsOn: [], state: 'done' }],
      ledger: [{ unit: 'u1', outcome: 'complete', summary: 'done there', claims: [{ statement: 'tests pass' }] }],
    },
  }
  const value = await workControl.execute({ operation: 'import', payload }, exec)
  assert.equal(value.imported.from, 'task-elsewhere')
  assert.match(value.next, /run the checks on this machine/)
  const plan = await workPlan.execute({ operation: 'list' }, exec)
  assert.equal(plan.units[0].state, 'pending')
  const saved = [...stub.records.values()].find(row => row.id === value.taskId)
  assert.equal(saved.ledger[0].verifiedHere, false)
})

test('import answers a payload that is not an export without changing anything', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const workStart = stub.tools.find(tool => tool.name === 'work_start')
  const workControl = stub.tools.find(tool => tool.name === 'work_control')
  const exec = { agent: { id: 'a', session: { id: 's' } }, callId: 'c', signal: undefined }
  await workStart.execute({ request: 'x', mode: 'do' }, exec)
  const result = await workControl.execute({ operation: 'import', payload: { hello: 1 } }, exec)
  assert.equal(result.imported, false)
  assert.match(result.tellUser, /不是一份 dsh-auto-dev 导出/)
})

test('work_start moves the project root when the declared paths live in a subdirectory', async () => {
  // Regression for journey E: the session recorded the parent directory, so
  // every declared path resolved one level too high and a clean in-scope task
  // submitted with "writes outside the declared scope".
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const root = mkdtempSync(path.join(tmpdir(), 'v3-plugin-project-'))
  mkdirSync(path.join(root, 'journey-e'), { recursive: true })
  writeFileSync(path.join(root, 'journey-e', 'str.mjs'), '// fixture\n')
  try {
    const stub = stubContext(root)
    await (testApply(stub))
    const workStart = stub.tools.find(tool => tool.name === 'work_start')
    const exec = { agent: { id: 'agent-1', session: { id: 'session-1' } }, callId: 'call-1', signal: undefined }
    const value = await workStart.execute({ request: 'add a lower() to str.mjs with a test', mode: 'do', scope: ['str.mjs'] }, exec)
    assert.equal(value.project, path.join(root, 'journey-e'))
    assert.equal(value.projectRoot.adjusted, true)
    assert.equal(stub.records.get(`tasks/${value.taskId}`).project, path.join(root, 'journey-e'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkpoints: false stops the snapshot before it reaches git', async () => {
  const stub = stubContext('/tmp/v3-checkpoints-off')
  await testApply(stub, { checkpoints: false })
  const workStart = stub.tools.find(tool => tool.name === 'work_start')
  const exec = { agent: { id: 'agent-1', session: { id: 'session-1' } }, callId: 'call-1', signal: undefined }
  const value = await workStart.execute({ request: 'look at how the parser is wired', mode: 'do', scope: ['.'] }, exec)
  assert.equal(value.checkpoint.snapshot, 'skipped')
  assert.match(value.checkpoint.reason, /disabled in the dsh-auto-dev settings/)
})

test('another Auto Dev that shadows the tools owns the session, and v3 stays quiet', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const postExecute = stub.handlers.get('tools/post-execute')
  const preExecute = stub.handlers.get('tools/pre-execute')
  const v2Agent = {
    id: 'agent-v2', session: { id: 'session-v2', seq: 5 },
    ctx: { tools: { schemas: () => [{ name: 'work_submit', description: 'Auto Dev v2: submit a work result' }] } },
  }
  const exec = { agent: v2Agent, name: 'write', callId: 'call-1', arguments: { path: 'a.js', content: 'x' } }
  const downstream = { additionalContexts: [] }
  const after = await postExecute(exec, { isError: false }, async () => downstream)
  assert.equal(after, downstream, 'no reminder is added to a v2 session')
  assert.equal(stub.tables.tasks && Object.keys(stub.tables.tasks).length, 0, 'no phantom task is enrolled')
  const decision = await preExecute(exec, async () => undefined)
  assert.equal(decision, undefined, 'v3 does not refuse actions inside a v2 session')
})

/**
 * Every tool has to answer on the stub host, not just register.
 *
 * A refactor moved the tool table into its own module and silently dropped one
 * import: `work_status { view: "executions" }` threw a ReferenceError while all
 * 88 tests stayed green, because no test had ever called that view. Registration
 * is not coverage.
 */
test('every tool answers, including the views a refactor can orphan', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent: { id: 'agent-1', session: { id: 'session-1', seq: 3, eventAt: () => undefined } }, callId: `call-${name}`, signal: undefined }
    return tool.execute(args, exec)
  }

  const started = await call('work_start', {
    request: 'add a subtract function', mode: 'build', scope: ['.'],
    acceptance: ['npm test passes'],
    plan: [
      { id: 'u-1', goal: 'subtract exists', scope: ['.'], acceptance: ['tests pass'], dependsOn: [] },
      { id: 'u-2', goal: 'subtract is tested', scope: ['.'], acceptance: ['tests pass'], dependsOn: ['u-1'] },
    ],
  })
  assert.equal(started.gates.plan, false)

  assert.equal((await call('work_plan', { operation: 'list' })).units.length, 2)
  assert.equal((await call('work_plan', { operation: 'activate', unit: 'u-1' })).unit.state, 'active')
  assert.equal((await call('work_plan', { operation: 'state', unit: 'u-1', state: 'blocked' })).unit.state, 'blocked')

  const summary = await call('work_status', { view: 'summary' })
  assert.equal(summary.task.id, started.taskId)
  assert.equal(summary.units.length, 2)
  const board = await call('work_status', { view: 'board' })
  assert.equal(board.progress.done, 0)
  const executions = await call('work_status', { view: 'executions' })
  assert.equal(Array.isArray(executions.executions), true)

  assert.equal((await call('work_control', { operation: 'status' })).taskId, started.taskId)
  const checkpoints = await call('work_control', { operation: 'checkpoints' })
  assert.equal(typeof checkpoints.recorded, 'object')
  assert.equal(Array.isArray(checkpoints.refs), true)
  assert.equal((await call('work_control', { operation: 'pause' })).state, 'paused')
  assert.equal((await call('work_control', { operation: 'resume' })).state, 'active')
  assert.equal((await call('work_control', { operation: 'export' })).format, 'dsh-auto-dev/export@1')

  const asked = await call('work_extend', { kind: 'authorization', risk: 'recursive-delete', reason: 'clean the build directory' })
  assert.equal(asked.granted, false)
  assert.match(asked.tellUser, /直接问用户/)
  // Words the model writes into the call grant nothing.
  assert.equal((await call('work_extend', { kind: 'authorization', risk: 'recursive-delete', reason: 'clean', authorization: 'yes go ahead' })).granted, false)

  assert.equal((await call('work_control', { operation: 'cancel', reason: 'test over' })).state, 'cancelled')
})

test('a plan in the {units: [...]} spelling is the same plan', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent: { id: 'agent-1', session: { id: 'session-1', seq: 3, eventAt: () => undefined } }, callId: `call-${name}`, signal: undefined }
    return tool.execute(args, exec)
  }
  const units = [{ id: 'u1', goal: 'one', scope: ['src'], acceptance: [] }]
  const started = await call('work_start', { request: 'x', mode: 'build', plan: { units } })
  assert.ok(started.planId, 'work_start must return the plan it created')
  const listed = await call('work_plan', { taskId: started.taskId, operation: 'list' })
  assert.deepEqual(listed.units.map(unit => unit.id), ['u1'])
})

test('a plan with fields missing is filled in, not refused', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent: { id: 'agent-1', session: { id: 'session-1', seq: 3, eventAt: () => undefined } }, callId: `call-${name}`, signal: undefined }
    return tool.execute(args, exec)
  }
  const started = await call('work_start', { request: 'bad plan', mode: 'build', plan: [{ id: 'u1', goal: 'no scope, no children', acceptance: [] }] })
  const listed = await call('work_plan', { taskId: started.taskId, operation: 'list' })
  assert.deepEqual(listed.units.map(unit => [unit.id, unit.scope]), [['u1', ['.']]])
})

test('an unreadable plan starts the task without one', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent: { id: 'agent-1', session: { id: 'session-1', seq: 3, eventAt: () => undefined } }, callId: `call-${name}`, signal: undefined }
    return tool.execute(args, exec)
  }
  const started = await call('work_start', { request: 'x', mode: 'build', plan: { packets: [] } })
  assert.match(started.taskId, /^task-/)
  assert.equal(started.planId, undefined)
})

test('an option the owner picked lets the stopped action through; nothing is copied into a call', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const log = []
  const session = { id: 'sess-1', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-1', session }
  await stub.tools.find(candidate => candidate.name === 'work_start').execute({ request: 'write the config', mode: 'do', scope: ['.'] }, { agent, callId: 'c0' })
  const pre = stub.handlers.get('tools/pre-execute')
  const next = async () => ({ kind: 'continue' })
  const action = { name: 'bash', arguments: { command: 'git push --force' }, agent }
  assert.equal((await pre({ ...action, callId: 'c1' }, next)).kind, 'deny')
  log.push({ type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question', arguments: { questions: [{ question: 'Allow git push --force?' }] } } })
  log.push({ type: 'tool/result', data: { message: { toolCallId: 'q1', isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'ask', selected: ['allow'] }] }) }] } } })
  assert.equal((await pre({ ...action, callId: 'c2' }, next)).kind, 'continue')
})

test('a build plan arrives compiled: units in order, one verifier read from the repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-compile-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const stub = stubContext(root)
  await (testApply(stub))
  const exec = { agent: { id: 'agent-1', session: { id: 'sess-1', seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
  const call = (name, args) => stub.tools.find(candidate => candidate.name === name).execute(args, exec)

  const started = await call('work_start', {
    request: 'ship the parser',
    mode: 'build',
    scope: ['.'],
    plan: [{ id: 'u2', goal: 'parse', scope: ['src'], acceptance: [], dependsOn: ['u1'] }, { id: 'u1', goal: 'tokenise', scope: ['src'], acceptance: [] }],
  })
  assert.deepEqual(started.compiled.verifier, { command: 'npm test', source: 'package.json scripts.test' })
  assert.deepEqual(started.compiled.order.sort(), ['u1', 'u2'])
  assert.deepEqual(started.compiled.unresolved, [])

  const listed = await call('work_plan', { taskId: started.taskId, operation: 'list' })
  assert.equal(listed.units.every(unit => unit.verifier === 'npm test'), true)
  assert.deepEqual(listed.runnable, ['u1'])
})

test('a task can name its own project root, and a root that does not exist is refused', async () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'v3-session-'))
  const real = mkdtempSync(join(tmpdir(), 'v3-elsewhere-'))
  writeFileSync(join(real, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const stub = stubContext(sessionRoot)
  await (testApply(stub))
  const exec = { agent: { id: 'agent-1', session: { id: 'sess-1', seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
  const start = args => stub.tools.find(candidate => candidate.name === 'work_start').execute(args, exec)

  const named = await start({ request: 'x', mode: 'do', scope: ['.'], project: real })
  assert.equal(named.project, real, 'an explicit root beats every inference')

  await assert.rejects(() => start({ request: 'x', mode: 'do', scope: ['.'], project: join(real, 'nope') }), /is not a directory/)
})

test('a nested plan compiles to its leaves, and the report counts them rather than the milestones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-nested-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const stub = stubContext(root)
  await (testApply(stub))
  const exec = { agent: { id: 'agent-1', session: { id: 'sess-1', seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
  const started = await stub.tools.find(candidate => candidate.name === 'work_start').execute({
    request: 'ship it', mode: 'build', scope: ['.'],
    plan: {
      units: [
        { id: 'm1', goal: 'milestone one', scope: ['src'], acceptance: [], units: [
          { id: 'u-a', goal: 'a', scope: ['src'], acceptance: [], dependsOn: [] },
          { id: 'u-b', goal: 'b', scope: ['src'], acceptance: [], dependsOn: ['u-a'] },
        ] },
        { id: 'm2', goal: 'milestone two', scope: ['src'], acceptance: [], dependsOn: ['m1'] },
      ],
    },
  }, exec)
  // The declared array holds two milestones; the work is three leaves, and one node
  // of the three is a milestone-shaped unit that carries no children.
  assert.equal(started.compiled.units, 4, JSON.stringify(started.compiled))
  assert.equal(started.compiled.leaves, 3)
  assert.equal(started.compiled.milestones, 1)
  assert.deepEqual(started.compiled.order, ['m1', 'u-a', 'u-b', 'm2'])
  assert.deepEqual(started.compiled.unresolved, [])

  // The first runnable unit is a leaf, and it names the milestone that holds it.
  assert.equal(started.nextUnit.id, 'u-a')
  assert.equal(started.nextUnit.parent, 'm1')
  // Naming the milestone means the leaf inside it that is next.
  const activated = await stub.tools.find(candidate => candidate.name === 'work_plan')
    .execute({ taskId: started.taskId, operation: 'activate', unit: 'm1' }, exec)
  assert.equal(activated.unit.id, 'u-a')
})

test('a project with no declared check says so instead of inventing one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-noverify-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node .' } }))
  const stub = stubContext(root)
  await (testApply(stub))
  const exec = { agent: { id: 'agent-1', session: { id: 'sess-1', seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
  const started = await stub.tools.find(candidate => candidate.name === 'work_start')
    .execute({ request: 'x', mode: 'build', scope: ['.'], plan: [{ id: 'u1', goal: 'g', scope: ['src'], acceptance: [] }] }, exec)
  assert.equal(started.compiled.verifier, undefined)
  assert.deepEqual(started.compiled.unresolved, ['u1'])
})

test('what the project learns is written to the project and read back by the next task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-memory-live-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const stub = stubContext(root)
  await (testApply(stub))
  const exec = { agent: { id: 'agent-1', session: { id: 'sess-1', seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
  const call = (name, args) => stub.tools.find(candidate => candidate.name === name).execute(args, exec)

  const first = await call('work_start', { request: 'first', mode: 'do', scope: ['.'] })
  assert.equal(first.memory, undefined, 'an empty project sends no memory block')
  const stored = await call('work_control', { taskId: first.taskId, operation: 'remember', payload: { kind: 'fact', text: 'tests run with npm test' } })
  assert.equal(stored.stored, true)
  assert.match(stored.path, /\.auto-dev\/memory\.json$/)

  const second = await call('work_start', { request: 'second', mode: 'do', scope: ['.'] })
  assert.deepEqual(second.memory.facts, ['tests run with npm test'])
  assert.deepEqual(second.memory.counts, { facts: 1, incidents: 0 })

  const status = await call('work_status', { taskId: second.taskId })
  assert.equal(status.memory.facts, 1)
})

test('a scope that exists nowhere under the resolved project is reported, not silently out of scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v3-missingscope-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const stub = stubContext(root)
  await (testApply(stub))
  const exec = { agent: { id: 'agent-1', session: { id: 'sess-1', seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
  const started = await stub.tools.find(candidate => candidate.name === 'work_start')
    .execute({ request: 'x', mode: 'do', scope: ['src/nowhere.mjs'], acceptance: ['npm test 绿'] }, exec)
  assert.equal(started.warnings.length, 1)
  assert.match(started.warnings[0], /none of the declared scope exists under/)
})


test('activating a milestone activates the unit inside it', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const exec = { agent: { session: { seq: 1 }, id: 'agent-a' }, callId: 'call-plan-1' }
  const call = async (name, args) => stub.tools.find(tool => tool.name === name).execute(args, exec)
  const started = await call('work_start', {
    request: 'ship two milestones of work',
    mode: 'build',
    scope: ['.'],
    plan: {
      units: [
        { id: 'm1', goal: 'the first milestone', scope: ['.'], acceptance: [], units: [
          { id: 'm1-a', goal: 'first unit', scope: ['.'], acceptance: [] },
        ] },
      ],
    },
  })
  const milestone = await call('work_plan', { taskId: started.taskId, operation: 'list' })
  assert.equal(milestone.nextUnit.id, 'm1-a', 'the plan points at the unit inside the milestone, not the milestone')
  const activated = await call('work_plan', { taskId: started.taskId, operation: 'activate', unit: 'm1' })
  assert.equal(activated.unit.id, 'm1-a')
  assert.equal(activated.unit.state, 'active')
})

test('the plugin listens to the subagent lifecycle, which is the only place a child exists', async () => {
  const stub = stubContext(mkdtempSync(join(tmpdir(), 'v3-child-')))
  await (testApply(stub))
  assert.equal(typeof stub.handlers.get('subagent/start'), 'function')
  assert.equal(typeof stub.handlers.get('subagent/end'), 'function')
})

test('a task left half done in another session is adopted, and its window restarts here', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-adopt-'))
  const stub = stubContext(project)
  await (testApply(stub))

  const logA = []
  const sessionA = { id: 'sess-a', get seq() { return logA.length }, eventAt: index => logA[index] }
  const execA = { agent: { id: 'agent-a', session: sessionA }, callId: 'a1', signal: undefined }
  const callA = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, execA)
  const started = await callA('work_start', {
    request: 'add a formatter', mode: 'build', acceptanceMode: 'auto', project, scope: ['.'],
    plan: [{ id: 'u-one', goal: 'format() exists', scope: ['src/fmt.mjs'], acceptance: ['the suite passes'] }],
  })
  await callA('work_plan', { operation: 'activate', unit: 'u-one' })

  // A second session whose log starts at zero. Its seq numbers are its own, so a
  // task carrying the first session's `startedSeq` would filter out everything
  // this session observes — the exact way an honest claim looks invented.
  const logB = []
  const sessionB = { id: 'sess-b', get seq() { return logB.length }, eventAt: index => logB[index] }
  const execB = { agent: { id: 'agent-b', session: sessionB }, callId: 'b1', signal: undefined }
  const callB = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, execB)

  const listed = await callB('work_status', { view: 'tasks' })
  const row = listed.tasks.find(task => task.taskId === started.taskId)
  assert.ok(row, 'the ledger is shared, so another session\'s task is findable')
  assert.equal(row.here, false)

  const adopted = await callB('work_control', { operation: 'adopt', taskId: started.taskId })
  assert.equal(adopted.adopted, true)
  assert.equal(adopted.from, 'sess-a')
  assert.equal(adopted.state, 'active')
  assert.equal(adopted.nextUnit.id, 'u-one')

  logB.push({ type: 'tool/call', data: { callId: 'b-test', name: 'bash', arguments: { command: 'npm test' } } })
  logB.push({ type: 'tool/result', data: { message: { toolCallId: 'b-test', isError: false, content: [{ type: 'text', text: JSON.stringify({ exitCode: 0 }) }] } } })
  const submitted = await callB('work_submit', {
    outcome: 'complete', summary: 'format() added', next: 'none',
    claims: [{ statement: 'the suite passes', command: 'npm test', execution: { callId: 'b-test' } }],
  })
  assert.equal(submitted.outcome, 'complete')
  assert.equal(submitted.state, 'closed')
})

test('adopt answers what cannot be continued with what can', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-adopt-'))
  const stub = stubContext(project)
  await (testApply(stub))
  const log = []
  const session = { id: 'sess-c', get seq() { return log.length }, eventAt: index => log[index] }
  const exec = { agent: { id: 'agent-c', session }, callId: 'c1', signal: undefined }
  const call = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, exec)

  assert.match((await call('work_control', { operation: 'adopt' })).tellUser, /没说接手哪一条/)
  assert.match((await call('work_control', { operation: 'adopt', taskId: 'task-nope' })).tellUser, /没有任务 task-nope/)

  const started = await call('work_start', { request: 'x', mode: 'do', project, scope: ['.'] })
  await call('work_control', { operation: 'cancel', taskId: started.taskId, reason: 'done elsewhere' })
  const cancelled = await call('work_control', { operation: 'adopt', taskId: started.taskId })
  assert.equal(cancelled.adopted, false)
  assert.match(cancelled.tellUser, /已取消/)
})

test('a snapshot taken here travels as a coordinate, so an import keeps what it cannot carry', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-export-'))
  const run = command => execFileSync('git', command, { cwd: project, stdio: 'ignore' })
  run(['init', '-q'])
  run(['config', 'user.email', 'v3@example.test'])
  run(['config', 'user.name', 'v3'])
  writeFileSync(join(project, 'README.md'), '# demo\n')
  run(['add', '.'])
  run(['commit', '-qm', 'init'])
  // A clean tree has nothing to snapshot, so the demo leaves a real edit behind:
  // 'before' means 'what the work started from', not 'the empty diff'.
  writeFileSync(join(project, 'README.md'), '# demo\n\nedited before the task\n')

  const stub = stubContext(project)
  await (testApply(stub))
  const log = []
  const session = { id: 'sess-d', get seq() { return log.length }, eventAt: index => log[index] }
  const exec = { agent: { id: 'agent-d', session }, callId: 'd1', signal: undefined }
  const call = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, exec)

  const started = await call('work_start', { request: 'x', mode: 'do', project, scope: ['.'] })
  assert.equal(started.checkpoint.snapshot, 'captured')
  const exported = await call('work_control', { operation: 'export', taskId: started.taskId })
  assert.equal(exported.format, 'dsh-auto-dev/export@1')
  assert.equal(exported.task.checkpoints.length, 1)
  // The coordinate travels; the object does not. A restore on the far side says
  // "that checkpoint object is gone from this repository" instead of pretending.
  assert.equal(exported.task.checkpoints[0].tag, 'before')
  assert.equal(exported.task.checkpoints[0].commit, started.checkpoint.commit)

  const imported = await call('work_control', { operation: 'import', payload: exported })
  const record = stub.records.get(`tasks/${imported.taskId}`)
  assert.equal(record.checkpoints[0].commit, started.checkpoint.commit)
  assert.equal(record.imported.from, started.taskId)
})

test('a slash command cannot address the model, so it leaves a request the next step picks up', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-intake-'))
  const stub = stubContext(project)
  await (testApply(stub))
  const log = []
  const session = { id: 'sess-e', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-e', session }
  const command = stub.commands[0]

  const empty = await command.handler({ agent, rawInput: 'start' })
  assert.equal(empty.kind, 'error')
  const started = await command.handler({ agent, rawInput: 'start 给 slug 加 trim，并补一个测试' })
  assert.equal(started.kind, 'success')

  const pre = stub.handlers.get('agent/pre-step')
  const next = async () => ({ kind: 'allow', messages: [] })
  const step = await pre({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '开始' }] }], step: 1 }, next)
  const notice = step.messages.find(message => message.source?.kind === 'dsh-auto-dev')
  assert.ok(notice, 'the request has to reach the model somehow')
  assert.match(notice.content[0].text, /给 slug 加 trim，并补一个测试/)
  assert.match(notice.content[0].text, /已经登记好，直接开工/)
  assert.equal(Object.values(stub.tables.tasks).find(task => task.sessionId === 'sess-e')?.request, '给 slug 加 trim，并补一个测试')

  // Delivered once: the next step must not repeat it as if it were fresh.
  const again = await pre({ agent, messages: [], step: 2 }, next)
  assert.equal(again.messages.filter(message => message.source?.summary === 'dsh-auto-dev start').length, 0)
})

test('a fresh session is told which task is already half done, so "continue" has an address', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-resume-'))
  const stub = stubContext(project)
  await (testApply(stub))

  const logA = []
  const sessionA = { id: 'sess-f', get seq() { return logA.length }, eventAt: index => logA[index] }
  const execA = { agent: { id: 'agent-f', session: sessionA }, callId: 'f1', signal: undefined }
  const callA = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, execA)
  const started = await callA('work_start', {
    request: 'split the parser into two modules', mode: 'build', project, scope: ['.'],
    plan: [{ id: 'u-lex', goal: 'the lexer lives in its own file', scope: ['src/lex.mjs'], acceptance: ['the suite passes'] }],
  })
  assert.ok(started.taskId)

  // A second conversation on the same project, first turn: the person just says
  // "continue". Nothing in the conversation knows the task exists; the hint does.
  const logB = []
  const sessionB = { id: 'sess-g', get seq() { return logB.length }, eventAt: index => logB[index] }
  const agentB = { id: 'agent-g', session: sessionB }
  const pre = stub.handlers.get('agent/pre-step')
  const next = async () => ({ kind: 'allow', messages: [] })
  const step = await pre({ agent: agentB, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '继续工作' }] }], step: 1 }, next)
  const hint = step.messages.find(message => message.source?.summary === 'dsh-auto-dev resume hint')
  assert.ok(hint, 'without this the model starts a second task over the first')
  assert.match(hint.content[0].text, new RegExp(started.taskId))
  assert.match(hint.content[0].text, /接过来再继续/)
  assert.match(hint.content[0].text, /split the parser into two modules/)

  // Said once, and only while the task is unfinished.
  const again = await pre({ agent: agentB, messages: [], step: 2 }, next)
  assert.equal(again.messages.filter(message => message.source?.summary === 'dsh-auto-dev resume hint').length, 0)
})

test('a request typed after the command name starts the work now, not on the next message', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-command-'))
  const stub = stubContext(project)
  await (testApply(stub))

  const log = []
  const session = { id: 'sess-h', get seq() { return log.length }, eventAt: index => log[index] }
  const turns = []
  // What a real host gives a command handler: followup opens an ordinary turn.
  const agent = { id: 'agent-h', session, followup: message => turns.push(message) }
  const command = stub.commands[0]

  // How a person actually asks: the command name, then the request in their words.
  const answered = await command.handler({ agent, rawInput: '给 slug 加 trim，并补一个测试' })
  assert.equal(answered.kind, 'success')
  assert.match(answered.text, /已交给模型/)
  assert.equal(turns.length, 1, 'the words have to reach the model in this same gesture')
  assert.equal(turns[0].source.kind, 'user')
  assert.equal(turns[0].content[0].text, '给 slug 加 trim，并补一个测试')

  // Nothing is left waiting for a second message: the request already went through.
  const pre = stub.handlers.get('agent/pre-step')
  const step = await pre({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '给 slug 加 trim，并补一个测试' }] }], step: 1 }, async () => ({ kind: 'allow', messages: [] }))
  assert.equal(step.messages.filter(message => message.source?.summary === 'dsh-auto-dev start').length, 0)

  // A real verb still wins: `status` answers and opens nothing.
  const status = await command.handler({ agent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.equal(turns.length, 1, 'a status query must not open a turn')
})

test('adopt continues in the same gesture, and the turn names the task and the first step', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-command-adopt-'))
  const stub = stubContext(project)
  await (testApply(stub))

  // A task abandoned by another session: this is what a person comes back to.
  const logA = []
  const sessionA = { id: 'sess-i', get seq() { return logA.length }, eventAt: index => logA[index] }
  const started = await stub.tools.find(tool => tool.name === 'work_start').execute({
    request: 'split the parser into two modules', mode: 'build', project, scope: ['.'],
    plan: [{ id: 'u-lex', goal: 'the lexer lives in its own file', scope: ['src/lex.mjs'], acceptance: ['the suite passes'] }],
  }, { agent: { id: 'agent-i', session: sessionA }, callId: 'i1', signal: undefined })

  const log = []
  const session = { id: 'sess-j', get seq() { return log.length }, eventAt: index => log[index] }
  const turns = []
  const agent = { id: 'agent-j', session, followup: message => turns.push(message) }

  const adopted = await stub.commands[0].handler({ agent, rawInput: 'adopt' })
  assert.equal(adopted.kind, 'success')
  assert.equal(turns.length, 1, 'adopting without continuing would need a second message')
  assert.match(turns[0].content[0].text, new RegExp(started.taskId))
  assert.match(turns[0].content[0].text, /接手卡/)
  assert.equal(turns[0].source.kind, 'user')
})

/**
 * The silence nudge: a worker that runs steps without one visible sentence
 * leaves the owner guessing. The bar is one number; the reminder re-arms only
 * after another full window; a child reports to its parent, not the owner.
 */
const narrationSuite = async (config = {}) => {
  const project = mkdtempSync(join(tmpdir(), 'v3-narrate-'))
  const stub = stubContext(project)
  await testApply(stub, config)
  // The reminder reads the session log (host facts): one step/start + assistant/message per step.
  const log = []
  const session = { id: 'sess-n', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-n', session }
  const hook = stub.handlers.get('agent/pre-step')
  let last = 0
  const pre = ({ agent, messages, step }, next) => {
    for (let at = last + 1; at <= step; at++) {
      log.push({ type: 'step/start', data: { step: at } })
      const content = at === step ? messages[0].content : [{ type: 'tool-call', name: 'bash' }]
      log.push({ type: 'assistant/message', data: { step: at, message: { role: 'assistant', content } } })
    }
    last = step
    return hook({ agent, messages, step }, next)
  }
  const toolOnly = [{ role: 'assistant', content: [{ type: 'tool_call', name: 'bash' }] }]
  const spoke = text => [{ role: 'assistant', content: [{ type: 'text', text }] }]
  const firedIn = stepResult => stepResult.messages.filter(m => m.source?.summary === 'no visible words to the user').length
  return { agent, pre, toolOnly, spoke, firedIn }
}

test('a silent worker is told to say a word to the owner, once per window', async () => {
  const { agent, pre, toolOnly, spoke, firedIn } = await narrationSuite()
  // 29 quiet steps: quiet is allowed to be quiet.
  assert.equal(firedIn(await pre({ agent, messages: toolOnly, step: 29 }, async () => ({ kind: 'allow', messages: [] }))), 0)
  // At the bar it fires — and not again on the next step.
  assert.equal(firedIn(await pre({ agent, messages: toolOnly, step: 30 }, async () => ({ kind: 'allow', messages: [] }))), 1)
  assert.equal(firedIn(await pre({ agent, messages: toolOnly, step: 31 }, async () => ({ kind: 'allow', messages: [] }))), 0)
  // A visible sentence resets the clock; the next window re-arms from there.
  assert.equal(firedIn(await pre({ agent, messages: spoke('我开始处理登录分支的缓存失效'), step: 40 }, async () => ({ kind: 'allow', messages: [] }))), 0)
  assert.equal(firedIn(await pre({ agent, messages: toolOnly, step: 55 }, async () => ({ kind: 'allow', messages: [] }))), 0)
  assert.equal(firedIn(await pre({ agent, messages: toolOnly, step: 70 }, async () => ({ kind: 'allow', messages: [] }))), 1)
})

test('a delegated child is exempt: it reports to its parent, who relays', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-narrate-child-'))
  const stub = stubContext(project)
  await (testApply(stub))
  const session = { id: 'sess-nc', header: { id: 'sess-nc', parentSession: 'sess-owner' }, get seq() { return 0 }, eventAt: () => undefined }
  const agent = { id: 'agent-nc', session }
  const pre = stub.handlers.get('agent/pre-step')
  const step = await pre({ agent, messages: [{ role: 'assistant', content: [{ type: 'tool_call', name: 'bash' }] }], step: 99 }, async () => ({ kind: 'allow', messages: [] }))
  assert.equal(step.messages.filter(m => m.source?.summary === 'no visible words to the user').length, 0)
})

test('narrationNudgeAfter=0 turns the reminder off, and the schema bounds the rest', async () => {
  const { agent, pre, toolOnly, firedIn } = await narrationSuite({ narrationNudgeAfter: 0 })
  assert.equal(firedIn(await pre({ agent, messages: toolOnly, step: 500 }, async () => ({ kind: 'allow', messages: [] }))), 0)
  assert.equal(DSH_AUTO_DEV_SCHEMA({ narrationNudgeAfter: 0 }).narrationNudgeAfter, 0)
  assert.throws(() => DSH_AUTO_DEV_SCHEMA({ narrationNudgeAfter: 501 }), TypeError)
  assert.throws(() => DSH_AUTO_DEV_SCHEMA({ narrationNudgeAfter: -1 }), TypeError)
})

test('work_start ships the reporting contract with the task', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-telluser-'))
  const stub = stubContext(project)
  await (testApply(stub))
  const session = { id: 'sess-t', get seq() { return 0 }, eventAt: () => undefined }
  const exec = { agent: { id: 'agent-t', session }, callId: 't1', signal: undefined }
  const started = await stub.tools.find(tool => tool.name === 'work_start').execute({ request: '修一个登录跳转', mode: 'do', project }, exec)
  assert.match(started.tellUser, /用户一句/)
})

// ------------------------------------------- user-started only (requireUserStart)
test('work_start is not even offered until the user starts, and one start grants one task', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-gate-'))
  const stub = stubContext(project)
  await apply(stub.ctx, {})   // the profile default: requireUserStart true

  const log = []
  const session = { id: 'sess-gate', get seq() { return log.length }, eventAt: index => log[index] }
  const turns = []
  const agent = { id: 'agent-gate', session, followup: message => turns.push(message) }
  const call = (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    assert.ok(tool, `${name} is offered to a session that never started Auto Dev`)
    return tool.execute(args, { agent, callId: 'g1', signal: undefined })
  }

  // Dormant: the model never sees a `work_*` tool, so it cannot register a task on
  // its own initiative and no refusal has to be explained to it. This is the whole
  // point of the opt-in — a conversation that never asked gets nothing at all.
  assert.equal(stub.tools.length, 0, 'a dormant session gets no Auto Dev tools')
  assert.equal(turns.length, 0)

  // The person starts: the command is the opt-in, writes the grant, and the words
  // ride this gesture.
  const answered = await stub.commands[0].handler({ agent, rawInput: 'start 把登录按钮改成进度条' })
  assert.equal(answered.kind, 'success')
  assert.equal(turns.length, 1, 'the grant and the turn come from the same user gesture')
  assert.deepEqual(stub.tools.map(tool => tool.name).sort(), ['work_control', 'work_env', 'work_extend', 'work_plan', 'work_start', 'work_status', 'work_submit'])

  // Drive the command's actual followup: the model must see registration as the
  // next action, not a request to make the person repeat the command.
  log.push({ type: 'user/message', data: { message: turns[0] } })
  const preStep = stub.handlers.get('agent/pre-step')
  const hinted = await preStep({ agent, messages: [turns[0]], step: 1 }, async () => ({ kind: 'continue', messages: [turns[0]] }))
  const granted = hinted.messages.find(message => message.source?.summary === 'dsh-auto-dev start granted')
  assert.ok(granted)
  // The start registered the task itself: the model reads the user's words and begins, filling nothing.
  assert.doesNotMatch(granted.content[0].text, /work_start/)
  assert.match(granted.content[0].text, /不用再问要不要开始/)
  assert.match(granted.content[0].text, /把登录按钮改成进度条/)
  assert.equal(hinted.messages.some(message => message.source?.summary === 'dsh-auto-dev standing hint'), false)
  const repeated = await preStep({ agent, messages: [turns[0]], step: 1 }, async () => ({ kind: 'continue', messages: [turns[0]] }))
  assert.equal(repeated.messages.some(message => message.source?.summary === 'dsh-auto-dev start granted'), false, 'the registration is once per grant')
  assert.equal(Object.keys(stub.tables.tasks).length, 1)
  const seen = await call('work_status', {})
  assert.equal(seen.task.request, '把登录按钮改成进度条')

  // One start, one task: a second call hears the task already open (v32 #53 said "nobody started"),
  // and books nothing new.
  const tasks = Object.keys(stub.tables.tasks).length
  const again = await call('work_start', { request: '再来一个', mode: 'do', project })
  assert.equal(again.already, true)
  assert.equal(again.taskId, seen.task.id)
  assert.equal(Object.keys(stub.tables.tasks).length, tasks)
})

test('a profile can restore model-initiated starts with requireUserStart: false', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-gate-off-'))
  const stub = stubContext(project)
  await apply(stub.ctx, { requireUserStart: false })
  const log = []
  const session = { id: 'sess-open', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-open', session }
  const started = await stub.tools.find(tool => tool.name === 'work_start').execute(
    { request: '按你自己的想法改', mode: 'do', project }, { agent, callId: 'o1', signal: undefined })
  assert.ok(started.taskId)
})

test('the start command accepts attachments and carries them into the turn', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-attach-'))
  const stub = stubContext(project)
  await apply(stub.ctx, {})
  const log = []
  const session = { id: 'sess-attach', get seq() { return log.length }, eventAt: index => log[index] }
  const turns = []
  const agent = { id: 'agent-attach', session, followup: message => turns.push(message) }
  const command = stub.commands[0]
  // The composer refuses attachments on any command that does not declare them,
  // so the declaration is the fix — a screenshot with the request is normal work.
  assert.equal(command.input?.attachments, true)
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAA' } }
  const answered = await command.handler({ agent, rawInput: 'start 照这张图改按钮', attachments: [image] })
  assert.equal(answered.kind, 'success')
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].content[0], image, 'the picture rides the same user message')
  assert.match(turns[0].content[1].text, /照这张图改按钮/)
  assert.match(answered.text, /1 个附件/)
})

test('the settings section and its schema carry requireUserStart and autoEnroll', async () => {
  const stub = stubContext()
  await apply(stub.ctx, {})
  const settings = DSH_AUTO_DEV_SCHEMA({})
  assert.equal(settings.requireUserStart, true, 'a person must start the task')
  assert.equal(settings.autoEnroll, false, 'writes alone no longer book a task')
  const json = DSH_AUTO_DEV_SCHEMA.toJSON()
  assert.equal(json.properties.requireUserStart.default, true)
  assert.equal(json.properties.autoEnroll.default, false)
})

// ------------------------------------------------ progress notes, hints, settle-ups
test('work_plan note appends a line, survives an add, and shows in list', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-note-'))
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const session = { id: 'sess-note', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-note', session }
  const call = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, { agent, callId: 'n1', signal: undefined })
  await call('work_start', {
    request: '分两步做', mode: 'build', project, scope: ['.'],
    plan: [{ id: 'u-a', goal: '第一步', scope: ['.'], acceptance: ['ok'] }],
  })
  const noted = await call('work_plan', { operation: 'note', unit: 'u-a', text: '跑通了一半' })
  assert.equal(noted.recorded, true)
  // Appending a unit re-normalizes the whole plan; the note has to survive it.
  await call('work_plan', { operation: 'add', units: [{ id: 'u-b', goal: '第二步', scope: ['.'], acceptance: [] }] })
  const listed = await call('work_plan', { operation: 'list' })
  assert.equal(listed.units.find(unit => unit.id === 'u-a').note, '跑通了一半')
  // An empty note records nothing; any other line is kept as written.
  assert.equal((await call('work_plan', { operation: 'note', unit: 'u-a', text: '   ' })).recorded, false)
  // Activating a unit teaches the note path in the same breath.
  const activated = await call('work_plan', { operation: 'activate', unit: 'u-a' })
  assert.match(activated.tellUser, /用户一句/)
})

test('a write before work_start gets one hint about the user-start command, and no phantom task', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-hint-'))
  const stub = stubContext(project)
  await testApply(stub)
  const agent = { id: 'agent-hint', session: { id: 'sess-hint', seq: 3 } }
  const postExecute = stub.handlers.get('tools/post-execute')
  const downstream = { additionalContexts: [] }
  const exec = { agent, name: 'write', callId: 'h1', arguments: { path: 'src/x.mjs', content: 'x' } }
  const after = await postExecute(exec, { isError: false }, async () => downstream)
  const hints = after.additionalContexts.filter(notice => notice.source?.summary === 'dsh-auto-dev start hint')
  assert.equal(hints.length, 1)
  assert.match(hints[0].content[0].text, /\/dsh-auto-dev start/)
  // Once per session: a reminder that repeats is one people learn to skip.
  const again = await postExecute({ ...exec, callId: 'h2' }, { isError: false }, async () => downstream)
  assert.equal(again.additionalContexts.filter(notice => notice.source?.summary === 'dsh-auto-dev start hint').length, 0)
  assert.equal(Object.keys(stub.tables.tasks ?? {}).length, 0, 'no phantom task is enrolled')
})

test('an active unit gets no bookkeeping knock after 20 calls', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-settle-'))
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const session = { id: 'sess-settle', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-settle', session }
  const call = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, { agent, callId: 's1', signal: undefined })
  await call('work_start', { request: '一步步来', mode: 'build', project, scope: ['.'], plan: [{ id: 'u-a', goal: '第一步', scope: ['.'], acceptance: [] }] })
  await call('work_plan', { operation: 'activate', unit: 'u-a' })
  // Work piles up: enough calls that the settlement clock is past its window.
  for (let index = 0; index < 25; index += 1) log.push({ role: 'user', content: [{ type: 'text', text: 'x' }] })
  const pre = stub.handlers.get('agent/pre-step')
  const next = async () => ({ kind: 'allow', messages: [] })
  const first = await pre({ agent, messages: [], step: 2 }, next)
  assert.equal(first.messages.filter(notice => notice.source?.summary === 'dsh-auto-dev settle up').length, 0)
  // A recorded note is a settlement: the clock starts again.
  await call('work_plan', { operation: 'note', unit: 'u-a', text: '做完第一页' })
  const quiet = await pre({ agent, messages: [], step: 3 }, next)
  assert.equal(quiet.messages.filter(notice => notice.source?.summary === 'dsh-auto-dev settle up').length, 0)
  for (let index = 0; index < 20; index += 1) log.push({ role: 'user', content: [{ type: 'text', text: 'x' }] })
  const again = await pre({ agent, messages: [], step: 4 }, next)
  assert.equal(again.messages.filter(notice => notice.source?.summary === 'dsh-auto-dev settle up').length, 0)
})

test('a plan with no active unit gets no activation nag', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-noname-'))
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const session = { id: 'sess-noname', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-noname', session }
  const call = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, { agent, callId: 's1', signal: undefined })
  await call('work_start', { request: '三个单元', mode: 'build', project, scope: ['.'], plan: [
    { id: 'u-a', goal: '第一步', scope: ['.'], acceptance: [] },
    { id: 'u-b', goal: '第二步', scope: ['.'], acceptance: [], dependsOn: ['u-a'] },
  ] })
  const pre = stub.handlers.get('agent/pre-step')
  const next = async () => ({ kind: 'allow', messages: [] })
  const fired = step => step.messages.filter(notice => notice.source?.summary === 'dsh-auto-dev name the step').length
  // The baseline is taken on the first look; a window of calls after it fires once.
  assert.equal(fired(await pre({ agent, messages: [], step: 2 }, next)), 0)
  for (let index = 0; index < 25; index += 1) log.push({ role: 'user', content: [{ type: 'text', text: 'x' }] })
  assert.equal(fired(await pre({ agent, messages: [], step: 3 }, next)), 0)
  assert.equal(fired(await pre({ agent, messages: [], step: 4 }, next)), 0)
  // Naming a step is what the ask was for: it stops.
  await call('work_plan', { operation: 'activate', unit: 'u-a' })
  for (let index = 0; index < 25; index += 1) log.push({ role: 'user', content: [{ type: 'text', text: 'x' }] })
  assert.equal(fired(await pre({ agent, messages: [], step: 5 }, next)), 0)
})

test('a closed task gets no settlement knock: there is no unit left to settle', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-settle-closed-'))
  const stub = stubContext(project)
  await testApply(stub)
  const log = []
  const session = { id: 'sess-settle-closed', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-settle-closed', session }
  const call = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, { agent, callId: 's1', signal: undefined })
  const started = await call('work_start', { request: '一次性做完', mode: 'build', project, scope: ['.'], plan: [{ id: 'u-a', goal: '唯一一步', scope: ['.'], acceptance: [] }] })
  await call('work_plan', { operation: 'activate', unit: 'u-a' })
  await call('work_submit', { taskId: started.taskId, unit: 'u-a', outcome: 'complete', summary: '做完了这一步，测试通过', next: '无' })
  for (let index = 0; index < 40; index += 1) log.push({ role: 'user', content: [{ type: 'text', text: 'x' }] })
  const pre = stub.handlers.get('agent/pre-step')
  const result = await pre({ agent, messages: [], step: 2 }, async () => ({ kind: 'allow', messages: [] }))
  assert.equal(result.messages.filter(notice => notice.source?.summary === 'dsh-auto-dev settle up').length, 0)
})

test('start resumes the unfinished task instead of opening a second one', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-resume-'))
  const stub = stubContext(project)
  await testApply(stub)
  const tools = Object.fromEntries(stub.tools.map(tool => [tool.name, tool]))
  const previous = { id: 'agent-prev', session: { id: 'session-prev', get seq() { return 0 }, eventAt: () => undefined } }
  const created = await tools.work_start.execute(
    { request: '把第三个入口接进新分支', mode: 'build', project,
      plan: [{ id: 'u1', goal: '接进入口', scope: ['.'], acceptance: [] }, { id: 'u2', goal: '跑回归', scope: ['.'], acceptance: [] }] },
    { agent: previous, callId: 'p1', signal: undefined })
  assert.ok(created.taskId)
  const turns = []
  const session = { id: 'session-next', get seq() { return 0 }, eventAt: () => undefined }
  const agent = { id: 'agent-next', session, followup: message => turns.push(message) }
  const answered = await stub.commands[0].handler({ agent, rawInput: 'start 接着上次那件事，先把日志也看一眼' })
  assert.equal(answered.kind, 'success')
  assert.match(answered.text, /已接管/)
  assert.match(answered.text, /new/)
  // The point of the rule: one task, not two.
  assert.deepEqual(Object.keys(stub.tables.tasks), [created.taskId])
  assert.equal(stub.tables.tasks[created.taskId].sessionId, 'session-next', 'the record moved to this session')
  assert.equal(turns.length, 1)
  assert.match(turns[0].content.at(-1).text, /不要重新登记/)
  assert.match(turns[0].content.at(-1).text, /先把日志也看一眼/)
})

test('new opens a fresh task even while older work is unfinished', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-new-task-'))
  const stub = stubContext(project)
  await apply(stub.ctx, {})
  const now = new Date().toISOString()
  stub.tables.tasks['task-old'] = {
    id: 'task-old', project, mode: 'build', state: 'active', sessionId: 'session-gone',
    request: '旧活', createdAt: now, updatedAt: now, ledger: [],
  }
  const log = []
  const turns = []
  const session = { id: 'session-new', get seq() { return log.length }, eventAt: index => log[index] }
  const agent = { id: 'agent-new', session, followup: message => turns.push(message) }
  const answered = await stub.commands[0].handler({ agent, rawInput: 'new 另起一件事' })
  assert.equal(answered.kind, 'success')
  assert.match(answered.text, /已交给模型/)
  log.push({ type: 'user/message', data: { message: turns[0] } })
  const hinted = await stub.handlers.get('agent/pre-step')(
    { agent, messages: [turns[0]], step: 1 }, async () => ({ kind: 'continue', messages: [turns[0]] }))
  assert.ok(hinted.messages.some(message => message.source?.summary === 'dsh-auto-dev start granted'))
  assert.equal(hinted.messages.some(message => message.source?.summary === 'dsh-auto-dev resume hint'), false,
    'an explicit new must not be redirected to unfinished work')
  // The command opted this session in, so the model has the tools now; its words
  // are the grant, so a fresh task can be registered while the older one waits.
  const tools = Object.fromEntries(stub.tools.map(tool => [tool.name, tool]))
  assert.ok(tools.work_start, 'the command is the opt-in: the tools arrive with it')
  // The command's words registered the new task on the first step; the model filled nothing.
  const started = Object.values(stub.tables.tasks).find(task => task.sessionId === 'session-new')
  assert.equal(started.request, '另起一件事')
  assert.notEqual(started.id, 'task-old')
  assert.equal(stub.tables.tasks['task-old'].sessionId, 'session-gone', 'the old task was left alone')
})

// --- who may see Auto Dev at all -------------------------------------------
//
// A conversation that never asked got the tools, the craft skill and four
// different nudges, all of them in the model's context: a session that never ran
// `/dsh-auto-dev` was told to ask the user whether to track the work, and was told
// about another window's unfinished task by name. Opting in is a record now, and
// nothing Auto Dev says to the model may cross it.

test('a dormant session hears nothing, not even that another window has a task', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-dormant-'))
  const stub = stubContext(project)
  await apply(stub.ctx, {})
  const now = new Date().toISOString()
  stub.tables.tasks['task-elsewhere'] = {
    id: 'task-elsewhere', version: 1, project, mode: 'build', state: 'active', sessionId: 'session-elsewhere',
    request: '别人家没做完的活', createdAt: now, updatedAt: now, ledger: [],
  }
  const pre = stub.handlers.get('agent/pre-step')
  const userMessage = [{ role: 'user', content: [{ type: 'text', text: '继续' }] }]
  const decision = await pre(
    { agent: { id: 'agent-quiet', session: { id: 'session-quiet' } }, messages: userMessage, step: 1 },
    async () => ({ kind: 'allow', messages: [] }),
  )
  assert.deepEqual(decision.messages, [], 'a session that never opted in gets no notice at all')

  // A subagent is never told to ask a human: it cannot talk to one. Its parent
  // opted in, which must not travel down.
  await stub.commands[0].handler({
    agent: { id: 'agent-parent', session: { id: 'session-parent' }, followup: () => {} },
    rawInput: 'start 让子代理看一眼',
  })
  stub.tables.sessions['session-child'] = { id: 'session-child', version: 1, project, at: now }
  const child = await pre(
    { agent: { id: 'agent-child', session: { id: 'session-child', header: { parentSession: 'session-parent' } } }, messages: userMessage, step: 1 },
    async () => ({ kind: 'allow', messages: [] }),
  )
  assert.deepEqual(child.messages, [], 'a subagent is never asked to bring the user in')
})

test('opting in is a record: a reloaded host gives the session its tools back', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-optin-'))
  const stub = stubContext(project)
  await apply(stub.ctx, {})
  const first = { id: 'agent-1', session: { id: 'session-keep' }, followup: () => {} }
  await stub.commands[0].handler({ agent: first, rawInput: 'start 记住这件事' })
  assert.equal(stub.tables.sessions['session-keep'].project, project, 'the opt-in is stored, not only remembered')

  // The host comes back with the same storage and none of the plugin's memory.
  const reloaded = stubContext(project, stub.tables)
  await apply(reloaded.ctx, {})
  assert.equal(reloaded.tools.length, 0, 'a fresh host starts dormant for every conversation')
  const created = reloaded.handlers.get('agent/created')
  assert.ok(created, 'the session must be told apart when it is announced, not guessed at chat time')
  created({ agent: { id: 'agent-r', session: { id: 'session-keep' } } })
  assert.deepEqual(reloaded.tools.map(tool => tool.name).sort(),
    ['work_control', 'work_env', 'work_extend', 'work_plan', 'work_start', 'work_status', 'work_submit'])
  created({ agent: { id: 'agent-o', session: { id: 'session-other' } } })
  assert.equal(reloaded.tools.length, 7, 'a different conversation stays dormant')

  // Announcing the same session again does not stack a second set on top of it.
  created({ agent: { id: 'agent-r2', session: { id: 'session-keep' } } })
  assert.equal(reloaded.tools.length, 7)
})

test('a task already running when this build arrives keeps its conversation enabled', async () => {
  const project = mkdtempSync(join(tmpdir(), 'v3-carry-'))
  const stub = stubContext(project)
  const now = new Date().toISOString()
  stub.tables.tasks['task-live'] = {
    id: 'task-live', version: 1, project, mode: 'do', state: 'active', sessionId: 'session-live',
    request: '还没做完的活', createdAt: now, updatedAt: now, ledger: [],
  }
  stub.tables.tasks['task-done'] = {
    id: 'task-done', version: 1, project, mode: 'do', state: 'closed', sessionId: 'session-done',
    request: '早就做完的活', createdAt: now, updatedAt: now, ledger: [],
  }
  await apply(stub.ctx, {})
  // An upgrade must not take the tools away from a conversation that is mid-task;
  // a finished task is history, not a standing grant.
  assert.ok(stub.tables.sessions['session-live'], 'the in-flight task records its holder')
  assert.equal(stub.tables.sessions['session-live'].project, project)
  assert.equal(stub.tables.sessions['session-done'], undefined)
  stub.handlers.get('agent/created')({ agent: { id: 'agent-live', session: { id: 'session-live' } } })
  assert.equal(stub.tools.filter(tool => tool.name === 'work_start').length, 1)
})

test('a unit opens with a checkpoint, asks when a person is needed, and closes with a card', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const post = stub.handlers.get('tools/post-execute')
  const log = []
  const agent = { id: 'agent-unit', session: { id: 'session-unit', get seq() { return log.length }, eventAt: index => log[index] } }
  // A tool cannot address the model: whatever it says has to leave through the
  // host's context channel, which is what post-execute does with the outbox.
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.operation ?? args.outcome ?? ''}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }
  const form = (contexts, wanted) => contexts.find(message => message.source?.form === wanted)

  await call('work_start', { request: '把渲染管线做完', mode: 'do', scope: ['.'], acceptance: ['能渲染'] })
  await call('work_plan', {
    operation: 'set',
    units: [{ id: 'b1', goal: '渲染管线落地', scope: ['.'], acceptance: ['能渲染'], deliverable: '一屏能演示的渲染管线' }],
  })

  const opened = await call('work_plan', { operation: 'activate', unit: 'b1' })
  assert.equal(opened.result.unit.deliverable, '一屏能演示的渲染管线', 'the plan keeps the sentence the unit promised')
  const open = form(opened.contexts, 'unit-start')
  assert.ok(open, 'opening a unit tells the conversation')
  assert.equal(open.source.data.unit, 'b1')
  assert.match(open.content[0].text, /开始/)
  assert.equal(open.content[0].text.includes('一屏能演示的渲染管线'), true)

  const asked = await call('work_plan', { operation: 'ask', unit: 'b1', text: '产物要放进仓库吗？' })
  assert.equal(asked.result.asked, '产物要放进仓库吗？')
  const question = form(asked.contexts, 'ask')
  assert.ok(question, 'a question becomes a card, not a sentence the model may skip')
  assert.equal(question.source.data.unit, 'b1')

  // A complete submission needs one executed check: the record of a real run,
  // not the model's word for it.
  log.push({ type: 'tool/call', data: { callId: 'unit-test', name: 'bash', arguments: { command: 'npm test' } } })
  log.push({ type: 'tool/result', data: { message: { toolCallId: 'unit-test', isError: false, content: [{ type: 'text', text: JSON.stringify({ exitCode: 0 }) }] } } })
  const won = await call('work_submit', {
    unit: 'b1', outcome: 'complete', summary: '一屏能演示的渲染管线跑起来了', next: '无',
    claims: [{ statement: '能渲染', command: 'npm test', execution: { callId: 'unit-test' } }],
  })
  assert.equal(won.result.outcome, 'complete')
  // A unit with something to look at parks the task instead of closing it: the
  // person has not said it works yet, so "任务完成" would be the model grading
  // its own homework. The next step asks them to look (form `review`).
  assert.equal(won.result.state, 'review_ready')
  assert.equal(form(won.contexts, 'task-done'), undefined, 'a task waiting for the person is not done')
})

test('a long flat plan is warned about, not refused', async () => {
  const stub = stubContext()
  await testApply(stub)
  const exec = { agent: { id: 'agent-flat', session: { id: 'session-flat', seq: 1, eventAt: () => undefined } }, callId: 'c-flat' }
  const tool = name => stub.tools.find(candidate => candidate.name === name)
  await tool('work_start').execute({ request: '一条大任务', mode: 'build', scope: ['.'], acceptance: [] }, exec)
  const units = Array.from({ length: 8 }, (_, index) => ({ id: `u${index}`, goal: `第 ${index} 步`, scope: ['.'], acceptance: [] }))
  const written = await tool('work_plan').execute({ operation: 'set', units }, exec)
  assert.equal(written.units.length, 9, 'the plan is accepted as written, plus the bucket it lands in')
  assert.equal(written.units[0].id, 'daily', 'every task carries the 日需 bucket')
  assert.equal(written.units[0].role, 'daily')
  assert.equal(written.units.find(unit => unit.id === 'u0').parent, 'daily')
  assert.match(written.warning, /日需/, 'a crowded bucket is named, not refused')
  const grouped = await tool('work_plan').execute({
    operation: 'set',
    units: [{ id: 't1', goal: '一条价值线' }, ...units.map(unit => ({ ...unit, parent: 't1' }))],
  }, exec)
  assert.equal(grouped.warning, undefined, 'one campaign theme is enough to stop the warning')
  assert.equal(grouped.units.find(unit => unit.id === 't1').parent, undefined, 'a theme with children stays a root')
  assert.equal(grouped.units.find(unit => unit.id === 'daily'), undefined, 'a plan with nothing loose needs no bucket')
})

test('a theme can be added to a plan that already grew flat, without retyping it', async () => {
  const stub = stubContext()
  await testApply(stub)
  const post = stub.handlers.get('tools/post-execute')
  const log = []
  const agent = { id: 'agent-group', session: { id: 'session-group', get seq() { return log.length }, eventAt: index => log[index] } }
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.unit ?? args.operation ?? args.outcome ?? ''}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }
  const form = (contexts, wanted) => contexts.find(message => message.source?.form === wanted)

  await call('work_start', { request: '一条大任务', mode: 'build', scope: ['.'], acceptance: [] })
  const units = Array.from({ length: 6 }, (_, index) => ({ id: `u${index}`, goal: `第 ${index} 步`, scope: ['.'], acceptance: [] }))
  await call('work_plan', { operation: 'set', units })
  await call('work_plan', { operation: 'activate', unit: 'u0' })
  await call('work_plan', { operation: 'note', unit: 'u0', text: '第一步跑通了' })

  const grouped = await call('work_plan', {
    operation: 'group',
    unit: 't1',
    text: '先打通主路径',
    members: ['u0', 'u1', 'u2'],
  })
  assert.equal(grouped.result.milestones.length, 2, 'the campaign theme joins the bucket')
  const byId = new Map(grouped.result.units.map(row => [row.id, row]))
  assert.equal(byId.get('u0').parent, 't1')
  assert.equal(byId.get('u2').parent, 't1')
  assert.equal(byId.get('u3').parent, 'daily', 'units left out stay in the bucket')
  assert.equal(byId.get('u0').state, 'active', 'the state the unit already had is kept')
  assert.equal(byId.get('u0').note, '第一步跑通了', 'the notes are not retyped or lost')
  const opened = form(grouped.contexts, 'theme-open')
  assert.ok(opened, 'the cleanup is announced as a new theme')
  assert.equal(opened.source.data.unit, 't1')
  assert.equal(opened.source.data.label, '先打通主路径')

  // A taken theme id gets a fresh one; members that do not exist change nothing and the answer lists what does.
  assert.equal((await call('work_plan', { operation: 'group', unit: 't1', text: '重复', members: ['u3'] })).result.unit, 't1-2')
  assert.match((await call('work_plan', { operation: 'group', unit: 't2', text: '拿不到', members: ['nope'] })).result.answer, /现有单元/)
})

test('organize proposes, and applies only after the person answered', async () => {
  const stub = stubContext()
  await testApply(stub)
  const post = stub.handlers.get('tools/post-execute')
  const pre = stub.handlers.get('agent/pre-step')
  const log = []
  const agent = { id: 'agent-organize', session: { id: 'session-organize', get seq() { return log.length }, eventAt: index => log[index] } }
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.operation ?? args.outcome ?? ''}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }
  const form = (contexts, wanted) => contexts.find(message => message.source?.form === wanted)

  await call('work_start', { request: '一条大任务', mode: 'build', scope: ['.'], acceptance: [] })
  const units = Array.from({ length: 6 }, (_, index) => ({ id: `u${index}`, goal: `第 ${index} 步`, scope: ['.'], acceptance: [] }))
  await call('work_plan', { operation: 'set', units })

  const proposed = await call('work_plan', { operation: 'organize' })
  assert.ok(proposed.result.proposalId, 'a review is recorded with an id')
  assert.deepEqual(proposed.result.daily, ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'])
  assert.match(proposed.result.instruction, /ask_user_question/)

  // Nobody has spoken since the review: applying now would be the model agreeing
  // with itself.
  const early = await call('work_plan', {
    operation: 'organize', action: 'apply', proposalId: proposed.result.proposalId, approval: '好',
    steps: [{ kind: 'group', theme: 't1', label: '一条线', members: ['u0', 'u1'] }],
  })
  assert.equal(early.result.unchanged, true)
  assert.match(early.result.answer, /还没回话/)

  const answer = `同意 ${proposed.result.proposalId}：前两件收成一条线`
  human(log, answer)
  await pre({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: answer }] }], step: 1 }, async () => ({ kind: 'continue', messages: [] }))

  const applied = await call('work_plan', {
    operation: 'organize', action: 'apply', proposalId: proposed.result.proposalId, approval: answer,
    steps: [{ kind: 'group', theme: 't1', label: '一条线', members: ['u0', 'u1'] }],
  })
  assert.equal(applied.result.applied.steps, 1)
  const byId = new Map(applied.result.units.map(row => [row.id, row]))
  assert.equal(byId.get('u0').parent, 't1')
  assert.equal(byId.get('u2').parent, 'daily')
  const badge = form(applied.contexts, 'organize-done')
  assert.ok(badge, 'what changed is said once, in the stream')
  assert.equal(badge.source.data.title, '已整理')

  // The same proposal cannot be replayed after it was used: the plan stays as it is.
  const replayed = await call('work_plan', { operation: 'organize', action: 'apply', proposalId: proposed.result.proposalId, approval: answer, steps: [] })
  assert.equal(replayed.result.unchanged, true)
  assert.match(replayed.result.answer, /已经做过/)
})

test('an answer given in the UI counts as the person speaking', async () => {
  const stub = stubContext()
  await testApply(stub)
  const post = stub.handlers.get('tools/post-execute')
  const log = []
  const agent = { id: 'agent-ui', session: { id: 'session-ui', get seq() { return log.length }, eventAt: index => log[index] } }
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.operation ?? ''}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }

  await call('work_start', { request: '两条线', mode: 'build', scope: ['.'], acceptance: [] })
  await call('work_plan', { operation: 'set', units: [
    { id: 'a1', goal: '甲', scope: ['.'], acceptance: [] },
    { id: 'a2', goal: '乙', scope: ['.'], acceptance: [] },
  ] })
  const proposed = await call('work_plan', { operation: 'organize' })

  // Asking the question writes events (call + result), then the answer lands.
  log.push({ type: 'tool/call', data: { callId: 'call-ask', name: 'ask_user_question', arguments: { questions: [{ question: `应用 ${proposed.result.proposalId}？` }] } } })
  log.push({ type: 'tool/result', data: { message: { toolCallId: 'call-ask', isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: ['可以'] }) }] } } })

  // The answer arrives as the question tool's result, not as a user message: the
  // approval must still be honoured, or organize could never be applied from the UI.
  await post({ agent, name: 'ask_user_question', callId: 'call-ask', arguments: {} }, { isError: false }, async () => ({}))

  const applied = await call('work_plan', {
    operation: 'organize', action: 'apply', proposalId: proposed.result.proposalId, approval: '可以',
    steps: [{ kind: 'group', theme: 't1', label: '一条线', members: ['a1'] }],
  })
  assert.equal(applied.result.applied.steps, 1)
})

test('an approval given in another window still counts', async () => {
  const stub = stubContext()
  await testApply(stub)
  const post = stub.handlers.get('tools/post-execute')
  const log = []
  const agent = { id: 'agent-other', session: { id: 'session-other', get seq() { return log.length }, eventAt: index => log[index] } }
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.operation ?? ''}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }

  await call('work_start', { request: '两条线', mode: 'build', scope: ['.'], acceptance: [] })
  await call('work_plan', { operation: 'set', units: [
    { id: 'b1', goal: '甲', scope: ['.'], acceptance: [] },
    { id: 'b2', goal: '乙', scope: ['.'], acceptance: [] },
  ] })
  const proposed = await call('work_plan', { operation: 'organize' })
  // The answer arrived in another window, so this session never saw a message.
  const plan = Object.values(stub.tables.plans)[0]
  plan.proposal.spokeAt = new Date(Date.now() + 1000).toISOString()

  human(log, `同意 ${proposed.result.proposalId}`)
  const applied = await call('work_plan', {
    operation: 'organize', action: 'apply', proposalId: proposed.result.proposalId, approval: `同意 ${proposed.result.proposalId}`,
    steps: [{ kind: 'group', theme: 't2', label: '一条线', members: ['b1'] }],
  })
  assert.equal(applied.result.applied.steps, 1)
})

test('a theme is announced when it opens and when its last child lands', async () => {
  const stub = stubContext()
  await testApply(stub)
  const post = stub.handlers.get('tools/post-execute')
  const log = []
  const agent = { id: 'agent-theme', session: { id: 'session-theme', get seq() { return log.length }, eventAt: index => log[index] } }
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.unit ?? args.operation ?? args.outcome ?? ''}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }
  const form = (contexts, wanted) => contexts.find(message => message.source?.form === wanted)
  const ran = id => {
    log.push({ type: 'tool/call', data: { callId: id, name: 'bash', arguments: { command: 'npm test' } } })
    log.push({ type: 'tool/result', data: { message: { toolCallId: id, isError: false, content: [{ type: 'text', text: JSON.stringify({ exitCode: 0 }) }] } } })
  }

  await call('work_start', { request: '把渲染管线做完', mode: 'do', scope: ['.'], acceptance: ['能渲染'] })
  // A theme is a unit with children: the plan shape itself, no special operation.
  const plan = await call('work_plan', {
    operation: 'set',
    units: [{
      id: 't1', goal: '渲染管线换血',
      units: [
        { id: 'b1', goal: '描述符解析', scope: ['.'], acceptance: ['能解析'] },
        { id: 'b2', goal: '管线接入', scope: ['.'], acceptance: ['能渲染'] },
      ],
    }],
  })
  const opened = form(plan.contexts, 'theme-open')
  assert.ok(opened, 'opening a theme tells the conversation')
  assert.equal(opened.source.data.unit, 't1')
  assert.match(opened.content[0].text, /新主题/)
  assert.equal(opened.source.data.label, '渲染管线换血')

  await call('work_plan', { operation: 'activate', unit: 'b1' })
  ran('theme-b1')
  const first = await call('work_submit', { unit: 'b1', outcome: 'complete', summary: '解析通了', next: 'b2', claims: [{ statement: '能解析', command: 'npm test', execution: { callId: 'theme-b1' } }] })
  assert.equal(form(first.contexts, 'theme-open') ?? form(first.contexts, 'theme-seal'), undefined, 'a theme is not over while a child is pending')

  await call('work_plan', { operation: 'activate', unit: 'b2' })
  ran('theme-b2')
  const last = await call('work_submit', { unit: 'b2', outcome: 'complete', summary: '渲染通了', next: '无', claims: [{ statement: '能渲染', command: 'npm test', execution: { callId: 'theme-b2' } }] })
  const sealed = form(last.contexts, 'theme-seal')
  assert.ok(sealed, 'the last child landing closes the theme')
  assert.equal(sealed.source.data.unit, 't1')
  assert.equal(sealed.source.data.tag, '已收')
})

test('a task records who decides it is done, and the default is the person', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const start = async (args, sessionId = 'sess-1') => {
    const exec = { agent: { id: 'agent-1', session: { id: sessionId, seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
    return stub.tools.find(tool => tool.name === 'work_start').execute(args, exec)
  }

  const judged = await start({ request: 'ship the export', mode: 'do', scope: ['.'] }, 'sess-pm')
  assert.equal(judged.acceptanceMode, 'pm')
  assert.equal(judged.needsReceipt, undefined)
  assert.equal(stub.tables.tasks[judged.taskId].acceptanceMode, 'pm')

  const checked = await start({ request: 'tidy the readme', mode: 'do', scope: ['.'], acceptanceMode: 'auto' }, 'sess-auto')
  assert.equal(checked.acceptanceMode, 'auto')
  assert.equal(checked.needsReceipt, undefined)
  assert.equal(stub.tables.tasks[checked.taskId].acceptanceMode, 'auto')

  // A look task writes nothing, so there is no result for a person to accept.
  const looked = await start({ request: 'where is the parser', mode: 'look', scope: ['.'] }, 'sess-look')
  assert.equal(looked.acceptanceMode, 'auto')
  assert.equal(looked.needsReceipt, undefined)

  assert.ok(['auto', 'pm'].includes((await start({ request: 'x', mode: 'do', scope: ['.'], acceptanceMode: 'nobody' }, 'sess-bad')).acceptanceMode))
})

test('a receipt is what the user agreed to; a missing one is a warning, not a refusal', async () => {
  const stub = stubContext()
  await (testApply(stub))
  const exec = { agent: { id: 'agent-1', session: { id: 'sess-1', seq: 0, eventAt: () => undefined } }, callId: 'call-x', signal: undefined }
  const call = (name, args) => stub.tools.find(tool => tool.name === name).execute(args, exec)

  const started = await call('work_start', { request: 'ship the export', mode: 'do', scope: ['.'] })
  assert.equal(started.needsReceipt, undefined)
  await call('work_plan', { taskId: started.taskId, operation: 'set', units: [
    { id: 'b1', goal: '导出', scope: ['.'], acceptance: [] },
    { id: 'b2', goal: '收尾', scope: ['.'], acceptance: [] },
  ] })

  // No receipt yet: the delivery still succeeds, and the model is told to write one.
  const first = await call('work_submit', { taskId: started.taskId, unit: 'b1', outcome: 'complete', summary: '导出可用', next: '收尾' })
  assert.equal(first.state, 'active', 'a missing receipt never blocks a submission')
  assert.equal(first.warnings.some(warning => warning.includes('回执')), false)

  const wrote = await call('work_control', { taskId: started.taskId, operation: 'receipt', text: '目标：导出 Excel\n验收：三种格式都能打开\n不做：筛选联动\n默认：只支持当前筛选' })
  assert.equal(wrote.receipt.text.includes('验收'), true)
  assert.equal(typeof wrote.receipt.at, 'string')
  assert.equal(wrote.receipt.firstAt, wrote.receipt.at, 'the first receipt records when the agreement started')

  // Rewriting keeps the first moment and replaces the words.
  const again = await call('work_control', { taskId: started.taskId, operation: 'receipt', text: '目标：导出 Excel\n验收：三种格式都能打开\n不做：筛选联动\n默认：只支持当前筛选（含表头）' })
  assert.equal(again.receipt.firstAt, wrote.receipt.firstAt)
  assert.equal(again.receipt.text.includes('表头'), true)

  const second = await call('work_submit', { taskId: started.taskId, unit: 'b2', outcome: 'complete', summary: '做完了', next: '你用过再说' })
  assert.equal(second.warnings.some(warning => warning.includes('回执')), false, 'with a receipt there is nothing left to ask')

  // A blank receipt keeps the one on file.
  await call('work_control', { taskId: started.taskId, operation: 'receipt', text: '  ' })
  assert.match((await call('work_status', { taskId: started.taskId, view: 'board' })).task.receipt?.text ?? again.receipt.text, /表头/)
  assert.equal((await call('work_control', { taskId: started.taskId, operation: 'receipt', text: 'x'.repeat(420) })).receipt.text.length, 420)
})

test('业务事实落在项目里：带来源、同词改写不新增行', async () => {
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'v3-domain-'))
  try {
    const stub = stubContext(root)
    await testApply(stub, { checkpoints: false })
    const tool = name => stub.tools.find(entry => entry.name === name)
    const exec = { agent: { id: 'agent-1', session: { id: 'session-1' } }, callId: 'call-1', signal: undefined }
    const started = await tool('work_start').execute({ request: '把导出的列按页面对齐', mode: 'do', scope: ['.'] }, exec)
    // No file yet: the tool reports that, it does not create an empty one.
    assert.equal(started.domainFile, null)

    const first = await tool('work_control').execute({
      operation: 'remember', target: 'domain',
      payload: { kind: 'term', key: '对账', text: '按单号把两边流水配对', quote: '对账就是按单号配起来' },
    }, exec)
    assert.equal(first.kind, 'term')
    assert.equal(first.replaced, false)
    const file = join(root, '.auto-dev/project-domain.md')
    assert.equal(existsSync(file), true)
    const body = readFileSync(file, 'utf8')
    assert.match(body, /- \*\*对账\*\* — 按单号把两边流水配对/)
    assert.match(body, /来源：session-1/)
    assert.match(body, /原话：「对账就是按单号配起来」/)

    // The same word with a sharper sentence updates the line instead of adding one.
    const again = await tool('work_control').execute({
      operation: 'remember', target: 'domain',
      payload: { kind: 'term', key: '对账', text: '按单号配对两张表的流水' },
    }, exec)
    assert.equal(again.replaced, true)
    const sharper = readFileSync(file, 'utf8')
    assert.equal((sharper.match(/- \*\*对账\*\*/g) ?? []).length, 1)
    assert.match(sharper, /按单号配对两张表的流水/)

    // A decision has no key; it lands under its own heading.
    await tool('work_control').execute({
      operation: 'remember', target: 'domain',
      payload: { kind: 'decision', text: '导出用 CSV，不做 xlsx' },
    }, exec)
    const withDecision = readFileSync(file, 'utf8')
    assert.match(withDecision, /## 耐久决策\n- 导出用 CSV，不做 xlsx/)
    assert.equal((withDecision.match(/^# 项目业务事实$/gm) ?? []).length, 1)

    // Now that the file exists, the next task is handed its path at start.
    const next = await tool('work_start').execute({ request: '继续补导出', mode: 'do', scope: ['.'] }, exec)
    assert.equal(next.domainFile, file)
    // A term without a key takes its first words as the key.
    const term = await tool('work_control').execute({ operation: 'remember', target: 'domain', payload: { kind: 'term', text: '快照：导出时的筛选结果' } }, exec)
    assert.equal(term.stored, true)
    assert.match(readFileSync(file, 'utf8'), /快照/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('目标改一次多一版，旧的一句不丢', async () => {
  const stub = stubContext('/tmp/v3-goal')
  await testApply(stub, { checkpoints: false })
  const tool = name => stub.tools.find(entry => entry.name === name)
  const exec = { agent: { id: 'agent-1', session: { id: 'session-1' } }, callId: 'call-1', signal: undefined }
  await tool('work_start').execute({ request: '把导出做完', mode: 'do', scope: ['.'] }, exec)

  const first = await tool('work_control').execute({ operation: 'goal', text: '导出三种格式都能打开', why: '用户说还要 xlsx' }, exec)
  assert.equal(first.goalRevision, 1)
  const second = await tool('work_control').execute({ operation: 'goal', text: '导出三种格式，列顺序跟页面一致', why: '列顺序要和页面一致' }, exec)
  assert.equal(second.goalRevision, 2)
  assert.equal(second.history[0].text, '导出三种格式都能打开')
  assert.equal(second.goalRevision, 2)

  // Saying the same sentence again changes nothing — a rephrase is still a new version, an echo is not.
  const echo = await tool('work_control').execute({ operation: 'goal', text: '导出三种格式，列顺序跟页面一致' }, exec)
  assert.equal(echo.unchanged, true)
  assert.equal(echo.goalRevision, 2)

  const blank = await tool('work_control').execute({ operation: 'goal' }, exec)
  assert.equal(blank.goalRevision ?? 2, 2)
  const board = await tool('work_status').execute({ view: 'board' }, exec)
  assert.equal(board.task.goalRevision, 2)
  assert.deepEqual(board.task.goalHistory, ['导出三种格式都能打开'])
})

test('有可看的东西就先停下等人：说「可以」收案，说哪里不对就退回改', async () => {
  const stub = stubContext('/tmp/v3-review')
  await testApply(stub, { checkpoints: false })
  const tool = name => stub.tools.find(entry => entry.name === name)
  const log = []
  const agent = {
    id: 'agent-1',
    session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] },
    ctx: { tools: { schemas: () => [] } },
  }
  const exec = { agent, callId: 'c1', turn: 1, signal: undefined }
  const run = async (name, args) => {
    const callId = `c-${name}-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
    const value = await tool(name).execute(args, { ...exec, callId })
    log.push({ type: 'tool/result', data: { callId, message: { toolCallId: callId, isError: false, content: [] } } })
    return value
  }
  const started = await run('work_start', {
    request: '把导出按钮接到真接口', mode: 'do', scope: ['/tmp/v3-review'],
    plan: [{ id: 'a', goal: '导出按钮能点', scope: ['src'], acceptance: [], deliverable: '点一下能导出三行' }],
  })
  await run('work_plan', { operation: 'activate', unit: 'a' })
  log.push({ type: 'tool/call', data: { callId: 'sh-1', name: 'bash', arguments: { command: 'node --version' } } })
  log.push({ type: 'tool/result', data: { callId: 'sh-1', message: { toolCallId: 'sh-1', isError: false, content: [{ type: 'text', text: 'v25' }] } } })
  const submitted = await run('work_submit', {
    unit: 'a', outcome: 'complete', summary: '按钮接上了', next: '等你用过',
    claims: [{ statement: 'node --version', execution: { callId: 'sh-1' } }],
  })
  assert.equal(submitted.state, 'review_ready', 'a unit that promised something parks for the person')
  const pre = stub.handlers.get('agent/pre-step')
  const next = async () => ({ kind: 'continue', messages: [] })
  // The hand-in itself asks (queued with the delivery card), so a turn that ends here still shows it.
  assert.equal(stub.records.get(`tasks/${started.taskId}`).review.asked, true, 'the hand-in asks once')
  const asked = await pre({ agent, messages: [], step: 2 }, next)
  assert.ok(!asked.messages.some(message => message.source?.form === 'review'), 'and the next step does not ask again')

  // 人的话只是决定；改状态是模型那一步的事（work_control），宿主不再替它猜。
  human(log, '列少了，缺更新时间')
  const revise = await pre({ agent, messages: [{ role: 'user', content: [{ type: 'text', text: '列少了，缺更新时间' }], source: { kind: 'user' } }], step: 3 }, next)
  assert.match(revise.messages.at(-1).content[0].text, /退回（rework）按他说的改/)
  assert.equal(stub.records.get(`tasks/${started.taskId}`).state, 'review_ready')
  await run('work_control', { operation: 'rework', text: '列少了，缺更新时间' })
  assert.equal(stub.records.get(`tasks/${started.taskId}`).state, 'active')
  assert.match(stub.records.get(`tasks/${started.taskId}`).rework.note, /缺更新时间/)

  // Hand it in again; this time the person says yes.
  log.push({ type: 'tool/call', data: { callId: 'sh-2', name: 'bash', arguments: { command: 'node --version' } } })
  log.push({ type: 'tool/result', data: { callId: 'sh-2', message: { toolCallId: 'sh-2', isError: false, content: [{ type: 'text', text: 'v25' }] } } })
  await run('work_submit', { unit: 'a', outcome: 'complete', summary: '补上更新时间', next: '收', claims: [{ statement: 'node --version', execution: { callId: 'sh-2' } }] })
  human(log, '可以，就这样')
  const accepted = await pre({ agent, messages: [{ role: 'user', content: [{ type: 'text', text: '可以，就这样' }], source: { kind: 'user' } }], step: 4 }, next)
  assert.match(accepted.messages.at(-1).content[0].text, /这算同意，收案/)
  await run('work_control', { operation: 'accept', text: '可以，就这样' })
  assert.equal(stub.records.get(`tasks/${started.taskId}`).state, 'closed')
  // 收案那一刻的回执由工具排队，下一次工具调用结束时交给宿主——这里把它抽出来看。
  const post = stub.handlers.get('tools/post-execute')
  const flushed = await post({ agent, name: 'bash', callId: 'c-flush' }, { kind: 'continue', messages: [], additionalContexts: [] }, async () => ({ kind: 'continue', messages: [], additionalContexts: [] }))
  assert.equal(flushed.additionalContexts.at(-1).source.form, 'review-done', '收案那一刻有一行给到人')
})

test('auto 验收的后端任务按已执行证据直接收', async () => {
  const stub = stubContext('/tmp/v3-auto-close')
  await testApply(stub, { checkpoints: false })
  const tool = name => stub.tools.find(entry => entry.name === name)
  const log = []
  const agent = { id: 'agent-1', session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] } }
  const exec = { agent, callId: 'c1', turn: 1 }
  const run = async (name, args) => {
    const callId = `c-${name}-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
    return tool(name).execute(args, { ...exec, callId })
  }
  await run('work_start', {
    request: '把 retry 退避调稳', mode: 'do', acceptanceMode: 'auto', scope: ['/tmp/v3-auto-close'],
    plan: [{ id: 'a', goal: '退避重试有上限', scope: ['src'], acceptance: [] }],
  })
  await run('work_plan', { operation: 'activate', unit: 'a' })
  log.push({ type: 'tool/call', data: { callId: 'sh-1', name: 'bash', arguments: { command: 'npm test' } } })
  log.push({ type: 'tool/result', data: { callId: 'sh-1', message: { toolCallId: 'sh-1', isError: false, content: [{ type: 'text', text: 'ok' }] } } })
  const done = await run('work_submit', {
    unit: 'a', outcome: 'complete', summary: '上限 3 次', next: '没了',
    claims: [{ statement: 'npm test', execution: { callId: 'sh-1' } }],
  })
  assert.equal(done.state, 'closed', 'nothing to look at, nothing to wait for')
})

test('连续 partial 不会误判为失败或要求停下', async () => {
  const stub = stubContext('/tmp/v3-halt')
  await testApply(stub, { checkpoints: false })
  const tool = name => stub.tools.find(entry => entry.name === name)
  const log = []
  const agent = { id: 'agent-1', session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] } }
  const exec = { agent, callId: 'c1', turn: 1 }
  const run = async (name, args) => {
    const callId = `c-${name}-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
    return tool(name).execute(args, { ...exec, callId })
  }
  await run('work_start', { request: '修掉偶发 500', mode: 'do', scope: ['/tmp/v3-halt'], plan: [{ id: 'a', goal: '不再 500', scope: ['src'], acceptance: [] }] })
  await run('work_plan', { operation: 'activate', unit: 'a' })
  for (let index = 0; index < 3; index += 1) {
    await run('work_submit', { unit: 'a', outcome: 'partial', summary: `第 ${index + 1} 次还没修好`, next: '再看日志' })
  }
  const pre = stub.handlers.get('agent/pre-step')
  const next = async () => ({ kind: 'continue', messages: [] })
  const halted = await pre({ agent, messages: [], step: 2 }, next)
  assert.equal(halted.messages.some(row => row.source?.form === 'halt'), false)
  const again = await pre({ agent, messages: [], step: 3 }, next)
  assert.equal(again.messages.some(row => row.source?.form === 'halt'), false)
})

test('人用一句话答应也收案，且未知 operation 不会写坏记录', async () => {
  const stub = stubContext('/tmp/v3-review-natural')
  await testApply(stub, { checkpoints: false })
  const tool = name => stub.tools.find(entry => entry.name === name)
  const log = []
  const agent = {
    id: 'agent-1',
    session: { id: 'session-1', header: {}, get seq() { return log.length }, eventAt: index => log[index] },
    ctx: { tools: { schemas: () => [] } },
  }
  const run = async (name, args) => {
    const callId = `c-${name}-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name, arguments: args } })
    const value = await tool(name).execute(args, { agent, callId, turn: 1 })
    log.push({ type: 'tool/result', data: { callId, message: { toolCallId: callId, isError: false, content: [] } } })
    return value
  }
  const started = await run('work_start', {
    request: '把导出按钮接到真接口', mode: 'do', scope: ['/tmp/v3-review-natural'],
    plan: [{ id: 'a', goal: '导出按钮能点', scope: ['src'], acceptance: [], deliverable: '点一下能导出三行' }],
  })
  await run('work_plan', { operation: 'activate', unit: 'a' })
  log.push({ type: 'tool/call', data: { callId: 'sh-1', name: 'bash', arguments: { command: 'node --version' } } })
  log.push({ type: 'tool/result', data: { callId: 'sh-1', message: { toolCallId: 'sh-1', isError: false, content: [{ type: 'text', text: 'v25' }] } } })
  await run('work_submit', { unit: 'a', outcome: 'complete', summary: '接上了', next: '等你用过', claims: [{ statement: 'node --version', execution: { callId: 'sh-1' } }] })
  // A whole sentence, not one word: this used to fall through every matcher.
  const pre = stub.handlers.get('agent/pre-step')
  human(log, '我点开看过了，可以')
  const answered = await pre({
    agent,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我点开看过了，可以' }] }],
    step: 3,
  }, async () => ({ kind: 'continue', messages: [] }))
  assert.match(answered.messages.at(-1).content[0].text, /这算同意，收案/)
  assert.equal(stub.records.get(`tasks/${started.taskId}`).state, 'review_ready', '一句话只是证据，状态由工具改')
  await run('work_control', { operation: 'accept', text: '我点开看过了，可以' })
  assert.equal(stub.records.get(`tasks/${started.taskId}`).state, 'closed')

  assert.match((await run('work_control', { operation: 'nonsense' })).tellUser, /不认识「nonsense」/)
  assert.equal(stub.records.get(`tasks/${started.taskId}`).state, 'closed', 'a stray call leaves the record alone')
})

test('writing the postmortem leaves one row in the conversation', async () => {
  const stub = stubContext(mkdtempSync(join(tmpdir(), 'v3-pm-')))
  await testApply(stub)
  const post = stub.handlers.get('tools/post-execute')
  const log = []
  const agent = { id: 'agent-pm', session: { id: 'session-pm', get seq() { return log.length }, eventAt: index => log[index] } }
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.operation}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }
  await call('work_start', { request: '把导出修好', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  const written = await call('work_control', {
    operation: 'postmortem',
    payload: { symptom: '导出空表', cause: '列名写错', change: '改列名', finding: '缺一条回归', prevention: '补回归' },
  })
  const row = written.contexts.find(message => message.source?.form === 'postmortem')
  assert.ok(row, 'the person should see that the postmortem landed')
  assert.equal(row.source.data.tag, '已写')
  assert.ok(written.result.path.endsWith('memory.json'))
})

test('remembering a fact leaves one row in the conversation', async () => {
  const stub = stubContext(mkdtempSync(join(tmpdir(), 'v3-mem-')))
  await testApply(stub)
  const post = stub.handlers.get('tools/post-execute')
  const log = []
  const agent = { id: 'agent-mem', session: { id: 'session-mem', get seq() { return log.length }, eventAt: index => log[index] } }
  const call = async (name, args) => {
    const tool = stub.tools.find(candidate => candidate.name === name)
    const exec = { agent, name, callId: `call-${name}-${args.operation}`, arguments: args }
    const result = await tool.execute(args, exec)
    const after = await post(exec, { isError: false }, async () => ({ additionalContexts: [] }))
    return { result, contexts: after.additionalContexts ?? [] }
  }
  await call('work_start', { request: '把导出修好', mode: 'do', scope: ['.'], acceptance: ['能导出'] })
  const stored = await call('work_control', {
    operation: 'remember', target: 'domain',
    payload: { kind: 'rule', key: '导出落盘', text: '导出文件放仓库内 outputs/，不进系统下载目录' },
  })
  const row = stored.contexts.find(message => message.source?.form === 'remember')
  assert.ok(row, 'the person should see that something was remembered')
  assert.equal(row.source.data.tag, '1 条')
})

test('a session already open when the plugin loads gets its tools on the first apply', async () => {
  // A reload (or an upgrade while a window is open) finds conversations that opted
  // in before these listeners existed. The rescan installs into them; it once ran
  // before the tool api was built and failed silently into the diag log.
  const sid = 'session-open-before-load'
  const stub = stubContext('/repo/example', {
    tasks: {}, plans: {}, decisions: {},
    sessions: { [sid]: { id: sid, version: 1, project: '/repo/example', at: '2026-10-29T00:00:00.000Z' } },
  })
  const own = []
  const agent = {
    id: `agent-${sid}`,
    session: { id: sid, seq: 0, header: { id: sid }, eventAt: () => undefined },
    ctx: { tools: { register: definition => { own.push(definition); return () => {} } } },
  }
  stub.ctx.get = service => (service === 'agents' ? { list: () => [agent] } : undefined)
  await apply(stub.ctx, {})
  assert.deepEqual(own.map(tool => tool.name).sort(),
    ['work_control', 'work_env', 'work_extend', 'work_plan', 'work_start', 'work_status', 'work_submit'])
  // Opted out stays opted out: a session with no row is not handed the tools.
  const stranger = { ...agent, id: 'agent-other', session: { ...agent.session, id: 'session-other', header: { id: 'session-other' } }, ctx: { tools: { register: definition => { own.push(definition); return () => {} } } } }
  const before = own.length
  const second = stubContext('/repo/example')
  second.ctx.get = service => (service === 'agents' ? { list: () => [stranger] } : undefined)
  await apply(second.ctx, {})
  assert.equal(own.length, before)
})

test('first-write card: the start words cut into sentences, verbatim, only when scattered and unanswered', async () => {
  const { firstWriteCard, requestSentences } = await import('../src/craft.mjs')
  const request = '/dsh-auto-dev notes 想加几个东西：list 能按关键词过滤；另外 rm 删不存在的 id 会说 removed，这个不对；顺便 add 空文本应该拒绝；还有 usage 也更新一下。验收：npm test 全过。'
  assert.deepEqual(requestSentences(request), ['notes 想加几个东西：list 能按关键词过滤', '另外 rm 删不存在的 id 会说 removed，这个不对', '顺便 add 空文本应该拒绝', '还有 usage 也更新一下'])
  assert.match(firstWriteCard(false, undefined, request)[0], /事实：开工原话断开是 4 句，开工后用户还没说过话——「notes 想加几个东西：list 能按关键词过滤」「另外 rm/)
  assert.doesNotMatch(firstWriteCard(true, undefined, request)[0], /开工原话/, '用户说过话就不再提')
  assert.doesNotMatch(firstWriteCard(false, undefined, '修一下 add 的重复 id，顺便补个测试')[0], /开工原话/, '一两句不说')
})

test('first-write card: 先复述 only while the person has not spoken since the start', async () => {
  const { firstWriteCard } = await import('../src/craft.mjs')
  assert.match(firstWriteCard(false)[0], /先停下，对用户复述/)
  assert.doesNotMatch(firstWriteCard(true)[0], /复述/)
  assert.match(firstWriteCard(true)[0], /一次只改一处/)
  assert.match(firstWriteCard(true, { command: 'npm test' })[0], /跑就写 `npm test`；要截短输出就写 `set -o pipefail; npm test 2>&1 \| tail -40`/)
})

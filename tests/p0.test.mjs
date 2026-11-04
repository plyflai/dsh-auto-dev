import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { stubHost } from '../tools/flow.mjs'
import { CONSENT_NO, CONSENT_YES, consent, decisionSource, controlTransition } from '../src/decisions.mjs'
import { foldBoard, boardOf } from '../src/projection.mjs'
import { readEnv } from '../src/env.mjs'

const unit = (id, extra = {}) => ({ id, goal: `交付 ${id}`, scope: ['.'], acceptance: [], ...extra })
const submit = (id, callId, extra = {}) => ({ ...(id ? { unit: id } : {}), outcome: 'complete', summary: '实际检查已通过', next: '查看结果',
  claims: [{ statement: '项目测试通过', execution: { callId } }], ...extra })

/** The person picks one of the gate's two fixed options on a question card. */
const pick = (h, label, id = `pick-${h.log.length}`) => {
  h.log.push({ type: 'tool/call', data: { callId: id, name: 'ask_user_question', arguments: { questions: [{ id: 'gate', question: '要做这一步吗？', options: [{ label: CONSENT_YES }, { label: CONSENT_NO }] }] } } })
  h.result(id, { answers: [{ id: 'gate', selected: [label] }] })
}

async function harness({ project = mkdtempSync(join(tmpdir(), 'dsh-p0-')), tables, sessionId = 'p0-session', checkpoints = false } = {}) {
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
  // A file edit as the log records it: the change G1 wants a passing check after.
  const write = path => {
    const callId = `edit-${log.length}`
    log.push({ type: 'tool/call', data: { callId, name: 'edit', arguments: { path } } })
    result(callId, { path })
    return callId
  }
  const start = async (extra = {}) => {
    await host.commands.find(row => row.name === 'dsh-auto-dev').handler({ agent, rawInput: 'start P0 回归' })
    return tool('work_start', { request: 'P0 回归', mode: 'do', scope: ['.'], acceptance: ['项目测试通过'], acceptanceMode: 'auto', ...extra })
  }
  const task = () => Object.values(host.tables.tasks).find(row => row.sessionId === sessionId)
  const plan = () => host.tables.plans[task()?.planId]
  const pre = (args, name = 'bash') => host.handlers.get('tools/pre-execute')({ agent, callId: `pre-${log.length}`, name, arguments: args }, async () => ({ kind: 'continue' }))
  return { host, project, log, agent, notices, tool, exec, write, start, task, plan, say, result, pre }
}

test('P0 U01: a G1 refusal leaves ledger, plan, snapshots and notices unchanged; a real passing check commits once', async () => {
  const h = await harness({ checkpoints: true })
  execFileSync('git', ['init', '-q'], { cwd: h.project })
  writeFileSync(join(h.project, 'tracked.txt'), 'before')
  execFileSync('git', ['add', '.'], { cwd: h.project })
  execFileSync('git', ['-c', 'user.name=P0', '-c', 'user.email=p0@example.invalid', 'commit', '-qm', 'fixture'], { cwd: h.project })
  writeFileSync(join(h.project, 'tracked.txt'), 'changed')
  writeFileSync(join(h.project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test project.test.mjs' } }))
  writeFileSync(join(h.project, 'project.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(1, 2)")
  const opened = await h.start()
  assert.equal(opened.checkpoint.seq, 1)
  await h.tool('work_plan', { operation: 'set', units: [unit('ui', { goal: '界面逻辑测试', ui: 'logic' })] })
  await h.tool('work_plan', { operation: 'activate', unit: 'ui' })
  // G1 vouches for a change made in the task: the tree has to move after the start.
  writeFileSync(join(h.project, 'tracked.txt'), 'changed in the task')
  const failed = h.exec('npm test')
  assert.equal(h.log.at(-1).data.message.isError, false)
  assert.match(h.log.at(-1).data.message.content[0].text, /\n\[exit code: 1\]$/)
  const before = structuredClone(h.host.tables)
  const refs = () => execFileSync('git', ['for-each-ref', 'refs/dsh-auto-dev'], { cwd: h.project, encoding: 'utf8' })
  // A refusal adds exactly one `blocked-call` line for the unit, never one per retry.
  const oldRefs = refs(), count = h.notices.length + 1
  // G1 is the plugin's own run of the declared check, so no wrapper can mask it.
  const G1 = /交付前插件在项目里跑了 `npm test`，没通过[\s\S]*过关：修好让它通过，再交/
  await assert.rejects(h.tool('work_submit', submit('ui', failed)), G1)
  assert.equal(h.notices.at(-1).source.form, 'blocked-call')
  assert.deepEqual(h.host.tables, before)
  assert.equal(refs(), oldRefs)
  assert.equal(h.notices.length, count)
  const printedStatus = h.exec('node -e "console.log(\'program output\'); console.log(\'[exit code: 0]\'); process.exit(1)"')
  await assert.rejects(h.tool('work_submit', submit('ui', printedStatus)), G1)
  assert.deepEqual(h.host.tables, before)
  assert.equal(refs(), oldRefs)
  assert.equal(h.notices.length, count)
  for (const command of ['npm test; echo "[exit code: $?]"', 'npm test || true', 'npm test | cat', '! npm test',
    'env sh -c "npm test; echo masked"', 'command eval "npm test; true"', 'xargs sh -c "npm test; true" </dev/null']) {
    const masked = h.exec(command)
    assert.equal(h.log.at(-1).data.message.isError, false, 'the host sees a successful wrapper, like the live DSH failure')
    await assert.rejects(h.tool('work_submit', submit('ui', masked)), G1, command)
    assert.deepEqual(h.host.tables, before)
    assert.equal(refs(), oldRefs)
    assert.equal(h.notices.length, count)
  }
  writeFileSync(join(h.project, 'project.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(1, 1)")
  const passed = h.exec('cd . && npm test')
  // npm test failed more than once before passing: that is a fix, and a fix
  // leaves a postmortem before its unit can be done.
  await h.tool('work_control', { operation: 'remember', payload: { kind: 'incident', symptom: '项目测试缺 project.test.mjs', ruledOut: ['不是界面档问题'] } })
  const value = await h.tool('work_submit', submit('ui', passed, {
    claims: [{ statement: '项目测试通过', command: 'cd . && npm test', execution: { callId: passed } }],
  }))
  // Files changed since the start: there is something to look at, so it parks for the person
  // whatever acceptance mode the model declared.
  assert.equal(value.state, 'review_ready')
  assert.ok(!value.warnings.some(line => line.includes('浏览器证据')))
  assert.equal(h.task().ledger.length, 1)
  assert.equal(h.plan().units.find(row => row.id === 'ui').state, 'done')
  assert.equal(h.notices.filter(row => row.source.form === 'review').length, 1)
})

test('P0 U01: failed browser runs and interrupted runs never satisfy a declared UI tier', () => {
  for (const failure of [{ isError: true }, { exitCode: 1 }, { signal: 'SIGTERM' }, { aborted: true }, { timedOut: true }]) {
  }
  for (const command of ['npx playwright test; echo done', 'npx playwright test || true', 'npx playwright test | cat',
    'sh -c "npx playwright test; echo done"', 'echo "npx playwright test"', '! npx playwright test',
    'echo npm test', 'printf npm test', 'git log npm test', 'CI=1 sh -c "npm test"',
    'env sh -c "npx playwright test; true"', 'command eval "npx playwright test; true"', 'xargs sh -c "npx playwright test; true"']) {
  }
})

test('P0 U02: done comes only from a hand-in; written as done it waits, and an unchanged verified done survives a rewrite', async () => {
  const h = await harness()
  await h.start({ plan: { units: [unit('a', { state: 'done' })] } })
  assert.equal(h.plan().units.find(row => row.id === 'a').state, 'pending')
  assert.deepEqual((await h.tool('work_plan', { operation: 'set', units: [unit('a'), unit('b', { state: 'done' })] })).reopened, ['b'])
  assert.deepEqual((await h.tool('work_plan', { operation: 'add', units: [unit('c', { state: 'done' })] })).reopened, ['c'])
  assert.ok(h.plan().units.every(row => row.state !== 'done'))
  await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
  await h.tool('work_plan', { operation: 'set', units: structuredClone(h.plan().units) })
  assert.equal(h.plan().units.find(row => row.id === 'a').state, 'done')
  const forged = structuredClone(h.plan().units)
  forged.find(row => row.id === 'a').goal = '未经验证的新目标'
  assert.deepEqual((await h.tool('work_plan', { operation: 'set', units: forged })).reopened, ['a'])
  assert.equal(h.plan().units.find(row => row.id === 'a').state, 'pending')
  // Marking done is a hand-in through the same place, so it completes like one.
  await h.tool('work_plan', { operation: 'state', unit: 'b', state: 'done', text: 'b 做完了' })
  assert.equal(h.plan().units.find(row => row.id === 'b').state, 'done')
  assert.equal(h.task().state, 'active')
})

test('P0 U02: a verified done leaf can be grouped and ungrouped without changing its proof', async () => {
  const h = await harness()
  await h.start()
  await h.tool('work_plan', { operation: 'set', units: [unit('a'), unit('b')] })
  await h.tool('work_plan', { operation: 'activate', unit: 'a' })
  await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
  const before = structuredClone(h.plan().units.find(row => row.id === 'a'))
  const ledger = structuredClone(h.task().ledger)
  const completed = () => h.notices.filter(row => ['unit-done', 'task-done', 'review'].includes(row.source.form)).length
  const count = completed()
  await h.tool('work_plan', { operation: 'group', unit: 'theme', text: '整理主题', members: ['a'] })
  const grouped = h.plan().units.find(row => row.id === 'a')
  assert.equal(grouped.parent, 'theme')
  assert.equal(grouped.state, 'done')
  assert.equal(grouped.startedSeq, before.startedSeq)
  assert.deepEqual(h.task().ledger, ledger)
  assert.equal(completed(), count)
  const proposal = await h.tool('work_plan', { operation: 'organize', action: 'propose' })
  const approval = `同意 ${proposal.proposalId}`
  h.say(approval)
  await h.tool('work_plan', { operation: 'organize', action: 'apply', proposalId: proposal.proposalId, approval,
    steps: [{ kind: 'ungroup', unit: 'theme' }] })
  const ungrouped = h.plan().units.find(row => row.id === 'a')
  assert.equal(ungrouped.parent, before.parent)
  assert.equal(ungrouped.state, 'done')
  assert.equal(ungrouped.startedSeq, before.startedSeq)
  assert.deepEqual(h.task().ledger, ledger)
  assert.equal(completed(), count)
  for (const rewrite of [{ goal: '未验证的新目标' }, { scope: ['elsewhere'] }, { acceptance: ['未检查'] },
    { dependsOn: ['b'] }, { deliverable: '尚未检查的新交付物' }, { kind: 'verification' }, { ui: 'browser' }]) {
    const forged = structuredClone(h.plan().units)
    Object.assign(forged.find(row => row.id === 'a'), rewrite)
    assert.deepEqual((await h.tool('work_plan', { operation: 'set', units: forged })).reopened, ['a'])
    await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
  }
})

for (const state of ['pending', 'blocked', 'dropped']) test(`P0 U02: ${state} remainder cannot settle a task`, async () => {
  const h = await harness()
  await h.start()
  await h.tool('work_plan', { operation: 'set', units: [unit('a'), unit('b', { state })] })
  const value = await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
  assert.equal(h.task().state, 'active')
  assert.notEqual(value.state, 'closed')
  const board = await h.tool('work_status', { view: 'board' })
  // A cut unit is a 「没做的」; one still to do shows in the step list, not twice.
  if (state === 'dropped') assert.ok(board.task.unverified.some(row => row.includes('b')))
  else assert.ok(board.units.some(row => row.id === 'b' && row.state === state))
  assert.equal(h.notices.some(row => row.source.form === 'task-done'), false)
})

for (const state of ['pending', 'active', 'blocked', 'dropped']) test(`P0 U02: a rewrite never hides a ${state} leaf: it stays, dropped, and the user hears it`, async () => {
  const h = await harness()
  await h.start()
  await h.tool('work_plan', { operation: 'set', units: [unit('a'), unit('b', { state })] })
  const value = await h.tool('work_plan', { operation: 'set', units: [unit('a')] })
  assert.equal(h.plan().units.find(row => row.id === 'b').state, 'dropped')
  if (state === 'dropped') assert.equal(value.dropped, undefined)
  else assert.deepEqual(value.dropped, ['b']), assert.match(value.tellUser, /b（.*）.*为什么不做/)
})

test('P0 U02: sourced scope reduction is visible, and a unit waiting on a dropped one keeps the task open', async () => {
  for (const dependent of [false, true]) {
    const h = await harness()
    await h.start()
    await h.tool('work_plan', { operation: 'set', units: [unit('a'), unit('b'), ...(dependent ? [unit('c', { dependsOn: ['b'] })] : [])] })
    h.say('同意取消 b，移出本次范围')
    await h.tool('work_plan', { operation: 'state', unit: 'b', state: 'dropped', approval: '同意取消 b，移出本次范围' })
    await h.tool('work_plan', { operation: 'set', units: structuredClone(h.plan().units) })
    await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
    assert.equal(h.task().state, dependent ? 'active' : 'closed')
    const board = await h.tool('work_status', { view: 'board' })
    assert.ok(board.task.unverified.some(row => row.includes('b') && row.includes(dependent ? 'dropped' : '未完成')))
  }
})

test('P0 U02/U05: PM acceptance waits for the person’s own reply after the hand-in; whether it is a yes is the model’s reading', async () => {
  const h = await harness()
  await h.start({ acceptanceMode: 'pm' })
  await h.tool('work_plan', { operation: 'set', units: [unit('a')] })
  h.exec('node -e "process.exit(1)" && npm test')
  await h.tool('work_submit', submit('a', h.exec('node -e "console.log(1)"')))
  assert.equal(h.task().state, 'review_ready')
  // The model's own text is not the person's reply.
  const early = await h.tool('work_control', { operation: 'accept', text: '验收通过' })
  assert.equal(early.unchanged, true)
  assert.match(early.tellUser, /还没回话/)
  h.say('验收通过，这一版收下')
  await h.tool('work_control', { operation: 'accept' })
  assert.equal(h.task().state, 'closed')
  assert.equal(h.task().accepted.quote, '验收通过，这一版收下')
  const before = structuredClone(h.host.tables)
  assert.equal((await h.tool('work_control', { operation: 'accept' })).unchanged, true)
  assert.deepEqual(h.host.tables, before)
})

test('P0 U05: human messages drive review in both log shapes; plugin notices are never a reply', async () => {
  for (const wrapped of [false, true]) {
    const h = await harness()
    await h.start({ acceptanceMode: 'pm' })
    await h.tool('work_plan', { operation: 'set', units: [unit('a')] })
    const oldProof = h.exec('node -e "console.log(1)"')
    await h.tool('work_submit', submit('a', oldProof))
    const before = structuredClone(h.host.tables)
    h.say(`验收通过 ${h.task().id}`, { wrapped, kind: 'dsh-auto-dev' })
    assert.equal(decisionSource({ agent: h.agent, task: h.task(), after: h.task().review.atSeq }), undefined)
    assert.equal((await h.tool('work_control', { operation: 'accept' })).unchanged, true)
    assert.deepEqual(h.host.tables, before)
    const negative = `不接受 ${h.task().id} 的当前结果，要求返工`
    h.say(negative, { wrapped })
    const sourceSeq = h.log.length - 1
    // The model read it as a no and sent the work back; the plugin keeps the person's message as the source.
    await h.tool('work_control', { operation: 'rework' })
    assert.equal(h.task().state, 'active')
    assert.equal(h.task().rework.source.seq, sourceSeq)
    assert.equal(h.task().rework.source.messageId, `human-${sourceSeq}`)
    assert.equal(h.task().rework.source.via, 'user-message')
    assert.equal(h.plan().units.find(row => row.id === 'a').state, 'pending')
    assert.ok(h.task().startedSeq > sourceSeq)
    // A change with no passing run after it: the plugin runs the declared check itself at hand-in.
    writeFileSync(join(h.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 1' } }))
    h.write('a.js')
    await h.tool('work_submit', submit('a', h.exec("npm test")))
    h.say(`验收通过 ${h.task().id}，这一版收下`, { wrapped })
    await h.tool('work_control', { operation: 'accept' })
    assert.equal(h.task().state, 'closed')
    assert.equal(h.task().accepted.source.via, 'user-message')
  }
})

test('P0 U03: a candidate becomes a rule only after the person has replied; whether the reply is a yes is the model’s reading', async () => {
  const h = await harness()
  await h.start()
  await h.tool('work_env', { operation: 'propose', kind: 'blocked', key: 'migrations', value: '不得修改 migrations/' })
  const before = await readEnv(h.project)
  assert.match((await h.tool('work_env', { operation: 'confirm', key: 'migrations' })).tellUser, /问用户一句/)
  assert.deepEqual(await readEnv(h.project), before)
  h.say('确认 migrations 禁令')
  await h.tool('work_env', { operation: 'confirm', key: 'migrations' })
  assert.equal((await readEnv(h.project)).blocked[0].source.by, 'user')
  await h.tool('work_env', { operation: 'propose', kind: 'fact', key: 'port', value: '8080' })
  h.log.push({ type: 'tool/call', data: { callId: 'env-choice', name: 'ask_user_question', arguments: { questions: [{ question: '采用 port = 8080？' }] } } })
  h.result('env-choice', { answers: [{ answer: '采用候选' }] })
  await h.tool('work_env', { operation: 'confirm', key: 'port' })
  assert.equal((await readEnv(h.project)).facts.find(row => row.key === 'port').source.via, 'option-choice')
})

test('P0 U03: G3 — a rule the person set holds until the person lifts it; lifting one leaves the others', async () => {
  const h = await harness()
  await h.start()
  for (const key of ['migrations', 'secrets']) {
    await h.tool('work_env', { operation: 'propose', kind: 'blocked', key, value: `不得修改 ${key}/` })
    h.say(`确认 ${key} 禁令`)
    await h.tool('work_env', { operation: 'confirm', key })
  }
  // G3 reads the path a file tool names — a structured argument, never shell text.
  const action = { path: join(h.project, 'migrations/old.sql'), content: 'x' }
  assert.equal((await h.pre({ command: 'cat migrations/old.sql' })).kind, 'continue', '命令文本不猜')
  const refused = await h.pre(action, 'write')
  assert.equal(refused.kind, 'deny')
  assert.match(refused.reason, /用户禁令.*不得修改 migrations\/.*\n过关：/s)
  assert.doesNotMatch(refused.reason, /work_env|work_extend|key=/)
  // First lift attempt stops and asks with two fixed options; words are not read, the picked option decides.
  await assert.rejects(h.tool('work_env', { operation: 'forget', key: 'migrations' }), new RegExp(`是用户定的规则\\n过关：用问题卡问用户，只给两个选项「${CONSENT_YES}」「${CONSENT_NO}」`))
  h.say('好，撤销 migrations 禁令')
  await assert.rejects(h.tool('work_env', { operation: 'forget', key: 'migrations' }), /是用户定的规则/, '打字回答不算点选')
  pick(h, CONSENT_NO)
  await assert.rejects(h.tool('work_env', { operation: 'forget', key: 'migrations' }), /是用户定的规则/)
  pick(h, CONSENT_YES)
  await h.tool('work_env', { operation: 'forget', key: 'migrations' })
  assert.equal((await h.pre(action, 'write')).kind, 'continue')
  assert.equal((await h.pre({ path: 'secrets/token.txt', old_string: 'a', new_string: 'b' }, 'edit')).kind, 'deny')
  const env = await readEnv(h.project)
  assert.equal(env.blocked.find(row => row.key === 'migrations').status, 'stale')
  assert.equal(env.blocked.find(row => row.key === 'secrets').source.by, 'user')
  assert.match(h.notices.findLast(row => row.source.form === 'env-forget').source.data.line, /migrations/)
})

test('P0 U05: G2 by sequence — stopped once, then the option the person picks decides for that kind of action', async () => {
  const h = await harness()
  await h.start()
  // Only the exact list of irreversible commands; rm -rf is covered by saves and the deleted card.
  assert.equal((await h.pre({ command: 'rm -rf disposable' })).kind, 'continue')
  const action = 'git reset --hard HEAD~1'
  const first = await h.pre({ command: action })
  assert.equal(first.kind, 'deny')
  assert.match(first.reason, new RegExp(`破坏性操作.*\\n过关：用问题卡问用户，只给两个选项「${CONSENT_YES}」「${CONSENT_NO}」`, 's'))
  assert.doesNotMatch(first.reason, /work_extend|authorization/)
  // Asked, not answered yet: still stopped.
  assert.equal((await h.pre({ command: action })).kind, 'deny')
  // Typed words are not read: only the picked option counts.
  h.say('可以删')
  assert.equal((await h.pre({ command: action })).kind, 'deny')
  pick(h, CONSENT_NO)
  assert.equal((await h.pre({ command: action })).kind, 'deny')
  pick(h, CONSENT_YES)
  assert.equal((await h.pre({ command: action })).kind, 'continue')
  assert.equal((await h.pre({ command: 'git reset --hard origin/main' })).kind, 'continue')
  // A different kind of irreversible action asks on its own.
  assert.equal((await h.pre({ command: 'git push --force origin main' })).kind, 'deny')
})

test('P0 U05: an option the person picked is a reply; work_extend never grants, it says what to ask', async () => {
  const h = await harness()
  await h.start()
  const action = 'git clean -fdx'
  assert.equal((await h.pre({ command: action })).kind, 'deny')
  const asked = await h.tool('work_extend', { kind: 'authorization', action, reason: '清理备份' })
  assert.equal(asked.granted, false)
  assert.match(asked.tellUser, /直接问用户/)
  pick(h, CONSENT_YES, 'confirm_cmd')
  assert.equal((await h.pre({ command: action })).kind, 'continue')
  const source = decisionSource({ agent: h.agent, task: h.task(), after: 0 })
  assert.equal(source.via, 'option-choice')
  assert.equal(source.callId, 'confirm_cmd')
})

test('P0 U05: consent is per task and per kind', () => {
  const log = []
  const agent = { session: { id: 's', get seq() { return log.length }, eventAt: n => log[n] } }
  const state = {}
  assert.equal(consent(state, agent, { id: 't1' }, 'risk:deploy', 0).granted, false)
  log.push({ type: 'user/message', data: { id: 'm', source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: '发吧' }] } })
  assert.equal(consent(state, agent, { id: 't1' }, 'risk:deploy', 1).granted, false, '打字回答不算点选')
  log.push({ type: 'tool/call', data: { callId: 'q', name: 'ask_user_question', arguments: {} } })
  log.push({ type: 'tool/result', data: { message: { toolCallId: 'q', isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'gate', selected: [CONSENT_YES] }] }) }] } } })
  assert.equal(consent(state, agent, { id: 't1' }, 'risk:deploy', 3).granted, true)
  assert.equal(consent(state, agent, { id: 't2' }, 'risk:deploy', 3).granted, false)
  assert.equal(consent(state, agent, { id: 't1' }, 'risk:recursive-delete', 3).granted, false)
})

test('P0 U04: only successful tool results change projected business state', () => {
  const call = (id, name, args) => ({ type: 'tool/call', data: { callId: id, name, arguments: args } })
  const result = (id, value, isError = false) => ({ type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
  let state = foldBoard(null, call('start', 'work_start', { mode: 'do', request: 'P0', acceptance: ['实际验收'] }))
  assert.equal(boardOf(state), null)
  state = foldBoard(state, result('start', { taskId: 'task-p0' }))
  state = foldBoard(state, call('plan', 'work_plan', { operation: 'set', units: [unit('a')] }))
  state = foldBoard(state, result('plan', {}))
  const baseline = boardOf(state)
  state = foldBoard(state, call('submit-fail', 'work_submit', { unit: 'a', outcome: 'complete', summary: '不实结论' }))
  assert.deepEqual(boardOf(state).units, baseline.units)
  state = foldBoard(state, result('submit-fail', { error: 'missing UI evidence' }, true))
  assert.deepEqual(boardOf(state).units, baseline.units)
  assert.equal(boardOf(state).last, baseline.last)
  state = foldBoard(state, call('ok', 'work_submit', { unit: 'a', outcome: 'complete', summary: '通过' }))
  state = foldBoard(state, result('ok', { state: 'review_ready' }))
  assert.equal(boardOf(state).taskState, 'review_ready')
  assert.equal(boardOf(state).units[0].state, 'done')
})

test('P0 U05: controls are idempotent; terminal resume refuses and explicit adoption creates a fresh window', async () => {
  assert.deepEqual(controlTransition('paused', 'pause'), { state: 'paused', changed: false })
  for (const state of ['closed', 'cancelled', 'review_ready']) assert.equal(controlTransition(state, 'resume').changed, false)
  const h = await harness()
  const started = await h.start()
  await h.tool('work_plan', { operation: 'set', units: [unit('a')] })
  const oldProof = h.exec('node -e "console.log(1)"')
  await h.tool('work_submit', submit('a', oldProof))
  assert.equal((await h.tool('work_control', { operation: 'continue' })).unchanged, true)
  await h.tool('work_control', { operation: 'adopt', taskId: started.taskId })
  assert.equal(h.task().state, 'active')
  assert.equal(h.plan().units.find(row => row.id === 'a').state, 'pending')
  writeFileSync(join(h.project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 1' } }))
  h.write('a.js')
  await h.tool('work_submit', submit('a', h.exec("npm test")))
  const other = await harness({ project: h.project, tables: h.host.tables, sessionId: 'new-session' })
  await other.host.commands[0].handler({ agent: other.agent, rawInput: 'start 接手' })
  await other.tool('work_control', { operation: 'adopt', taskId: started.taskId })
  assert.equal(other.task().sessionId, 'new-session')
  assert.equal(other.task().startedSeq, other.plan().units.find(row => row.id === 'a').startedSeq)
})

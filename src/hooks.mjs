import { craftMessages, failureContext } from './craft.mjs'
/**
 * The three observation points, and nothing else — plus one rescue.
 *
 * `agent/pre-step` captures the user's own words and offers one line of hint;
 * `tools/pre-execute` is the only place that can refuse an action before it runs;
 * `tools/post-execute` enrols a write that was never registered and reminds about a
 * missing check. Only the refusal is a gate — the other two are observations, and
 * an observation that nags is an observation people learn to ignore.
 *
 * `agent/turn-stopping` is not an observation: a provider that only parses the
 * tool names the request declared can leave an undeclared call as prose, and a
 * turn that "finishes" without ever running it is the one failure a person cannot
 * see and cannot type around. Rescuing that turn once is the difference between a
 * retry and silence.
 */
import { isWriteExecution, wasRefused } from './session-log.mjs'
import { isCheckCommand, risksOfCall } from './risk.mjs'
import { browserRunOf, createTaskRecord, windowObservations } from './task.mjs'
import { nextUnit } from './plan.mjs'
import { readEnv } from './env.mjs'
import { grantsAction } from './decisions.mjs'
import { callsSince, currentTurn, lastAssistant, pseudoCallOf, rescueMessage } from './pseudo-call.mjs'

/** Does this unit put something on a screen? Same signals the submit warning uses. */
function screenUnit(unit, task) {
  const text = `${unit?.goal ?? ''} ${unit?.deliverable ?? ''} ${task?.goal ?? ''} ${task?.request ?? ''}`
  if (/界面|页面|按钮|样式|前端|截图|\bui\b|\bhtml\b/i.test(text)) return true
  return (Array.isArray(unit?.scope) ? unit.scope : []).some(path =>
    /\.(tsx|jsx|vue|svelte|html|css|scss)$|public\/|static\//.test(String(path)))
}

/** Calls allowed without a settlement (a note or a submit restarts the count). */
const grantedStartHint = grant =>
  `用户已经通过 /dsh-auto-dev 命令授权开工。现在调用 work_start 登记任务，request 用命令中的用户原话：${JSON.stringify(grant.text)}；同时填写范围和验收。work_start 是任务登记，无需再次询问是否开工，也无需让用户重输命令。`
/**
 * What the person said in this step, or '' when the step was not started by a
 * human. Only a real message counts: a tool result is not an opinion.
 */
/**
 * Every string a call carries, at two levels: a command, a path, a glob, an id.
 *
 * Blocked rules have to see the paths a write tool names, or a project's "never
 * touch this directory" only protects people who work through `bash`.
 */
function stringsIn(value, depth = 0, out = []) {
  if (depth > 2 || value == null) return out
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, depth + 1, out)
    return out
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) stringsIn(item, depth + 1, out)
  }
  return out
}

/**
 * The fragments of a blocked row worth matching: its key, and path-like or
 * command-like words in its value. "不许改 migrations/ 下的历史文件" → ["migrations"].
 */
function needlesOf(row) {
  const words = String(row?.value ?? '').split(/[\s，。、；;:：()（）"'“”]+/)
  return [row?.key, ...words]
    .map(word => String(word ?? '').trim().toLowerCase())
    .filter(word => word.length >= 2 && (word.includes('/') || /^[a-z0-9._-]+$/.test(word)))
}

function personSaid(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (message?.source?.kind && message.source.kind !== 'user') continue
    const parts = Array.isArray(message?.content) ? message.content : []
    const said = parts.filter(part => part?.type === 'text').map(part => part.text).join(' ').trim()
    if (said !== '') return said
    return ''
  }
  return ''
}

/**
 * Three answers matter after "做完了": yes, not yet (with a reason), and silence.
 *
 * The person answers in their own words, so this reads like a person: an explicit
 * yes, an objection, or anything else (which is treated as "not yet, keep quiet").
 */
function reviewVerdict(said) {
  const body = String(said).trim()
  if (body === '') return 'ignore'
  // A person rarely answers with one word: "我点开看过了，可以" is an acceptance.
  // Anything that reads as a complaint wins, otherwise an approval word anywhere
  // in the sentence counts. Anchoring on the first character missed both.
  if (/不|别|缺|少|改|换|错|不对|丑|奇怪|再补|补一下|慢|卡|崩/.test(body)) return 'revise'
  if (/(可以|行|好的|好嘞|没问题|通过|同意|就这样|收了|收尾|满意|不错|能用|能看|OK)/i.test(body)) return 'accepted'
  if (/^(ok|okay|yes|pass|lgtm)\b/i.test(body)) return 'accepted'
  return 'ignore'
}


export function registerHooks(ctx, api) {
  // A call the provider streamed as prose. Two observation points look for it —
  // the step that follows a message which also made a real call, and the last
  // word before the turn settles — so the bookkeeping lives here, not in either.
  //
  // Bound: one correction per message, and a second correction in the same turn
  // only once the model has made a real call since the first. That is the loop
  // bound — a model that answers a correction with more prose gets silence, while
  // a long turn that recovers and loses another call later is corrected again.
  // (A fixed "two per turn" cap was wrong: session f40c042c spent it at step 5 and
  // then lost a 10 KB `write` at step 24 with no correction left to give.)
  const corrected = new Set()
  const correctedAt = new Map()
  const lostCall = last => {
    if (!last) return null
    const call = pseudoCallOf(last.text)
    if (!call) return null
    // Prose that repeats a call the message really made is narration, not a loss.
    if (call.name && last.callNames.includes(call.name)) return null
    return call
  }
  const claim = (agent, turn, step) => {
    const key = `${api.sessionId(agent)}:${turn}`
    const mark = `${key}:${step}`
    if (corrected.has(mark)) return false
    const floor = correctedAt.get(key)
    if (floor !== undefined && !callsSince(agent.session, turn, floor)) return false
    if (corrected.size > 500) { corrected.clear(); correctedAt.clear() }
    corrected.add(mark)
    correctedAt.set(key, step)
    return true
  }
  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    const decision = await next()
    const state = api.sessionState(agent)
    const userTexts = []
    for (const message of messages ?? []) {
      if (message?.source?.kind !== 'user') continue
      const body = (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n').trim()
      if (body) userTexts.push(body)
    }
    state.userTexts.push(...userTexts)
    // When the person last spoke, by log position: an organize proposal may only be
    // applied after they said something themselves, and this is that evidence.
    if (userTexts.length > 0) await api.markUserSpoke(agent)
    if (decision.kind === 'reject') return decision
    // Everything below is about a task. This session has to have asked for one:
    // the plugin is mounted for every conversation in the profile, and a
    // conversation that never ran `/dsh-auto-dev start` must not be told what a
    // tool it does not have is for, nor that some other window is halfway through
    // something. The words collected above stay collected — an opted-in session
    // that starts later cites them as the request it was given.
    if (!api.optedIn(agent)) return decision
    // Method hints precede ordinary early returns, so intake/UI/review cannot hide
    // a real failure or handoff context. Rejected/non-opted-in sessions stay silent.
    // One read per step: nothing below writes a task before it returns, and each
    // read clones a record whose ledger grows with the work.
    const active = api.activeTask(agent)
    let latest
    const latestTask = () => (latest ??= { task: api.latestTask(agent) }).task
    let observed
    const observations = () => (observed ??= api.observationsOf(agent))
    const methodTask = active ?? latestTask()
    if (methodTask) {
      const methodUnit = (api.planOf(methodTask)?.units ?? []).find(row => row.state === 'active')
      const window = windowObservations(observations(), methodTask, methodUnit)
      const failure = failureContext(window.results, methodTask.ledger)
      // A failed write may have changed files; a pre-execute refusal did not.
      // Once per submission, not per write: "check the last change" said after
      // every `sed -i` buries the work it is about (one research session got 55).
      // A submission closes the stretch — the writes it covered are checked — and
      // only a write after it opens a new one.
      const settled = methodTask.ledger?.at(-1)?.seq ?? -1
      const changed = window.results.some(row => row.seq > settled && isWriteExecution(row) && !wasRefused(row))
      const methods = craftMessages(api, agent, { task: methodTask, unit: methodUnit, failure, changed,
        ...(changed ? { context: { verification: `submits:${methodTask.ledger?.length ?? 0}` } } : {}) })
      if (methods.length) decision.messages = [...(decision.messages ?? []), ...methods]
    }
    // 命令欠这个会话的一行（接手没有工具调用可以挂）。随下第一步一起到。
    const owed = api.takeReceipts(agent)
    if (owed.length) return { ...decision, messages: [...owed, ...(decision.messages ?? [])] }
    // A slash command cannot address the model, so `/dsh-auto-dev start …` writes
    // the request down and this is where it reaches the one turn that can act on
    // it. Same for adopt: the record moved, but the model still has to read it.
    const pending = api.takeIntake(agent)
    if (pending) {
      // This delivery path is still the user's own start: the command could not
      // open a turn, so its words arrive here instead. The grant has to travel
      // with the words, or work_start would refuse the very request just made.
      if (pending.kind === 'start') api.grantStart(agent, pending.text)
      const body = pending.kind === 'start'
        ? `用户刚用 /dsh-auto-dev start 登记了这个需求，原话逐字：\n「${pending.text}」\n调用 work_start 时 request 用这段原话；mode、scope、acceptance 按任务自己判断。`
        : `任务 ${pending.taskId} 已经用 /dsh-auto-dev adopt 转到这个会话（来自 ${pending.from ?? '另一个会话'}）。先读它的计划与进度（work_status；只暴露 run_code 的会话里走 run_code：await tools.work_status(...)），再从那里继续，别重新开工。`
      const extra = pending.kind === 'adopt'
        ? { form: 'handoff', data: { unit: pending.taskId ?? '', title: `接手 · ${pending.taskId ?? ''}`, line: `从会话 ${pending.from ?? '另一处'} 接过来，接着做没做完的单元`, tag: '已存档', tone: 'neutral' } }
        : undefined
      return { ...decision, messages: [...decision.messages, api.notice(body, `auto-dev-v3 ${pending.kind}`, extra)] }
    }
    // A task waiting at the review step is not "active" any more, but it is still
    // the task this conversation is about — so the step has to see it.
    const task = active ?? (latestTask()?.state === 'review_ready' ? latestTask() : undefined)
    // 收案：打完了不等于收案。有人能看的东西就停在这儿，等人一句话。
    if (task && task.state === 'review_ready') {
      const said = personSaid(messages)
      const verdict = reviewVerdict(said)
      const now = new Date().toISOString()
      // The person's words are the decision; the state change is the model's
      // call. Handing the words over instead of writing `closed` here keeps the
      // ledger honest: a task closes because accept was called, never because a
      // hook guessed what a sentence meant.
      if (verdict === 'accepted') {
        return { ...decision, messages: [...decision.messages, api.notice(
          `用户看过并说「${said.slice(0, 40)}」：调用 work_control operation "accept"，text 用他的原话，把任务收掉。`,
          'auto-dev-v3 review accepted')] }
      }
      if (verdict === 'revise') {
        return { ...decision, messages: [...decision.messages, api.notice(
          `用户看过并提了意见：「${said.slice(0, 200)}」。调用 work_control operation "rework"，text 用他的原话；任务会回到进行中，改完再交。`,
          'auto-dev-v3 review revise')] }
      }
      if (said === '' && !task.review?.asked) {
        await api.records.change('tasks', task.id, current => ({
          ...current, updatedAt: now, review: { ...(current.review ?? {}), asked: true, askedAt: now },
        }))
        return { ...decision, messages: [...decision.messages, api.notice(
          `**做完了 · 要不要看一眼？** — ${task.goal || task.request || '这次交付'}。停下来等用户：说「可以」就收案，说哪里不对就退回改，说别的就什么都别做，不要追问他。`,
          'auto-dev-v3 review ask',
          { form: 'review', data: { unit: task.id, title: '做完了 · 要不要看一眼？', line: '可以 / 再来一轮 / 先放这儿', tag: '回一句就行', tone: 'done' } })] }
      }
    }
    // 界面单元还没让浏览器真跑过：在整个任务里说这一次，跑过就永久闭嘴。
    // It goes here rather than at submit because by submit the unit is done: a
    // reminder that cannot change anything is just noise.
    if (task && task.state === 'active') {
      const plan = api.planOf(task)
      const activeUnit = (plan?.units ?? []).find(unit => unit.state === 'active')
      const state = api.sessionState(agent)
      // Once per unit, and never again for this conversation once a browser has
      // run: the sentence the model reads then matches what happened.
      const key = activeUnit ? `${task.id}:${activeUnit.id}` : undefined
      // Read the answer off the session log, not off a counter: a run in another
      // process is still a run, and "it stops nagging" has to mean that.
      // Look at this unit's window, not the whole conversation: a browser run in
      // an earlier unit covers the earlier unit, and the next screen still needs
      // its own look.
      const browserRan = (activeUnit
        ? windowObservations(observations(), task, activeUnit).results
        : []).some(row => browserRunOf(row))
      if (key && (activeUnit.ui === undefined || activeUnit.ui === 'browser') && state.uiNudged !== key && screenUnit(activeUnit, task) && !browserRan) {
        state.uiNudged = key
        return { ...decision, messages: [...decision.messages, api.notice(
          `「${activeUnit.id}」有界面，这一次还没让浏览器真跑过：起服务后用非 headless 的 Playwright 点一遍（npx playwright test --headed），截图放 outputs/，把路径写进 claims。跑过之后我不再提（references/craft/gui.md）。`,
          'auto-dev-v3 ui test')] }
      }
    }
    // 栽过的地方值得留一段复盘，否则同一个坑会再踩一次。工具早就能写，缺的是
    // 有人叫它写：`blocked` 关闭，或同一个毛病第二次出现，就在下一步说一次。
    const stoppedTask = active ?? api.stoppedTask(agent) ?? latestTask()
    if (stoppedTask && !api.sessionState(agent).postmortemNudged && !(stoppedTask.pulse?.postmortemAt)) {
      // 只在任务真的停下时提这一次：进行中的"同一个毛病又出现了"是下面那条
      // "停一下"的事，两条都发会变成同一步里两句抱怨。
      const stopped = stoppedTask.state === 'closed' || stoppedTask.state === 'cancelled'
      const carried = (stoppedTask.ledger ?? []).some(row => row.outcome === 'failed' || row.outcome === 'blocked')
      if (stopped && carried) {
        api.sessionState(agent).postmortemNudged = true
        return { ...decision, messages: [...decision.messages, api.notice(
          `**要不要留个复盘** — 这个任务带着失败关掉了。` +
          '有可复用发现时，用 work_control record kind learning 留下观察、尝试和证据；根因未知可以不填。记录可选，继续已授权工作。',
          'auto-dev-v3 postmortem',
          { form: 'postmortem', data: { unit: stoppedTask.id, title: '要不要留个复盘', line: '这个任务带着失败关掉了，留一份下次能用的记录？', tag: '回一句就行', tone: 'info' } })] }
      }
    }
    // An explicit start/new already carries the person's intent, including when
    // they chose new while older work is unfinished. Teach registration first.
    const startGrant = api.readStartGrant(agent)
    if (!task && startGrant.ok && !state.startHinted) {
      state.startHinted = true
      return { ...decision, messages: [...decision.messages, api.notice(
        grantedStartHint(startGrant),
        'auto-dev-v3 start granted',
      )] }
    }
    // Before the generic hint, the one that matters more: something is already
    // half done on this project. In the skill generation the state sat in the
    // project directory, so opening another conversation and saying "continue"
    // just worked; this record is host-wide instead, so it has to be named or the
    // model cheerfully starts a second task over the top of the first.
    if (!startGrant.ok && !state.resumeHinted && userTexts.length > 0 && !task) {
      const elsewhere = api.unfinishedElsewhere(agent)
      if (elsewhere.length) {
        state.resumeHinted = true
        const first = elsewhere[0]
        return { ...decision, messages: [...decision.messages, api.notice(
          `这个项目有一条没做完的任务 ${first.id}（${first.state}${first.progress ? `，${first.progress}` : ''}）：「${first.request}」。用户如果是在说「继续」或接着上一件活干，先 work_control operation="adopt" taskId="${first.id}" 把它接过来再继续，不要重新登记一个；如果是另一件新事，直接忽略这条。`,
          'auto-dev-v3 resume hint',
        )] }
      }
    }
    // One standing hint per session, at the first step a person speaks on. The
    // task is started by the person, never by the model: this line teaches the
    // one legal path (the command's grant) instead of inviting a self-driven
    // registration that would put work on the board nobody asked for.
    if (!startGrant.ok && !state.hinted && userTexts.length > 0 && !task && step === 1) {
      state.hinted = true
      state.taskId = undefined
      return { ...decision, messages: [...decision.messages, api.notice(
        'Auto Dev v3 在这个 profile 里只由用户手动启动：用户会用 /dsh-auto-dev start <他的原话> 开一个任务。你不要自己调用 work_start；如果你判断这是一件需要跟踪的交付工作，用一句话问用户「要不要我用 auto-dev 跟一下」，等他同意。看一眼代码、问个问题都不需要任何登记。',
        'auto-dev-v3 standing hint',
      )] }
    }
    // The silence nudge. A worker that grinds for tens of steps without one
    // visible sentence leaves the owner staring at a tool stream, guessing —
    // the board can count the calls, but only the model can say what they mean.
    // One number is the whole rule: steps since the last assistant message that
    // carried text, same bar for every session, and the reminder re-arms only
    // after another full window of silence. A delegated child is exempt by
    // design — it reports to its parent, who relays — and the session header's
    // `parentSession` is the host's exact mark for that, not a guess from tools.
    const narrationLimit = api.settings().narrationNudgeAfter
    if (narrationLimit > 0 && !agent?.session?.header?.parentSession) {
      const history = messages ?? []
      let lastAssistant
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index]
        if (message?.role === 'assistant' || message?.source?.kind === 'assistant') { lastAssistant = message; break }
      }
      if (lastAssistant && (lastAssistant.content ?? []).some(block => block?.type === 'text' && String(block.text ?? '').trim() !== '')) {
        state.narratedStep = step
      }
      const narratedAt = state.narratedStep ?? 0
      const nudgedAt = state.narrationNudgedAt ?? 0
      if (step - narratedAt >= narrationLimit && step - nudgedAt >= narrationLimit) {
        state.narrationNudgedAt = step
        return { ...decision, messages: [...decision.messages, api.notice(
          `Auto Dev v3：你已经 ${step - narratedAt} 步没有对用户说一句可见的话了。先用一两句向用户交代——现在在做什么、最近的关键结果、有没有卡住——然后再继续干活。工具调用不算对用户说话。`,
          'no visible words to the user',
        )] }
      }
    }

    // A message that wrote a call as prose and made another one for real: the
    // model reads its own result, finds the one it wanted missing, and blames the
    // tool — session f40c042c did exactly that and repeated the same `read` until
    // the turn ended. Correct it before that conclusion, not after the turn.
    const turn = currentTurn(agent.session)
    const last = turn === null ? null : lastAssistant(agent.session, turn)
    if (last && last.step < step) {
      const call = lostCall(last)
      if (call && claim(agent, turn, last.step)) {
        return { ...decision, messages: [...decision.messages, api.notice(
          rescueMessage(call), 'auto-dev-v3 伪调用纠正', { form: 'notice' })] }
      }
    }
    return decision
  })

  /**
   * Does another Auto Dev already own this session?
   *
   * v2 ships as an agent preset with its own scoped `work_*` tools. DSH lets a scoped
   * tool shadow a global one of the same name without complaint, so after both are
   * installed a v2 session would dispatch v2's tools while v3's hooks kept enrolling
   * phantom tasks and refusing actions v2 already permitted. Detecting the shadowed
   * description is crude, but it is decided once per call on evidence the host
   * provides, and the alternative is two control planes arguing inside one session.
   */
  const v2OwnsSession = agent => {
    try {
      const schemas = agent?.ctx?.tools?.schemas?.()
      const scoped = Array.isArray(schemas) ? schemas.find(schema => schema?.name === 'work_submit') : undefined
      return Boolean(scoped && /auto-dev-v2|Auto Dev v2/i.test(String(scoped.description ?? '')))
    } catch { return false }
  }

  // The authorization gate has to act before the effect, not after it. A api.notice
  // printed once `rm -rf src` has already run is a receipt for damage, and the
  // submit gate refusing it later only means the report is withheld — the work
  // is gone. Denying the call is the difference between a gate and a diary.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (!agent || exec.name.startsWith('work_')) return next()
    // A conversation that never started a task has no authorizations to check and
    // no business being refused in Auto Dev's name.
    if (!api.optedIn(agent)) return next()
    if (v2OwnsSession(agent)) return next()
    // With no task there is nobody to record an authorization for; the
    // post-execute hook enrols the write instead of nagging mid-call.
    const task = api.activeTask(agent)
    if (!task) return next()
    // What this project said never to touch beats any general rule: it is the one
    // place a person can put a promise the agent cannot talk its way out of.
    // A blocked entry is written by a person as a sentence ("不许改 migrations/ 下的
    // 历史文件"), so it is matched by the words that carry a path or a command —
    // not by the whole sentence, which no argv ever contains. File writes count
    // too: a promise about a directory is worth nothing if only `bash` is checked.
    const args = exec.arguments ?? {}
    const touched = stringsIn(args).join('\n').toLowerCase()
    if (touched) {
      const env = await readEnv(task.project)
      const hit = (env.blocked ?? []).find(row => row.status !== 'stale'
        && needlesOf(row).some(needle => touched.includes(needle)))
      if (hit) {
        api.blockedOnce(agent, `env:${task.id}:${hit.key}`,
          { title: '拦下 · 环境禁令', line: `${hit.value} — 改走禁区外` })
        return {
          kind: 'deny',
          reason: `auto-dev-v3: 环境禁令 key="${hit.key}"，内容「${hit.value}」${hit.note ? `；${hit.note}` : ''}。`
            + `来源：${JSON.stringify(hit.source ?? { by: 'historical', note: '来源未记录' })}。`
            + `可以继续检查禁区外的文件或改用安全替代方案。确需修改禁令时，由用户明确说明更新/撤销哪条规则；用 work_env propose/confirm 更新同一 key，或 forget/stale 并在 note 引用用户撤销原话。work_extend 不会解除环境禁令。`,
        }
      }
    }
    const config = api.settings()
    const risks = risksOfCall(exec, { protectedPrefixes: config.protectedPaths })
    const raised = risks.destructive.concat(risks.production)
    if (!raised.length) return next()
    const action = args.command ?? args.cmd ?? args.script ?? JSON.stringify(args)
    const unasked = raised.filter(risk => !grantsAction(task, risk, action, { agent }))
    if (!unasked.length) return next()
    api.denied.add(exec.callId)
    api.blockedOnce(agent, `irreversible:${task.id}:${unasked[0]}`,
      { title: '拦下 · 不可逆操作', line: `${String(action).split(/;|&&|\|\|/)[0].trim().slice(0, 48)} 没有你的授权 — 先问你再跑` })
    return {
      kind: 'deny',
      reason: `auto-dev-v3: ${unasked.join(', ')} is irreversible, and task ${task.id} has no recorded authorization for it. `
        + `Call work_extend first (kind "authorization", risk "${unasked[0]}", action = the exact command) so the user's own words are on the record — `
        + 'that is also what shows the user what they are agreeing to. If the action is not actually needed, do something reversible instead.',
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const agent = exec.agent
    if (!agent) return downstream
    const name = exec.name
    // A person answering a question in the UI speaks through a tool result, not a
    // user message; count it as speech so approvals that wait for a human word
    // (organize apply) can go through.
    if (name === 'ask_user_question') await api.markUserSpoke(agent)
    // A tool cannot address the model through its own return value (that is data
    // the model reads, not a message it is given), so the notices a work_* tool
    // queued ride the host's context channel from here, in the same step.
    const queued = api.takeOutbox(agent)
    if (name.startsWith('work_')) {
      if (!queued.length) return downstream
      return { ...downstream, additionalContexts: [...queued, ...(downstream?.additionalContexts ?? [])] }
    }
    // The enrolment reminder is an Auto Dev notice, so it only goes to a session
    // that asked for Auto Dev. A conversation that never opted in gets its own
    // silence, not a suggestion to run a command it has never heard of.
    if (!api.optedIn(agent)) return downstream
    if (v2OwnsSession(agent)) return downstream
    const args = exec.arguments ?? {}
    const command = typeof args.command === 'string' ? args.command : undefined
    const current = { name, command, ...args, isError: result?.isError,
      errorText: result?.error?.message ?? result?.content?.find(block => block.type === 'text')?.text }
    const write = isWriteExecution(current) && !wasRefused(current) && !api.denied.has(exec.callId)
    const task = api.activeTask(agent)
    const notices = [...queued]
    const settingsValue = api.settings()

    // An unregistered write is enrolled, never waved through and never blocked.
    // Enrollment gives the work an identity so a later claim can be checked
    // against it; the gates stay off until someone states the request. With
    // enrollment off (the default now that tasks are user-started) the same
    // moment gets one line pointing at the only legal start, then silence.
    if (!task && write) {
      if (settingsValue.autoEnroll) {
        const key = `auto-enroll:${agent.id}`
        if (!api.nudged.has(key)) {
          api.nudged.set(key, true)
          const now = new Date().toISOString()
          const id = api.newId('task')
          const record = { ...createTaskRecord({
            id, project: api.projectOf(agent), sessionId: api.sessionId(agent), ownerId: agent.id,
            request: '', goal: '', mode: 'do', scope: [], acceptance: [], startedSeq: api.seq(agent), now,
          }), enrolled: false }
          await api.records.change('tasks', id, () => record)
          api.sessionState(agent).taskId = id
          notices.push(api.notice(
            'Auto Dev v3：这个会话还没登记任务就改了文件，已经记成一条「未登记任务」。如果这是正式交付，请用 work_start 补上用户原话、范围和验收；如果只是随手看一眼，忽略这条即可。',
            'unregistered write enrolled',
          ))
        }
      } else if (!api.nudged.has(`start-hint:${agent.id}`)) {
        api.nudged.set(`start-hint:${agent.id}`, true)
        const startGrant = api.readStartGrant(agent)
        notices.push(api.notice(
          startGrant.ok ? grantedStartHint(startGrant) :
            'Auto Dev v3：这个会话还没有登记任务就在改文件。如果这是一件要交付的工作，把用户的请求原话交回给用户，让他运行 /dsh-auto-dev start <他的原话>；只是随手改代码就忽略这条。',
          'auto-dev-v3 start hint',
        ))
      }
    }

    if (task && write) {
      const observations = api.observationsOf(agent)
      const plan = api.planOf(task)
      const unit = plan ? nextUnit(plan) : undefined
      const window = windowObservations(observations, task, unit)
      const writing = window.results.filter(row => isWriteExecution(row) && !wasRefused(row))
      const currentLogged = writing.some(row => row.callId === exec.callId)
      const writeCount = writing.length + (currentLogged ? 0 : 1)
      const lastWrite = currentLogged ? writing[writing.length - 1].seq : observations.endSeq
      // The call that just ran is not in the log yet when this hook fires, so a
      // check the model *just* performed has to be counted from the call itself;
      // otherwise every write sequence nudges even after a real test run.
      // A failing test still counts as a check — it is evidence of running, and
      // the answer to a red run is a fix, not another reminder.
      // A single shell line can write a file and then check it (`python3 - <<EOF`
      // followed by `node --check`). Counting that call only as a write made the
      // reminder fire on work that had just been verified.
      const checkedAfterLastWrite = !write
        || isCheckCommand(command)
        || window.results.some(row => row.seq > lastWrite && !isWriteExecution(row))
      const key = `${task.id}:verify:${unit?.id ?? ''}`
      const nudgedAt = api.nudged.get(key) ?? 0
      // Remind only when the work has moved on since the last check AND since the
      // last reminder: a nudge that repeats itself is a nudge people learn to skip.
      if (!checkedAfterLastWrite
        && writeCount >= settingsValue.verificationNudgeAfter
        && writeCount - nudgedAt >= settingsValue.verificationNudgeAfter) {
        api.nudged.set(key, writeCount)
        notices.push(api.notice(
          `Auto Dev v3：这条任务已经改了 ${writeCount} 次文件，最近一次改动之后还没有跑过检查。跑一个能变红的检查（测试、构建、curl 之类的可观测命令），提交时把它的 callId 写进 claims；如果你只是在探索，把任务切到 look 模式就不用管这条。`,
          `no check after ${writeCount} writes`,
        ))
      }
      const granted = new Set((task.decisions ?? []).filter(decision => decision.granted).map(decision => decision.risk))
      // Only the call that just ran is in question. Older destructive rows in the
      // window are history: the submit gate still refuses to call them authorized,
      // but nagging about them again every time the plugin reloads is noise.
      const now = risksOfCall(exec, { protectedPrefixes: settingsValue.protectedPaths })
      const unasked = now.destructive.concat(now.production).filter(risk => !granted.has(risk))
      if (unasked.length && !api.denied.has(exec.callId)) {
        const risks = unasked
        const key2 = `authorization:${exec.callId}`
        if (!api.nudged.has(key2)) {
          api.nudged.set(key2, true)
          notices.push(api.notice(
            `Auto Dev v3：刚跑的动作被判定为不可逆（${risks.join('、')}）。提交时会被拒绝，除非先用 work_extend 把用户的明确同意记下来——现在问用户还来得及。`,
            `irreversible: ${risks.join(',')}`,
          ))
        }
      }
    }

    if (!notices.length) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: [...notices, ...(downstream.additionalContexts ?? [])] }
    }
    return { ...downstream, additionalContexts: [...notices, ...(downstream.additionalContexts ?? [])] }
  })

  // The last word before a turn settles. When the provider turned a call into
  // prose, the turn is about to end without the model ever saying that nothing
  // ran — the model believes it acted, so waiting for it to notice is waiting
  // forever. One corrective step, carrying the exact call, is what converts
  // silence into a retry; a bound of two is what stops a loop.
  //
  // The newest message decides, not the turn: session f40c042c ran seven real
  // `run_code` calls and still lost its last `read` to prose, then ended the turn
  // on a step that was nothing but the repeated text. A turn-wide call count
  // called that turn healthy, which is why this reads `lastAssistant`.
  //
  // A listener that throws ends the turn with an error (the host contains the
  // exception in `turn/end`), so a bug in the rescue must cost the rescue, not
  // the turn: the body is sealed, and so is each read that can fail.
  const guarded = (agent, turn) => {
    const last = lastAssistant(agent.session, turn)
    const call = lostCall(last)
    if (!call) return null
    if (!claim(agent, turn, last.step)) return null
    return api.notice(rescueMessage(call), 'auto-dev-v3 伪调用纠正', { form: 'notice' })
  }
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    try {
      if (signal?.aborted) return
      if (!agent?.session || typeof agent.steer !== 'function') return
      // Only the conversations that asked for Auto Dev, and not the ones v2 owns:
      // a notice about a pseudo call is only worth sending where a task exists.
      if (!api.optedIn(agent) || v2OwnsSession(agent)) return
      const message = guarded(agent, turn)
      if (message) agent.steer(message)
    } catch {
      // A rescue that fails silently is still better than a turn that ends in an
      // error the person cannot connect to anything they did.
    }
  })

  // Human commands. These exist because a person who does not read code should
  // not have to type a prompt to see what is going on or to stop the work.
}

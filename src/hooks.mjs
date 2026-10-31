import { deletedCard, deliveryOnce, firstWriteCard, fixCard, fixedCard, handoffCard, reviewCard } from './craft.mjs'
import { referencesTo } from './checkpoint.mjs'
import { checkRuns, exactCheck, fixesIn, redStreak, tailOf } from './facts.mjs'
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
import { resultFailed } from './session-log.mjs'
import { fingerprint, markGreen, markStart, marksOf, storedPrint, vanished } from './disk.mjs'
import { noteTrail, withSaid } from './trail.mjs'
import { filePathOf, risksOfCall } from './risk.mjs'
import { createTaskRecord, windowObservations } from './task.mjs'
import { nextUnit } from './plan.mjs'
import { blockedBy, blockedCommand, readEnv } from './env.mjs'
import { detectVerifier } from './detect.mjs'
import { consent, spokeSinceStart } from './decisions.mjs'
import { GATES, GateError } from './gate.mjs'
import { callsSince, currentTurn, lastAssistant, pseudoCallOf, rescueMessage } from './pseudo-call.mjs'


/** What the model reads when the user's start registered the task: their words, and what this project already knows. */
const startedBrief = (words, started) => [
  `用户用 /dsh-auto-dev start 开了任务（${started.taskId}），原话逐字：「${words}」。已经登记好，直接开工，不用再问要不要开始。`,
  started.tellUser,
  ...(Array.isArray(started.brief) ? started.brief : []),
  started.memory?.facts?.length ? `这个项目记过的事实：${started.memory.facts.join('；')}` : '',
  typeof started.envLine === 'string' ? started.envLine : '',
].filter(Boolean).join('\n')
/**
 * What the person said in this step, or '' when the step was not started by a
 * human. Only a real message counts: a tool result is not an opinion.
 */
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


/** Steps since the last assistant text or user message in the log; undefined when the log can't say. */
export function silentSteps(agent) {
  const session = agent?.session
  if (typeof session?.eventAt !== 'function' || typeof session.seq !== 'number') return undefined
  let steps = 0
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq)
    if (event?.type === 'step/start') steps += 1
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') return steps
    if (event?.type === 'assistant/message' && (event.data?.message?.content ?? []).some(block => block?.type === 'text' && String(block.text ?? '').trim() !== '')) return steps
  }
  return steps
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
  const saveNotice = (unit, line, saved, tone = 'neutral') => api.notice(
    `**存档** — ${line}${saved?.ref ? `（${saved.ref}）` : `：没存上（${saved?.reason ?? '未知原因'}）`}`,
    'dsh-auto-dev save',
    { form: 'save', data: { unit: unit?.id ?? '', title: '存档', line, tag: saved?.ref ? `#${saved.seq}` : '未存档', tone } })
  // The fix flow's two moments, from the project's own check and nothing else:
  // the second red in a row (save 修前, the fix card) and green after two or more
  // reds (save 修通, the fixed card). Whether it was a bug is the model's call.
  const fixCards = async (agent, task, unit, rows) => {
    const state = api.sessionState(agent)
    if (!(state.craftSeen instanceof Set)) state.craftSeen = new Set()
    const once = key => !state.craftSeen.has(key) && Boolean(state.craftSeen.add(key))
    const runs = checkRuns(rows, detectVerifier(task.project))
    const out = []
    // The newest run as the log has it, for a window that picks the task up later (交接).
    const last = runs.at(-1)
    if (last && task.trail?.check?.callId !== last.callId) {
      await noteTrail(api.records, task.id, () => ({ check: { callId: last.callId, command: last.command, ok: last.ok, tail: tailOf(last.output, 12), at: new Date().toISOString() } }))
    }
    const reds = redStreak(runs)
    if (reds.length >= 2 && once(`${task.id}:fix:${reds[0].callId}`)) {
      out.push(api.notice(...fixCard(unit, reds, task.project)))
      const saved = await api.snapshot(task, 'before', { unit: unit?.id, label: `修：${reds[0].command}` })
      out.push(saveNotice(unit, `修之前 · ${reds[0].command}`, saved))
    }
    const fix = fixesIn(runs).at(-1)
    if (fix && once(`${task.id}:fixed:${fix.green.callId}`)) {
      const saved = await api.snapshot(task, 'after', { unit: unit?.id, label: `修通：${fix.green.command}`, outcome: 'done' })
      out.push(saveNotice(unit, `修通 · ${fix.green.command}`, saved, 'done'))
      out.push(api.notice(...fixedCard(unit, fix)))
    }
    return out
  }
  // Files that were there when the task started and are gone now, while other
  // files still say their name. Each vanished file is looked up once.
  const deletedNotices = async (agent, task, now) => {
    const gone = await vanished(task.project, marksOf(task.id).start, now)
    if (!gone.length) return []
    const state = api.sessionState(agent)
    if (!(state.craftSeen instanceof Set)) state.craftSeen = new Set()
    const fresh = gone.filter(path => !state.craftSeen.has(`${task.id}:deleted:${path}`))
    for (const path of fresh) state.craftSeen.add(`${task.id}:deleted:${path}`)
    const refs = fresh.length ? await referencesTo(task.project, fresh) : []
    const unit = (api.planOf(task)?.units ?? []).find(row => row.state === 'active')
    return refs.length ? [api.notice(...deletedCard(unit, refs))] : []
  }
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
    // The person's own words stay on the task record for a later window (交接).
    if (userTexts.length) {
      const holder = api.activeTask(agent)
      // Not the start command, the request spliced back in, or the plugin's own 继续 line (command.mjs openTurn).
      const words = userTexts.filter(text => !/^\/dsh-auto-dev\b/.test(text.trim()) && text.trim() !== String(holder?.request ?? '').trim() && !text.startsWith(`继续 ${holder?.id}`))
      if (holder && words.length) await noteTrail(api.records, holder.id, trail => withSaid(trail, words, new Date().toISOString()))
    }
    // The fix cards precede ordinary early returns, so intake/UI/review cannot
    // hide them. One read per step.
    const active = api.activeTask(agent)
    let latest
    const latestTask = () => (latest ??= { task: api.latestTask(agent) }).task
    let observed
    const observations = () => (observed ??= api.observationsOf(agent))
    const methodTask = active ?? latestTask()
    if (methodTask && methodTask.mode !== 'look') {
      const methodUnit = (api.planOf(methodTask)?.units ?? []).find(row => row.state === 'active')
      const cards = await fixCards(agent, methodTask, methodUnit, windowObservations(observations(), methodTask, methodUnit).results)
      if (cards.length) decision.messages = [...(decision.messages ?? []), ...cards]
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
      const adopted = pending.kind === 'adopt' ? api.records.get('tasks', pending.taskId) : undefined
      if (adopted) return { ...decision, messages: [...decision.messages, api.notice(...await handoffCard(adopted, { from: `会话 ${pending.from ?? '另一处'}` }))] }
      const body = pending.kind === 'start'
        ? startedBrief(pending.text, await api.startTask(agent, pending.text))
        : `任务 ${pending.taskId} 已经用 /dsh-auto-dev adopt 转到这个会话（来自 ${pending.from ?? '另一个会话'}）。`
      return { ...decision, messages: [...decision.messages, api.notice(body, `dsh-auto-dev ${pending.kind}`)] }
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
          `用户看过并说「${said.slice(0, 40)}」：这算同意，收案（accept），告诉他这一版收下了。`,
          'dsh-auto-dev review accepted')] }
      }
      if (verdict === 'revise') {
        return { ...decision, messages: [...decision.messages, api.notice(
          `用户看过并提了意见：「${said.slice(0, 200)}」。退回（rework）按他说的改，改完再交。`,
          'dsh-auto-dev review revise')] }
      }
      if (said === '' && !task.review?.asked) {
        await api.records.change('tasks', task.id, current => ({
          ...current, updatedAt: now, review: { ...(current.review ?? {}), asked: true, askedAt: now },
        }))
        return { ...decision, messages: [...decision.messages, api.notice(...reviewCard(task))] }
      }
    }
    // An explicit start/new already carries the person's intent, including when
    // they chose new while older work is unfinished. Teach registration first.
    const startGrant = api.readStartGrant(agent)
    if (!task && startGrant.ok && !state.startHinted) {
      state.startHinted = true
      return { ...decision, messages: [...decision.messages, api.notice(
        startedBrief(startGrant.text, await api.startTask(agent, startGrant.text)),
        'dsh-auto-dev start granted',
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
          `这个项目有一条没做完的任务 ${first.id}（${first.state}${first.progress ? `，${first.progress}` : ''}）：「${first.request}」。用户如果是在说「继续」或接着上一件活干，先把 ${first.id} 接过来再继续，不要重新登记一个；如果是另一件新事，直接忽略这条。`,
          'dsh-auto-dev resume hint',
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
        'Auto Dev v3 在这个 profile 里只由用户手动启动：用户会用 /dsh-auto-dev start <他的原话> 开一个任务。你不要自己开任务；如果你判断这是一件需要跟踪的交付工作，用一句话问用户「要不要我用 auto-dev 跟一下」，等他同意。看一眼代码、问个问题都不需要任何登记。',
        'dsh-auto-dev standing hint',
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
      // Read from the session log (host facts), not from this step's message delta:
      // steps since the last assistant message with text, or since the person spoke.
      const silent = silentSteps(agent)
      if (silent !== undefined) state.narratedStep = step - silent
      const narratedAt = state.narratedStep ?? 0
      const nudgedAt = state.narrationNudgedAt ?? 0
      // Parked for the person (review asked): waiting is the right thing, not silence.
      const parked = latestTask()?.state === 'review_ready'
      if (!parked && step - narratedAt >= narrationLimit && step - nudgedAt >= narrationLimit) {
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
          rescueMessage(call), 'dsh-auto-dev 伪调用纠正', { form: 'notice' })] }
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
  const RISK_WORDS = { 'recursive-delete': '整个删掉一批文件', 'forced-git-reset': '丢掉没提交的改动', 'force-push': '覆盖或删掉远端的提交', 'history-rewrite': '改写 git 历史', 'sql-destruction': '删掉数据库里的数据', infrastructure: '改动线上基础设施', 'disk-or-package': '对外发布或改动磁盘', deploy: '部署到线上', 'production-write': '改动线上数据', 'remote-shell': '在远端机器上执行', 'control-plane': '改动受保护的文件' }
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
    // The tree before the task's first call in this process: what 删除 and 收尾 compare to.
    const startPrint = await markStart(task.project, task.id)
    if (!task.trail?.start) await noteTrail(api.records, task.id, () => ({ start: storedPrint(startPrint) }))
    // What this project said never to touch (G3): the path a file tool names, or a
    // command the person wrote, word for word at the start of a simple command.
    // Shell writes into a blocked path are seen on disk at hand-in.
    const args = exec.arguments ?? {}
    const path = filePathOf(exec)
    const env = await readEnv(task.project)
    const hit = (path && blockedBy(env, [path])?.row) || (typeof args.command === 'string' && blockedCommand(env, args.command)?.row)
    if (hit) {
      api.blockedOnce(agent, `env:${task.id}:${hit.key}`,
        { title: '拦下 · 环境禁令', line: `${hit.value} — 改走禁区外` })
      return {
        kind: 'deny',
        // G3: one rule, one way through.
        reason: `dsh-auto-dev ${GATES.G3}：用户定过「${hit.key && !String(hit.value).includes(hit.key) ? `${hit.key}：` : ''}${hit.value}」${hit.note ? `（${hit.note}）` : ''}。\n过关：改走禁区外；真要动它，先问用户要不要解除这条。`,
      }
    }
    const config = api.settings()
    const risks = risksOfCall(exec, { protectedPrefixes: config.protectedPaths })
    const raised = risks.destructive.concat(risks.production)
    if (!raised.length) return next()
    const action = args.command ?? args.cmd ?? args.script ?? JSON.stringify(args)
    // G2 by sequence: the first one of a kind is stopped and the model asks; the
    // person's next reply decides — a no keeps it stopped, anything else lets this
    // kind through for the rest of the task. No quote to copy, no form to fill.
    const state = api.sessionState(agent)
    const asked = raised.map(risk => ({ risk, ...consent(state, agent, task, `risk:${risk}`, api.seq(agent)) })).find(row => !row.granted)
    if (!asked) return next()
    api.denied.add(exec.callId)
    const shown = String(action).split(/;|&&|\|\|/)[0].trim().slice(0, 48)
    api.blockedOnce(agent, `irreversible:${task.id}:${asked.risk}`,
      { title: '拦下 · 不可逆操作', line: asked.refused ? `${shown} — 你说了不，换个做法` : `${shown} — 先问你再跑` })
    return {
      kind: 'deny',
      reason: asked.refused
        ? `dsh-auto-dev ${GATES.G2}：用户没同意（「${asked.refused.slice(0, 60)}」）。\n过关：换一个可逆的做法。`
        : `dsh-auto-dev ${GATES.G2}：\`${String(action).slice(0, 160)}\` 跑了就回不来。\n过关：先问用户「要跑这个吗？会${RISK_WORDS[asked.risk] ?? '造成不可逆的改动'}」，他回了同意再跑。`,
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
    const task = api.activeTask(agent)
    // A write before any task: only a file tool says so with a structured path; shell text is not read.
    const write = Boolean(filePathOf({ name, arguments: args })) && !result?.isError && !api.denied.has(exec.callId)
    const notices = [...queued]
    // The project's own check, run plainly: a pass marks the tree it covers (G1),
    // and every run is when files gone from disk since the start are looked up.
    if (task && command && exactCheck(command, detectVerifier(task.project))) {
      const now = resultFailed(result?.content, name, result?.isError)
        ? await fingerprint(task.project)
        : await markGreen(task.project, task.id, api.seq(agent))
      notices.push(...await deletedNotices(agent, task, now))
    }
    // The task's first file write: the 「动手前」 sentences, once. Shell writes are not read (宁可漏).
    // The plugin's own files (.auto-dev/: incidents, domain) are not a change to the project (v36 survey).
    const own = /(^|[\\/])\.auto-dev[\\/]/.test(String(filePathOf({ name, arguments: args }) ?? ''))
    if (task && write && !own && task.mode !== 'look' && !api.nudged.has(`first-write:${task.id}`)) {
      api.nudged.set(`first-write:${task.id}`, true)
      const spoke = spokeSinceStart(agent, task)
      notices.push(api.notice(...firstWriteCard(spoke, detectVerifier(task.project), task.request)))
    }
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
            'Auto Dev v3：这个会话还没开任务就改了文件，已经记成一条「未登记任务」。如果这是正式交付，请用户用 /dsh-auto-dev start <他的原话> 开任务；只是随手看一眼就忽略这条。',
            'unregistered write enrolled',
          ))
        }
      } else if (!api.nudged.has(`start-hint:${agent.id}`)) {
        api.nudged.set(`start-hint:${agent.id}`, true)
        const startGrant = api.readStartGrant(agent)
        notices.push(api.notice(
          startGrant.ok ? startedBrief(startGrant.text, await api.startTask(agent, startGrant.text)) :
            'Auto Dev v3：这个会话还没有登记任务就在改文件。如果这是一件要交付的工作，把用户的请求原话交回给用户，让他运行 /dsh-auto-dev start <他的原话>；只是随手改代码就忽略这条。',
          'dsh-auto-dev start hint',
        ))
      }
    }

    // A stretch of edits with no check is the `unchecked` card's (pre-step, from the log);
    // an irreversible action is stopped before it runs (pre-execute, G2). Nothing to add here.

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
    return api.notice(rescueMessage(call), 'dsh-auto-dev 伪调用纠正', { form: 'notice' })
  }
  // 收尾. A turn that ends on the model's own words, with the project on disk
  // different from when the task started, is a hand-in: the plugin settles it,
  // so delivery never waits on the model remembering a tool. G1/G4 still decide;
  // a refusal goes on once per tree, a second stop on the same tree ends the turn.
  // A turn that ends on a question is waiting on the person, not handing in.
  const settleAtStop = async (agent, turn) => {
    const task = api.activeTask(agent)
    if (!task || task.state !== 'active' || task.mode === 'look') return null
    const last = lastAssistant(agent.session, turn)
    const text = String(last?.text ?? '').trim()
    if (!text || last.callNames?.length || /[？?]\s*$/.test(text)) return null
    const start = marksOf(task.id).start
    const now = start && await fingerprint(task.project)
    if (!now || now.id === start.id) return null
    const state = api.sessionState(agent)
    if (!(state.craftSeen instanceof Set)) state.craftSeen = new Set()
    const key = `${task.id}:settle:${now.id}`
    if (state.craftSeen.has(key)) return null
    state.craftSeen.add(key)
    // Hand-in is a moment the plugin speaks: a turn that ends by itself never sees
    // the tool result that carries the conditional sentences (v33 perf/refactor), so
    // they go in once per task before the hand-in, and the next stop hands in.
    const card = await deliveryOnce(api, agent, task)
    if (card) {
      state.craftSeen.delete(key)
      return api.notice(...card)
    }
    try {
      await api.handIn(agent, text.slice(0, 600))
      // The hand-in's cards were queued for a tool call that will not come this
      // turn. Written into the conversation now, without waking the model, so the
      // person sees 已交付 where the turn ended. A host without that write gets
      // them on the next step.
      for (const message of api.takeOutbox(agent)) {
        if (typeof agent.session?.append === 'function') agent.session.append('user/message', message, { surfaceOp: 'append' })
        else api.queueReceipt(agent, message)
      }
      return null
    } catch (error) {
      if (!(error instanceof GateError)) return null
      return api.notice(`dsh-auto-dev ${GATES[error.gate]}：${error.message}`, 'dsh-auto-dev 收尾', { form: 'notice' })
    }
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    try {
      if (signal?.aborted) return
      if (!agent?.session || typeof agent.steer !== 'function') return
      // Only the conversations that asked for Auto Dev, and not the ones v2 owns:
      // a notice about a pseudo call is only worth sending where a task exists.
      if (!api.optedIn(agent) || v2OwnsSession(agent)) return
      const message = guarded(agent, turn) ?? await settleAtStop(agent, turn)
      if (message) agent.steer(message)
    } catch {
      // A rescue that fails silently is still better than a turn that ends in an
      // error the person cannot connect to anything they did.
    }
  })

  // Human commands. These exist because a person who does not read code should
  // not have to type a prompt to see what is going on or to stop the work.
}

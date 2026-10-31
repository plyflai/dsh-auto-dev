/**
 * `/dsh-auto-dev`: the person's own entry point. A command talks to the host, not
 * to the model, so every branch either answers directly or opens a model turn
 * carrying the person's words.
 */
import { randomUUID } from 'node:crypto'
import { newestFirst } from './lookup.mjs'
import { handoffCard } from './craft.mjs'

// Verbs a person types after the command name. Anything else is a request:
// `/dsh-auto-dev 给 slug 加 trim` is how someone actually asks for work, and
// reading the first word as an unknown verb is what made the command look
// broken — it answered as "status" and nothing started.
export const COMMAND_VERBS = new Set(['start', 'new', 'status', 'tasks', 'adopt', 'organize', 'pause', 'resume', 'cancel', 'plan', 'help'])

export function registerCommand(ctx, {
  records, sessionState, sessionId, projectOf, planOf, activeTask, latestTask,
  optIn, unfinishedElsewhere, adoptTask, proposeOrganize, statusView,
  notice, queueReceipt, intake, grantStart,
}) {
  const brief = (value, max = 120) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  /**
   * Open a real model turn carrying the person's own words.
   *
   * A command is a message to the host, not to the model: without this the
   * request waits in an intake slot until the person types something else, which
   * is the bug a person reports as "the slash command did nothing". The message
   * rides `source.kind: 'user'` because the words are theirs, typed into this
   * command — that is what lets `work_start` and `work_extend` cite them later
   * instead of paraphrasing.
   * @param invocation - the command invocation that carried the words.
   * @param text - what to say in that turn.
   * @returns whether a turn was opened, and why not when it was not.
   */
  const openTurn = (invocation, text, attachments = []) => {
    const agent = invocation.agent
    if (typeof agent?.followup !== 'function') return { ok: false, reason: 'this host does not let a command open a turn' }
    // Pictures and files ride the same message: the person attached them to this
    // very gesture, and a command that quietly dropped them would be the same bug
    // as a command that quietly dropped the request.
    const content = [
      ...(Array.isArray(attachments) ? attachments : []),
      { type: 'text', text },
    ]
    try {
      agent.followup({ id: randomUUID(), role: 'user', content, source: { kind: 'user' } })
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
    return { ok: true }
  }

  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'dsh-auto-dev',
      description: 'Auto Dev: 开始一个任务 / 查看 / 暂停 / 继续 / 取消 / 接管别的会话留下的任务',
      // `attachments: true` is what lets the composer send a screenshot with the
      // request; without it the whole line is refused before it reaches us.
      input: { hint: '<用你自己的话说要做什么> | start | status | new | tasks | adopt [taskId] | pause | resume | cancel', attachments: true },
      handler: async invocation => {
        const agent = invocation.agent
        const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : []
        const raw = invocation.rawInput.trim()
        const head = raw.split(/\s+/)[0]?.toLowerCase() ?? ''
        const known = COMMAND_VERBS.has(head)
        const operation = known ? head : (raw ? 'start' : 'status')
        const rest = known ? raw.slice(raw.split(/\s+/)[0].length).trim() : raw
        if (operation === 'start' || operation === 'new') {
          if (!rest) return { kind: 'error', text: '用法：/dsh-auto-dev start <用你自己的话说这次要做什么>（这个项目还有没做完的活时会先接管它；一定要另开新任务用 /dsh-auto-dev new <需求>）' }
          // This is the opt-in, and it happens before anything else the command
          // does: the tools and the skill go into this conversation now, so the
          // turn opened below is a turn that can actually register the task.
          await optIn(agent)
          // Work already half done in this project is resumed, not duplicated. A
          // person who says "do this" after an interruption means "keep going", and
          // a second task laid over the first loses its plan, its notes and the
          // evidence window of the unit that was in flight.
          if (operation === 'start') {
            const waiting = unfinishedElsewhere(agent)
            if (waiting.length > 0) {
              const adopted = await adoptTask({ taskId: waiting[0].id }, agent)
              const resume = `继续 ${adopted.taskId}（${brief(adopted.request ?? '', 80)}）。用户这次说：「${rest}」。接手卡上是这个任务留下的事实；不要重新登记一个任务。`
              const opened = openTurn(invocation, resume, attachments)
              const where = adopted.from === sessionId(agent) ? '本会话' : '别的会话'
              // 人刚点了一下，得先有一行东西证明"交接发生了"，否则要等模型
              // 调完第一个工具才看得见。这行随下一次 pre-step 一起到。
              queueReceipt(agent, notice(...await handoffCard(records.get('tasks', adopted.taskId), { from: where })))
              if (opened.ok) return { kind: 'success', text: `这个项目有没做完的 ${adopted.taskId}（在${where}），已接管并交给模型继续：「${brief(rest)}」${attachments.length ? `，连同 ${attachments.length} 个附件` : ''}。要另开新任务用 /dsh-auto-dev new。` }
              intake.set(sessionId(agent), { kind: 'adopt', taskId: adopted.taskId, from: adopted.from, at: new Date().toISOString() })
              return { kind: 'success', text: `已接管 ${adopted.taskId}（在${where}），但没能直接开一轮（${opened.reason}）。发下一条消息，模型会先读进度再继续。` }
            }
          }
          // The words are the grant: work_start may be called only while this
          // fresh user-issued start is unspent.
          grantStart(agent, rest)
          // Hand the words to the model now. The intake slot stays the fallback:
          // a host that refuses to open a turn still delivers the request on the
          // person's next message instead of losing it.
          const opened = openTurn(invocation, rest, attachments)
          if (opened.ok) return { kind: 'success', text: `已交给模型：「${brief(rest)}」${attachments.length ? `，连同 ${attachments.length} 个附件` : ''}\n任务已登记，进度看 /dsh-auto-dev status。` }
          intake.set(sessionId(agent), { kind: 'start', text: rest, at: new Date().toISOString() })
          return { kind: 'success', text: `记下了，但没能直接开一轮（${opened.reason}）。发下一条消息（哪怕只说「开始」），模型就会按这段话开工。附件这次没能带过去，请在下一轮重新贴。` }
        }
        if (operation === 'tasks') {
          const project = projectOf(agent, ['.'])
          const rows = records.all('tasks', row => row.project === project)
            .sort(newestFirst(records)).slice(0, 10)
          if (!rows.length) return { kind: 'success', text: `这个项目（${project}）还没有任务记录。` }
          const lines = rows.map(row => {
            const units = planOf(row)?.units ?? []
            const leaves = units.filter(unit => !units.some(candidate => candidate.parent === unit.id))
            const here = row.sessionId === sessionId(agent) ? '本会话' : '别的会话'
            return `${row.state === 'active' ? '▶' : row.state === 'closed' ? '✓' : row.state === 'cancelled' ? '✕' : '⏸'} ${row.id}  ${row.mode}  ${here}  ${leaves.length ? `${leaves.filter(unit => unit.state === 'done').length}/${leaves.length}` : '单步'}  ${String(row.request ?? '').slice(0, 40)}`
          })
          return { kind: 'success', text: [`项目 ${project} 的任务：`, ...lines, '用 /dsh-auto-dev adopt <taskId> 接管其中一条。'].join('\n') }
        }
        if (operation === 'organize') {
          const task = activeTask(agent) ?? latestTask(agent)
          if (!task) return { kind: 'error', text: '这个会话还没有任务：先用 /dsh-auto-dev start <需求> 开一个。' }
          await optIn(agent)
          const proposal = await proposeOrganize(task, agent)
          if (!proposal) return { kind: 'error', text: '这个任务还没有计划，没东西可整理。' }
          const lines = [
            `日需 ${proposal.daily.length} 件${proposal.daily.length ? `：${proposal.daily.slice(0, 8).join(', ')}` : ''}`,
            `战役主题 ${proposal.themes.length} 个${proposal.themes.length ? `：${proposal.themes.map(theme => `${theme.label}(${theme.units.length})`).join('、')}` : ''}`,
          ]
          const opened = openTurn(invocation, `用户刚跑了 /dsh-auto-dev organize 体检。\n记录里现在是：${lines.join('；')}。\n请用 ask_user_question 问他：这份整理提案是否满意；不满意的话问他希望怎么整理（归组到哪个主题、哪些该拆开、哪个该改名）。他只说了「整理一下」不算同意。\n他点头后再按提案 ${proposal.id} 整理计划，只做他同意的那几步。`, attachments)
          const notice = `已生成整理提案 ${proposal.id}（只写记录，计划没动）。\n${lines.join('\n')}`
          if (opened.ok) return { kind: 'success', text: `${notice}\n已经交给模型：它会用提问卡问你满不满意，你点头后才会改。` }
          return { kind: 'success', text: `${notice}\n没能直接开一轮（${opened.reason}）；发下一条消息，模型会先看到这份提案。` }
        }
        if (operation === 'adopt') {
          // No id means "the one waiting", which is how a person says it out loud.
          const target = rest || unfinishedElsewhere(agent)[0]?.id
          if (!target) return { kind: 'error', text: '这个项目没有没做完的任务。用 /dsh-auto-dev tasks 看历史，或直接说一个新需求。' }
          // Adopting is starting work here, so it is also the opt-in.
          await optIn(agent)
          const adopted = await adoptTask({ taskId: target }, agent)
          if (!adopted.taskId) return { kind: 'error', text: adopted.tellUser }
          // Continuing is the whole point of adopting, so the turn starts here
          // instead of waiting for the person to say "go" a second time.
          const opened = openTurn(invocation, `继续 ${adopted.taskId}：「${brief(adopted.request ?? '', 80)}」。接手卡上是这个任务留下的事实。`, attachments)
          if (opened.ok) {
            // The person watched a task move between windows; that is a fact about
            // their work, not about the model's next tool call.
            if (adopted.adopted) {
              queueReceipt(agent, notice(...await handoffCard(records.get('tasks', adopted.taskId), { from: `会话 ${adopted.from ?? '另一处'}` })))
            }
            return { kind: 'success', text: adopted.adopted
              ? `已接管 ${adopted.taskId}（原来在 ${adopted.from}），模型会先读进度再继续。`
              : `任务 ${adopted.taskId} 本来就在这个会话里，已重新激活并让模型接着做。` }
          }
          intake.set(sessionId(agent), { kind: 'adopt', taskId: adopted.taskId, from: adopted.from, at: new Date().toISOString() })
          return { kind: 'success', text: adopted.adopted
            ? `已接管 ${adopted.taskId}（原来在 ${adopted.from}）。发下一条消息，模型会先读它的进度再继续。`
            : `任务 ${adopted.taskId} 本来就在这个会话里，已重新激活。` }
        }
        const task = activeTask(agent)
        if (!task) {
          const elsewhere = unfinishedElsewhere(agent)
          if (elsewhere.length) {
            return { kind: 'success', text: [
              '这个会话还没有任务，但这个项目有没做完的：',
              ...elsewhere.map(row => `▶ ${row.id}  ${row.mode}  ${row.progress ?? '单步'}  ${row.request}`),
              '说一句「继续」我来接管最近那条，或者 /dsh-auto-dev adopt <taskId>。',
            ].join('\n') }
          }
          return { kind: 'success', text: '还没有 Auto Dev 任务。直接说需求即可，或者用 /dsh-auto-dev start 写一句需求原话。' }
        }
        if (operation === 'pause' || operation === 'resume' || operation === 'cancel') {
          const nextState = { pause: 'paused', resume: 'active', cancel: 'cancelled' }[operation]
          const updated = await records.change('tasks', task.id, current => ({ ...current, state: nextState, updatedAt: new Date().toISOString() }))
          if (nextState === 'cancelled') sessionState(agent).taskId = undefined
          return { kind: 'success', text: `任务 ${task.id} 现在是 ${updated.state}。` }
        }
        if (operation === 'plan') {
          return { kind: 'success', text: '说一句「用 auto-dev 帮我做 X」就会开始；我也会在你说开发任务时提示模型先登记。' }
        }
        const plan = planOf(task)
        const status = statusView(task, plan)
        const lines = [
          `任务 ${task.id}（${status.task.effectiveMode}，${status.task.state}）`,
          `目标：${status.task.goal || status.task.request || '（未写）'}`,
          `进度：${status.progress.label}`,
          ...status.units.map(unit => `  ${unit.state === 'done' ? '✓' : unit.state === 'active' ? '▶' : '·'} ${unit.goal}`),
          ...(status.pending.lines.length ? [`待答：${status.pending.lines.join('；')}`] : []),
          status.lastLedger ? `最近：${status.lastLedger.summary}` : '还没有提交过结果',
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })
}

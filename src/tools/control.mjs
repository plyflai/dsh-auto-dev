import { CONSENT_ASK, consent, controlTransition, decisionSource } from '../decisions.mjs'
import { GateError } from '../gate.mjs'
import { rememberDomain } from '../domain.mjs'
import { recordTask } from '../task-record.mjs'
import { listCheckpoints, restoreCheckpoint } from '../checkpoint.mjs'
import { remember } from '../memory.mjs'
import { string } from './shared.mjs'

export const workControl = api => (
  // -------------------------------------------------------------- work_control
  ['work_control', `Control pause/resume/cancel/accept/rework; record optionally stores goal/receipt/clarify/learning (or entries); legacy adapters remain. remember writes engineering/domain knowledge; adopt/export/import/checkpoints/rollback are indexed in references/operations.md. Rollback overwrites tracked workspace files; exported executions are history, not portable proof; records are not consent.`, {
    taskId: string, operation: { type: 'string', enum: ['pause', 'resume', 'cancel', 'continue', 'adopt', 'export', 'import', 'checkpoints', 'rollback', 'remember', 'record', 'goal', 'receipt', 'clarify', 'postmortem', 'alternative', 'accept', 'rework', 'status'] }, reason: string, target: string, label: string, text: string, goal: string, assumption: string, sourceSeq: { type: 'integer' },
    asked: { type: 'array', items: { type: 'object', additionalProperties: true } },
    answers: { type: 'array', items: { type: 'object', additionalProperties: true } },
    payload: { type: 'object', additionalProperties: true },
    entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
    why: string, verdict: string, quote: string,
  }, ['operation'],
  async (args, exec) => {
    const state = api.sessionState(exec.agent)
    // Import is the one operation that runs before there is a task here: it is
    // how a task arrives from another machine in the first place.
    if (args.operation === 'import') return api.importSnapshot(args, exec.agent)
    // Adopt names a task that is not this session's yet, so it resolves from the
    // taskId alone — the same reason import gets to run before there is a task.
    if (args.operation === 'adopt') return api.adoptTask(args, exec.agent)
    const task = api.requireTask(api.activeTask(exec.agent) ?? api.latestTask(exec.agent), args.taskId)
    if (!task) return api.noTask(exec.agent)
    if (args.operation === 'export') return api.exportSnapshot(task, api.observationsOf(exec.agent))
    // A one-call read of where the task stands, for hosts that want the shape
    // without the board's rendering fields.
    if (args.operation === 'status') {
      const status = api.statusView(task, api.planOf(task))
      return { ...status, unitRows: status.units, taskId: task.id, state: status.task.state,
        mode: status.task.mode, effectiveMode: status.task.effectiveMode, acceptanceMode: status.task.acceptanceMode,
        units: status.progress.total, nextUnit: status.current,
        receipt: status.task.hasReceipt, clarify: Boolean(task.clarify), review: task.review ?? null }

    }
    if (args.operation === 'accept' || args.operation === 'rework') {
      const previous = args.operation === 'accept' ? task.accepted : task.rework
      if ((args.operation === 'accept' ? task.state === 'closed' : task.state === 'active') && previous?.source && (previous.quote ?? previous.note) === args.text?.trim()) {
        return { taskId: task.id, state: task.state, unchanged: true }
      }
      if (task.state !== 'review_ready') {
        return { taskId: task.id, state: task.state, unchanged: true, tellUser: '现在没有在等用户验收的交付，什么都没动。' }
      }
      // The person's own reply after the hand-in is the decision; the model's text is not.
      const source = decisionSource({ agent: exec.agent, task, after: task.review?.atSeq ?? 0, subject: task.id })
      if (!source) return { taskId: task.id, state: task.state, unchanged: true, tellUser: '用户还没回话：等他看过再说。' }
      const quote = source.quote
      const now = new Date().toISOString()
      if (args.operation === 'accept') {
        const updated = await api.records.change('tasks', task.id, current => ({
          ...current,
          state: 'closed',
          accepted: { at: now, by: 'person', quote, source, atSeq: api.seq(exec.agent) },
          updatedAt: now,
        }))
        api.queueNotice(exec.agent,
          `**收案 · ${updated.id}** — 这一版收下了`,
          'dsh-auto-dev review done',
          { form: 'review-done', data: { unit: updated.id, title: '已收案', line: quote || '这一版收下了', tag: '已收', tone: 'done' } })
        return { taskId: updated.id, state: updated.state, accepted: updated.accepted, tellUser: '告诉用户这一版收下了；下次要继续就开新任务。' }
      }
      const updated = await api.records.change('tasks', task.id, current => ({
        ...current,
        state: 'active',
        review: undefined,
        rework: { at: now, note: quote, source, atSeq: api.seq(exec.agent) },
        updatedAt: now,
      }))
      const plan = api.planOf(task)
      if (plan) await api.records.change('plans', plan.id, current => ({ ...current,
        units: current.units.map(row => row.state === 'done' ? { ...row, state: 'pending', startedSeq: api.seq(exec.agent) } : row), updatedAt: now }))
      await api.records.change('tasks', task.id, current => ({ ...current, startedSeq: api.seq(exec.agent) }))
      api.queueNotice(exec.agent,
        `**退回 · ${updated.id}** — ${quote || '按意见改'}`,
        'dsh-auto-dev review revise',
        { form: 'review-revise', data: { unit: updated.id, title: '按意见改', line: quote || '按意见改', tag: '继续修改', tone: 'neutral' } })
      return { taskId: updated.id, state: updated.state, rework: updated.rework, tellUser: '问清是哪里不对，改完再交一次。' }
    }
    if (['record', 'goal', 'receipt', 'clarify', 'alternative', 'postmortem'].includes(args.operation)) return recordTask(api, task, args, exec)
    if (args.operation === 'remember') {
      // The lesson goes next to the project, not into this host's ledger: it has
      // to survive a reinstall, a machine change and a different assistant.
      if (args.target === 'domain') {
        const payload = args.payload ?? {}
        const stored = rememberDomain(task.project, {
          kind: payload.kind ?? 'term', key: payload.key ?? '', text: payload.text ?? '',
          quote: payload.quote ?? '', session: api.sessionId(exec.agent) ?? 'this session',
        })
        api.queueNotice(exec.agent,
          `**记住** — ${String(payload.text ?? payload.key ?? '').trim().slice(0, 40)}`,
          'dsh-auto-dev remember',
          { form: 'remember', data: { unit: task.id, title: '记住', line: String(payload.text ?? payload.key ?? '').trim().slice(0, 40), tag: '1 条', tone: 'info' } })
        return { taskId: task.id, ...stored, tellUser: '把这条业务事实给用户看一眼（一行），他改口就用同一句再记一次。' }
      }
      // `text` alone is a fact: v16 wrote {operation:'remember', text} after the
      // perf card asked for one and got "an incident needs a symptom".
      if (!args.payload && typeof args.text === 'string') args = { ...args, payload: { kind: 'fact', text: args.text } }
      const stored = remember(task.project, args.payload ?? {}, { taskId: task.id, session: api.sessionId(exec.agent) })
      api.queueNotice(exec.agent,
        `**记住** — ${String(args.payload?.symptom ?? args.payload?.text ?? args.payload?.key ?? '').trim().slice(0, 40)}`,
        'dsh-auto-dev remember',
        { form: 'remember', data: { unit: task.id, title: '记住', line: String(args.payload?.symptom ?? args.payload?.text ?? args.payload?.key ?? '').trim().slice(0, 40), tag: '1 条', tone: 'info' } })
      return { taskId: task.id, ...stored }
    }
    if (args.operation === 'checkpoints') {
      const listed = await listCheckpoints(task.project, api.slugOf(task))
      return { taskId: task.id, recorded: api.checkpointView(task), refs: listed }
    }
    if (args.operation === 'rollback') {
      // Restoring overwrites whatever a person typed since the checkpoint, so
      // it needs the owner's own words on file — the same rule every other
      // irreversible action follows.
      const rows = [...(task.checkpoints ?? [])]
      const target = typeof args.target === 'string' && args.target !== '' ? args.target : 'latest'
      // A label is the human name of a before/after pair ("B6 收尾"): the model proposes
      // it when it saves, a person can say it back without quoting a ref.
      const label = typeof args.label === 'string' ? args.label.trim() : ''
      const pick = label !== ''
        ? [...rows].reverse().find(row => row.label === label)
        : target === 'latest' ? rows[rows.length - 1]
          : target === 'before' ? [...rows].reverse().find(row => row.tag === 'before')
            : rows.find(row => row.ref === target || row.commit === target)
      if (!pick) return { taskId: task.id, restored: false, checkpoints: rows.map(row => ({ ref: row.ref ?? row.commit, label: row.label, tag: row.tag })), tellUser: rows.length ? `没有「${label || target}」这个存档点，现有的列在 checkpoints 里。` : '这个任务还没有存档点，没法回滚。' }
      const action = `rollback ${pick.ref ?? pick.commit}`
      // G2: a rollback overwrites work that was never committed. Asked once, then the person's reply decides.
      const asked = task.auto ? { granted: false } : consent(api.sessionState(exec.agent), exec.agent, task, 'rollback', api.seq(exec.agent))
      if (!asked.granted) {
        throw new GateError('G2', `回滚会覆盖还没提交的改动（${action}）`, task.auto
          ? '自动驾驶开着，不替用户丢改动：换一个不丢改动的做法，交付时把回滚列为「等你决定」'
          : `${CONSENT_ASK}「要回到 ${pick.label || pick.ref || pick.commit} 吗？没提交的改动会丢」；他选「同意」再回滚，选「不同意」就换一个不丢改动的做法`)
      }
      const restored = await restoreCheckpoint(task.project, pick.commit)
      if (!restored.ok) return { taskId: task.id, restored: false, reason: restored.reason, tellUser: `回滚没成：${restored.reason}` }
      await api.records.change('tasks', task.id, current => ({
        ...current, updatedAt: new Date().toISOString(),
        stateReason: `rolled back to ${pick.ref}`,
      }))
      return { taskId: task.id, restored: true, from: pick.ref ?? pick.commit, changedFiles: restored.restored }
    }
    const transition = controlTransition(task.state, args.operation)
    const next = transition.state
    if (!transition.changed) return { taskId: task.id, state: task.state, unchanged: true, ...(transition.answer ? { tellUser: transition.answer } : {}) }
    const updated = await api.records.change('tasks', task.id, current => ({
      ...current, state: next, updatedAt: new Date().toISOString(),
      ...(args.reason ? { stateReason: args.reason } : {}),
    }))
    if (next === 'cancelled' && state.taskId === task.id) state.taskId = undefined
    return { taskId: updated.id, state: updated.state }
  }]
)

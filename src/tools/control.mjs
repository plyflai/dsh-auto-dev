import { controlTransition, decisionSource, grantsAction } from '../decisions.mjs'
import { rememberDomain } from '../domain.mjs'
import { recordTask } from '../task-record.mjs'
import { listCheckpoints, restoreCheckpoint } from '../checkpoint.mjs'
import { remember } from '../memory.mjs'
import { string } from './shared.mjs'

export const workControl = api => (
  // -------------------------------------------------------------- work_control
  ['work_control', `Control pause/resume/cancel/accept/rework; record optionally stores goal/receipt/clarify/alternative/learning (or entries); legacy adapters remain. remember writes engineering/domain knowledge; adopt/export/import/checkpoints/rollback are indexed in references/operations.md. Rollback overwrites tracked workspace files; exported executions are history, not portable proof; records are not consent.`, {
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
    const task = args.taskId ? api.requireTask(undefined, args.taskId, { agent: exec.agent }) : (api.activeTask(exec.agent) ?? api.latestTask(exec.agent))
    if (!task) throw new Error('no task in this session: call work_start first')
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
        throw new Error(`only a task parked for review can be accepted or sent back; this one is ${task.state ?? 'unknown'}`)
      }
      const quote = typeof args.text === 'string' ? args.text.trim() : ''
      const source = decisionSource({ agent: exec.agent, task, quote, after: task.review?.atSeq ?? api.seq(exec.agent), subject: task.id, intent: args.operation })
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
          'auto-dev-v3 review done',
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
        'auto-dev-v3 review revise',
        { form: 'review-revise', data: { unit: updated.id, title: '按意见改', line: quote || '按意见改', tag: '继续修改', tone: 'neutral' } })
      return { taskId: updated.id, state: updated.state, rework: updated.rework, tellUser: '问清是哪里不对，改完再 work_submit 一次。' }
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
          'auto-dev-v3 remember',
          { form: 'remember', data: { unit: task.id, title: '记住', line: String(payload.text ?? payload.key ?? '').trim().slice(0, 40), tag: '1 条', tone: 'info' } })
        return { taskId: task.id, ...stored, tellUser: '把这条业务事实给用户看一眼（一行），他改口就用同一句再记一次。' }
      }
      const stored = remember(task.project, args.payload ?? {}, { taskId: task.id, session: api.sessionId(exec.agent) })
      api.queueNotice(exec.agent,
        `**记住** — ${String(args.payload?.symptom ?? args.payload?.text ?? args.payload?.key ?? '').trim().slice(0, 40)}`,
        'auto-dev-v3 remember',
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
      if (!pick) throw new Error(`this task has no checkpoint matching "${target}" — call work_control operation "checkpoints" to see what exists`)
      const action = `rollback ${pick.ref ?? pick.commit}`
      if (!grantsAction(task, 'rollback', action, { agent: exec.agent })) throw new Error(`rollback overwrites uncommitted work: use work_extend kind="authorization", risk="rollback", action="${action}" with the owner's exact answer before restoring`)
      const restored = await restoreCheckpoint(task.project, pick.commit)
      if (!restored.ok) throw new Error(restored.reason)
      await api.records.change('tasks', task.id, current => ({
        ...current, updatedAt: new Date().toISOString(),
        stateReason: `rolled back to ${pick.ref}`,
      }))
      return { taskId: task.id, restored: true, from: pick.ref ?? pick.commit, changedFiles: restored.restored }
    }
    const transition = controlTransition(task.state, args.operation)
    const next = transition.state
    if (!transition.changed) return { taskId: task.id, state: task.state, unchanged: true }
    const updated = await api.records.change('tasks', task.id, current => ({
      ...current, state: next, updatedAt: new Date().toISOString(),
      ...(args.reason ? { stateReason: args.reason } : {}),
    }))
    if (next === 'cancelled' && state.taskId === task.id) state.taskId = undefined
    return { taskId: updated.id, state: updated.state }
  }]
)

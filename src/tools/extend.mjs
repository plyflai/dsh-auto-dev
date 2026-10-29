import { decisionSource } from '../decisions.mjs'
import { text } from '../task.mjs'
import { string } from './shared.mjs'

export const workExtend = api => (
  // --------------------------------------------------------------- work_extend
  ['work_extend', `Request or record a task-scoped decision with kind + reason + exact action; authorization quotes a current real user message or option. Authorization risk must match the refusal; a grant covers only that action and cannot override an environment prohibition. Capability/policy requests retain their existing meaning.`, {
    taskId: string, kind: { type: 'string', enum: ['authorization', 'capability', 'policy'] },
    risk: string, action: string, reason: string, proposal: string, authorization: string,
  }, ['kind', 'reason'],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent), args.taskId, { allowMissing: true, agent: exec.agent })
    const state = api.sessionState(exec.agent)
    const kind = args.kind
    const reason = text(args.reason, 'reason', { max: 2000 })
    if (!task) throw new Error('no task in this session: call work_start before asking for a decision')
    if (typeof args.authorization === 'string' && args.authorization.trim() !== '') {
      const quote = args.authorization.trim()
      const request = task.decisionRequest
      const action = typeof args.action === 'string' ? args.action.trim() : request?.action
      if (!action) throw new Error('work_extend needs action: the exact command/action being authorized')
      const pending = request?.kind === kind && request?.risk === args.risk && request?.action === action
      const source = decisionSource({ agent: exec.agent, task, quote, after: pending ? request.atSeq : task.startedSeq - 1, subject: action, intent: 'grant', allowShort: pending })
      if (!pending && !source.quote.includes(action)) throw new Error('without a pending request, the user answer must name the concrete action; ask work_extend first if the answer is ambiguous')
      const decision = {
        id: api.newId('decision'), version: 1, project: task.project, taskId: task.id,
        kind, ...(args.risk ? { risk: args.risk } : {}), reason,
        authorization: quote, granted: true, action, source, atSeq: api.seq(exec.agent), via: source.via, at: new Date().toISOString(),
      }
      await api.records.change('decisions', decision.id, () => decision)
      await api.records.change('tasks', task.id, current => ({
        ...current, decisionRequest: undefined, decisions: [...(current.decisions ?? []), { id: decision.id, kind, risk: args.risk, granted: true, action, source, atSeq: decision.atSeq, at: decision.at }], updatedAt: decision.at,
      }))
      return { granted: true, decisionId: decision.id, kind, risk: args.risk }
    }
    const action = text(args.action ?? args.proposal ?? reason, 'action', { max: 2000 })
    await api.records.change('tasks', task.id, current => ({ ...current,
      decisionRequest: { kind, risk: args.risk, action, atSeq: api.seq(exec.agent) }, updatedAt: new Date().toISOString() }))
    return {
      granted: false, kind, reason, action,
      question: kind === 'authorization'
        ? `这件事会带来不可逆的后果（${args.risk ?? '不可逆动作'}），需要您确认是否允许。动作：${action}。理由：${reason}`
        : kind === 'capability'
          ? `当前这个任务缺一个能力：${args.proposal ?? reason}。是否允许我去接入并使用它？`
          : `这条任务需要放宽一项检查：${reason}。是否允许？`,
      next: 'put that question to the user, then call work_extend again with authorization = their exact answer',
    }
  }]
)

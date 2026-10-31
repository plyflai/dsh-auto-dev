import { text } from '../task.mjs'
import { string } from './shared.mjs'

export const workExtend = api => (
  // --------------------------------------------------------------- work_extend
  // Nothing here grants anything. An irreversible action is decided by the person's
  // reply after the plugin stopped it once (G2); this tool only puts a need for a new
  // capability or a looser check on the record, and says what to ask.
  ['work_extend', `Record that this task needs a capability or a looser check, and get the question to ask the user. Irreversible actions need no call here: the plugin stops the first one, you ask the user, and their reply decides.`, {
    taskId: string, kind: { type: 'string', enum: ['authorization', 'capability', 'policy'] },
    risk: string, action: string, reason: string, proposal: string, authorization: string,
  }, [],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent), args.taskId)
    if (!task) return api.noTask(exec.agent)
    const kind = ['authorization', 'capability', 'policy'].includes(args.kind) ? args.kind : 'capability'
    const reason = text(args.reason, 2000)
    const action = text(args.action ?? args.proposal ?? reason, 2000)
    if (kind === 'authorization') {
      return { granted: false, kind, action,
        tellUser: `直接问用户：「要${action ? `执行 ${action.slice(0, 120)}` : '做这一步'}吗？${reason ? `（${reason.slice(0, 120)}）` : ''}」他回了同意，再跑就会放行。` }
    }
    await api.records.change('tasks', task.id, current => ({ ...current,
      decisionRequest: { kind, action, atSeq: api.seq(exec.agent) }, updatedAt: new Date().toISOString() }))
    return {
      granted: false, kind, reason, action,
      tellUser: kind === 'capability'
        ? `问用户：当前这个任务缺一个能力：${action || reason}。要不要接入并使用它？`
        : `问用户：这条任务需要放宽一项检查：${reason || action}。可以吗？`,
    }
  }]
)

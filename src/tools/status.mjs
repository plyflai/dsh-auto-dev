import { newestFirst } from '../lookup.mjs'
import { executionSummary } from '../session-log.mjs'
import { string } from './shared.mjs'

export const workStatus = api => (
  // --------------------------------------------------------------- work_status
  ['work_status', `Canonical read: summary (default), executions (actual callIds and results), board (human panel facts), tasks (project history). Match a claim to the executed check; status/projection data is not execution evidence. Old control status and slash status adapt these facts.`, {
    taskId: string, view: { type: 'string', enum: ['summary', 'executions', 'board', 'tasks'] }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  }, [],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent) ?? api.latestTask(exec.agent), args.taskId)
    const view = args.view ?? 'summary'
    const limit = args.limit ?? 20
    if (view === 'executions') {
      const observations = api.observationsOf(exec.agent)
      const rows = observations.results.slice(-limit).reverse().map(row => executionSummary(row))
      return { sessionId: observations.sessionId, total: observations.results.length, executions: rows }
    }
    if (view === 'tasks') {
      // The ledger is one KV shared by every session on this host, so a task
      // another session started is already here — it just has no handle in this
      // conversation. This view is the handle.
      const project = api.projectOf(exec.agent, ['.'])
      const rows = api.records.all('tasks', row => row.project === project)
        .sort(newestFirst(api.records))
        .slice(0, limit)
        .map(row => {
          const units = api.planOf(row)?.units ?? []
          const leaves = units.filter(unit => !units.some(candidate => candidate.parent === unit.id))
          const last = (row.ledger ?? []).slice(-1)[0]
          return {
            taskId: row.id, state: row.state, mode: row.mode, here: row.sessionId === api.sessionId(exec.agent),
            request: String(row.request ?? '').slice(0, 120),
            units: leaves.length ? `${leaves.filter(unit => unit.state === 'done').length}/${leaves.length}` : undefined,
            updatedAt: row.updatedAt,
            ...(last ? { last: { outcome: last.outcome, summary: String(last.summary ?? '').slice(0, 140) } } : {}),
          }
        })
      return {
        project, tasks: rows,
        hint: 'work_control operation "adopt" continues one of these in this session; "import" is the path for a task from another machine',
      }
    }
    const readable = task ?? api.watchedTask?.(exec.agent)
    if (!readable) return { task: null, hint: "no task in this session yet: call work_start with the user's own words" }
    const plan = api.planOf(readable)
    const status = api.statusView(readable, plan)
    const value = view === 'board' ? api.boardView(readable, plan, api.records.all('decisions', row => row.taskId === readable.id))
      : { ...status, ledger: status.ledger.slice(-limit) }
    return task ? value : { ...value, readOnly: true,
      hint: `task ${readable.id} is held by ${readable.sessionId ?? 'another session'}: read it here; use work_control adopt to work on it.` }

  }]
)

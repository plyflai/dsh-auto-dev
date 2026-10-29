/**
 * Which task a conversation is looking at.
 *
 * Every question here is a read of the shared records keyed by session: the one
 * this session may change, the one it last worked on, the one it just parked, and
 * the one its panel shows. None of them writes a record; the only state they touch
 * is the per-session `taskId` cache.
 */

/**
 * Newest first, as a comparator over one table. Two writes in the same millisecond
 * share an `updatedAt`, and the table order then decided which task a person got:
 * the row this process wrote last wins the tie, and after a restart the id does —
 * ids are issued in creation order (see `newId`).
 */
export const newestFirst = (records, table = 'tasks') => (a, b) =>
  String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? ''))
  || (records?.written?.(table, b?.id) ?? 0) - (records?.written?.(table, a?.id) ?? 0)
  || String(b?.id ?? '').localeCompare(String(a?.id ?? ''))

/**
 * Every session that has held a task, oldest first.
 *
 * `sessionId` is the one holding it now and nothing more. When the work is
 * handed on, the earlier conversation is still where the earlier half was done,
 * and the person who left it open expects that window to keep showing what it
 * was working on. The record is host-wide, so this list is all it takes.
 */
export const heldSessions = (task, extra) => [...new Set([
  ...(Array.isArray(task?.sessions) ? task.sessions : []),
  task?.sessionId, extra,
].filter(value => typeof value === 'string' && value !== ''))]

/**
 * @param deps.records - the open record store.
 * @param deps.sessionState - per-conversation in-memory state.
 * @param deps.sessionId - the session id of an agent.
 */
export function createLookup({ records, sessionState, sessionId }) {
  // A task this conversation watched but no longer holds: after a hand-off the
  // old window keeps seeing the board, yet its tools see "no task". Say which
  // task that is instead of telling the model to start a fresh one.
  const watchedTask = agent => {
    const sid = sessionId(agent)
    if (typeof sid !== 'string' || sid === '') return undefined
    const task = records.peek('tasks')
      .filter(task => task.state !== 'cancelled' && task.sessionId !== sid && heldSessions(task).includes(sid))
      .sort(newestFirst(records))[0]
    return task && structuredClone(task)
  }

  const activeTask = agent => {
    const state = sessionState(agent)
    if (state.taskId) {
      const task = records.get('tasks', state.taskId)
      // The cache can name a task this conversation handed over: the record says
      // which session holds it, and a stale id would let the old window keep
      // submitting into work somebody else is doing.
      if (task && task.sessionId === sessionId(agent) && task.state !== 'cancelled' && task.state !== 'closed') return task
      state.taskId = undefined
    }
    // Filter the shared rows and clone only the one handed out: this runs on every
    // hook, and the whole table grows with the project, not with the call.
    const mine = sessionId(agent)
    const candidate = records.peek('tasks')
      .filter(task => task.sessionId === mine && ['active', 'paused'].includes(task.state))
      .sort(newestFirst(records))[0]
    if (candidate) { state.taskId = candidate.id; return structuredClone(candidate) }
    return undefined
  }
  /**
   * The most recent task this session worked on, closed or not.
   *
   * `activeTask` answers "may this session change code right now?" and must stop at
   * a closed task. Reading the state and asking what happened are different
   * questions: after a submission closes a task, a taskId-less `work_status` or
   * `work_plan list` still has to say which task that was, and "call work_start
   * first" when a task is sitting there closed is simply a lie (found by the
   * smoke run of the shipping build).
   */
  /**
   * The task this conversation just parked, cancelled included.
   *
   * `latestTask` treats a cancelled task as gone, which is right for "carry on":
   * you cannot resume it. It is wrong for "this one ended badly" — a cancelled
   * task still owes the next task a postmortem, and the failure is in its ledger,
   * not in the conversation.
   */
  const stoppedTask = agent => {
    const mine = sessionId(agent)
    // `peek` is the cheap read; a host without it (the test stub) still works.
    const all = typeof records.peek === 'function' ? records.peek('tasks') : records.all('tasks')
    const rows = all
      .filter(task => task.state === 'closed' || task.state === 'cancelled')
      .filter(task => task.sessionId === mine || heldSessions(task).includes(mine))
      .sort(newestFirst(records))
    return rows[0]
  }
  const latestTask = agent => {
    const state = sessionState(agent)
    if (state.taskId) {
      const task = records.get('tasks', state.taskId)
      if (task && task.state !== 'cancelled') return task
    }
    const rows = records.all('tasks', task => task.sessionId === sessionId(agent) && task.state !== 'cancelled')
      .sort(newestFirst(records))
    if (rows.length) { state.taskId = rows[0].id; return rows[0] }
    return undefined
  }
  const planOf = task => (task?.planId ? records.get('plans', task.planId) : undefined)

  /**
   * The task a session is showing, whoever holds it now.
   *
   * A running task wins over a paused one, the newest over the older, and a
   * cancelled one is never shown. Membership (not ownership) is the test: the
   * session that started the work keeps its board after the work moved on.
   */
  const taskForSession = sid => {
    if (typeof sid !== 'string' || sid === '') return undefined
    const rank = task => (task.state === 'active' ? 0 : task.state === 'paused' ? 1 : 2)
    // `peek`, not `all`: the projection asks this on every view, and cloning the
    // whole task table per render is work nobody sees the result of.
    const rows = records.peek('tasks')
      .filter(task => task.state !== 'cancelled')
      .filter(task => task.sessionId === sid || heldSessions(task).includes(sid))
      .sort((a, b) => rank(a) - rank(b) || newestFirst(records)(a, b))
    const task = rows[0]
    if (!task) return undefined
    const plan = task.planId ? records.peekOne('plans', task.planId) : undefined
    return { task, ...(plan ? { plan } : {}) }
  }

  // The project's history, newest first. A board answers "what is this task"; the
  // timeline answers "what has this project been through", which is the question a
  // person asks when a new task replaces the panel they were reading. It carries
  // only what a collapsed row needs plus the units an expanded one draws — the full
  // board of a past task is built from the same record when it is opened.
  const timelineForProject = (project, currentId) => {
    if (typeof project !== 'string' || project === '') return []
    const rows = records.peek('tasks')
      .filter(task => task && task.project === project && task.state !== 'cancelled')
      // The current task pins to the top whatever the clock says: it is the one the
      // panel is about, and two tasks started in the same second must not swap places
      // between reads.
      .sort((a, b) => (a.id === currentId ? -1 : 0) - (b.id === currentId ? -1 : 0)
        || newestFirst(records)(a, b))
    const boundId = currentId
    return rows.map(task => {
      const plan = task.planId ? records.peekOne('plans', task.planId) : undefined
      const units = Array.isArray(plan?.units) ? plan.units : []
      const themes = new Set(units.filter(unit => typeof unit?.parent === 'string' && unit.parent !== '').map(unit => unit.parent))
      return {
        id: task.id,
        at: task.createdAt ?? task.updatedAt ?? null,
        updatedAt: task.updatedAt ?? null,
        state: task.state ?? null,
        mode: task.mode ?? null,
        goal: (typeof task.goal === 'string' && task.goal.trim() !== '' ? task.goal.trim() : '') || (task.request ?? '') || '',
        current: task.id === boundId,
        themes: themes.size,
        marks: Array.isArray(task.checkpoints) ? task.checkpoints.length : 0,
        // One line per unit is all an expanded past row shows; the goal text is the
        // same sentence the board would print, so nothing is reworded for history.
        units: units.map(unit => ({
          id: unit.id, goal: unit.goal, state: unit.state ?? 'pending',
          ...(unit.parent ? { parent: unit.parent } : {}),
          ...(unit.deliverable ? { deliverable: unit.deliverable } : {}),
        })),
      }
    })
  }

  const timelineForSession = sid => {
    const bound = taskForSession(sid)
    return timelineForProject(bound?.task?.project, bound?.task?.id)
  }

  return { watchedTask, activeTask, stoppedTask, latestTask, planOf, taskForSession, timelineForProject, timelineForSession }
}

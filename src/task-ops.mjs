/**
 * Everything that writes a task or its plan: snapshots, hand-offs between
 * sessions, export and import, and plan replacement. Each operation reads the
 * record it changes again after writing, so callers never see a stale copy.
 */
import { createTaskRecord, MODES, text } from './task.mjs'
import { executionSummary } from './session-log.mjs'
import { leafUnits, normalizeUnits } from './plan.mjs'
import { captureCheckpoint, retireCheckpoints, rotateCheckpoints } from './checkpoint.mjs'
import { heldSessions, newestFirst } from './lookup.mjs'

export function createTaskOps({ records, settings, sessionState, sessionId, seq, projectOf, planOf, latestTask, planView, checkpointView }) {
  /**
   * Record a review of the plan for a person to approve.
   *
   * The host writes down what it saw — the bucket, the themes, the untouched rows —
   * so "yes, go ahead" has something exact to apply to. It never edits the plan
   * itself: arranging work is the model's job, and only after the person answered.
   * @param task - the task whose plan is being reviewed.
   * @param agent - the conversation that triggered the review.
   * @returns the recorded proposal.
   */
  const proposeOrganize = async (task, agent) => {
    const plan = planOf(task)
    if (!plan) return null
    const rows = plan.units ?? []
    const daily = rows.filter(row => row.parent === 'daily').map(row => row.id)
    const themes = rows
      .filter(row => rows.some(other => other.parent === row.id) && row.id !== 'daily')
      .map(row => ({ id: row.id, label: row.goal, units: rows.filter(other => other.parent === row.id).map(other => other.id) }))
    const at = new Date().toISOString()
    const proposal = { id: newId('proposal'), at, atSeq: seq(agent), daily, themes }
    await records.change('plans', plan.id, current => ({ ...current, proposal, updatedAt: at }))
    return proposal
  }

  const slugOf = task => String(task.id ?? 'task').replace(/^task-/, '')
  /**
   * Snapshot the working tree before and after a span. A checkpoint is an
   * affordance, not a promise: a directory that is not a repository, a repo
   * with no commits, or a clean tree simply records why it could not snapshot.
   */
  const snapshot = async (task, tag, meta = {}) => {
    // The background copies are told apart by their tag: `auto` is what rotates,
    // the before/after pair of a promised unit is what a person asked to keep.
    if (meta.auto === true) tag = 'auto'
    // Honour the setting: someone who turned checkpoints off should not find
    // refs in their repository anyway.
    if (settings().checkpoints === false) {
      return { snapshot: 'skipped', reason: 'checkpoints are disabled in the dsh-auto-dev settings' }
    }
    const seq = (task.checkpoints ?? []).length + 1
    const captured = await captureCheckpoint(task.project, { slug: slugOf(task), tag, seq, ...(meta.commit ? { commit: meta.commit } : {}) })
    const at = new Date().toISOString()
    if (!captured.ok) {
      await records.change('tasks', task.id, current => ({ ...current, checkpointSkipped: captured.skipped, updatedAt: at }))
      return { snapshot: 'skipped', reason: captured.skipped, ...(captured.untracked ? { untracked: captured.untracked } : {}) }
    }
    // A checkpoint is a pair around something demonstrable, or a background copy
    // that rotates. The labels ride on the record so the panel can name the pair
    // without asking git what it was for.
    const entry = {
      ref: captured.ref, commit: captured.commit, tag, seq, at: captured.at,
      ...(meta.unit ? { unit: meta.unit } : {}),
      ...(meta.label ? { label: meta.label } : {}),
      ...(meta.outcome ? { outcome: meta.outcome } : {}),
    }
    await records.change('tasks', task.id, current => ({
      ...current,
      checkpoints: [...(current.checkpoints ?? []), entry],
      checkpointSkipped: undefined,
      updatedAt: at,
    }))
    if (tag === 'auto') {
      // Rotation is housekeeping: losing the race just means one extra ref stays
      // one more round, which is not worth failing a submit over.
      try { await rotateCheckpoints(task.project, slugOf(task), 5) } catch { /* the refs are still usable */ }
    }
    // Older tasks' saves retire once this one has its own (大原则 8).
    try { await retireCheckpoints(task.project, { current: slugOf(task) }) } catch { /* housekeeping */ }
    return { snapshot: 'captured', ref: captured.ref, commit: captured.commit, seq }
  }
  // Ids order by creation: the time part never repeats inside this process, so two
  // records made in the same millisecond still sort the way they were made, and
  // `newestFirst` can still break an `updatedAt` tie after a restart.
  let lastIdAt = 0
  const newId = prefix => {
    lastIdAt = Math.max(Date.now(), lastIdAt + 1)
    return `${prefix}-${lastIdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * A task that leaves this machine. Executions are summarised by what the host
   * watched (name, command, exit code); the callId coordinates stay host-local
   * and are exported as history, never as proof — another machine cannot resolve
   * them, and pretending it could is exactly the failure this format avoids.
   */
  function exportSnapshot(task, observations) {
    const plan = planOf(task)
    return {
      format: 'dsh-auto-dev/export@1',
      exportedAt: new Date().toISOString(),
      task: {
        id: task.id, project: task.project, mode: task.mode, state: task.state,
        request: task.request, goal: task.goal, scope: task.scope,
        acceptance: task.acceptance ?? [], deliverable: task.deliverable,
        // parent/depth 跟着走：导出再导入，主题（容器）必须还是容器，否则
        // 一个没有 scope 的容器会在导入时被当成叶子，整份计划被拒。
        units: (plan?.units ?? []).map(unit => ({
          id: unit.id, goal: unit.goal, scope: unit.scope, acceptance: unit.acceptance,
          dependsOn: unit.dependsOn, state: unit.state,
          ...(unit.deliverable ? { deliverable: unit.deliverable } : {}),
          ...(unit.kind ? { kind: unit.kind } : {}),
          ...(unit.parent ? { parent: unit.parent, depth: unit.depth } : {}),
          ...(unit.role ? { role: unit.role } : {}),
          ...(unit.ui ? { ui: unit.ui } : {}),
        })),
        ledger: (task.ledger ?? []).map(entry => ({
          unit: entry.unit, outcome: entry.outcome, summary: entry.summary, at: entry.at,
          claims: (entry.claims ?? []).map(claim => ({
            statement: claim.statement,
            execution: claim.execution ? { name: claim.execution.name, command: claim.execution.command, exitCode: claim.execution.exitCode } : undefined,
          })),
        })),
        decisions: (task.decisions ?? []).map(decision => ({ kind: decision.kind, risk: decision.risk, reason: decision.reason, granted: decision.granted })),
        // Snapshots travel as coordinates, not content: `git stash create` objects
        // live in this repository. Another machine may not have them, and restore
        // says so plainly instead of pretending.
        checkpoints: (task.checkpoints ?? []).map(({ ref, commit, tag, at }) => ({ ref, commit, tag, at })),
      },
      executions: (observations?.results ?? []).map(row => executionSummary(row)),
      note: 'execution callIds are host-local history; on another machine they identify nothing — re-run the checks there before claiming them',
    }
  }

  /**
   * Bring a task in from another machine. Nothing arrives verified: units land
   * pending, prior claims are kept as history and marked as not verified here, so
   * the task cannot be closed on the strength of somebody else's run.
   */
  async function importSnapshot(args, agent) {
    const payload = args.payload
    // Anything but an export of ours is answered, not refused: there is simply nothing to bring in.
    if (!payload || typeof payload !== 'object' || payload.format !== 'dsh-auto-dev/export@1' || !payload.task || typeof payload.task !== 'object') {
      return { imported: false, tellUser: '这不是一份 dsh-auto-dev 导出，没导入。' }
    }
    const incoming = payload.task
    const now = new Date().toISOString()
    const task = createTaskRecord({
      id: newId('task'),
      project: text(typeof incoming.project === 'string' ? incoming.project : projectOf(agent), 400),
      sessionId: agent?.session?.id,
      ownerId: agent?.id,
      request: text(typeof incoming.request === 'string' ? incoming.request : '(imported task)'),
      goal: typeof incoming.goal === 'string' ? incoming.goal : undefined,
      mode: MODES.includes(incoming.mode) ? incoming.mode : 'do',
      scope: Array.isArray(incoming.scope) && incoming.scope.length ? incoming.scope : ['.'],
      acceptance: Array.isArray(incoming.acceptance) ? incoming.acceptance : [],
      deliverable: typeof incoming.deliverable === 'string' ? incoming.deliverable : undefined,
      startedSeq: observationsStart(agent),
      startedTurn: undefined,
      now,
    })
    const record = {
      ...task,
      state: 'active',
      imported: { from: incoming.id, at: now, fromProject: incoming.project, note: 'claims listed below were verified on another machine; none of them counts as evidence here' },
      ledger: (incoming.ledger ?? []).map(entry => ({ ...entry, verifiedHere: false })),
      ...(Array.isArray(incoming.checkpoints) && incoming.checkpoints.length ? { checkpoints: incoming.checkpoints } : {}),
    }
    await records.change('tasks', record.id, () => record)
    if (Array.isArray(incoming.units) && incoming.units.length) {
      await setUnits(record.id, incoming.units.map(unit => ({ ...unit, state: 'pending' })))
    }
    sessionState(agent).taskId = record.id
    // Import arrives with a plan and no local copy of the tree: take the "before"
    // now, otherwise the first submit's autosave is the oldest thing there is.
    const imported = records.get('tasks', record.id)
    const before = await snapshot(imported, 'before', { label: '导入前' })
    return {
      taskId: record.id, imported: record.imported,
      before: before.snapshot === 'captured' ? before : { snapshot: before.snapshot, reason: before.reason },
      units: (incoming.units ?? []).length,
      history: (record.ledger ?? []).length,
      next: 'the plan came in pending: run the checks on this machine before submitting anything as complete',
    }
  }

  /**
   * Tasks of this project that this session is not holding.
   *
   * The skill era worked because the control plane lived in the project directory:
   * open any session, say "continue", and it read the same files. This state lives
   * in one host-wide ledger instead, which is better (nothing to commit) and worse
   * (a fresh conversation has no idea the record exists). Naming them is the
   * equivalent courtesy — after that, the model's own judgement decides whether the
   * person means "carry on" or "while you are here, do this other thing".
   */
  const unfinishedElsewhere = agent => {
    const project = projectOf(agent, ['.'])
    const mine = sessionId(agent)
    return records.all('tasks', task => task.project === project && task.sessionId !== mine
      && (task.state === 'active' || task.state === 'paused'))
      .sort(newestFirst(records))
      .slice(0, 3)
      .map(task => {
        const units = planOf(task)?.units ?? []
        const leaves = units.filter(unit => !units.some(candidate => candidate.parent === unit.id))
        return {
          id: task.id, state: task.state, mode: task.mode,
          request: String(task.request ?? '').slice(0, 160),
          progress: leaves.length ? `${leaves.filter(unit => unit.state === 'done').length}/${leaves.length}` : undefined,
          updatedAt: task.updatedAt,
        }
      })
  }

  /**
   * Continue a task another session left half done, on this host.
   *
   * Nothing is copied: the record already exists in the one KV every session on
   * this machine shares. What moves is the handle — the session pointer — and what
   * has to be re-based is the evidence window: `startedSeq` is an offset into one
   * session's log, so carrying another session's number here would filter out
   * every run that happens now and make honest claims look invented. The prior
   * ledger stays as history, exactly as an import keeps it.
   */
  async function adoptTask(args, agent) {
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : ''
    // What cannot be adopted is answered with what can, never refused.
    const waiting = unfinishedElsewhere(agent).map(row => row.id)
    const none = line => ({ adopted: false, tellUser: `${line}${waiting.length ? `可以接手的：${waiting.join('、')}。` : ''}` })
    if (!taskId) return none('没说接手哪一条。')
    const found = records.get('tasks', taskId)
    if (!found) return none(`这里没有任务 ${taskId}。`)
    if (found.state === 'cancelled') return none(`${taskId} 已取消，要做就让用户重新 /dsh-auto-dev start。`)
    if (found.state === 'review_ready') return none(`${taskId} 在等用户验收：用户说可以就收案，说哪里不对就退回改。`)
    const from = found.sessionId
    const now = new Date().toISOString()
    if (from === sessionId(agent) && found.state !== 'closed') {
      // Same holder, but the row predates the hand-off list: name this session in
      // it, or a window that adopts this task back later would lose the trail.
      const reopened = await records.change('tasks', taskId, current => ({
        ...current,
        state: 'active',
        sessions: heldSessions(current, sessionId(agent)),
        updatedAt: now,
      }))
      sessionState(agent).taskId = taskId
      return { taskId, adopted: false, from, state: reopened.state, note: 'that task was already this session\'s, so its evidence window was left alone' }
    }
    const start = observationsStart(agent)
    const record = await records.change('tasks', taskId, current => ({
      ...current,
      state: 'active',
      review: undefined, accepted: undefined,
      sessionId: sessionId(agent),
      // The earlier sessions keep their board: the record is the only thing they
      // can draw from once the work has moved on.
      sessions: heldSessions(current, sessionId(agent)),
      ownerId: agent?.id,
      startedSeq: start,
      updatedAt: now,
      adopted: { from, at: now, note: 'runs made before this point belong to the earlier session: the checks that count are the ones run here' },
    }))
    const plan = planOf(record)
    if (plan) {
      // A unit that was in flight reopens its window too, or its own `startedSeq`
      // (an offset from the other session) would still hide what happens now.
      await records.change('plans', plan.id, current => ({
        ...current,
        units: current.units.map(unit => (unit.state === 'active' || (found.state === 'closed' && unit.state === 'done') ? { ...unit, state: 'pending', startedSeq: start } : unit)),
        updatedAt: now,
      }))
    }
    sessionState(agent).taskId = taskId
    const fresh = records.get('tasks', taskId)
    // A handoff is the one moment nothing else will save: the tree is whatever the
    // previous session left behind, and the next submit's copy would be the first
    // thing anyone could go back to.
    const before = await snapshot(fresh, 'before', { label: '接手前' })
    const settled = records.get('tasks', taskId)
    const freshPlan = planOf(settled)
    return {
      taskId, adopted: true, from, project: settled.project, mode: settled.mode, state: settled.state,
      request: settled.request ?? '', goal: settled.goal ?? '',
      ...(freshPlan ? planView(settled, freshPlan) : {}),
      checkpoints: checkpointView(settled),
      before: before.snapshot === 'captured' ? before : { snapshot: before.snapshot, reason: before.reason },
      ledger: (fresh.ledger ?? []).slice(-3),
      next: 'that task is this session\'s now: run the check yourself here before submitting anything as complete',
    }
  }

  // An imported task starts watching from the current point of the session log:
  // executions that happened before it arrived belong to somebody else's task.
  function observationsStart(agent) {
    const seq = agent?.session?.seq
    return typeof seq === 'number' ? seq : 0
  }

  // A taskId that names nothing is a typo, not a request for another task: use this session's.
  function requireTask(task, taskId) {
    return (taskId ? records.get('tasks', taskId) : undefined) ?? task
  }

  /** The answer a work_* call gets when this session has no task: the user opens one, not the model. */
  function noTask(agent) {
    const known = agent ? latestTask(agent) : undefined
    return { task: null, waiting: 'user-start',
      tellUser: known?.state === 'closed'
        ? `上一个任务 ${known.id} 已经收尾。要接着做，请用户 /dsh-auto-dev adopt ${known.id}；要做新的，请用户 /dsh-auto-dev start <要做的事>。`
        : '这个会话还没有任务：任务由用户用 /dsh-auto-dev start <要做的事> 开，先照常回答用户。' }
  }

  async function setUnits(taskId, units) {
    const now = new Date().toISOString()
    const task = records.get('tasks', taskId)
    const prior = planOf(task)?.units ?? []
    let normalized = normalizeUnits(units ?? []).map(unit => {
      const old = prior.find(row => row.id === unit.id)
      return { ...unit, ...(Number.isInteger(old?.startedSeq) ? { startedSeq: old.startedSeq } : {}),
        ...(old?.startedAt ? { startedAt: old.startedAt } : {}) }
    })
    // Only a submission makes a unit done. Grouping may move a verified leaf without
    // changing the work it proved; anything else written as done goes back to waiting.
    const priorLeaves = new Set(leafUnits(prior).map(unit => unit.id))
    const definition = unit => JSON.stringify([unit.goal, unit.scope, unit.acceptance, unit.dependsOn ?? [], unit.deliverable ?? null, unit.kind ?? 'delivery', unit.ui ?? null])
    const leavesOf = rows => new Set(leafUnits(rows).map(unit => unit.id))
    let nextLeaves = leavesOf(normalized)
    const reopened = []
    normalized = normalized.map(unit => {
      if (unit.state !== 'done') return unit
      const old = prior.find(row => row.id === unit.id)
      if (old?.state === 'done' && priorLeaves.has(unit.id) === nextLeaves.has(unit.id) && definition(old) === definition(unit)) return unit
      reopened.push(unit.id)
      return { ...unit, state: old?.state && old.state !== 'done' ? old.state : 'pending' }
    })
    // An unfinished leaf never disappears in a rewrite: it stays, dropped, and the
    // person hears about it — a quietly shrunk plan is the drift this guards.
    const kept = leafUnits(prior).filter(row => row.state !== 'done' && !normalized.some(unit => unit.id === row.id))
    const vanished = kept.filter(row => row.state !== 'dropped')
    normalized = [...normalized, ...kept.map(row => ({ ...row, state: 'dropped' }))]
    nextLeaves = leavesOf(normalized)
    const digested = {
      ...(reopened.length ? { reopened } : {}),
      ...(vanished.length ? { dropped: vanished.map(row => row.id), tellUser: `计划里拿掉了没做完的 ${vanished.map(row => `${row.id}（${row.goal}）`).join('、')}：已记为不做了。给用户一句为什么不做。` } : {}),
    }
    if (task.planId) {
      const updated = await records.change('plans', task.planId, current => ({ ...current, units: normalized, updatedAt: now }))
      return { ...planView(records.get('tasks', taskId), updated), ...digested }
    }
    const plan = { id: newId('plan'), version: 1, project: task.project, taskId, units: normalized, createdAt: now, updatedAt: now }
    await records.change('plans', plan.id, () => plan)
    await records.change('tasks', taskId, current => ({ ...current, planId: plan.id, updatedAt: now }))
    return { ...planView(records.get('tasks', taskId), plan), ...digested }
  }

  return { proposeOrganize, slugOf, snapshot, newId, exportSnapshot, importSnapshot, unfinishedElsewhere, adoptTask, observationsStart, requireTask, noTask, setUnits }
}

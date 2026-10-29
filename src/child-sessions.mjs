/**
 * What a delegated child session actually did.
 *
 * A subagent logs into its own session, so this task's window cannot see its
 * writes — and the plugin said so with a warning, which is honest but useless to
 * an owner who paid for a child to do the work. The host keeps every session,
 * including the children, and a child's id appears in the delegation's own tool
 * result, so the work is readable after all: read its log, count what it wrote
 * and what it ran, and report that next to the warning.
 *
 * What this does NOT do is make a child's passing run count as this task's
 * evidence. A check that vouches for the result still has to be run by the
 * session that submits, because that is the only run whose effect on this
 * working tree is observable here.
 */

const WRITE_TOOL = /^(write|write_file|edit|edit_file|multi_edit|apply_patch|str_replace_editor|create_file|notebook_edit)$/
const CHECK = /(^|\s)(npm|pnpm|yarn|bun)(\s+(run\s+)?[\w:-]+)?|(^|\s)(node\s+--test|pytest|python3?\s+-m\s+(pytest|unittest)|go\s+test|cargo\s+test|mvn\s+\S*test|make(\s+\w+)?|tsc|eslint|npx\s+\S+)(\s|$)/

const argsOf = value => {
  if (!value || typeof value !== 'object') return {}
  if (typeof value.arguments === 'string') {
    try { return JSON.parse(value.arguments) } catch { return {} }
  }
  return value.arguments ?? value.args ?? {}
}

/**
 * The manifest a child writes about itself before it takes its first turn.
 *
 * `subagent/descriptor` is the only place the choice of model and reasoning
 * effort is stated as data. The lifecycle edge carries neither, and the parent's
 * log only carries the tool name, so a board that wants to say "which model, how
 * hard" has to read the child's own header. It is log-only (never a message), so
 * reading it cannot change what the child's history means.
 */
export function descriptorOf(session) {
  if (!session || typeof session.eventAt !== 'function') return null
  for (let at = 0; at < (session.seq ?? 0); at += 1) {
    const event = session.eventAt(at)
    if (event?.type !== 'subagent/descriptor') continue
    const data = event.data ?? {}
    return {
      label: typeof data.label === 'string' ? data.label : null,
      mode: typeof data.mode === 'string' ? data.mode : null,
      // `agentProvider` / `agentModel` are the resolved route, not the tool
      // instance's configured default: that is what actually ran.
      provider: typeof data.agentProvider === 'string' ? data.agentProvider : null,
      model: typeof data.agentModel === 'string' ? data.agentModel : null,
      effort: typeof data.agentReasoningEffort === 'string' ? data.agentReasoningEffort : null,
    }
  }
  return null
}

/** The last tool a child called, as one short line: what it is doing right now. */
export function lastAction(session, { scan = 240 } = {}) {
  if (!session || typeof session.eventAt !== 'function') return null
  const total = session.seq ?? 0
  let seen = 0
  for (let at = total - 1; at >= 0 && seen < scan; at -= 1, seen += 1) {
    const event = session.eventAt(at)
    if (event?.type !== 'tool/call') continue
    const { name, arguments: raw } = event.data ?? {}
    const args = argsOf({ arguments: raw })
    const target = typeof args.path === 'string' ? args.path
      : typeof args.file_path === 'string' ? args.file_path
        : typeof args.filePath === 'string' ? args.filePath
          : typeof args.command === 'string' ? args.command
            : typeof args.description === 'string' ? args.description
              : typeof args.query === 'string' ? args.query
                : typeof args.unit === 'string' ? args.unit : ''
    const clean = String(target).replace(/\s+/g, ' ').trim()
    const short = clean.length > 120 ? `${clean.slice(0, 117)}…` : clean
    return { tool: typeof name === 'string' ? name : 'tool', target: clean || null, text: `${name ?? 'tool'}${short ? ` · ${short}` : ''}`, at: event.time ?? null }
  }
  return null
}

/** The session ids a delegation handed work to, read off its own result payload. */
export function childIds(results = []) {
  const ids = []
  for (const row of results) {
    if (!/^(subagent|spawn_agent|workflow)/.test(row?.name ?? '') || row.isError) continue
    const value = row.value ?? {}
    // `tool-subagent` answers `{kind:'activation', subagentId}`, and that id is the
    // child's own session id — the same string its notices are signed with.
    for (const key of ['subagentId', 'childId', 'childSessionId', 'sessionId', 'agentId', 'id']) {
      if (typeof value[key] === 'string' && value[key]) { ids.push({ childId: value[key], callId: row.callId, seq: row.seq }); break }
    }
  }
  return ids
}

/**
 * Summarise one child session: the files it wrote and the checks it ran.
 * Returns `{ childId, reachable: false, reason }` when the host no longer holds
 * that session — a pruned child must degrade to the old opaque warning instead of
 * pretending nothing happened.
 */
/** Scan one child session object: the files it wrote and the checks it ran. */
export function scanChild(session, base = {}) {
  if (!session || typeof session.eventAt !== 'function') return { ...base, reachable: false, reason: 'the child session is no longer stored' }
  const writes = new Set()
  const checks = new Set()
  const commands = []
  let calls = 0
  for (let at = 0; at < (session.seq ?? 0); at += 1) {
    const event = session.eventAt(at)
    if (event?.type !== 'tool/call') continue
    calls += 1
    const { name, arguments: raw } = event.data ?? {}
    const args = argsOf({ arguments: raw })
    if (WRITE_TOOL.test(name ?? '')) {
      for (const key of ['path', 'file_path', 'filePath']) if (typeof args[key] === 'string') writes.add(args[key])
      continue
    }
    const command = typeof args.command === 'string' ? args.command : undefined
    if (command && CHECK.test(command)) checks.add(command.length > 120 ? `${command.slice(0, 117)}…` : command)
    if (command && commands.length < 20) commands.push(command.length > 120 ? `${command.slice(0, 117)}…` : command)
  }
  return { ...base, reachable: true, calls, writes: [...writes], checks: [...checks], commands }
}

export async function readChild(sessions, { childId, callId, seq } = {}) {
  const base = { childId, callId, seq }
  if (!sessions || typeof sessions.get !== 'function') return { ...base, reachable: false, reason: 'this host exposes no session store' }
  let session
  try {
    session = await sessions.get(childId)
  } catch (error) {
    return { ...base, reachable: false, reason: error?.message ?? 'the session could not be read' }
  }
  if (!session || typeof session.eventAt !== 'function') return { ...base, reachable: false, reason: 'the child session is no longer stored' }
  return scanChild(session, base)
}

export async function readChildren(sessions, results = [], { limit = 6 } = {}) {
  const ids = childIds(results).slice(-limit)
  const children = []
  for (const entry of ids) children.push(await readChild(sessions, entry))
  return children
}

/** One line per child, for the warning a person actually reads. */
export function describeChild(child) {
  if (!child.reachable) return `delegated work in session ${child.childId} could not be read (${child.reason}) — its writes are unknown to this task`
  const wrote = child.writes.length ? `${child.writes.length} file(s): ${child.writes.slice(0, 5).join(', ')}` : 'no files through a write tool'
  const ran = child.checks.length ? `; it ran ${child.checks.join(' / ')}` : '; it ran no command that looks like a check'
  return `delegated work in session ${child.childId}: ${wrote}${ran} — those runs are evidence for its own log, so run the check yourself before submitting`
}

/**
 * A live registry of the children this host ran, filled from the subagent
 * lifecycle rather than from the session log.
 *
 * The parent's log carries no `subagent/*` event (the history is cleaned before
 * it is written), so a child is invisible there. The host does publish
 * `subagent/start` / `subagent/end` on the context bus, with the child's id and
 * — on the way out — the child's own final message. That message is not
 * evidence: it is what the child says it did, which is exactly what the owner
 * needs to know when the run itself cannot be re-read.
 */
export function childRegistry({ limit = 40, agentOf = () => undefined } = {}) {
  // A flat ring of runs, each attributed to the session that delegated it. The
  // listener is not handed the parent (the delegating agent rides the dispatch
  // carrier for scope filtering, not as an argument), so the attribution comes
  // from the child's own session header: `parentSession` is exact, where a guess
  // from timing or cwd would not be.
  const runs = []
  const textOf = blocks => {
    if (!Array.isArray(blocks)) return ''
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n').trim()
    return text.length > 600 ? `${text.slice(0, 597)}…` : text
  }
  // A child's log grows while it works, so the scan is cached against the log's
  // own seq: every parent render during a long run would otherwise re-walk
  // thousands of events.
  const scans = new WeakMap()
  const actions = new WeakMap()
  const scanOf = child => {
    const session = child?.session
    if (!session) return null
    const seq = session.seq ?? 0
    const cached = scans.get(session)
    if (cached && cached.seq === seq) return cached.value
    const value = scanChild(session, {})
    scans.set(session, { seq, value })
    return value
  }
  const actionOf = child => {
    const session = child?.session
    if (!session) return null
    const seq = session.seq ?? 0
    const cached = actions.get(session)
    if (cached && cached.seq === seq) return cached.value
    const value = lastAction(session)
    actions.set(session, { seq, value })
    return value
  }
  const find = runId => (runId ? runs.find(run => run.runId === runId) : undefined)
  const remember = entry => {
    const seen = find(entry.runId)
    if (seen) Object.assign(seen, entry)
    else {
      runs.push(entry)
      while (runs.length > limit) runs.shift()
    }
    return seen ?? entry
  }
  return {
    start(info = {}, parent) {
      // `agents.get(id)` is the child as a live agent: its session is the log the
      // parent's transcript cannot show. Holding the reference is what turns
      // "something was delegated" into "it wrote these files and ran these
      // commands" — after the end edge the committed session stays readable.
      const child = agentOf(info.id)
      const header = child?.session?.header
      remember({
        childId: info.id, runId: info.runId, provider: info.provider, local: info.local,
        parentId: header?.parentSession ?? parent?.session?.id, cwd: header?.cwd,
        state: 'running', startedAt: Date.now(), session: child?.session,
        descriptor: descriptorOf(child?.session),
      })
    },
    end(info = {}, parent) {
      const known = find(info.runId)
      remember({
        childId: info.id, runId: info.runId, provider: info.provider, local: info.local,
        parentId: known?.parentId ?? parent?.session?.id,
        session: known?.session,
        // The child's manifest is still readable after it settles; keep it so a
        // restart-free board can still say which model ran the work.
        descriptor: known?.descriptor ?? descriptorOf(known?.session),
        state: 'settled', stopReason: info.stopReason, reported: textOf(info.lastAssistantMessage), settledAt: Date.now(),
      })
    },
    /** Every child this session delegated, oldest first, with what its log shows. */
    list(sessionId, { since = 0 } = {}) {
      return runs
        .filter(child => child.parentId === sessionId && (child.startedAt ?? 0) >= since)
        .map(child => {
          const descriptor = child.descriptor ?? descriptorOf(child.session)
          const base = {
            childId: child.childId,
            provider: child.provider,
            state: child.state,
            stopReason: child.stopReason,
            reported: child.reported,
            ...(descriptor ? {
              label: descriptor.label,
              model: descriptor.model,
              agentProvider: descriptor.provider,
              effort: descriptor.effort,
            } : {}),
          }
          if (!child.session) return { ...base, reachable: false, reason: 'the child agent was not resident on this host, so only its report is known' }
          return { ...base, ...scanOf(child) }
        })
    },
    /**
     * The live view the board merges: one row per child, with the model and
     * reasoning effort from its own descriptor, the tool it is on now, and the
     * report it ended with. This is a read of the host, not a log fold, so it is
     * never persisted; the board folds the durable half from the parent's log.
     */
    snapshot(sessionId, { since = 0 } = {}) {
      return runs
        .filter(child => child.parentId === sessionId && (child.startedAt ?? 0) >= since)
        .map(child => {
          const descriptor = child.descriptor ?? descriptorOf(child.session)
          const scan = scanOf(child)
          return {
            childId: child.childId,
            runId: child.runId ?? null,
            provider: child.provider ?? null,
            local: child.local ?? null,
            parentId: child.parentId ?? null,
            label: descriptor?.label ?? child.label ?? null,
            mode: descriptor?.mode ?? null,
            agentProvider: descriptor?.provider ?? null,
            model: descriptor?.model ?? null,
            effort: descriptor?.effort ?? null,
            state: child.state,
            startedAt: child.startedAt ?? null,
            settledAt: child.settledAt ?? null,
            stopReason: child.stopReason ?? null,
            reported: child.reported ?? null,
            activity: child.state === 'running' ? actionOf(child) : null,
            reachable: scan?.reachable ?? false,
            calls: scan?.calls ?? 0,
            writes: scan?.writes ?? [],
            checks: scan?.checks ?? [],
          }
        })
    },
  }
}

/** One line per recorded child, for the report a person actually reads. */
export function describeRecord(child) {
  const where = child.childId ? ` in session ${child.childId}` : ''
  const said = child.reported ? `; it reported: ${String(child.reported).replace(/\s+/g, ' ')}` : '; it reported nothing'
  if (child.state === 'running') return `a delegated child${where} is still running — count on that changing after it finishes`
  if (child.reachable) {
    const wrote = child.writes?.length ? `${child.writes.length} file(s): ${child.writes.slice(0, 6).join(', ')}` : 'no files through a write tool'
    const ran = child.checks?.length ? `; it ran ${child.checks.join(' / ')}` : '; it ran no command that looks like a check'
    return `a delegated child${where} ${wrote}${ran}${said} — that is its own log, so run the check yourself before submitting`
  }
  return `a delegated child${where} finished${child.stopReason ? ` (${child.stopReason})` : ''}${said} — its log could not be read, so its writes are unknown here`
}

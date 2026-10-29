/**
 * The board is a fold over the session log *and* the task record.
 *
 * The log says what happened in this conversation: which `work_*` calls the model
 * made, what it submitted, what the checks found, and how long it has been quiet.
 * That is what makes the panel survive a restart, a reconnect and a different
 * browser without a synchronization path of its own.
 *
 * What the log cannot say is what the work *is*, because a task outlives the
 * conversation that started it: it is handed to another window, paused, picked up
 * again days later. The record is the root — the task, its lane, its goal and its
 * units — and `syncState` folds it into the state on every read.
 */

import { taskStatus, planProgress } from './status.mjs'
import { modeLabel } from './mode.mjs'
import { resultFailed } from './session-log.mjs'

// A command that reads as a check: the project's own verifier, or a test/type/lint run.
const CHECK_WORDS = /\b(?:test|tests|check|lint|tsc|vitest|jest|pytest|playwright|mocha)\b/
const isCheck = (command, verifier) => (typeof verifier === 'string' && verifier !== '' && command.includes(verifier)) || CHECK_WORDS.test(command)

/** A tool call that handed work to another agent: its writes are not in this log. */
const DELEGATION = /^(subagent|spawn_agent|workflow)(?:_|$)/

const EMPTY = Object.freeze({
  // Which task this board is about. Seeded from the record, never rebuilt from the
  // log: a session that adopted a task logged a command, and one that only read a
  // task logged a `work_status` — neither carries the task's identity in its own
  // arguments, and without it the state cannot say whether it is still current.
  taskId: null,
  mode: null,
  request: null,
  goal: null,
  acceptance: [],
  units: [],
  last: null,
  submits: 0,
  taskState: null,
  // Who decides the task is done; the panel words it "由你验收 / 自动收".
  acceptanceMode: null,
  goalRevision: 0,
  hasReceipt: null,
  clarify: null,
  // The project's tasks in time order, as the record sees them. A board answers
  // "what is this" for one task; the timeline answers "what has this project been
  // through", which is what a person reads when a new task replaces the last one.
  timeline: null,
  delegations: 0,
  // The bar used to answer "is anything running?" and nothing about whether the
  // work is recoverable or was submitted with doubts attached. Both are in the
  // log: a checkpoint is a returned `checkpoint.snapshot === 'captured'`, a doubt
  // is a returned warning on the submission that carried it.
  checkpoints: 0,
  marks: null,
  warnings: 0,
  warningLines: [],
  // `checkpoint` and `warnings` are the host's answer, not the caller's claim: they
  // appear in the *result*, so the fold has to remember which call asked for what
  // and read the answer when it arrives.
  pending: {},
  // What the second and third bands of the panel are made of: where the work is
  // happening (host-resolved, not the model's spelling), which goal it serves, and
  // what the project already knows.
  program: null,
  project: null,
  gates: null,
  verifier: null,
  memory: null,
  checkpoint: null,
  children: [],
  // Delegated work, as the log itself records it. `subagent/catalog` names the
  // child and the work it was given; `user/message` relays what the child sent
  // back. Neither is a `work_*` call, so without these fields a session that spent
  // an hour on three children drew a board with no trace of them.
  //
  // `sessionId` is seeded from the session header (the projection's `init`), not
  // from an event: the client half needs it to ask the live registry which
  // children are running *for this session*, and `wire.view` receives only state.
  // `null` rather than `{}` keeps the shared EMPTY object immutable.
  sessionId: null,
  lastDelegation: null,
  childMeta: null,
  childUnits: null,
  // The heartbeat: every tool call is counted, not only the `work_*` ones that
  // move the plan. A board that only moves when the model keeps books cannot
  // answer the owner's real question — "is this still working?" — during a long
  // silent stretch. The count and the clock come off the log line; the board
  // never guesses which step that work belongs to.
  beats: null,
  // The unit in flight as this log first saw it running, and the last check run
  // under it. Both come off the log's own clock and results; the dock draws them.
  since: null,
  check: null,
  // Per unit, what its settlement rested on; and the reminders of the last one,
  // in the words the person is shown.
  proofs: {},
  reminders: null,
  // The record signature the current units were seeded from. `apply` runs on
  // every committed event and a state object the host did not see before is work
  // to push, so an unrelated event has to be able to return the very same state.
  seeded: null,
})

function asStrings(value) {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim()) : []
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * A `tool/call` event carries `arguments` as a JSON *string* in the session log,
 * not as an object. Reading it as an object silently produced a board with no
 * goal, no units and mode "do" for every task — the fold has to parse.
 */
function argsOf(value) {
  if (typeof value === 'string') {
    try { return asObject(JSON.parse(value)) } catch { return {} }
  }
  return asObject(value)
}

/** Normalize one unit exactly the way the host validates it. */
function unitOf(raw, parent = undefined, depth = 0) {
  const value = asObject(raw)
  return {
    id: typeof value.id === 'string' && value.id.trim() !== '' ? value.id.trim() : undefined,
    goal: typeof value.goal === 'string' ? value.goal.trim() : '',
    scope: asStrings(value.scope),
    acceptance: asStrings(value.acceptance),
    dependsOn: asStrings(value.dependsOn),
    state: 'pending',
    ...(parent ? { parent, depth } : {}),
  }
}

/**
 * Flatten a plan the way the host does, because a milestone is a container and
 * the board counts the work inside it, not the container. A plan written flat
 * comes through unchanged.
 */
function unitsOf(list, parent = undefined, depth = 0, out = []) {
  if (!Array.isArray(list)) return out
  for (const raw of list) {
    const value = asObject(raw)
    const unit = unitOf(value, parent, depth)
    if (unit.id) out.push(unit)
    if (Array.isArray(value.units)) unitsOf(value.units, unit.id, depth + 1, out)
  }
  return out
}

function mergeUnits(existing, incoming) {
  const byId = new Map(existing.map(unit => [unit.id, unit]))
  for (const unit of incoming) {
    if (!unit.id) continue
    const previous = byId.get(unit.id)
    // A plan rewrite redeclares the unit, not its progress history: a note the
    // model appended must survive the next `add`/`set` of the same id.
    byId.set(unit.id, { ...unit, state: previous?.state ?? 'pending', ...(previous?.notes ? { notes: previous.notes } : {}) })
  }
  return [...byId.values()]
}

function setUnitState(units, id, state) {
  return units.map(unit => unit.id === id ? { ...unit, state } : unit)
}

/** Append one progress note to a unit, newest last, capped like the record itself. */
function noteUnit(units, id, note) {
  return units.map(unit => unit.id === id
    ? { ...unit, notes: [...(unit.notes ?? []).slice(-7), note] }
    : unit)
}

/**
 * One unit of an inherited task.
 *
 * A declared plan arrives as intent, so every unit starts pending. An inherited
 * one arrives with its progress attached (adopt / import / a status read), which
 * is the difference between a board that draws U3 正在做 and one that draws four
 * units nobody has touched.
 */
function seedUnitOf(raw, parent = undefined, depth = 0) {
  const value = asObject(raw)
  const id = typeof value.id === 'string' && value.id.trim() !== '' ? value.id.trim() : undefined
  if (!id) return undefined
  const trail = Array.isArray(value.notes) ? value.notes : []
  const latest = typeof value.note === 'string' && value.note.trim() !== '' ? value.note.trim() : null
  const notes = trail.length
    ? trail.map(entry => ({ at: asObject(entry).at ?? null, text: String(asObject(entry).text ?? '') }))
    : latest ? [{ at: null, text: latest }] : []
  // A stored plan is flat, with `parent` and `depth` on each row, while a plan
  // handed back by a tool is nested. Both have to seed the same board, or a task
  // read back from its record would lose the milestones it was drawn with.
  const parentId = parent ?? (typeof value.parent === 'string' && value.parent.trim() !== '' ? value.parent.trim() : undefined)
  const level = parent ? depth : (typeof value.depth === 'number' && Number.isFinite(value.depth) ? value.depth : depth)
  return {
    id,
    goal: typeof value.goal === 'string' ? value.goal.trim() : '',
    scope: asStrings(value.scope),
    acceptance: asStrings(value.acceptance),
    dependsOn: asStrings(value.dependsOn),
    state: typeof value.state === 'string' && value.state.trim() !== '' ? value.state.trim() : 'pending',
    ...(parentId ? { parent: parentId, depth: level } : {}),
    ...(typeof value.deliverable === 'string' && value.deliverable.trim() !== ''
      ? { deliverable: value.deliverable.trim() }
      : {}),
    ...(value.asked && typeof asObject(value.asked).question === 'string'
      ? { asked: asObject(value.asked).question }
      : {}),
    // The bucket is a role, not a name: the panel draws it apart from a campaign
    // theme, so the role has to survive the record round-trip.
    ...(value.role === 'daily' ? { role: 'daily' } : {}),
    ...(notes.length ? { notes } : {}),
  }
}

/** Flatten an inherited plan the same way `unitsOf` flattens a declared one. */
function seedUnitsOf(list, parent = undefined, depth = 0, out = []) {
  if (!Array.isArray(list)) return out
  for (const raw of list) {
    const value = asObject(raw)
    const unit = seedUnitOf(value, parent, depth)
    if (unit) out.push(unit)
    if (Array.isArray(value.units)) seedUnitsOf(value.units, unit?.id ?? parent, depth + 1, out)
  }
  return out
}

/**
 * The task a session inherited but never registered.
 *
 * `work_start` is the only call that draws a board out of its own arguments, and a
 * session picking up somebody else's task never makes it: it adopts, imports, or
 * just reads the task back. The snapshot in that answer is then the only
 * description of the work in this log, so the fold seeds the board from it —
 * otherwise a session that is genuinely finishing U3 draws the empty state and the
 * panel says "开始任务后…" while the record says 2/4.
 */
function snapshotOf(value) {
  const row = asObject(value)
  const plan = asObject(row.plan)
  const units = Array.isArray(row.units) ? row.units : plan.units
  if (typeof row.mode !== 'string' || row.mode.trim() === '' || !Array.isArray(units)) return undefined
  const seeded = seedUnitsOf(units)
  if (seeded.length === 0) return undefined
  const state = typeof row.state === 'string' ? row.state
    : typeof row.taskState === 'string' ? row.taskState : 'active'
  const request = typeof row.request === 'string' ? row.request : null
  return {
    mode: row.mode,
    request,
    goal: typeof row.goal === 'string' ? row.goal : request,
    units: seeded,
    taskState: state,
  }
}

/**
 * Read a tool result that answers a tracked call.
 *
 * A checkpoint the host did not capture is not a checkpoint, and a warning list the
 * caller wrote does not count — both come from the result payload, so the board
 * cannot be talked into showing a safety it does not have.
 */
function foldResult(current, message) {
  const callId = typeof message.toolCallId === 'string'
    ? message.toolCallId
    : typeof asObject(message.source).callId === 'string' ? asObject(message.source).callId : undefined
  // `current` may be null (a session with no task yet); an untracked result has to
  // leave that exactly as it was rather than seed an empty board.
  const kind = callId ? current?.pending?.[callId] : undefined
  if (!kind) return current
  const pending = { ...current.pending }
  delete pending[callId]
  if (typeof kind === 'object' && kind?.kind === 'check') {
    const ok = !resultFailed(message.content, kind.name, message.isError === true)
    const count = current.check?.command === kind.command ? current.check.count + 1 : 1
    return { ...current, pending, check: { command: kind.command, ok, count } }
  }
  const text = asStrings(Array.isArray(message.content) ? message.content.map(block => asObject(block).text) : []).join('')
  let value
  try { value = JSON.parse(text) } catch { return { ...current, pending } }
  if (value === null || typeof value !== 'object') return { ...current, pending }
  if (message.isError === true || asObject(value).error) return { ...current, pending }
  if (typeof kind === 'object' && kind?.kind === 'apply') {
    const confirmed = foldBoard({ ...current, pending }, {
      type: 'tool/call', time: kind.time,
      data: { name: kind.name, arguments: kind.args, callId, confirmed: true },
    })
    // The same result also supplies authoritative settlement/checkpoint data.
    return foldResult(confirmed, message)
  }
  // A note only counts when the host answered it. A refused call leaves plain text
  // behind, which the parse above already drops; a JSON-shaped refusal is caught
  // here. Folding the arguments alone once put a refused probe on the board as a
  // real line of progress.
  if (typeof kind === 'object' && kind?.kind === 'note') {
    if (message.isError === true || asObject(value).error) return { ...current, pending }
    return { ...current, pending, units: noteUnit(current.units, kind.unit, { at: kind.at, text: kind.text }) }
  }
  // A snapshot fills an empty board; it never rewrites one this session drew, so a
  // status read taken mid-run cannot roll live progress back to an older state.
  if (kind === 'snapshot') {
    const seeded = snapshotOf(value)
    if (!seeded || current?.mode) return { ...current, pending,
      ...(typeof value.state === 'string' ? { taskState: value.state } : {}) }
    return { ...(current ?? EMPTY), pending, ...seeded }
  }
  const checkpoint = asObject(value.checkpoint)
  const captured = checkpoint.snapshot === 'captured' ? 1 : 0
  const ref = typeof checkpoint.ref === 'string' ? checkpoint.ref : null
  if (kind === 'start') {
    const compiled = asObject(value.compiled)
    return {
      ...current,
      pending,
      ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
      checkpoints: (current.checkpoints ?? 0) + captured,
      checkpoint: ref ?? current.checkpoint,
      // The root the host actually used. The model may have meant a different
      // directory; showing the requested one would make every later "out of scope"
      // warning look like a mystery.
      project: typeof value.project === 'string' ? value.project : current.project,
      gates: value.gates !== null && typeof value.gates === 'object' ? value.gates : current.gates,
      verifier: typeof asObject(compiled.verifier).command === 'string'
        ? asObject(compiled.verifier).command
        : current.verifier,
      memory: value.memory !== null && typeof value.memory === 'object' ? value.memory : current.memory,
    }
  }
  return {
    ...current,
    pending,
    ...(typeof value.state === 'string' ? { taskState: value.state } : {}),
    checkpoints: (current.checkpoints ?? 0) + captured,
    checkpoint: ref ?? current.checkpoint,
    warnings: Array.isArray(value.warnings) ? value.warnings.length : 0,
    // Kept verbatim so the panel can say what the doubt was, not just that one existed.
    warningLines: Array.isArray(value.warnings) ? asStrings(value.warnings) : (current.warningLines ?? []),
    children: Array.isArray(value.children) ? value.children : current.children,
  }
}

/** The prose of a relayed child message, without the envelope the host added. */
function childMessageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const text = blocks
    .map(block => asObject(block).text)
    .filter(entry => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => entry.trim())
    .join('\n')
  // `agent-message` prefixes every block with "Agent <id> sent a message: ";
  // `subagent-settled` prefixes the closing message with a fixed marker.
  const messagePrefix = /^Agent\s+\S+\s+sent a message:\s*/i
  if (messagePrefix.test(text)) return text.replace(messagePrefix, '').trim()
  const marker = text.indexOf('Its closing message:')
  return (marker >= 0 ? text.slice(marker + 'Its closing message:'.length) : text).trim()
}

/** The unit a delegation belongs to, read from the label and the prompt. */
function unitFor(base, label, delegation) {
  const units = Array.isArray(base.units) ? base.units : []
  if (units.length === 0) return null
  const haystack = [label, delegation?.description, delegation?.prompt]
    .filter(entry => typeof entry === 'string' && entry !== '')
    .join('\n')
  if (haystack === '') return units.find(unit => unit.state === 'active')?.id ?? null
  for (const unit of units) {
    const id = unit.id
    const at = typeof id === 'string' ? haystack.indexOf(id) : -1
    if (at < 0) continue
    // A bare `includes` would match B7 against B70; the token has to end where the
    // id ends, or the note lands on the wrong packet.
    const before = at === 0 ? '' : haystack[at - 1]
    const after = haystack[at + id.length] ?? ''
    if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return id
  }
  const named = haystack.match(/(?:单元|unit|packet)\s*([A-Za-z][\w-]*)/i)
  if (named && units.some(unit => unit.id === named[1])) return named[1]
  const token = haystack.match(/\b([A-Za-z]\d{1,3})\b/)
  if (token && units.some(unit => unit.id === token[1])) return token[1]
  return units.find(unit => unit.state === 'active')?.id ?? null
}

/**
 * A child was published: remember it and put the dispatch in its packet's notes.
 *
 * The label is the parent's own description of the work, and the delegated call
 * that immediately preceded the catalog carries the prompt — that pair is enough
 * to place almost every child on the unit it belongs to. When neither names a
 * unit the active one is the honest fallback: the board says where the work is
 * being done, and the model can correct it with a note.
 */
function foldCatalog(base, event, data) {
  const childId = typeof data.childId === 'string' ? data.childId : null
  if (!childId) return base
  const label = typeof data.label === 'string' ? data.label.trim() : ''
  const delegation = base.lastDelegation ?? null
  const unit = unitFor(base, label, delegation)
  const at = typeof event.time === 'number' ? event.time : null
  const entry = {
    ...(base.childMeta?.[childId] ?? {}),
    label,
    at,
    state: 'dispatched',
    ...(unit ? { unit } : {}),
    ...(delegation?.description ? { description: delegation.description } : {}),
  }
  const next = {
    ...base,
    lastDelegation: null,
    childMeta: { ...(base.childMeta ?? {}), [childId]: entry },
    ...(unit ? { childUnits: { ...(base.childUnits ?? {}), [childId]: unit } } : {}),
  }
  if (!unit) return next
  return {
    ...next,
    units: noteUnit(next.units, unit, { at, text: `子代理派出 · ${label || childId.slice(0, 8)}` }),
  }
}

/**
 * A child said something back: land it in the packet it belongs to.
 *
 * `agent-message` is relayed prose (possibly several messages during one run);
 * `subagent-settled` is the host's closing notice, which repeats the child's final
 * message. Keeping both would print the same report twice, so the settled notice
 * only contributes the report when the child never relayed one.
 */
function foldChildMessage(base, event, data, source) {
  const kind = source.kind
  const text = childMessageText(data)
  const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : null
  if (!childId) return base
  const prior = asObject(base.childMeta?.[childId])
  const report = text.length > 360 ? `${text.slice(0, 357)}…` : text
  const settled = kind === 'subagent-settled'
  const entry = {
    ...prior,
    // A relayed message is proof the child was alive when it sent it; the settled
    // notice is the only thing that says it stopped. A catalog row alone stays
    // `dispatched` — it says the child exists, not that it is doing anything.
    state: settled ? 'settled' : 'running',
    ...(report ? { report } : {}),
    ...(settled ? { endedAt: typeof event.time === 'number' ? event.time : prior.endedAt ?? null } : {}),
  }
  const unit = base.childUnits?.[childId] ?? prior.unit ?? unitFor(base, '', null)
  const next = {
    ...base,
    childMeta: { ...(base.childMeta ?? {}), [childId]: entry },
    ...(unit && !base.childUnits?.[childId]
      ? { childUnits: { ...(base.childUnits ?? {}), [childId]: unit } }
      : {}),
  }
  if (!report) return next
  // The settled notice is the same sentence the child already relayed, not a new
  // one: it updates the state without writing a second identical line.
  if (settled && prior.report) return next
  if (!unit) return next
  return {
    ...next,
    units: noteUnit(next.units, unit, { at: typeof event.time === 'number' ? event.time : null, text: `子代理回报 · ${report}` }),
  }
}

/** Fold one session event into the board state. Unknown events change nothing. */
export function foldBoard(state, event) {
  const base = state ?? EMPTY
  const data = asObject(event?.data)
  // Child work enters this log through two doorways, neither of which is a
  // `work_*` call: the catalog row that publishes the child, and the relayed
  // message that carries what it said. Folding only the bookkeeping calls left
  // both invisible.
  if (event?.type === 'subagent/catalog') return foldCatalog(base, event, data)
  if (event?.type === 'user/message') {
    const source = asObject(data.source)
    if (source.kind === 'agent-message' || source.kind === 'subagent-settled') {
      return foldChildMessage(base, event, data, source)
    }
    return base
  }
  if (event?.type === 'tool/result') return foldResult(state, asObject(data.message))
  if (event?.type !== 'tool/call') return base
  if (typeof data.name !== 'string') return base
  // The fold already sees every tool call; only the `work_*` ones used to change
  // anything, so a session grinding away without bookkeeping froze the board into
  // looking dead. The heartbeat counts the calls and stamps the log's own time and
  // seq — the fold reads no clock of its own, so replaying the log still produces
  // the same picture. Every branch below carries it, so no return path drops it.
  const beats = data.confirmed ? base.beats : {
    calls: (base.beats?.calls ?? 0) + (data.confirmed ? 0 : 1),
    lastAt: typeof event.time === 'number' ? event.time : base.beats?.lastAt ?? null,
    lastSeq: typeof event.seq === 'number' ? event.seq : base.beats?.lastSeq ?? 0,
  }
  const current = { ...base, beats }
  const activeId = (base.units ?? []).find(unit => unit.state === 'active')?.id ?? null
  if (activeId !== (base.since?.unit ?? null)) {
    current.since = activeId ? { unit: activeId, at: typeof event.time === 'number' ? event.time : null } : null
    current.check = null
  }
  if (DELEGATION.test(data.name)) {
    // The child keeps its own log; the board can still show that work left this
    // session, because a bar that looks idle while three subagents are running
    // tells the owner nothing true. The arguments are kept for the catalog that
    // follows this call: the label names the work, the prompt usually names the
    // unit, and neither is repeated anywhere else in the parent's log.
    const args = argsOf(data.arguments)
    return {
      ...current,
      delegations: (current.delegations ?? 0) + 1,
      lastDelegation: {
        callId: typeof data.callId === 'string' ? data.callId : null,
        name: data.name,
        description: typeof args.description === 'string' ? args.description : '',
        prompt: typeof args.prompt === 'string' ? args.prompt : '',
        at: typeof event.time === 'number' ? event.time : null,
      },
    }
  }
  if (!data.name.startsWith('work_')) {
    const command = argsOf(data.arguments).command
    if (!data.confirmed && typeof data.callId === 'string' && typeof command === 'string' && isCheck(command, current.verifier)) {
      return { ...current, pending: { ...current.pending, [data.callId]: { kind: 'check', name: data.name, command: command.trim() } } }
    }
    return current
  }
  const args = argsOf(data.arguments)
  if (!data.confirmed && typeof data.callId === 'string'
    && ['work_start', 'work_plan', 'work_submit', 'work_control'].includes(data.name)
    && !(data.name === 'work_control' && args.operation === 'status')) {
    return { ...current, pending: { ...current.pending,
      [data.callId]: { kind: 'apply', name: data.name, args, time: event.time } } }
  }
  // A work_start / work_submit is answered with a checkpoint ref and warnings. Keep
  // the call id so the answer can be attributed when the result event arrives.
  // A `work_start` / `work_submit` answer carries the checkpoint and the settlement;
  // an `adopt` / `import` / status answer carries a task snapshot. Keep the call id
  // for all four: a session that inherited its task has no `work_start` in its log,
  // and that snapshot is the only description of the work the board can seed from.
  const kindOf = name => name === 'work_start' ? 'start'
    : name === 'work_submit' ? 'submit'
      : name === 'work_control' || name === 'work_status' ? 'snapshot' : undefined
  const answerKind = kindOf(data.name)
  const pending = answerKind && typeof data.callId === 'string'
    ? { ...current.pending, [data.callId]: answerKind }
    : current.pending
  const live = pending === current.pending ? current : { ...current, pending }
  switch (data.name) {
    case 'work_start': {
      // A new task resets the plan but not the heartbeat: the calls before the
      // call that registered it really happened in this session.
      return {
        ...EMPTY,
        // The session id is not part of the task: a restart must not lose the key
        // the live child registry is queried with.
        sessionId: current.sessionId,
        beats,
        mode: typeof args.mode === 'string' ? args.mode : 'do',
        request: typeof args.request === 'string' ? args.request : null,
        goal: typeof args.goal === 'string' ? args.goal : null,
        acceptance: asStrings(args.acceptance),
        units: Array.isArray(args.plan) ? mergeUnits([], unitsOf(args.plan)) : Array.isArray(args.plan?.units) ? mergeUnits([], unitsOf(args.plan.units)) : [],
        taskState: 'active',
        program: typeof args.program === 'string' && args.program.trim() !== '' ? args.program.trim() : null,
        pending,
      }
    }
    case 'work_plan': {
      if (args.operation === 'set') return { ...current, units: mergeUnits([], unitsOf(args.units)) }
      if (args.operation === 'add') return { ...current, units: mergeUnits(current.units, unitsOf(args.units)) }
      // The progress note: one appended line, folded exactly as the record stores
      // it. It changes no state — the unit keeps whatever state it had — so the
      // board gains a sentence without gaining a claim. It is committed only when
      // the host answers the call: folding the arguments alone put a refused probe
      // call on the board as a real line of progress.
      if (args.operation === 'note' && typeof args.unit === 'string'
        && typeof args.text === 'string' && args.text.trim() !== '') {
        const note = { kind: 'note', unit: args.unit, text: args.text.trim(), at: typeof event.time === 'number' ? event.time : null }
        return typeof data.callId === 'string'
          ? { ...current, pending: { ...current.pending, [data.callId]: note } }
          : current
      }
      if (typeof args.unit !== 'string') return current
      if (args.operation === 'activate') return { ...current, units: setUnitState(current.units, args.unit, 'active') }
      if (args.operation === 'state' && typeof args.state === 'string') return { ...current, units: setUnitState(current.units, args.unit, args.state) }
      return current
    }
    case 'work_submit': {
      const outcome = typeof args.outcome === 'string' ? args.outcome : 'partial'
      const unitId = typeof args.unit === 'string' ? args.unit : current.units.find(unit => unit.state === 'active')?.id
      const units = unitId && outcome === 'complete' ? setUnitState(current.units, unitId, 'done')
        : unitId && outcome === 'failed' ? setUnitState(current.units, unitId, 'blocked')
          : current.units
      // A submission that closes the task has to say so: the bar draws pause/resume/cancel
      // from `taskState`, and a task whose last unit is done still looked "active" — the
      // strip kept offering buttons for work the host had already closed.
      // Only leaves count. A milestone row is a heading for its children and never
      // reports itself done, so "every unit is done" was never true for a nested
      // plan — a finished three-unit task still showed 进行中 with 3/3.
      const leaves = units.filter(unit => !units.some(candidate => candidate.parent === unit.id))
      const settled = outcome !== 'complete' ? 'active'
        : leaves.length === 0 || leaves.every(unit => unit.state === 'done') ? 'closed' : 'active'
      return {
        ...current,
        units,
        taskState: settled,
        submits: current.submits + 1,
        pending,
        last: {
          outcome,
          summary: typeof args.summary === 'string' ? args.summary : '',
          next: typeof args.next === 'string' ? args.next : '',
          unit: unitId ?? null,
          residue: asStrings(args.residue),
          // How much of the submission pointed at a real run. The board says the
          // count, not the verdict: the host is the one that decides whether those
          // references were good.
          claims: Array.isArray(args.claims) ? args.claims.length : 0,
        },
      }
    }
    case 'work_control': {
      // The bar has pause/resume/cancel buttons, so the board has to show the
      // task state those buttons change — otherwise a paused task looks active
      // and a cancelled one looks like it is still waiting for the next unit.
      const states = { pause: 'paused', resume: 'active', continue: 'active', cancel: 'cancelled' }
      const nextState = states[args.operation]
      return nextState ? { ...live, taskState: nextState } : live
    }
    default:
      return live
  }
}

/** Both the row's newest line and the trail behind it travel to the board: the
 * row needs one line, the expander needs every line it can open. */
function noteFields(unit) {
  const trail = Array.isArray(unit.notes) ? unit.notes : []
  if (trail.length === 0) return {}
  return {
    note: trail[trail.length - 1].text,
    notes: trail.map(entry => ({ at: entry.at ?? null, text: entry.text })),
  }
}

/** The trail a packet carries, with the live child line appended when there is one. */
function notesOf(unit, liveNotes) {
  const extra = liveNotes?.get(unit.id) ?? []
  if (extra.length === 0) return unit.notes
  return [...(unit.notes ?? []), ...extra.map(text => ({ at: null, text }))]
}

/** Milestones for display: a root with children becomes one row, everything else its own. */
function groupsOfUnits(units, liveNotes, proofs) {
  const roots = units.filter(unit => !unit.parent)
  const groups = []
  for (const root of roots) {
    const children = units.filter(unit => unit.parent === root.id)
    if (children.length === 0) continue
    // Same rule as the plan: half-landed is in progress, not "not started".
    const state = children.every(child => child.state === 'done')
      ? 'done'
      : children.some(child => child.state === 'active') || children.some(child => child.state === 'done')
        ? 'active' : (root.state ?? 'pending')
    groups.push({
      id: root.id,
      label: root.goal,
      // The bucket is a container too, but the panel draws it apart: it is where
      // small work lives, not a campaign, and it must never be counted as one.
      ...(root.role === 'daily' ? { role: 'daily' } : {}),
      state,
      // The child rows carry what the leaf rows carry: a unit inside a theme
      // promises things and waits on people just as often as a loose one, and the
      // panel should not lose that because its parent has children.
      units: children.map(child => ({
        id: child.id,
        goal: child.goal,
        state: child.state,
        ...noteFields({ notes: notesOf(child, liveNotes) }),
        ...(child.deliverable ? { deliverable: child.deliverable } : {}),
        ...(child.asked ? { asked: child.asked } : {}),
        ...(proofs?.[child.id]?.length ? { claims: proofs[child.id] } : {}),
      })),
    })
  }
  return groups
}

/** Everything the panel needs, computed once per read. */
export function boardOf(state, live) {
  const current = state ?? EMPTY
  if (!current.mode) return null
  // Live children come from the lifecycle registry, which is the only place a
  // running child's model, effort and current tool are known. The fold cannot
  // produce them: they are not in this session's log. Merging them here keeps the
  // stored board durable and the running picture current.
  const liveRows = typeof live === 'function' ? live() : Array.isArray(live) ? live : []
  const liveById = new Map()
  for (const row of liveRows) {
    if (row && typeof row.childId === 'string') liveById.set(row.childId, row)
  }
  const childNotes = new Map()
  const children = []
  const meta = current.childMeta ?? {}
  const unitOfChild = current.childUnits ?? {}
  for (const [childId, raw] of Object.entries(meta)) {
    const entry = asObject(raw)
    const row = liveById.get(childId)
    const unit = unitOfChild[childId] ?? entry.unit ?? null
    const childState = row?.state ?? entry.state ?? 'dispatched'
    // Only a running child has "what it is doing now"; a settled one's last tool
    // is history, not activity, and showing it as current would be a lie.
    const activity = childState === 'running' ? row?.activity ?? null : null
    const model = row?.model ?? null
    const effort = row?.effort ?? null
    children.push({
      id: childId,
      unit,
      label: entry.label || row?.label || '',
      model,
      provider: row?.agentProvider ?? null,
      effort,
      state: childState,
      startedAt: entry.at ?? row?.startedAt ?? null,
      settledAt: entry.endedAt ?? row?.settledAt ?? null,
      activity,
      report: entry.report ?? row?.reported ?? null,
      written: row?.writes?.length ?? 0,
      checked: row?.checks?.length ?? 0,
    })
    // The activity line needs a live row: without one, all the fold knows is that
    // a child was dispatched, and a generic "正在做" would crowd out its report.
    if (unit && childState === 'running' && row) {
      const stamp = [model, effort].filter(Boolean).join(' · ')
      const text = `子代理${stamp ? ` ${stamp}` : ''} 正在做 · ${activity?.text || row.label || entry.label || '已派出'}`
      childNotes.set(unit, [...(childNotes.get(unit) ?? []), text])
    }
  }
  // A child that started while this host was running but whose catalog row has
  // not arrived yet still deserves a line; it is not attached to a packet, so it
  // appears in the child strip only.
  for (const row of liveRows) {
    if (!row || typeof row.childId !== 'string' || meta[row.childId]) continue
    children.push({
      id: row.childId,
      unit: null,
      label: row.label ?? '',
      model: row.model ?? null,
      provider: row.agentProvider ?? null,
      effort: row.effort ?? null,
      state: row.state ?? 'running',
      startedAt: row.startedAt ?? null,
      settledAt: row.settledAt ?? null,
      activity: row.activity ?? null,
      report: row.reported ?? null,
      written: row.writes?.length ?? 0,
      checked: row.checks?.length ?? 0,
    })
  }
  // A milestone is a container, so progress counts the units inside it. Counting
  // the container as one more row made a plan of two milestones read "1/3".
  const parents = new Set(current.units.filter(unit => unit.parent).map(unit => unit.parent))
  const leaves = current.units.filter(unit => !parents.has(unit.id))
  const { total, done } = planProgress(current.units)
  const active = leaves.find(unit => unit.state === 'active')
  const next = leaves.find(unit => unit.state === 'pending'
    && (unit.dependsOn ?? []).every(id => current.units.find(row => row.id === id)?.state === 'done'))
  const lane = modeLabel(current.mode)
  return {
    taskId: current.taskId ?? null,
    // The project's history, newest first; the board draws the current task and
    // lists the rest under it. Each row is read-only: a past task is a record.
    timeline: Array.isArray(current.timeline) ? current.timeline : [],
    mode: current.mode,
    lane,
    goal: current.goal || current.request || '',
    // 0/1 means it was never revised; past that the panel prints "第 N 版".
    goalRevision: current.goalRevision ?? 0,
    // A closed task has no next step; repeating the submission's own `next` made the bar
    // read like work was still queued ("无（look 车道到此为止）" shown as the current task).
    next: (current.taskState === 'active' && current.clarify?.waiting
      ? `${current.clarify.waiting === 'user-answer' ? '等待回答' : '等待选择'}：${current.clarify.pending.join('；')}` : null)
      ?? active?.goal ?? next?.goal ?? (current.taskState === 'closed' || current.taskState === 'cancelled'
      ? '' : current.last?.next) ?? (total === 0 ? current.goal || current.request || '' : ''),
    taskState: current.taskState,
    acceptanceMode: current.acceptanceMode,
    acceptance: current.acceptance ?? [],
    unverified: current.unverified ?? [],
    hasReceipt: Boolean(current.hasReceipt),
    clarify: current.clarify ?? null,
    counting: total > 0 ? { done, total, label: `${done}/${total}` } : { done: 0, total: 0, label: current.submits > 0 ? '已交付' : '未开始' },
    units: current.units.map(unit => ({
      id: unit.id, goal: unit.goal, state: unit.state,
      // The newest progress line, verbatim, plus the trail the expander opens.
      // The panel may decide how to show it; the fold only carries what was written.
      ...noteFields({ notes: notesOf(unit, childNotes) }),
      ...(unit.parent ? { parent: unit.parent } : {}),
      ...(unit.deliverable ? { deliverable: unit.deliverable } : {}),
      ...(unit.asked ? { asked: unit.asked } : {}),
      ...(current.proofs?.[unit.id]?.length ? { claims: current.proofs[unit.id] } : {}),
    })),
    milestones: groupsOfUnits(current.units, childNotes, current.proofs),
    // The dock's pulse: which unit is running, since when, and how its last check
    // went. Only while that unit is still the one in flight.
    pulse: current.since?.unit && current.units.some(unit => unit.id === current.since.unit && unit.state === 'active')
      ? { unit: current.since.unit, since: current.since.at, check: current.check ?? null }
      : null,
    reminders: Array.isArray(current.reminders) ? current.reminders : null,
    delegations: current.delegations ?? 0,
    // Every child this task delegated, with the model and effort the child's own
    // descriptor states, the tool it is on now, and the last thing it reported.
    // The panel can show this without a second request: it is part of the board.
    children,
    running: children.filter(child => child.state === 'running').length,
    checkpoints: current.checkpoints ?? 0,
    marks: Array.isArray(current.marks) ? current.marks : [],
    warnings: current.warnings ?? 0,
    // The sentences themselves, not just the count: a panel that says "2" and
    // hides what they were is worse than not showing the chip at all.
    warningLines: Array.isArray(current.warningLines) ? current.warningLines : [],
    program: current.program,
    project: current.project,
    gates: current.gates,
    last: current.last,
    // The heartbeat, passed through as counted facts: how many calls and the
    // log stamp of the last one. What the panel says with it is its own choice;
    // the fold asserts nothing beyond the count.
    beats: current.beats ?? null,
    // The band under the plan: what the project already knows, what it can run, and
    // where the rest of the work went. All of it came out of tool results, so none of
    // it can be asserted by the model.
    assets: {
      verifier: current.verifier,
      memory: current.memory === null || current.memory === undefined ? null : {
        facts: asObject(current.memory.counts).facts ?? 0,
        incidents: asObject(current.memory.counts).incidents ?? 0,
        items: asStrings(current.memory.facts).slice(-2),
      },
      checkpoint: { count: current.checkpoints ?? 0, ref: current.checkpoint },
      children: (current.children ?? []).map(child => ({
        written: asStrings(asObject(child).writes).length,
        checked: asStrings(asObject(child).checks).length,
        state: typeof asObject(child).state === 'string' ? asObject(child).state : undefined,
      })),
    },
  }
}

export const boardSchema = {
  parse(value) {
    if (value === null || value === undefined) return null
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Auto Dev v3 board')
    return value
  },
}

/**
 * Seed the board from the task record, whoever holds the task right now.
 *
 * The fold alone cannot draw the two moments that matter most. Right after the
 * person runs `/dsh-auto-dev start` on unfinished work, the command adopts the task
 * and opens a turn: the log of that session holds a `command/run` and an ordinary
 * user message, and not one `work_*` call, so a log-only board stays empty and the
 * person cannot tell whether anything happened. Later, once the task is handed to
 * another window, the first session's log still ends at the hand-off, so it keeps
 * drawing a task it no longer owns.
 *
 * Both are the same defect: the record is the root and the log is the detail. The
 * record supplies what the task *is* (id, lane, goal, units, their states), the
 * fold supplies what the record does not keep (the last submission, the checks,
 * the heartbeat). Reading it on `init`, on every `apply` and on every `view` is
 * what makes the panel appear at the command itself, in whichever session holds
 * the task, and stay right across a reload without a replay.
 *
 * Returns the same object when the record says nothing new: the host treats a
 * changed state as work to push, so an unrelated event must not look like one.
 */
/** Same units, same states, same notes: then the reference can stay put. */
function sameUnits(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

export function syncState(state, store) {
  const current = state ?? EMPTY
  if (!store || typeof store.taskFor !== 'function') return current
  const session = typeof current.sessionId === 'string' ? current.sessionId : ''
  if (!session) return current
  let found
  try { found = store.taskFor(session) } catch { found = undefined }
  const task = asObject(found?.task)
  const mode = typeof task.mode === 'string' && task.mode.trim() !== '' ? task.mode.trim() : ''
  if (!mode) return current
  const plan = asObject(found?.plan)
  const rows = Array.isArray(plan?.units) ? plan.units : []
  const taskId = typeof task.id === 'string' ? task.id : null
  const request = typeof task.request === 'string' ? task.request : null
  const goal = typeof task.goal === 'string' && task.goal.trim() !== '' ? task.goal.trim() : request
  const taskState = typeof task.state === 'string' && task.state.trim() !== '' ? task.state.trim() : null
  const acceptanceMode = task.acceptanceMode === 'auto' ? 'auto' : task.acceptanceMode === 'pm' ? 'pm' : (current.acceptanceMode ?? null)
  const facts = taskStatus(task, plan)
  const evidenceView = facts.task
  // Whether the work was agreed on before it started: a fact about the record,
  // not something the log can answer once the receipt was written elsewhere.
  const hasReceipt = task.receipt === undefined || task.receipt === null ? Boolean(current.hasReceipt) : true
  // What the person was asked, and what the model assumed when they stayed quiet.
  const pending = facts.pending
  const clarify = task.clarify || pending.waiting
    ? { asked: (task.clarify?.asked ?? []).length, answered: (task.clarify?.answers ?? []).length,
      assumption: typeof task.clarify?.assumption === 'string' ? task.clarify.assumption : null,
      waiting: pending.waiting, pending: pending.lines }
    : current.clarify ?? null
  const project = typeof task.project === 'string' && task.project.trim() !== '' ? task.project.trim() : current.project
  // How many goal sentences there have been; derived, so a rephrase does not move it.
  const goalRevision = Array.isArray(task.goalHistory) ? task.goalHistory.length : (current.goalRevision ?? 0)
  // Everything the units depend on, and nothing else: a new note on a unit is a
  // `plan.updatedAt` change, a new unit changes the count.
  // The checkpoint rows travel with the board: the panel draws "before / after" on
  // a row from them, and a person should not have to call a tool to see them.
  const marks = Array.isArray(task.checkpoints)
    ? task.checkpoints.map(row => ({
      seq: asObject(row).seq, tag: asObject(row).tag,
      // `boss` is the name this field had before the copy went neutral; both spell
      // the same thing, and old checkpoints keep drawing.
      ...(typeof asObject(row).unit === 'string' ? { unit: asObject(row).unit } : (typeof asObject(row).boss === 'string' ? { unit: asObject(row).boss } : {})),
      ...(typeof asObject(row).label === 'string' ? { label: asObject(row).label } : {}),
      ...(typeof asObject(row).outcome === 'string' ? { outcome: asObject(row).outcome } : {}),
    }))
    : null
  // What each unit's last settlement rested on: a recorded run, or steps a person
  // still has to do. The panel marks each claim; it asserts nothing itself.
  const ledger = Array.isArray(task.ledger) ? task.ledger : []
  const proofs = {}
  for (const entry of ledger) {
    const row = asObject(entry)
    if (typeof row.unit !== 'string' || !Array.isArray(row.claims)) continue
    proofs[row.unit] = row.claims.map(raw => {
      const claim = asObject(raw)
      const execution = asObject(claim.execution)
      return {
        text: typeof claim.statement === 'string' ? claim.statement : '',
        proven: typeof execution.callId === 'string',
        ...(typeof execution.command === 'string' ? { command: execution.command } : {}),
      }
    }).filter(claim => claim.text)
  }
  // A settlement written before reminders existed has none; null says "not known",
  // so the panel can fall back to the model's warnings instead of showing nothing.
  const lastEntry = asObject(ledger[ledger.length - 1])
  const reminders = Array.isArray(lastEntry.reminders) ? asStrings(lastEntry.reminders) : null
  const signature = [taskId, task.updatedAt ?? '', taskState ?? '', plan?.updatedAt ?? '', rows.length, marks?.length ?? 0].join('\u0000')
  // The record is the authority for what the plan says. The signature cache only
  // exists to keep the reference stable; when the fold replaying this session's
  // own older events overwrote units with a stale picture (a task continued in
  // another session is exactly that), the record wins.
  const seeded = seedUnitsOf(rows)
  const units = sameUnits(current.units, seeded) ? current.units : seeded
  // Old tasks hold checkpoints written before a checkpoint named a unit; the count
  // is the only thing those rows can still say, so the panel gets it as a number.
  const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints.length : (current.checkpoints ?? 0)
  // The timeline is read from the store, not derived from this log: a task started
  // in another window is invisible here otherwise. Same signature trick as above —
  // the rows carry `updatedAt`, so a task that moved moves the reference.
  let timeline = current.timeline ?? null
  if (typeof store.timeline === 'function') {
    let rows
    try { rows = store.timeline(session) } catch { rows = undefined }
    if (Array.isArray(rows)) timeline = rows.length ? rows : null
  }
  const timelineSignature = Array.isArray(timeline) ? timeline.map(row => `${row?.id}#${row?.updatedAt ?? ''}`).join('|') : null
  const sameMarks = current.marks === marks || (Array.isArray(current.marks) && Array.isArray(marks)
    && current.marks.length === marks.length
    && JSON.stringify(current.marks.slice(-1)) === JSON.stringify(marks.slice(-1)))
  if (current.taskId === taskId && current.mode === mode && current.request === request && current.goal === goal
    && (current.goalRevision ?? 0) === goalRevision
    && current.taskState === taskState && current.acceptanceMode === acceptanceMode
    && JSON.stringify(current.acceptance ?? []) === JSON.stringify(evidenceView.acceptance)
    && JSON.stringify(current.unverified ?? []) === JSON.stringify(evidenceView.unverified)
    && Boolean(current.hasReceipt) === hasReceipt
    && JSON.stringify(current.clarify ?? null) === JSON.stringify(clarify)
    && current.project === project && current.units === units
    && current.checkpoints === checkpoints
    && sameTimeline(current.timeline, timeline)
    && JSON.stringify(current.proofs ?? {}) === JSON.stringify(proofs)
    && JSON.stringify(current.reminders ?? null) === JSON.stringify(reminders)
    && sameMarks && current.seeded === signature) {
    return current
  }
  return { ...current, acceptance: evidenceView.acceptance, unverified: evidenceView.unverified, taskId, mode, request, goal, goalRevision, taskState, acceptanceMode, hasReceipt, clarify, project, units, marks, checkpoints, timeline, proofs, reminders, seeded: signature }
}

/**
 * Two timelines are the same picture when their rows and their `updatedAt` agree.
 * JSON.stringify on the whole array would also do, but the array carries every
 * unit of every task and the panel reads it once per event.
 */
function sameTimeline(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (String(left[i]?.id) !== String(right[i]?.id)) return false
    if (String(left[i]?.updatedAt ?? '') !== String(right[i]?.updatedAt ?? '')) return false
  }
  return true
}

/**
 * Bumped whenever the fold changes what a given log produces. The host caches
 * folded cells per key; keeping the version at 1 after the parser fix meant a
 * session kept showing the board the broken fold had produced (an empty goal and
 * a phantom "partial"), because a cached cell at the same version is reused
 * instead of re-folded. Any change to `foldBoard`, `boardOf` or the seeding of
 * either must bump this.
 */
export const BOARD_STATE_VERSION = 23

/**
 * Register the board with the session projection registry.
 *
 * `register()` returns the exact disposer that unregisters the unit, and a
 * registration that is never released outlives the plugin instance that made it:
 * after a reload the service still held the *first* registration (stateVersion 1,
 * produced by a build that could not read JSON arguments), every later attempt
 * could not take the key, and the panel kept showing an empty board while the log
 * said otherwise. The registration is therefore owned by `ctx.effect`.
 */
export function registerBoard(ctx, options = {}) {
  const liveOf = typeof options.children === 'function' ? options.children : null
  const store = options.store ?? null
  // `wire.view` gets state and nothing else, so the session id is seeded into the
  // state by `init`. The registry calls `init` once per session cell; a missing
  // id (an old host that does not pass a header) degrades to "no live children",
  // which is exactly what the log-only board showed before.
  //
  // The view reads the store again rather than trusting the state: it is the one
  // call that happens after a restart, a hand-off and a tab switch alike, and the
  // record is the only thing that is always current.
  const view = state => {
    const seeded = syncState(state, store)
    if (!liveOf) return boardOf(seeded)
    let live
    try { live = liveOf(seeded) } catch { live = [] }
    return boardOf(seeded, live ?? [])
  }
  const disposer = ctx.sessionProjections.register({
    key: 'autoDevV3',
    stateSchema: boardSchema,
    init: header => syncState({ ...EMPTY, sessionId: header?.id ?? null }, store),
    apply: (state, event) => syncState(foldBoard(state, event), store),
    wire: { viewSchema: boardSchema, view },
    stateVersion: BOARD_STATE_VERSION,
  })
  if (typeof ctx.effect === 'function') ctx.effect(() => () => disposer.dispose?.())
  return disposer
}

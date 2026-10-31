/**
 * Evidence is read out of the session log, never out of the model's prose.
 * A claim can only pass while the referenced call exists in this session, did
 * not fail, and no file-changing call ran after it.
 */

const WRITE_TOOLS = new Set([
  'write', 'edit', 'multi_edit', 'apply_patch', 'apply_patch_edit', 'create_file',
  'str_replace', 'insert', 'delete', 'move', 'copy', 'notebook_edit',
])

/** Tool arguments that carry a shell command in DSH and in common MCP servers. */
function commandOf(name, args) {
  if (typeof args?.command === 'string') return args.command
  if (typeof args?.cmd === 'string') return args.cmd
  if (typeof args?.script === 'string') return args.script
  return undefined
}

function callDetails(call) {
  if (!call) return {}
  let args = call.arguments
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
  const command = commandOf(call.name, args)
  return {
    ...(call.name ? { name: call.name } : {}),
    ...(Number.isInteger(call.callSeq) ? { callSeq: call.callSeq } : {}),
    ...(/ask_user_question$/.test(call.name ?? '') ? { question: args } : {}),
    ...(command ? { command } : {}),
    ...(typeof args?.description === 'string' ? { description: args.description } : {}),
    ...(Array.isArray(args?.paths) ? { paths: args.paths } : {}),
    ...(typeof args?.path === 'string' ? { path: args.path } : {}),
    ...(typeof args?.file_path === 'string' ? { path: args.file_path } : {}),
  }
}

/**
 * The option labels a person picked in a question the agent asked.
 *
 * An answer chosen from a presented list is the owner's own decision, but it arrives
 * as a tool result rather than as a typed message, so a gate that only reads user
 * messages would tell a product owner who answered a question that they said nothing.
 * The labels are kept apart from typed words (`via`) so the record stays honest about
 * which one it was.
 */
export function choiceTexts(observations) {
  const texts = []
  for (const row of observations?.results ?? []) {
    if (!/ask_user_question$/.test(row.name ?? '')) continue
    for (const block of row.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  return texts
}

/** The text of a failed result, so a refusal can be told apart from a failure. */
function errorText(content = []) {
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text.slice(0, 400)
  }
  return undefined
}

/**
 * A call the pre-execute gate refused before it ran. The gate's own refusals start
 * with the plugin name, which is how this stays distinguishable from a command that
 * really ran and failed: the first changed nothing, the second may have.
 */
export function wasRefused(row) {
  return !!row?.isError && typeof row?.errorText === 'string' && /^(?:Error: )?dsh-auto-dev[: ]/.test(row.errorText)
}

/** DSH shell renderers report process failure in a terminal status suffix, not isError. */
function shellStatus(content, name) {
  if (!['bash', 'pwsh', 'shell'].includes(name)) return {}
  const status = {}
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    // Match the host's footer, never words such as "failed" in program output.
    const footer = /(?:\n\[(?:exit code: -?\d+|exit code: null|killed by signal: [^\]\n]+|timed out after \d+ms|stopped: [^\]\n]*)\])+$/.exec(block.text)?.[0]
    if (!footer) continue
    // The renderer appends the real process status last, after arbitrary stdout.
    const exit = /\[exit code: (-?\d+|null)\]$/.exec(footer)
    const signal = /\[killed by signal: ([^\]\n]+)\]$/.exec(footer)
    if (exit) status.exitCode = exit[1] === 'null' ? null : Number(exit[1])
    if (signal) status.signal = signal[1]
    if (footer.includes('[timed out after ')) status.timedOut = true
    if (footer.includes('[stopped: ')) status.aborted = true
  }
  return status
}

function resultDetails(content = [], name) {
  const status = shellStatus(content, name)
  for (const block of content) {
    if (block?.type !== 'text') continue
    try {
      const value = JSON.parse(block.text)
      if (value && typeof value === 'object') {
        return { value, ...Object.fromEntries(['exitCode', 'signal', 'aborted', 'timedOut']
          .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])), ...status }
      }
    } catch { /* not JSON — the text itself is still the evidence */ }
  }
  return status
}

/**
 * Collect every tool result from `startSeq` to the end of the session.
 * Dispatch records (`tool/code-dispatch`, `tool/ptc-dispatch`) count as results
 * because a PTC program's inner call is a real execution with its own call id.
 *
 * The whole-session read (`startSeq` 0) runs on every hook and most tools, so it
 * is incremental: the log is append-only, and a per-session cache resumes from
 * where the last read stopped. Rows are frozen and shared between reads — callers
 * filter, they never edit. A window read (`startSeq` > 0) stays a plain scan: it
 * is bounded, and a call made before the window must stay unknown to it.
 */
export function collectObservations(session, startSeq = 0) {
  if (!session) return { source: 'session-log', sessionId: undefined, startSeq, endSeq: 0, results: [] }
  const sessionId = session.id ?? session.header?.id
  const end = session.seq ?? 0
  if (startSeq > 0 || sessionId === undefined) {
    const scan = { calls: new Map(), rows: [] }
    scanEvents(session, scan, startSeq, end)
    return { source: 'session-log', sessionId, startSeq, endSeq: end, results: scan.rows }
  }
  // The same session object may trust a matching event shape; a session reached
  // only by id (hosts hand out a fresh wrapper per agent) must show the very same
  // event objects, so two logs that merely share an id never share a scan.
  let scan = scansBySession.get(session)
  if (!scan || !continues(session, scan, end, true)) {
    scan = scansById.get(sessionId)
    if (!scan || !continues(session, scan, end, false)) scan = { calls: new Map(), rows: [], end: 0 }
  }
  scansBySession.set(session, scan)
  scansById.delete(sessionId)
  scansById.set(sessionId, scan)
  if (scansById.size > SCAN_LIMIT) scansById.delete(scansById.keys().next().value)
  if (end > scan.end) {
    scanEvents(session, scan, scan.end, end)
    scan.end = end
    scan.first = mark(session.eventAt(0))
    scan.last = mark(session.eventAt(end - 1))
  }
  return { source: 'session-log', sessionId, startSeq, endSeq: end, results: scan.rows.slice() }
}

const scansBySession = new WeakMap()
const scansById = new Map()
const SCAN_LIMIT = 16

/** Enough of an event to tell that the log under a cached scan is still the same log. */
const mark = event => event && typeof event === 'object'
  ? { event, key: `${event.type}|${event.time ?? ''}|${event.data?.callId ?? event.data?.message?.toolCallId ?? event.data?.subCallId ?? event.data?.id ?? ''}` }
  : undefined
const same = (event, seen, byShape) => event === seen?.event || (byShape && seen !== undefined && mark(event)?.key === seen.key)

function continues(session, scan, end, byShape) {
  if (end < scan.end) return false
  if (scan.end === 0) return true
  return same(session.eventAt(0), scan.first, byShape) && same(session.eventAt(scan.end - 1), scan.last, byShape)
}

function scanEvents(session, scan, from, end) {
  const { calls, rows } = scan
  const push = (seq, row) => {
    const time = session.eventAt(seq)?.time
    if (Number.isFinite(time)) row.time = time
    // Freeze the row and its own copy of the content, not the call arguments it
    // shares with the host's event.
    deepFreeze(row.content)
    rows.push(Object.freeze(row))
  }
  for (let seq = from; seq < end; seq++) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/call') calls.set(event.data.callId, { ...event.data, callSeq: seq })
    else if (event?.type === 'tool/result') {
      const message = event.data.message
      if (message?.toolCallId !== undefined) {
        push(seq, { seq, callId: message.toolCallId, ...callDetails(calls.get(message.toolCallId)),
          isError: !!message.isError, content: structuredClone(message.content ?? []), ...resultDetails(message.content, calls.get(message.toolCallId)?.name),
          ...(message.isError ? { errorText: errorText(message.content) } : {}) })
      }
      for (const block of message?.content ?? []) {
        if (block?.type !== 'tool-result') continue
        push(seq, { seq, callId: block.toolCallId, ...callDetails(calls.get(block.toolCallId)),
          isError: !!block.isError, content: structuredClone(block.content ?? []), ...resultDetails(block.content, calls.get(block.toolCallId)?.name),
          ...(block.isError ? { errorText: errorText(block.content) } : {}) })
      }
    } else if (event?.type === 'tool/code-dispatch' || event?.type === 'tool/ptc-dispatch') {
      push(seq, { seq, callId: event.data.subCallId, rootCallId: event.data.rootCallId,
        ...callDetails(event.data), isError: !!event.data.isError,
        content: structuredClone(event.data.content ?? []), ...resultDetails(event.data.content, event.data.name) })
    }
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * A call that handed work to another agent.
 *
 * Child sessions keep their own logs: their writes never appear in this task's
 * window, so neither scope nor staleness can speak for them. The honest response is
 * to record that the task delegated and require the parent to check the result
 * itself — not to pretend the window saw everything.
 */
/** Whether a tool result reports a failed run: the exit code the host printed, a signal, a timeout. */
export function resultFailed(content, name, isError) {
  return executionFailed({ isError, ...resultDetails(Array.isArray(content) ? content : [], name) })
}

export function executionFailed(row) {
  return !!(row?.isError || (row?.exitCode !== undefined && row.exitCode !== 0)
    || row?.signal || row?.aborted || row?.timedOut)
}

export function isDelegation(row) {
  return /^(subagent|spawn_agent|workflow)(?:_|$)/.test(row?.name ?? '')
}


/** Compact, replayable reference — enough context to pick the right claim. */
export function executionSummary(row) {
  return {
    callId: row.callId, seq: row.seq, ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    isError: row.isError,
    ...Object.fromEntries(['name', 'command', 'description', 'callSeq', 'exitCode', 'signal', 'aborted', 'timedOut']
      .filter(key => row[key] !== undefined)
      .map(key => [key, typeof row[key] === 'string' ? row[key].slice(0, 240) : row[key]])),
  }
}

import { describeChild, describeRecord } from '../child-sessions.mjs'
import { approvedReduction, reconcileDelegation, validateSubmission, windowObservations, windowStart } from '../task.mjs'
import { leafUnits, nextUnit } from '../plan.mjs'
import { deliveryOnce, reviewCard } from '../craft.mjs'
import { checkRuns, fixesIn, incidentsChangedAt, INCIDENTS_FILE, redStreak, runCheck, tailOf, trimIncidents } from '../facts.mjs'
import { changedPaths, fingerprint, markGreen, markSubmitted, marksOf, startOf } from '../disk.mjs'
import { blockedBy, readEnv } from '../env.mjs'
import { recordWaiting } from '../task-record.mjs'
import { GateError } from '../gate.mjs'
import { noteTrail } from '../trail.mjs'
import { shareIncidents } from '../team.mjs'
import { string, strings, claimsSchema, containersOf, childrenOf, DAILY_UNIT, stepName } from './shared.mjs'

/**
 * G1: the tree being handed in passed the project's check. When the last green
 * the plugin saw covers a different tree (or there was none), the plugin runs the
 * check itself — its own act, so nothing about the model's commands is guessed.
 */
async function g1(api, task, agent, verifier) {
  if (!verifier?.command) return undefined
  // Outside git there is no fingerprint to compare, so the check runs every time.
  const now = await fingerprint(task.project)
  const green = marksOf(task.id).green
  if (now && green?.print?.id === now.id) return undefined
  const result = await runCheck(task.project, verifier)
  // A refusal leaves the records as they were (P0 U01); a red here is told to the model on the spot.
  if (!result.ok) return { red: tailOf(result.output, 20) }
  await noteTrail(api.records, task.id, () => ({ check: { command: verifier.command.trim(), ok: true, tail: tailOf(result.output, 12), at: new Date().toISOString(), by: 'plugin' } }))
  await markGreen(task.project, task.id, api.seq(agent))
  // The plugin's own green is a run too: after the model's reds it closes the fix (G4).
  return { green: { seq: api.seq(agent), callId: 'plugin:g1', time: Date.now(), command: verifier.command.trim(), ok: true, output: tailOf(result.output, 20) } }
}

async function g3(task) {
  const start = await startOf(task)
  if (!start) return undefined
  const env = await readEnv(task.project)
  if (!env.blocked?.length) return undefined
  return blockedBy(env, await changedPaths(task.project, start, await fingerprint(task.project)))
}

/**
 * G4: a check that went red twice and then green is a fix, and a fix leaves a
 * postmortem in the incidents file. Whether it was a bug is the model's call —
 * one line「有意的红」there passes too. The plugin looks only at the file.
 */
function g4(task, runs) {
  const fix = fixesIn(runs).at(-1)
  if (!fix) return undefined
  // Written since the task started (file times on both sides, no clock compared to the log),
  // or, for a task this process did not see start, after the green run.
  const start = marksOf(task.id).incidentsAt
  const at = incidentsChangedAt(task.project)
  const written = start !== undefined ? at > start : at >= (fix.green.time ?? Infinity)
  return written ? undefined : fix
}

export const workSubmit = api => (
  // --------------------------------------------------------------- work_submit
  ['work_submit', `Submit outcome + summary (next optional); continue authorized work unless the result names a real wait. Claims use statement + execution.callId from work_status executions; complete with acceptance needs fresh successful evidence after writes. Declared ui tiers, scope, dependencies and authority remain enforced; a partial result does not complete remaining work.`, {
    taskId: string, unit: string, outcome: { type: 'string', enum: ['complete', 'partial', 'blocked', 'failed'] },
    preserve: { type: 'array', items: { type: 'string' } }, tier: { type: 'string', enum: ['L1', 'L2', 'L3'] },
    summary: string, next: string, claims: claimsSchema, files: strings, residue: strings,
    limitations: strings,
  }, ['outcome', 'summary'],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent), args.taskId)
    if (!task) return api.noTask(exec.agent)
    // Delivered and waiting, or paused: nothing to hand in. Say so instead of refusing.
    if (task.state && task.state !== 'active') {
      return { taskId: task.id, state: task.state, waiting: task.state === 'review_ready' ? 'user-review' : task.state === 'paused' ? 'user-pause' : undefined,
        tellUser: task.state === 'review_ready' ? '已经交付、在等用户看：不用再交，停下等他回话。' : `这个任务现在是 ${task.state}，没有记下这次提交；要接着做，先请用户恢复它。` }
    }
    const plan = api.planOf(task)
    // The unit handed in: the one named (a milestone means its next leaf), else the one in hand.
    // A unit still waiting on others is handed in anyway — the work was done; the order was the plan's guess.
    // The plugin's own hand-in (turn ended on the model's words) is the whole task: it marks no step
    // done — which steps are done is the model's to say (v54 handoff: README marked done after 「保持 pending」).
    const settling = exec.callId === 'dsh-auto-dev-settle'
    const named = settling ? undefined : plan?.units.find(entry => entry.id === args.unit) ?? plan?.units.find(entry => entry.state === 'active') ?? (plan ? nextUnit(plan) : undefined)
    const unit = named ? api.leafOf(plan, named.id) : undefined
    const window = windowObservations(api.observationsOf(exec.agent), task, unit)
    const verifier = api.detectVerifier(task.project)
    const verdict = validateSubmission({ task, unit, args, observations: window, config: { ...api.settings(), project: task.project, agent: exec.agent, verifier } })
    // A refusal is the plugin's call, not a failed tool: the person sees it once
    // per unit, in one line, instead of a red call they have to decode.
    const refused = line => api.blockedOnce(exec.agent, `submit:${task.id}:${unit?.id ?? ''}`,
      { unit: unit?.id, title: '拦下 · 交付退回', line })
    const runs = checkRuns(window.results, verifier)
    // What the model declared (mode, acceptanceMode) is shown, never what decides a gate (v54 look tasks skipped G1).
    const handIn = verdict.outcome === 'complete'
    // G3 on disk: a file the person ruled out changed since the task started,
    // whichever tool did it. Paths from two fingerprints, never shell text.
    const banned = handIn ? await g3(task) : undefined
    if (banned) {
      refused(`改到了禁区 ${banned.path} — 撤回再交`)
      throw new GateError('G3', `用户定过「${banned.row.value}」，这次改到了 ${banned.path}`, '撤回这处改动（可回存档）；真要动它，先问用户要不要解除这条')
    }
    // G1 vouches for a change: with the tree as it was at the start there is nothing to vouch
    // for (v46–v49: 「定位根因」 marked done, nothing written, refused for a red check).
    const start = await startOf(task)
    const nowPrint = start ? await fingerprint(task.project) : undefined
    const moved = !start || nowPrint?.id !== start.id
    // Whether the disk moved, when both trees can be read; undefined outside git.
    const changed = start && nowPrint ? nowPrint.id !== start.id : undefined
    const ran = handIn && moved ? await g1(api, task, exec.agent, verifier) : undefined
    const red = ran?.red
    if (ran?.green) runs.push(ran.green)
    // G1 skipped because the plugin's own green already covers this tree: that green is a run too,
    // or the 红 streak below would say 「还红着」 about a tree the plugin saw pass (v57 clarify #612).
    const covering = marksOf(task.id).green
    if (!ran && covering?.print && runs.length && !runs.at(-1).ok && nowPrint?.id === covering.print.id) {
      runs.push({ seq: covering.seq, callId: 'plugin:green', time: Date.now(), command: verifier?.command?.trim() ?? '', ok: true, output: '' })
    }
    if (red !== undefined) {
      refused(`交付前插件跑了 ${verifier.command}，没通过 — 修好再交`)
      throw new GateError('G1', `交付前插件在项目里跑了 \`${verifier.command}\`，没通过。输出末尾：\n${red}\n这是插件跑的检查，不是用户的新要求：如果用户同意过留着这条红，停下告诉他，别为过门去改他不让动的地方`, '修好让它通过，再交')
    }
    const fix = handIn ? g4(task, runs) : undefined
    if (fix) {
      refused(`修通过一次，${INCIDENTS_FILE} 还没写 — 写完再交`)
      throw new GateError('G4', `\`${fix.green.command}\` 红了 ${fix.reds.length} 次后转绿，${INCIDENTS_FILE} 没有变化`,
        `把这次写进 ${INCIDENTS_FILE}：症状、试过的方向、根因、修法、验证命令；红是有意的就写一行「有意的红」`)
    }
    // The project's postmortems go to the team's place too (D2), trimmed first.
    if (handIn) { trimIncidents(task.project); shareIncidents(task.project) }
    // The same doubts as `warnings`, in the words the person reads on the receipt
    // and the board; `warnings` stays the model's instruction.
    const reminders = []
    // Read what the children did, so a delegation warning says something a
    // person can act on instead of "their writes are not in this task's log".
    const children = verdict.delegations ? await api.childWork(window.results, exec.agent) : []
    for (const child of children) verdict.warnings.push(child.state ? describeRecord(child) : describeChild(child))
    verdict.warnings = reconcileDelegation(verdict.warnings, children)
    const now = new Date().toISOString()
    const entry = {
      at: now, outcome: verdict.outcome, summary: verdict.summary, next: verdict.next,
      ...(unit ? { unit: unit.id } : {}), claims: verdict.claims, warnings: verdict.warnings,
      reminders, residue: verdict.residue, limitations: Array.isArray(args.limitations) ? args.limitations : [], seq: api.seq(exec.agent),
    }
    // Finishing the last unit is not the same as the person being done with it:
    // when there is something to look at, the task parks where it can be used.
    const dropped = plan ? leafUnits(plan.units).filter(row => row.state === 'dropped') : []
    const reduced = row => approvedReduction(task, plan, row)
    const remaining = plan ? leafUnits(plan.units).filter(row => row.id !== unit?.id && row.state !== 'done' && !(row.state === 'dropped' && reduced(row))) : []
    if (dropped.length) reminders.push(`这几步没做：${dropped.map(row => row.goal || stepName(plan.units, row.id)).join('、')}`)
    if (dropped.length) verdict.warnings.push(`dropped scope (not completed): ${dropped.map(row => `${row.id}${reduced(row) ? ' (person approved scope reduction)' : ' (unresolved)'}`).join(', ')}`)
    if (settling && remaining.length) reminders.push(`这几步没标完成：${remaining.map(row => row.goal || stepName(plan.units, row.id)).join('、')}`)
    const finishing = verdict.outcome === 'complete' && (remaining.length === 0 || settling)
    // Park for the person when there is something to look at (the tree moved since the start), close when
    // nothing changed on disk — a hard fact, not the model's acceptanceMode (v54 autopilot closed itself).
    // Outside git there is no tree to read, and the declared acceptance mode stands; autopilot always parks.
    const pmJudges = task.auto === true || (changed ?? (task.acceptanceMode ?? 'pm') === 'pm')
    const settledState = finishing ? (pmJudges ? 'review_ready' : 'closed') : undefined
    if (remaining.length && verdict.outcome === 'complete' && !settling) verdict.warnings.push(`task remains active: ${remaining.map(row => `${row.id} (${row.state ?? 'pending'})`).join(', ')}; blocked, dropped and unmet dependencies are not completed work`)
    // Reds of the project's own check since its last pass: exit codes, nothing read.
    const reds = redStreak(runs)
    if (reds.length) reminders.push(`${reds[0].command} 还红着（连续 ${reds.length} 次）`)
    const lastPulse = task.pulse && typeof task.pulse === 'object' ? task.pulse : {}
    const pulse = { ...lastPulse,
      submitsSinceProgress: reds.length, sameDefectCount: reds.length,
      lastKey: reds.length ? reds[0].command : undefined,
      ...(settledState === 'review_ready' ? { reviewAskedAt: undefined } : {}),
    }
    await api.records.change('tasks', task.id, current => ({
      ...current,
      ledger: [...(current.ledger ?? []), entry],
      updatedAt: now,
      pulse,
      // Where the next unit's evidence window opens when the model goes straight
      // on without activating it: the work before this point belongs to the unit
      // just settled.
      ...(unit && verdict.outcome === 'complete' ? { settledSeq: api.seq(exec.agent) } : {}),
      ...(settledState ? { state: settledState } : {}),
      ...(settledState === 'review_ready' ? { review: { at: now, atSeq: api.seq(exec.agent), asked: false } } : {}),
    }))
    // Short of complete: the tree this report covers, so a turn that just ends on it is not handed in again (G1).
    if (verdict.outcome !== 'complete') await markSubmitted(task.project, task.id)
    let updatedPlan
    if (plan && unit) {
      updatedPlan = await api.records.change('plans', plan.id, current => ({
        ...current,
        units: current.units.map(row => row.id === unit.id
          ? { ...row, state: verdict.outcome === 'complete' ? 'done' : ['failed', 'blocked'].includes(verdict.outcome) ? 'blocked' : row.state, asked: undefined }
          : row),
        updatedAt: now,
      }))
    }
    // The last child of a theme just landed: that is the moment the theme is
    // over, and it is worth one line rather than being derived silently.
    const seals = []
    if (verdict.outcome === 'complete' && unit && updatedPlan) {
      for (const theme of containersOf(updatedPlan.units ?? [])) {
        // 日需是桶，不是主题：它永远不收束，也不该在收口时说"全部完成"。
        if (theme.id === DAILY_UNIT.id || theme.role === 'daily') continue
        const kids = childrenOf(updatedPlan.units ?? [], theme.id)
        const before = childrenOf(plan?.units ?? [], theme.id)
        if (!kids.length || !kids.every(kid => kid.state === 'done')) continue
        if (before.length && before.every(kid => kid.state === 'done')) continue
        seals.push([
          `**主题完成 · ${theme.goal}** — ${kids.length} 步全部完成`,
          `dsh-auto-dev theme ${theme.id} sealed`,
          { form: 'theme-seal', data: { unit: theme.id, label: theme.goal, line: `${kids.length} 步全部完成`, tag: '已收', tone: 'neutral' } }])
      }
    }
    api.nudged.delete(`${task.id}:${unit?.id ?? ''}`)
    // A settlement is a progress record too: the unit's note clock restarts.
    api.sessionState(exec.agent).unitNoteSeq = api.seq(exec.agent)
    const promised = typeof unit?.deliverable === 'string' && unit.deliverable.trim() !== '' ? unit : undefined
    const after = promised
      // A unit that promised something closes with the submission that proves
      // it: the pair is what a person asked to keep, so it is not part of the
      // rotating background.
      ? await api.snapshot(api.records.get('tasks', task.id), 'after', {
        unit: promised.id, label: promised.deliverable.trim(),
        outcome: verdict.outcome === 'complete' ? 'done' : 'blocked',
      })
      : await api.snapshot(api.records.get('tasks', task.id), 'after', { auto: true })
    // One line per submission, and the closing one is about the task, not the
    // unit: the last unit is not more interesting than the thing it finished.
    // Hand-in is one of the moments the plugin speaks: the conditional sentences as a capsule, once per task.
    const delivery = finishing ? await deliveryOnce(api, exec.agent, task) : undefined
    if (delivery) api.queueNotice(exec.agent, ...delivery)
    // The step's own card first, then the theme it closed (v57: 「主题完成」 came before its last step).
    const sealAfter = () => { for (const seal of seals) api.queueNotice(exec.agent, ...seal) }
    if (verdict.outcome === 'complete') {
      const currentPlan = api.planOf(api.records.get('tasks', task.id))
      const following = currentPlan ? nextUnit(currentPlan) : undefined
      // 停在"等人看一眼"的任务还没有完成：说"任务完成"就提前替人验收了，
      // 下一步那张"做完了要不要看一眼"才是这一刻该说的话。
      const parked = api.records.get('tasks', task.id)?.state === 'review_ready'
      const closing = settledState === 'closed'
      const name = typeof task.goal === 'string' && task.goal.trim() !== '' ? task.goal.trim() : String(task.request ?? '').slice(0, 18)
      // A unit already done (handed in, then marked done again) gets no second card.
      if ((!parked || unit) && !(unit && unit.state === 'done')) {
        api.queueNotice(exec.agent,
          closing ? `**任务完成 · ${name}** — ${verdict.summary}` : `**${unit?.id ?? '这一步'} 完成** — ${unit?.goal ? `${unit.goal}：` : ''}${verdict.summary}`,
          closing ? 'dsh-auto-dev task done' : `dsh-auto-dev unit-done ${unit?.id ?? ''}`,
          closing
            ? { form: 'task-done', data: { unit: unit?.id, title: `任务完成 · ${name}`, line: verdict.summary, tag: after?.ref ? `已存档 #${after.seq}` : '已收尾', tone: 'done', ...(reminders.length ? { warnings: reminders } : {}) } }
            // The card is about this unit: its goal, not a summary that may cover the whole task (v52 #142).
            : { form: 'unit-done', data: { unit: unit?.id, title: `${unit ? stepName((api.planOf(api.records.get('tasks', task.id)) ?? plan)?.units, unit.id) : '这一步'}完成`, line: unit?.goal || verdict.summary, tag: following ? `下一步：${String(following.goal ?? '').slice(0, 24)}` : parked ? '待验收' : '仍有未完成单元', tone: 'done', ...(reminders.length ? { warnings: reminders } : {}) } })
      }
      sealAfter()
      // Parked for a person: the review card goes out with the hand-in itself, so a
      // hand-in at turn end (no next step to carry it) still shows it where the turn ended.
      const record = api.records.get('tasks', task.id)
      if (parked && !record?.review?.asked) {
        await api.records.change('tasks', task.id, current => ({
          ...current, review: { ...(current.review ?? {}), asked: true, askedAt: new Date().toISOString() },
        }))
        // What is still open rides the review card, the one the person reads when it parks.
        const [body, summary, extra] = reviewCard(record)
        api.queueNotice(exec.agent, reminders.length ? `${body}\n${reminders.join('\n')}` : body, summary,
          reminders.length ? { ...extra, data: { ...extra.data, warnings: reminders } } : extra)
      }
    } else if (promised && ['blocked', 'failed'].includes(verdict.outcome)) {
      api.queueNotice(exec.agent,
        `**${promised.id} 没通过** — ${verdict.summary}`,
        `dsh-auto-dev unit-blocked ${promised.id}`,
        { form: 'unit-blocked', data: { unit: promised.id, title: `${stepName(plan?.units, promised.id)}没通过`, line: verdict.summary, tag: after?.ref ? `已存档 #${after.seq}` : '未存档', tone: 'blocked' } })
    }
    const refreshed = api.records.get('tasks', task.id)
    const warnings = [...verdict.warnings]
    // The size of the change decides how much evidence is owed — not a ritual the
    // model declares. Counted the way the session already reports it: the files a
    // run touched since this unit started.
    const touchedFiles = new Set([
      ...(Array.isArray(args.files) ? args.files.map(String) : []),
      ...(api.observationsOf(exec.agent).writes ?? [])
        .filter(row => (row.seq ?? 0) >= windowStart(task, unit))
        .map(row => String(row.path ?? row.file ?? '')),
    ])
    const derivedTier = touchedFiles.size >= 6 ? 'L3' : touchedFiles.size >= 3 ? 'L2' : 'L1'
    const tierRank = { L1: 1, L2: 2, L3: 3 }
    const claimedTier = typeof args.tier === 'string' && tierRank[args.tier] ? args.tier : undefined
    const tier = claimedTier && tierRank[claimedTier] <= tierRank[derivedTier] ? claimedTier : derivedTier
    // Hand-in is one of the three moments the plugin speaks: conditional sentences only.
    return {
      taskId: task.id, outcome: verdict.outcome, warnings,
      state: refreshed.state, claims: verdict.claims.length,
      tier, derivedFrom: `${touchedFiles.size} 个文件`,
      waiting: refreshed.state === 'review_ready' ? 'user-review' : refreshed.state === 'paused' ? 'user-pause' : recordWaiting(refreshed).waiting,
      continueAuthorized: refreshed.state === 'active' && !recordWaiting(refreshed).waiting,
      tellUser: '给用户一句这次交付的结论（达成到什么程度、下一步是什么），用户不需要读工具流。',
      ...(verdict.delegations ? { delegations: verdict.delegations } : {}),
      ...(children.length ? { children } : {}),
      checkpoint: after,
      ...(plan ? { nextUnit: nextUnit(api.planOf(refreshed)) } : {}),
    }
  }]
)

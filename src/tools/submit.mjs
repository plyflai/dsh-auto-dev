import { describeChild, describeRecord } from '../child-sessions.mjs'
import { approvedReduction, namesCommand, reconcileDelegation, validateSubmission } from '../task.mjs'
import { leafUnits, nextUnit, runnableUnits } from '../plan.mjs'
import { failureContext } from '../craft.mjs'
import { uiMissing } from '../uicheck.mjs'
import { recordWaiting } from '../task-record.mjs'
import { string, strings, claimsSchema, touchesScreen, browserEvidence, containersOf, childrenOf, DAILY_UNIT } from './shared.mjs'

export const workSubmit = api => (
  // --------------------------------------------------------------- work_submit
  ['work_submit', `Submit outcome + summary + next; continue authorized work unless the result names a real wait. Claims use statement + execution.callId from work_status executions; complete with acceptance needs fresh successful evidence after writes. Declared ui tiers, scope, dependencies and authority remain enforced; a partial result does not complete remaining work.`, {
    taskId: string, unit: string, outcome: { type: 'string', enum: ['complete', 'partial', 'blocked', 'failed'] },
    preserve: { type: 'array', items: { type: 'string' } }, tier: { type: 'string', enum: ['L1', 'L2', 'L3'] },
    summary: string, next: string, claims: claimsSchema, files: strings, residue: strings,
    limitations: strings,
  }, ['outcome', 'summary', 'next'],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent), args.taskId, { agent: exec.agent })
    const plan = api.planOf(task)
    const unit = args.unit
      ? plan?.units.find(entry => entry.id === args.unit)
      : (plan ? nextUnit(plan) : undefined)
    if (args.unit && !unit) throw new Error(`unit "${args.unit}" is not in this plan`)
    if (plan && !unit) throw new Error('work_submit: no runnable unit; inspect blocked/pending dependencies with work_plan list before submitting')
    if (unit) {
      api.assertLeaf(plan, unit.id)
      if (!runnableUnits(plan.units).some(row => row.id === unit.id)) throw new Error(`work_submit: unit ${unit.id} is ${unit.state ?? 'pending'} or has unfinished dependencies; activate a runnable unit first`)
    }
    const observations = api.observationsOf(exec.agent)
    const since = Math.max(task.startedSeq ?? 0, unit?.startedSeq ?? 0)
    const window = { ...observations, results: observations.results.filter(row => row.seq >= since) }
    const verdict = validateSubmission({ task, unit, args, observations: window, config: { ...api.settings(), project: task.project, agent: exec.agent } })
    // A refusal is the plugin's call, not a failed tool: the person sees it once
    // per unit, in one line, instead of a red call they have to decode.
    const refused = line => api.blockedOnce(exec.agent, `submit:${task.id}:${unit?.id ?? ''}`,
      { unit: unit?.id, title: '拦下 · 交付退回', line })
    if (!verdict.ok) {
      refused(`${unit?.id ?? '这一步'} 的完成声明证据不够（${verdict.errors.length} 处）— 补跑检查后再交`)
      const error = new Error(`work_submit refused:\n- ${verdict.errors.join('\n- ')}`)
      error.details = { errors: verdict.errors, warnings: verdict.warnings }
      throw error
    }
    const uiGap = verdict.outcome === 'complete' && typeof unit?.ui === 'string' ? uiMissing({ unit, project: task.project, rows: window.results }) : undefined
    if (uiGap) {
      refused(`${unit.id} 写明了要${uiGap.check.name}，这次没跑 — 先跑 ${uiGap.check.command}`)
      throw new Error(`这个单元声明了界面测试（${uiGap.tier}），但这次没跑过：${uiGap.check.name}用 ${uiGap.check.command}。跑一条，或把单元上的 ui 改档 / 设 false，再交。`)
    }
    // A unit that completes without ever running the command the repository
    // declares as its check is not a failure — but the owner should see it.
    const verifier = api.detectVerifier(task.project)
    // The same doubts as `warnings`, in the words the person reads on the receipt
    // and the board; `warnings` stays the model's instruction.
    const reminders = []
    if (verdict.outside?.length) reminders.push(`改到了范围外：${verdict.outside.slice(0, 3).join('、')}${verdict.outside.length > 3 ? ' 等' : ''}`)
    const screenGap = (unit?.ui === undefined || unit.ui === 'browser') && touchesScreen(unit, task) && !browserEvidence(args, window, task.project)
    if (screenGap && verdict.outcome === 'complete') reminders.push('涉及界面，这次没有浏览器证据')
    // A look task answers a question; it never runs the suite, and a do task with no
    // claims asserted nothing to check. Only nag when something was actually claimed.
    if (verifier && verdict.outcome === 'complete' && task.mode !== 'look' && verdict.claims.length > 0) {
      // Compare against the recorded execution, not the claim's summary of it: the
      // summary is truncated for display, so a long shell line that ends in `npm test`
      // looked like it never ran the project's check.
      const recorded = new Map(window.results.map(row => [row.callId, row]))
      const ran = verdict.claims.some(claim => {
        const row = recorded.get(claim.execution?.callId)
        return typeof row?.command === 'string' && namesCommand(row.command, verifier.command)
      })
      if (!ran) {
        reminders.push(`没跑项目检查 ${verifier.command}`)
        verdict.warnings.push(`this unit completed without running the project's check "${verifier.command}" (${verifier.source}) — if another command is what proves it, the claim should say which`)
      }
    }
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
    if (dropped.length) reminders.push(`有范围没做：${dropped.map(row => row.id).join('、')}`)
    if (dropped.length) verdict.warnings.push(`dropped scope (not completed): ${dropped.map(row => `${row.id}${reduced(row) ? ' (person approved scope reduction)' : ' (unresolved)'}`).join(', ')}`)
    const finishing = verdict.outcome === 'complete' && remaining.length === 0
    const pmJudges = (task.acceptanceMode ?? 'pm') === 'pm'
    const settledState = finishing ? (pmJudges ? 'review_ready' : 'closed') : undefined
    if (remaining.length && verdict.outcome === 'complete') verdict.warnings.push(`task remains active: ${remaining.map(row => `${row.id} (${row.state ?? 'pending'})`).join(', ')}; blocked, dropped and unmet dependencies are not completed work`)
    // Progress is not failure. Repeated investigation comes only from actual
    // execution results in the current evidence window, never warning wording.
    const failure = failureContext(window.results, [...(task.ledger ?? []), entry])
    if (failure) reminders.push(`${failure.command} 失败过 ${failure.count} 次`)
    const lastPulse = task.pulse && typeof task.pulse === 'object' ? task.pulse : {}
    const pulse = { ...lastPulse,
      submitsSinceProgress: failure?.count ?? 0, sameDefectCount: failure?.count ?? 0,
      lastKey: failure?.key,
      ...(settledState === 'review_ready' ? { reviewAskedAt: undefined } : {}),
    }
    await api.records.change('tasks', task.id, current => ({
      ...current,
      ledger: [...(current.ledger ?? []), entry],
      updatedAt: now,
      pulse,
      ...(settledState ? { state: settledState } : {}),
      ...(settledState === 'review_ready' ? { review: { at: now, atSeq: api.seq(exec.agent), asked: false } } : {}),
    }))
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
    if (verdict.outcome === 'complete' && unit && updatedPlan) {
      for (const theme of containersOf(updatedPlan.units ?? [])) {
        // 日需是桶，不是主题：它永远不收束，也不该在收口时说"全部完成"。
        if (theme.id === DAILY_UNIT.id || theme.role === 'daily') continue
        const kids = childrenOf(updatedPlan.units ?? [], theme.id)
        const before = childrenOf(plan?.units ?? [], theme.id)
        if (!kids.length || !kids.every(kid => kid.state === 'done')) continue
        if (before.length && before.every(kid => kid.state === 'done')) continue
        api.queueNotice(exec.agent,
          `**主题完成 · ${theme.goal}** — ${kids.length} 个单元全部完成`,
          `auto-dev-v3 theme ${theme.id} sealed`,
          { form: 'theme-seal', data: { unit: theme.id, label: theme.goal, line: `${kids.length} 个单元全部完成`, tag: '已收', tone: 'neutral' } })
      }
    }
    api.nudged.delete(`${task.id}:${unit?.id ?? ''}`)
    // A settlement is a progress record too: the unit's note clock restarts.
    api.sessionState(exec.agent).unitNoteSeq = api.seq(exec.agent)
    const promised = typeof unit?.deliverable === 'string' && unit.deliverable.trim() !== '' ? unit : undefined
    const after = task.mode === 'look'
      ? { snapshot: 'skipped', reason: 'look does not write' }
      : promised
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
    if (verdict.outcome === 'complete') {
      const currentPlan = api.planOf(api.records.get('tasks', task.id))
      const following = currentPlan ? nextUnit(currentPlan) : undefined
      // 停在"等人看一眼"的任务还没有完成：说"任务完成"就提前替人验收了，
      // 下一步那张"做完了要不要看一眼"才是这一刻该说的话。
      const parked = api.records.get('tasks', task.id)?.state === 'review_ready'
      const closing = settledState === 'closed'
      const name = typeof task.goal === 'string' && task.goal.trim() !== '' ? task.goal.trim() : String(task.request ?? '').slice(0, 18)
      if (!parked || unit) {
        api.queueNotice(exec.agent,
          closing ? `**任务完成 · ${name}** — ${verdict.summary}` : `**${unit?.id ?? '这一步'} 完成** — ${verdict.summary}`,
          closing ? 'auto-dev-v3 task done' : `auto-dev-v3 unit-done ${unit?.id ?? ''}`,
          closing
            ? { form: 'task-done', data: { unit: unit?.id, title: `任务完成 · ${name}`, line: verdict.summary, tag: after?.ref ? `已存档 #${after.seq}` : '已收尾', tone: 'done', ...(reminders.length ? { warnings: reminders } : {}) } }
            : { form: 'unit-done', data: { unit: unit?.id, title: `${unit?.id ?? '这一步'} 完成`, line: verdict.summary, tag: following ? `下一步 ${following.id}` : parked ? '待验收' : '仍有未完成单元', tone: 'done', ...(reminders.length ? { warnings: reminders } : {}) } })
      }
    } else if (promised && ['blocked', 'failed'].includes(verdict.outcome)) {
      api.queueNotice(exec.agent,
        `**${promised.id} 没通过** — ${verdict.summary}`,
        `auto-dev-v3 unit-blocked ${promised.id}`,
        { form: 'unit-blocked', data: { unit: promised.id, title: `${promised.id} 没通过`, line: verdict.summary, tag: after?.ref ? `已存档 #${after.seq}` : '未存档', tone: 'blocked' } })
    }
    const refreshed = api.records.get('tasks', task.id)
    const warnings = [...verdict.warnings]
    // The size of the change decides how much evidence is owed — not a ritual the
    // model declares. Counted the way the session already reports it: the files a
    // run touched since this unit started.
    const touchedFiles = new Set([
      ...(Array.isArray(args.files) ? args.files.map(String) : []),
      ...(api.observationsOf(exec.agent).writes ?? [])
        .filter(row => (row.seq ?? 0) > (unit?.startedSeq ?? task.startedSeq ?? 0))
        .map(row => String(row.path ?? row.file ?? '')),
    ])
    const derivedTier = touchedFiles.size >= 6 ? 'L3' : touchedFiles.size >= 3 ? 'L2' : 'L1'
    const tierRank = { L1: 1, L2: 2, L3: 3 }
    const claimedTier = typeof args.tier === 'string' && tierRank[args.tier] ? args.tier : undefined
    const tier = claimedTier && tierRank[claimedTier] <= tierRank[derivedTier] ? claimedTier : derivedTier
    if (failure) warnings.push(`真实执行 ${failure.command} 失败 ${failure.count} 次：先复现、一次只验一个假设，再重跑；技术排查可继续，根因未知可保留（references/craft/debug.md）`)
    // A person who asks for a button expects it clicked, not described. The
    // default is a real browser run; when the unit touches a screen and nothing
    // in this session opened one, say so once — a hint, never a refusal.
    // The evidence has to come from this unit's window: a browser run in an
    // earlier task does not cover the screen somebody is changing now.
    // 界面单元声明了某一档，就必须有那档的执行记录（browser 覆盖 logic 覆盖 static）。
    // 只认单元上写明的档：默认推断仍然只提醒，不拦——小改动不该等在一个跑不起来的套件后面。
    if (screenGap) {
      warnings.push('这个单元涉及界面，但这次没有浏览器证据：起服务后用非 headless 的 Playwright 点一遍，把截图路径或这次执行写进 claims（确实只能人工看，就在 summary 里说明）')
    }
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

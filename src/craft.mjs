import { fileURLToPath } from 'node:url'
/**
 * Everything the plugin says to the model, and when (设计约定「第三条路」).
 *
 * The plugin opens its mouth at moments it can see without understanding:
 *   开工命令    — clarifyCard: the person's words and one method, alone (F-clarify 6b).
 *   登记        — START: conditional sentences; whether one applies is the model's call.
 *   第一次写文件  — FIRST_WRITE: the 「动手前」 sentences, at the moment they are about.
 *   检查第 2 次红 — the fix card: the failing output verbatim and the last incidents.
 *   红后转绿      — the fixed card: write the incident down.
 *   文件消失仍被引用 — the deleted card: which files still say its name.
 *   交付        — DELIVERY: conditional sentences again.
 *   接手        — the handoff card: what the task's record holds, verbatim.
 * 「先量基线 / 先跑基线」 left after v33: the model had already done both before
 * its first write, and at that moment 「改之前」 is too late anyway.
 * Nothing here reads meaning out of a command, an output or a request. A card
 * that only repeats what the model would do anyway is not here (沉默测试).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INCIDENTS_FILE, recentIncidents, tailOf, trimmedCheck } from './facts.mjs'
import { DOMAIN_FILE } from './domain.mjs'
import { changedPaths, changedSinceStored, fingerprint, marksOf, startOf } from './disk.mjs'
import { spokeSinceStart } from './decisions.mjs'
import { teamConventions, teamIncidents } from './team.mjs'
import { incidentIndex } from './incidents.mjs'
import { noticeSaid } from './said.mjs'
import { stepName } from './tools/shared.mjs'

/** Said once at start. Each is a condition the model checks against the person's words. */
export const START = Object.freeze([
  '如果用户要的是紧急止血：先最小改动止住症状，不扩范围。',
  '如果是补测试：测外部可见行为，至少一个失败或边界用例，照现有测试的写法；用户说只加测试就别改源码。',
  '如果是清理：删之前找引用，删完跑检查。',
  `如果用户只要你看、不要改：不写文件，结论写进 ${DOMAIN_FILE}。`,
])

/**
 * Said once, right after the task's first file-tool write (a structured path, not
 * shell text) — the moment 「动手前」 sentences are about. Said at start they drowned.
 */
export const FIRST_WRITE = Object.freeze([
  `如果这是提速：一次只改一处，改完用同一量法再量；没变快就回存档；交付写明热点、量法、前后数字，量法写进 ${DOMAIN_FILE}。`,
  '如果这是重构 / 提取 / 改名：删旧名前先找调用方；一小步一检查；交付时说哪些行为没变、怎么核对的。',
  '如果是新功能：先列计划（几步、每步怎么验），再往下写；每步做完跑一次项目检查。',
])
// A fixed shape for the restatement (v36 clarify: told to stop, the model went on): a
// format to follow, not a check — whether to restate at all is the model's call.
// Said only when the plugin had to register the task itself at the first write.
const ASK_FIRST = '如果需求有好几条或有含糊处、还没跟用户对过：先停下，对用户复述——第一行写「**我理解的要求：**」，下面逐条列要求和验收；有更好的做法另起一行讲清差别；最后只问一个最影响下一步的问题，然后结束这一回合等他回，别接着改。'

/** The person flipped the autopilot switch: the model hears what it means for this task, the person sees a capsule. */
export const autopilotCard = on => [on
  ? '用户把这个任务的自动驾驶打开了：之后不等用户确认，按你认为的最佳做法往下做；收不回的操作照样不做，换可逆的做法；交付时把没等用户确认就做的决定逐条列出来。'
  : '用户把这个任务的自动驾驶关了：需求有含糊、有更好的做法、碰到收不回的操作，先问用户再做。',
'dsh-auto-dev autopilot', { form: 'read-doc', data: { title: `自动驾驶 · ${on ? '开' : '关'}`, line: on ? '不等确认，按最佳做法往下做；收不回的事照样不做' : '有含糊、碰到收不回的事先问你', tag: '开关', tone: 'info' } }]

/**
 * Said once, the step after `/dsh-auto-dev start`, on its own: nothing is registered
 * yet, and registering is what this card asks for once the request is clear (v43:
 * registered at start and told 「直接开工」, the model never asked).
 */
// The methods ship with the plugin, not the project: the model gets the absolute path to read
// (v62 decompose: the skill tool did not know auto-dev-craft, and a relative path sent it searching the disk).
const CRAFT_DIR = fileURLToPath(new URL('../skills/auto-dev/', import.meta.url))
const craftDoc = doc => join(CRAFT_DIR, doc)
const DECOMPOSE = `先读 ${craftDoc('references/craft/decompose.md')}（需求拆解，插件自带的方法），`

// What the person confirms is what the tests check: an acceptance written as inputs and outputs
// is already the test list (2026-11-09: tests were written after the code, never from the acceptance).
const ACCEPTANCE_IO = '验收写成看得见的输入 → 输出，至少一条正常的、一条边界或非法的（例：`<命令或操作>` → `<应该看到什么>`）；拿不准的业务口径放进要用户拍板的问题。'
const TEST_FIRST = `如果这次要改程序的行为（修 bug、加功能）：先把验收里每条输入 → 输出写成测试，照项目现有测试的写法，跑一次项目检查看它们红，再改代码让它变绿。哪些用例自己补、哪些先问用户，见 ${craftDoc('references/craft/test.md')}。`

export function clarifyCard(words, auto = false) {
  const method = auto
    ? '自动驾驶开着：用户不会回话。先只读看代码，登记前不改不删；小需求用更专业的话复述成要求和验收；'
      + `${ACCEPTANCE_IO}`
      + `需求偏产品层、牵涉多处或要选做法，${DECOMPOSE}拆成 O（目标）和 KR（分步）写出来。`
      + '写清你怎么理解、选了哪个做法和为什么，直接登记开工；有含糊或有更好的做法，按你判断的最佳做法走，交付时把这些决定列出来让用户确认。'
    : '先弄清要什么再动手：登记前只读，不改不删。小需求（一两句说得清、改动集中、没什么可取舍）不用拆，用更专业的话复述成要求和验收；'
      + `${ACCEPTANCE_IO}`
      + `需求偏产品层、牵涉多处或要选做法，${DECOMPOSE}拆成 O（目标，补上更好的做法和用户可能没想到的点）和 KR（分步，全部做完 O 就成），要他拍板的最多 3 个。`
      + '两种都先在回复正文里写给用户看（第一行写「**我理解的要求：**」，拆的要把 O 和每个分步写出来；问题卡代替不了这段），然后结束这一回合等他说行；他说行，再把目标和验收登记成要求、分步登记成分步，开工。'
  return [`用户用 /dsh-auto-dev start 说了要做的事，原话逐字：「${words}」\n${method}`,
    'dsh-auto-dev start granted', { form: 'read-doc', data: { title: '先理需求', line: oneLine(words), tag: auto ? '自动驾驶' : '开工', tone: 'info' } }]
}
const oneLine = words => { const one = String(words ?? '').replace(/\s+/g, ' ').trim(); return one.length > 40 ? `${one.slice(0, 40)}…` : one }

/** The check agreement: the two forms the plugin counts (src/facts.mjs exactCheck), nothing else. */
const checkAgreement = command => `跑就写 \`${command}\`；要截短输出就写 \`${trimmedCheck(command)}\`（必须带 set -o pipefail，tail 行数随意）。别的写法（不带 pipefail、head、cd、&&）插件不认，出错时就没法帮你排查和存档。`

/**
 * The person's start words cut at 。；; and line breaks, verbatim; the 验收 sentence is not a
 * request (v28 clarify counted it). A cut, not a reading: whether a sentence is a
 * separate requirement is the model's call, so the card says 句, not 条要求.
 */
export const requestSentences = request => String(request ?? '')
  .replace(/^\s*\/dsh-auto-dev(\s+start)?\s*/, '')
  .split(/[。；;\n]+/).map(part => part.trim())
  .filter(part => part.length > 1 && !/^(验收|acceptance)\s*[:：]/i.test(part))
const SCATTERED = 3

/**
 * The first-write card. `unasked`: the plugin registered the task at this write (nobody did
 * before it) and the person has said nothing since the start — host facts both. Then, and only
 * then, the restatement line, with the start words verbatim when they run to three sentences
 * or more (v37 clarify: 「没什么含糊的」). A task the model registered was restated already.
 */
export function firstWriteCard(unasked, verifier, request) {
  const sentences = unasked ? requestSentences(request) : []
  const quoted = sentences.length >= SCATTERED
    ? [`事实：开工原话断开是 ${sentences.length} 句，开工后用户还没说过话——${sentences.slice(0, 8).map(part => `「${part}」`).join('')}`]
    : []
  const lines = [...quoted, ...(unasked ? [ASK_FIRST] : []), ...FIRST_WRITE]
  // The check agreement again, at the moment the next check is about to run (said at start it was not kept, v31).
  const check = verifier?.command ? `\n接下来跑项目检查：${checkAgreement(verifier.command)}` : ''
  return [`**刚改了第一个文件** — 都不适用就忽略：\n${lines.map(line => `- ${line}`).join('\n')}${check}`,
    'dsh-auto-dev first write', { form: 'read-doc', data: { title: '刚改了第一个文件', line: verifier?.command ? `检查写 ${verifier.command}` : '动手前的几件事', tag: '动手前', tone: 'info' } }]
}

/**
 * Said at hand-in: only lines with a hard fact behind them (a screen file changed, the
 * person never spoke, the person spoke, the domain file too long). The 提速 / 重构
 * delivery asks live in FIRST_WRITE: said to every flow at hand-in they made models
 * write 「都不适用」 paragraphs and empty 提速 sections (v34 test, v36 fix 沉默测试).
 */
export const DELIVERY = Object.freeze([])
// Only after the person said something since the start (a host fact): with no word
// from them there is no 口径 to keep, and the line sent models off writing a
// domain file of placeholders (v34 hotfix/test/fix).
const RULE_LINE = `如果这次用户定了口径或规则：写进 ${DOMAIN_FILE}。`
const SCREEN = /\.(tsx|jsx|vue|svelte|css|scss|html)$/i
const SCREEN_LINE = '如果改的是用户看得见的界面：交付前用浏览器真点一次、留截图。'

const domainText = (project, max = 1600) => {
  try {
    const text = readFileSync(join(project, DOMAIN_FILE), 'utf8').trim()
    return text.length > max ? `${text.slice(0, max)}\n…（全文见 ${DOMAIN_FILE}）` : text
  } catch { return '' }
}

// Up to this many entries the start brief carries them all verbatim; past it, the newest
// verbatim and every title, so the model chooses what to open (2026-11-09: 复盘成了知识库).
const VERBATIM = 3

/** This project's incidents for a brief: all verbatim when few, else the newest plus every title. */
const incidentsLine = project => {
  const { here } = incidentIndex(project)
  if (!here.length) return ''
  if (here.length <= VERBATIM) return `${INCIDENTS_FILE} 最近几条（原文）：\n${recentIncidents(project, VERBATIM)}`
  return `${INCIDENTS_FILE} 共 ${here.length} 条复盘。最新一条（原文）：\n${recentIncidents(project, 1)}\n全部标题（新→旧）：\n${here.map(title => `- ${title}`).join('\n')}`
}

// At most this many older titles per other project, and in all (the newest of each is shown verbatim).
const TEAM_TITLES = 5
const TEAM_TITLES_MAX = 20

/**
 * Titles other projects left beyond what the card already shows verbatim (the newest entry
 * of the first `shown` projects), newest project first. A list cut short says how many it
 * left out and where the rest is — counted by the plugin, never left to read as complete
 * (v67 rig-cross-project: 4 of 5 titles, the one that mattered missing, no count).
 */
const teamTitles = (project, shown) => {
  let left = TEAM_TITLES_MAX
  const rows = incidentIndex(project).team.map((row, index) => {
    const titles = index < shown ? row.titles.slice(1) : row.titles
    const listed = titles.slice(0, Math.max(0, Math.min(TEAM_TITLES, left)))
    left -= listed.length
    const hidden = titles.length - listed.length
    return { ...row, listed, hidden }
  }).filter(row => row.listed.length || row.hidden)
  if (!rows.length) return ''
  const line = row => `[${row.project}] ${row.listed.join('；')}${row.hidden ? `${row.listed.length ? '；' : ''}另有 ${row.hidden} 条更早的没列出（全文在 ${row.path}）` : ''}`
  return `\n别的项目更早的复盘标题：\n${rows.map(line).join('\n')}`
}

/**
 * The start brief's lines after the person's words: the plain-check agreement,
 * the conditional sentences, and this project's incidents and domain verbatim.
 */
export function startLines(project, verifier) {
  const domain = domainText(project)
  const team = teamIncidents(project, 3)
  const conventions = teamConventions()
  return [
    verifier?.command
      ? `项目检查是 \`${verifier.command}\`：${checkAgreement(verifier.command)}`
      : '',
    TEST_FIRST,
    ...START,
    incidentsLine(project),
    domain ? `${DOMAIN_FILE}（原文）：\n${domain}` : '',
    conventions ? `团队约定（用户写的原文；跟这个项目自己的约定冲突时，以项目为准）：\n${conventions}` : '',
    team.length ? `别的项目留下的复盘（各项目最新一条原文；跟这次像就参考，不像就忽略）：\n${team.map(row => `[${row.project}]\n${row.text}`).join('\n')}${teamTitles(project, team.length)}` : '',
  ].filter(Boolean)
}

/** The hand-in lines; `paths` are files the task changed on disk. */
/** Lines past which the domain file is asked to be merged down (大原则 8：有存就有退役). */
export const MAX_DOMAIN_LINES = 80

const UNCONFIRMED_LINE = '开工后用户还没说过话：如果需求有好几条或有含糊处，交付时逐条对照原话说你是怎么理解、怎么做的，没做的也说'

const clip = (text, max = 40) => { const one = String(text ?? '').replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max)}…` : one }
const AUTO_LINE = '自动驾驶开着：把没等用户确认就做的决定（怎么理解需求、选了哪个做法、跳过了哪些要用户点头的操作）逐条列出来，让用户回来一眼能看到'

export function deliveryLines(paths = [], project, { spoke = true, auto = false, open = [] } = {}) {
  let size = 0
  try { size = readFileSync(join(project ?? '', DOMAIN_FILE), 'utf8').split('\n').filter(line => line.trim()).length } catch { /* no domain file */ }
  return [...DELIVERY, ...(paths.some(path => SCREEN.test(String(path))) ? [SCREEN_LINE] : []),
    // Hard fact: the person has not said a word since the start.
    ...(spoke ? [RULE_LINE] : [UNCONFIRMED_LINE]),
    // Hard fact: the person switched autopilot on for this task.
    ...(auto ? [AUTO_LINE] : []),
    // Hard fact: steps the plan still has open. Which of them are done is the model's call (v53 key_reverse: none reported).
    ...(open.length ? [`计划里还没标完成的步骤：${open.slice(0, 8).map(row => `${row.name}「${clip(row.goal)}」`).join('；')}——如果其中有已经做完的，交付时说出来；没做的说明原因`] : []),
    ...(size > MAX_DOMAIN_LINES ? [`${DOMAIN_FILE} 已经 ${size} 行：如果有重复或过时的口径，合并或删掉，留下现在还成立的`] : [])]
}

/** The hand-in sentences said where the turn ended by itself: a capsule the person sees too (v34: form notice was hidden). */
export function deliveryCard(lines) {
  return [`交付前对照一下（只做适用的，不适用就直接结束）：\n${lines.map(line => `- ${line}`).join('\n')}`,
    'dsh-auto-dev delivery', { form: 'read-doc', data: { title: '交付前对照一下', line: `${lines.length} 条，只做适用的`, tag: '交付前', tone: 'info' } }]
}

/**
 * The hand-in sentences, once per task, whichever way the hand-in came (turn end or
 * a tool call, v36 feature/cleanup). The paths are a fingerprint diff, which leaves
 * out the plugin's own .auto-dev files: a task that changed nothing else hears none.
 */
export async function deliveryOnce(api, agent, task) {
  const key = `delivery:${task.id}`
  if (api.nudged.has(key) || noticeSaid(agent?.session, 'dsh-auto-dev delivery', task.openedSeq ?? task.startedSeq ?? 0)) return undefined
  const start = await startOf(task)
  const paths = await changedPaths(task.project, start, start && await fingerprint(task.project))
  if (!paths.length) return undefined
  api.nudged.set(key, true)
  const units = api.planOf?.(task)?.units ?? []
  const open = units.filter(row => !units.some(kid => kid.parent === row.id) && row.id !== 'daily' && !['done', 'dropped'].includes(row.state ?? 'pending'))
    .map(row => ({ id: row.id, goal: row.goal, name: stepName(units, row.id) }))
  return deliveryCard(deliveryLines(paths, task.project, { spoke: spokeSinceStart(agent, task), auto: task.auto === true, open }))
}

export const CARDS = Object.freeze({
  fix: {
    doc: 'references/craft/debug.md',
    title: '修 bug · 排查',
    brief: '同一检查红了第二次：按可能性逐个试',
    line: '先列 2–4 个最可能的方向，按可能性排序，从最可能的开始逐个用最便宜的办法证实或排除，排除了记一句再试下一个；可回「修前」档。如果这些红是你有意写的测试，忽略这张。',
  },
  fixed: {
    doc: 'references/craft/memory.md',
    title: '修通 · 记一笔',
    brief: `红过之后转绿：写进 ${INCIDENTS_FILE}`,
    line: `如果刚修好的是个 bug，在 ${INCIDENTS_FILE} 末尾加一条：第一行 \`## \` 开头，一句话说清这条经验落了什么，让以后的人只看标题就知道要不要点开（例：\`## 删除后再加 id 重复：id 用 length+1，改成 max+1\`）；下面写症状、试过的方向（哪些排除了、为什么）、根因、修法、验证命令。如果这些红是有意的，写一行 \`## 有意的红：<哪个测试>\`。`,
  },
  deleted: {
    doc: 'references/craft/impact.md',
    title: '删除 · 还有引用',
    brief: '删掉的东西仓库里还有人在用',
    line: '逐个确认：一起改、换入口或撤回删除，改完跑检查。',
  },
})

/** `[body, summary, options]` for api.notice / api.queueNotice. */
export function craftCard(key, { unit, facts = [] } = {}) {
  const page = CARDS[key]
  const body = [...facts.filter(Boolean).map(line => `事实：${line}`), `方法：${page.line}`, `参考：${craftDoc(page.doc)}`].join('\n')
  return [body, `dsh-auto-dev method ${key}`, { form: 'read-doc', data: { unit: unit?.id ?? '', title: page.title, line: page.brief, tag: page.doc, tone: 'info' } }]
}

/** The second red of the project's check in a row. */
export const fixCard = (unit, reds, project) => craftCard('fix', {
  unit,
  facts: [
    `\`${reds.at(-1).command}\` 连续第 ${reds.length} 次退出码非 0，最后一次输出末尾：\n${tailOf(reds.at(-1).output, 20)}`,
    incidentsLine(project),
  ],
})

/** A pass after two or more reds. */
export const fixedCard = (unit, fix) => craftCard('fixed', {
  unit,
  facts: [`\`${fix.green.command}\` 红了 ${fix.reds.length} 次之后退出码 0`],
})

/**
 * Red once, then green: a receipt for the person (修 bug 是一下子修好的，不用走排查). The model
 * gets one line it need not act on — it already knows; the card is drawn from `data`.
 */
export const quickFixCard = (unit, fix) => [
  '（给用户看的回执：项目检查红一次后转绿。不用回应，照常继续。）',
  'dsh-auto-dev quick fix',
  { form: 'read-doc', data: { unit: unit?.id ?? '', title: '一次修通', line: `\`${fix.green.command}\` 红一次后转绿`, tag: '项目检查', tone: 'done' } },
]

/** Files that vanished from disk while other files still say their name. */
export const deletedCard = (unit, refs) => craftCard('deleted', {
  unit,
  facts: [...new Set(refs.map(row => row.name))].map(name =>
    `这些文件里还出现「${name}」：${refs.filter(row => row.name === name).slice(0, 6).map(row => row.file).join('、')}`),
})

/** The hand-in moment when a person must look: one card, whichever path handed in. */
export const reviewCard = task => [
  `**做完了 · 要不要看一眼？** — ${String(task.goal || task.request || '这次交付').replace(/[。.\s]+$/, '')}。停下来等用户：说「可以」就收案，说哪里不对就退回改，说别的就什么都别做，不要追问他。`,
  'dsh-auto-dev review ask',
  { form: 'review', data: { unit: task.id, title: '做完了 · 要不要看一眼？', line: '可以 / 再来一轮 / 先放这儿', tag: '回一句就行', tone: 'done' } },
]

const HANDOFF_LINE = '如果你不记得前面的过程：从这些事实接着做，先看改过的文件和最后一次检查，别从头重来；跟原话对不上的地方问用户。'

/**
 * The handoff card (另一个会话接手): the task's record read back — the start words,
 * the person's later words, the last plain run of the check with its exit status,
 * the files changed since the start tree, the saves. A line with no fact is left
 * out, never turned into a "not": no record of a plain check run does not mean no
 * check ran (v40: `cd … && npm test` is not the plain command).
 */
export async function handoffCard(task, { from } = {}) {
  const trail = task.trail ?? {}
  const changed = trail.start ? await changedSinceStored(task.project, trail.start) : undefined
  const saves = (task.checkpoints ?? []).slice(-4)
  const facts = [
    `开工原话：「${String(task.request ?? '').trim()}」`,
    trail.said?.length ? `之后用户说过：${trail.said.map(row => `「${row.text}」`).join('')}` : '',
    trail.check ? `最后一次项目检查 \`${trail.check.command}\`${trail.check.by === 'plugin' ? '（插件交付时跑的）' : ''}：${trail.check.ok ? '退出码 0' : '退出码非 0'}${trail.check.tail ? `，输出末尾：\n${trail.check.tail}` : ''}` : '',
    !changed ? '' : changed.length ? `开工以来改过的文件：${changed.slice(0, 20).join('、')}${changed.length > 20 ? ` 等 ${changed.length} 个` : ''}` : '开工以来项目文件没有变化',
    saves.length ? `存档：${saves.map(row => `${row.label ?? row.tag}（${row.ref}）`).join('、')}` : '',
  ].filter(Boolean)
  const name = clip(task.goal || task.request, 24)
  return [`**接手 · ${name}** — 从${from ?? '别的会话'}接过来\n${facts.map(line => `事实：${line}`).join('\n')}\n方法：${HANDOFF_LINE}`,
    `dsh-auto-dev handoff ${task.id}`,
    { form: 'handoff', data: { unit: task.id, title: `接手 · ${name}`, line: changed?.length ? `改过 ${changed.length} 个文件${trail.check ? `，最后检查${trail.check.ok ? '通过' : '没过'}` : ''}` : `从${from ?? '别的会话'}接过来`, tag: saves.length ? `${saves.length} 个存档` : '已存档', tone: 'neutral' } }]
}

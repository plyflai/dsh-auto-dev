import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const SKILL_PATH = fileURLToPath(new URL('../skills/auto-dev/SKILL.md', import.meta.url))
const RESOURCE_BASE = dirname(SKILL_PATH)
const FALLBACK_DESCRIPTION = 'Development craft for Auto Dev tasks. Load when a task changes code and needs judgement beyond running commands.'

/**
 * The model sees this line, not the file's: it is read from SKILL.md's own
 * frontmatter so the two can never say different things. A missing or unreadable
 * file falls back to one plain line rather than failing the install.
 */
export function skillDescription(path = SKILL_PATH) {
  try {
    const head = readFileSync(path, 'utf8').match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
    return head.match(/^description:\s*(.+)$/m)?.[1]?.trim() || FALLBACK_DESCRIPTION
  } catch {
    return FALLBACK_DESCRIPTION
  }
}

const candidate = {
  name: 'auto-dev-craft',
  description: skillDescription(),
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'bundled',
  provider: 'dsh-auto-dev',
  rank: 100,
  locator: SKILL_PATH,
  path: SKILL_PATH,
  resourceBase: { kind: 'directory', path: RESOURCE_BASE },
}

/**
 * Offer the craft skill to one scope.
 *
 * A skill in the catalog is a standing instruction to the model, so it ships
 * with the tools and for the same reason: only to a conversation where somebody
 * started Auto Dev. Passing the agent's own context keeps it inside that
 * conversation (the tool and skill registries are scope-aware); the plugin
 * context is the fallback for a host that has no agent scopes.
 */
export function installSkill(scope) {
  return scope.skills.registerProvider(() => ({
    name: 'dsh-auto-dev',
    list: async () => [candidate],
    get: async requested => {
      if (requested.locator !== SKILL_PATH) return undefined
      const raw = await readFile(SKILL_PATH, 'utf8')
      return { ...candidate, content: raw.replace(/^---\n[\s\S]*?\n---\n/, '') }
    },
  }))
}

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const SKILL_PATH = fileURLToPath(new URL('../skills/auto-dev/SKILL.md', import.meta.url))
const RESOURCE_BASE = dirname(SKILL_PATH)

const candidate = {
  name: 'auto-dev-craft',
  description: 'Development craft knowledge for Auto Dev tasks - how to verify, debug, judge impact, cut deliverables, interview a non-technical owner, write behaviour scenarios, do UI acceptance and release. Load when a task involves changing code and you need judgement beyond running commands.',
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

// Tests and the bench never write the team's experience into the real ~/.dsh-auto-dev.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_AUTO_DEV_HOME ||= mkdtempSync(join(tmpdir(), 'dsh-auto-dev-home-'))

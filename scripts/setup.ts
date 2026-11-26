import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseArgs, parseEnv } from 'node:util'
import { distinctBearerTokens, localBearerTokens } from '../src/bearer-tokens.ts'

async function readOptional(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

// Only rewrite managed assignments. Verify the parsed result before replacing a file with custom content.
function updateEnv(raw: string, changes: Record<string, string>) {
  let updated = raw
  const expected = parseEnv(raw)
  for (const [key, value] of Object.entries(changes)) {
    if (expected[key] === value) continue
    const line = new RegExp(
      '^[ \\t]*(?:export[ \\t]+)?' + key + '[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)',
      'gm',
    )
    updated = updated.replace(line, '')
    expected[key] = value
    if (updated && !updated.endsWith('\n')) updated += '\n'
    updated += key + '=' + value + '\n'
  }
  const parsed = parseEnv(updated)
  if (
    Object.keys(expected).length !== Object.keys(parsed).length ||
    Object.keys(expected).some((key) => expected[key] !== parsed[key])
  )
    throw new Error(
      'Cannot safely update this .dev.vars file. Check the quoting of its managed assignments.',
    )
  return updated
}

async function setup() {
  parseArgs({ options: {} })
  const filename = '.dev.vars'
  const lock = filename + '.setup.lock'
  const fd = await open(lock, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error(
        'Setup is locked. If no setup process is running, remove .dev.vars.setup.lock and retry.',
      )
    throw error
  })
  const temp = filename + '.' + randomUUID()
  try {
    const raw = await readOptional(filename)
    const current = parseEnv(raw)
    const tokens: Record<string, string> = {}
    for (const name of localBearerTokens) {
      const value = current[name] || randomBytes(32).toString('hex')
      if (!/^[A-Za-z0-9._~-]+$/.test(value)) throw new Error('Invalid token in ' + name)
      tokens[name] = value
    }
    if (current.MCP_RECOVERY_TOKEN && !/^[A-Za-z0-9._~-]+$/.test(current.MCP_RECOVERY_TOKEN))
      throw new Error('Invalid token in MCP_RECOVERY_TOKEN')
    if (!distinctBearerTokens({ ...current, ...tokens }))
      throw new Error('Use distinct tokens for Telegram, the custom webhook and each MCP role.')
    const key = current.CREDENTIAL_ENCRYPTION_KEY || randomBytes(32).toString('hex')
    if (key.length !== 64 || !/^[0-9a-f]{64}$/i.test(key))
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.')
    const reused = Object.entries({ ...current, ...tokens }).some(
      ([name, value]) =>
        name !== 'CREDENTIAL_ENCRYPTION_KEY' && value?.toLowerCase() === key.toLowerCase(),
    )
    if (reused) throw new Error('Generate a separate key for CREDENTIAL_ENCRYPTION_KEY.')
    const contents = updateEnv(raw, { ...tokens, CREDENTIAL_ENCRYPTION_KEY: key })
    if (raw !== contents) {
      await writeFile(temp, contents, { flag: 'wx', mode: 0o600 })
      await rename(temp, filename)
    } else await chmod(filename, 0o600)
  } finally {
    await rm(temp, { force: true })
    await fd.close()
    await rm(lock, { force: true })
  }
  console.log(
    'Worker settings saved to .dev.vars. After deploying, check pairing with begin_muse_pairing in the admin MCP connector.',
  )
}

setup().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.')
  process.exitCode = 1
})

import { z } from 'zod'

const settings = z
  .strictObject({
    enabled: z.boolean().default(true),
    maxAttempts: z.int().positive().default(100),
    maxAttemptsPerSource: z.int().positive().optional(),
    suppressReturns: z.boolean().default(true),
  })
  .refine((v) => v.maxAttemptsPerSource === undefined || v.maxAttemptsPerSource <= v.maxAttempts)
type Settings = z.output<typeof settings>

function sourceLimit(config: Settings) {
  return config.maxAttemptsPerSource ?? Math.max(1, Math.floor(config.maxAttempts / 2))
}

type Budget = {
  generation: number
  maxAttempts: number
  maxAttemptsPerSource: number
  remaining: number
  openedAt: number | null
  suppressed: number
}
export type BreakerStatus =
  | { state: 'disabled' | 'invalid' }
  | (Budget & {
      state: 'open' | 'closed'
      suppressReturns: boolean
      sourceAttempts: Record<string, number>
    })
export type SuppressionReason = 'circuit_open' | 'source_open' | 'loop_return'

export function createCircuitBreaker(storage: DurableObjectStorage, raw?: string) {
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return new CircuitBreaker(storage.sql, null)
  }
  const parsed = settings.safeParse(value)
  if (!parsed.success) return new CircuitBreaker(storage.sql, null)
  return parsed.data.enabled ? new CircuitBreaker(storage.sql, parsed.data) : undefined
}

export class CircuitBreaker {
  constructor(
    private readonly sql: SqlStorage,
    private readonly config: Settings | null,
  ) {}

  get invalid() {
    return this.config === null
  }

  initialize() {
    if (!this.config) return
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivery_breaker (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL, maxAttempts INTEGER NOT NULL, remaining INTEGER NOT NULL,
        openedAt INTEGER, suppressed INTEGER NOT NULL, lastAttempt TEXT, maxAttemptsPerSource INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_breaker_sources (
        source TEXT PRIMARY KEY, attempts INTEGER NOT NULL
      );
      CREATE VIEW IF NOT EXISTS exhausted_breaker_sources AS
      SELECT source FROM delivery_breaker_sources, delivery_breaker WHERE attempts >= maxAttemptsPerSource
    `)
    this.sql.exec(
      `INSERT INTO delivery_breaker (singleton, generation, maxAttempts, remaining, suppressed, maxAttemptsPerSource)
       VALUES (1, 1, ?, ?, 0, ?) ON CONFLICT DO NOTHING`,
      this.config.maxAttempts,
      this.config.maxAttempts,
      sourceLimit(this.config),
    )
    // A delivery may have started before this middleware was mounted.
    const active = this.sql
      .exec<{ attempt: string; source: string }>(
        `
      SELECT attempt, source FROM events, delivery_breaker
      WHERE state = 'sending' AND attempt IS NOT lastAttempt AND remaining > 0 LIMIT 1
    `,
      )
      .toArray()[0]
    if (active) this.consume(active.source, active.attempt, Date.now())
    const reason = this.blocked()
    this.suppressQueued(reason ?? 'source_open')
  }

  status(): BreakerStatus {
    if (!this.config) return { state: 'invalid' }
    const budget = this.sql
      .exec<Budget>(
        'SELECT generation, maxAttempts, maxAttemptsPerSource, remaining, openedAt, suppressed FROM delivery_breaker',
      )
      .one()
    const usage = this.sql
      .exec<{ source: string; attempts: number }>('SELECT source, attempts FROM delivery_breaker_sources')
      .toArray()
    return {
      ...budget,
      sourceAttempts: Object.fromEntries(usage.map(({ source, attempts }) => [source, attempts])),
      state: budget.remaining > 0 ? 'closed' : 'open',
      suppressReturns: this.config.suppressReturns,
    }
  }

  private blocked(source?: string): SuppressionReason | undefined {
    const { remaining, exhausted } = this.sql
      .exec<{ remaining: number; exhausted: number }>(
        `SELECT remaining, EXISTS (SELECT 1 FROM exhausted_breaker_sources WHERE source = ?) AS exhausted
         FROM delivery_breaker`,
        source ?? null,
      )
      .one()
    if (!remaining) return 'circuit_open'
    if (exhausted) return 'source_open'
  }

  screenQueued(id: string, source: string, parentId?: string) {
    if (!this.config) return
    let reason = this.blocked(source)
    if (!reason && this.config.suppressReturns && parentId) {
      const parent = this.sql
        .exec(
          "SELECT 1 FROM events WHERE id = ? AND state IN ('sending', 'sent', 'unknown')",
          parentId,
        )
        .toArray()[0]
      if (parent) reason = 'loop_return'
    }
    if (reason) this.suppressQueued(reason, id)
  }

  authorize<T>(source: string, attempt: string, now: number, next: () => T): T | null {
    if (!this.config) return null
    const reason = this.blocked(source)
    if (reason) {
      this.suppressQueued(reason)
      return null
    }
    this.consume(source, attempt, now)
    const claim = next()
    const after = this.blocked(source)
    if (after) this.suppressQueued(after)
    return claim
  }

  private consume(source: string, attempt: string, now: number) {
    this.sql.exec(
      `INSERT INTO delivery_breaker_sources (source, attempts) VALUES (?, 1)
       ON CONFLICT(source) DO UPDATE SET attempts = attempts + 1`,
      source,
    )
    this.sql.exec(
      `UPDATE delivery_breaker SET remaining = remaining - 1, lastAttempt = ?,
         openedAt = CASE WHEN remaining = 1 THEN ? ELSE NULL END`,
      attempt,
      now,
    )
  }

  private suppressQueued(reason: SuppressionReason, id?: string) {
    const update =
      "UPDATE events SET state = 'suppressed', reason = ?, text = '' WHERE state = 'queued'"
    if (id !== undefined) this.sql.exec(update + ' AND id = ?', reason, id)
    else if (reason === 'source_open') {
      this.sql.exec(update + ' AND source IN (SELECT source FROM exhausted_breaker_sources)', reason)
    } else this.sql.exec(update, reason)
    this.sql.exec('UPDATE delivery_breaker SET suppressed = suppressed + changes()')
  }

  rearm(expectedGeneration: number): boolean {
    if (!this.config) return false
    const reset = this.sql.exec(
      `UPDATE delivery_breaker SET generation = generation + 1, remaining = ?, maxAttempts = ?,
         openedAt = NULL, suppressed = 0, maxAttemptsPerSource = ?
       WHERE generation = ? AND (remaining = 0 OR EXISTS (SELECT 1 FROM exhausted_breaker_sources))
         AND NOT EXISTS (SELECT 1 FROM events WHERE state = 'sending')
       RETURNING generation`,
      this.config.maxAttempts,
      this.config.maxAttempts,
      sourceLimit(this.config),
      expectedGeneration,
    ).toArray().length === 1
    if (reset) this.sql.exec('DELETE FROM delivery_breaker_sources')
    return reset
  }
}

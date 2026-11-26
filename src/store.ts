import type { BreakerStatus, CircuitBreaker, SuppressionReason } from './circuit-breaker.ts'
import type { Claim, Delivery, Outcome } from './delivery.ts'

export type HookEvent = Omit<Delivery, 'id'> & {
  key: string
  parentId?: string
  messageId?: string
  coalesceKey?: string
}
type State = 'queued' | 'sending' | 'sent' | 'unknown' | 'suppressed' | 'expired'
type Receipt =
  | { id: string; state: State; duplicate: boolean }
  | { invalidBreaker: true }
  | { limited: true }
  | { noDestination: true }
type ReceiptReason = SuppressionReason | 'side_chat_missing' | 'message_retracted' | 'destination_changed'
type Status = Omit<Delivery, 'text'> & { state: State; createdAt: number; reason?: ReceiptReason }
type Rule = { source: string; paused: boolean; types: string[] }
type SideChat = { name: string; sessionId: string }
type SideChatTarget = SideChat & { vmId: string }
type SideChats = { active: string | null; chats: SideChat[] }
type RuleRow = { source: string; paused: number; types: string }

const minute = 60_000
const ingressPerMinute = 10
const deliveriesPerMinute = 3
const pendingLifetime = 60 * minute
const deliveryTimeout = 2 * minute
const historyLifetime = 7 * 24 * 60 * minute

const typeFiltered = `json_array_length(types) > 0 AND
  NOT EXISTS (SELECT 1 FROM json_each(types) WHERE value = events.type)`

const blockedByRule = `EXISTS (
  SELECT 1 FROM rules WHERE rules.source = events.source AND (
    paused = 1 OR (${typeFiltered})
  )
)`

const chatRetry = `LEFT JOIN delivery_retries r ON r.destination = events.destination
  AND r.vmId = events.vmId AND r.sessionId = events.sessionId`

function decodeRule(row: RuleRow): Rule {
  return { source: row.source, paused: row.paused === 1, types: JSON.parse(row.types) }
}

export class DeliveryQueue {
  private readonly sql: SqlStorage
  private readonly holdSince: number | undefined

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly destination: string | null,
    private readonly breaker?: CircuitBreaker,
  ) {
    this.sql = storage.sql
    this.holdSince = storage.transactionSync(() => {
      this.initialize()
      this.breaker?.initialize()
      const key = 'invalid-breaker-since'
      const since = storage.kv.get<number>(key)
      if (this.breaker?.invalid) {
        if (since !== undefined) return since
        const now = Date.now()
        storage.kv.put(key, now)
        return now
      }
      if (since !== undefined) {
        this.sql.exec(
          "UPDATE events SET heldMs = heldMs + ? WHERE state = 'queued' AND createdAt + heldMs > ?",
          Math.max(0, Date.now() - since),
          since - pendingLifetime,
        )
        storage.kv.delete(key)
      }
    })
  }

  get invalidBreaker() {
    return this.holdSince !== undefined
  }

  private initialize() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT NOT NULL PRIMARY KEY,
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        heldMs INTEGER NOT NULL DEFAULT 0,
        startedAt INTEGER,
        attempt TEXT,
        outcome TEXT,
        reason TEXT,
        sessionId TEXT NOT NULL,
        destination TEXT NOT NULL,
        vmId TEXT NOT NULL,
        messageId TEXT,
        UNIQUE (source, key)
      );
      CREATE INDEX IF NOT EXISTS arrivals ON events(source, createdAt);
      CREATE INDEX IF NOT EXISTS source_message ON events(source, messageId) WHERE messageId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS history ON events(createdAt);
      CREATE INDEX IF NOT EXISTS pending ON events(state, createdAt);
      CREATE TABLE IF NOT EXISTS event_groups (
        source TEXT NOT NULL, groupKey TEXT NOT NULL,
        id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
        PRIMARY KEY (source, groupKey)
      );
      CREATE TABLE IF NOT EXISTS retractions (
        source TEXT NOT NULL, messageId TEXT NOT NULL, receivedAt INTEGER NOT NULL,
        PRIMARY KEY (source, messageId)
      );
      CREATE INDEX IF NOT EXISTS retraction_age ON retractions(receivedAt);
      CREATE TABLE IF NOT EXISTS delivery_retries (
        destination TEXT NOT NULL, vmId TEXT NOT NULL, sessionId TEXT NOT NULL, retryAt INTEGER NOT NULL,
        PRIMARY KEY (destination, vmId, sessionId)
      );
      CREATE TABLE IF NOT EXISTS lease_snapshots (
        destination TEXT NOT NULL PRIMARY KEY, vmIds TEXT NOT NULL, retryAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorizations (startedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rules (
        source TEXT NOT NULL PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0,
        types TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS side_chats (
        destination TEXT NOT NULL,
        name TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        vmId TEXT NOT NULL,
        active INTEGER NOT NULL,
        PRIMARY KEY (destination, name)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_side_chat ON side_chats(destination) WHERE active = 1;
    `)
  }

  getActiveSideChat(): SideChatTarget | undefined {
    return this.sql.exec<SideChatTarget>(
      'SELECT name, sessionId, vmId FROM side_chats WHERE destination = ? AND active = 1',
      this.destination,
    ).toArray()[0]
  }

  getSideChat(name: string) {
    return this.sql.exec<SideChatTarget>(
      'SELECT name, sessionId, vmId FROM side_chats WHERE destination = ? AND name = ?',
      this.destination, name,
    ).toArray()[0]
  }

  listSideChats(): SideChats {
    const chats = this.sql.exec<SideChat>(
      'SELECT name, sessionId FROM side_chats WHERE destination = ? ORDER BY name', this.destination,
    ).toArray()
    return { active: this.getActiveSideChat()?.name ?? null, chats }
  }

  registerSideChat(name: string, sessionId: string, vmId: string): SideChats {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO side_chats (destination, name, sessionId, vmId, active)
         VALUES (?, ?, ?, ?, NOT EXISTS (SELECT 1 FROM side_chats WHERE destination = ? AND active = 1))
         ON CONFLICT(destination, name) DO UPDATE SET sessionId = excluded.sessionId, vmId = excluded.vmId,
           active = MAX(side_chats.active, excluded.active)`,
        this.destination, name, sessionId, vmId, this.destination,
      )
      return this.listSideChats()
    })
  }

  setActiveSideChat(chat: SideChatTarget): SideChats | null {
    return this.storage.transactionSync(() => {
      const current = this.getSideChat(chat.name)
      if (!current || current.sessionId !== chat.sessionId || current.vmId !== chat.vmId) return null
      this.sql.exec('UPDATE side_chats SET active = 0 WHERE destination = ? AND active = 1', this.destination)
      this.sql.exec('UPDATE side_chats SET active = 1 WHERE destination = ? AND name = ?', this.destination, chat.name)
      return this.listSideChats()
    })
  }

  retractMessages(source: string, ids: string[]) {
    this.storage.transactionSync(() => {
      const now = Date.now()
      const messages = JSON.stringify(ids)
      this.sql.exec('DELETE FROM retractions WHERE receivedAt <= ?', now - historyLifetime)
      this.sql.exec(
        'INSERT OR REPLACE INTO retractions SELECT ?, value, ? FROM json_each(?)',
        source, now, messages,
      )
      this.sql.exec(
        `UPDATE events SET text = '', reason = 'message_retracted',
          state = CASE WHEN state = 'queued' THEN 'suppressed' ELSE state END
         WHERE source = ? AND messageId IN (SELECT value FROM json_each(?)) AND state IN ('queued', 'sending')`,
        source, messages,
      )
    })
  }

  abandonPending() {
    this.sql.exec(
      "UPDATE events SET state = 'suppressed', text = '', reason = 'destination_changed' WHERE state = 'queued' AND destination = ?",
      this.destination,
    )
  }

  enqueue(event: HookEvent): Receipt {
    if (this.invalidBreaker) return { invalidBreaker: true }
    return this.storage.transactionSync(() => {
      const now = Date.now()
      this.prune(now)
      const existing = this.sql
        .exec<{
          id: string
          state: State
        }>('SELECT id, state FROM events WHERE source = ? AND key = ?', event.source, event.key)
        .toArray()[0]
      if (existing) return { ...existing, duplicate: true }
      if (event.coalesceKey) {
        const grouped = this.sql.exec<{ id: string; state: State }>(
          'SELECT events.id, state FROM event_groups JOIN events USING (id) WHERE event_groups.source = ? AND groupKey = ?',
          event.source, event.coalesceKey,
        ).toArray()[0]
        if (grouped) return { ...grouped, duplicate: true }
      }

      const target = this.getActiveSideChat()
      if (!target) return { noDestination: true }

      const { count } = this.sql
        .exec<{
          count: number
        }>(
          'SELECT COUNT(*) AS count FROM events WHERE source = ? AND createdAt > ?',
          event.source,
          now - minute,
        )
        .one()
      if (count >= ingressPerMinute) return { limited: true }

      const id = crypto.randomUUID()
      this.sql.exec(
        "INSERT INTO events(id, source, key, type, text, state, createdAt, sessionId, destination, vmId, messageId) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
        id,
        event.source,
        event.key,
        event.type,
        event.text,
        now,
        target.sessionId,
        this.destination,
        target.vmId,
        event.messageId ?? null,
      )
      if (event.coalesceKey) {
        // A filtered callback cannot reserve the message for its other subscribed event types.
        this.sql.exec(
          `INSERT INTO event_groups SELECT source, ?, id FROM events WHERE id = ? AND NOT EXISTS
           (SELECT 1 FROM rules WHERE rules.source = events.source AND ${typeFiltered})`,
          event.coalesceKey, id,
        )
      }
      if (event.messageId) {
        this.sql.exec(
          `UPDATE events SET state = 'suppressed', text = '', reason = 'message_retracted'
           WHERE id = ? AND EXISTS (SELECT 1 FROM retractions WHERE source = ? AND messageId = ? AND receivedAt > ?)`,
          id, event.source, event.messageId, now - historyLifetime,
        )
      }
      this.breaker?.screenQueued(id, event.source, event.parentId)
      this.suppressBlocked(event.source)
      const { state } = this.sql
        .exec<{ state: State }>('SELECT state FROM events WHERE id = ?', id)
        .one()
      return { id, state, duplicate: false }
    })
  }

  recordLeases(vmIds: string[]) {
    this.sql.exec(
      'INSERT OR REPLACE INTO lease_snapshots (destination, vmIds, retryAt) VALUES (?, ?, ?)',
      this.destination, JSON.stringify(vmIds), Date.now() + minute,
    )
  }

  nextWakeAt(): number | null {
    if (this.invalidBreaker) return null
    const now = Date.now()
    this.prune(now)
    const active = this.sql
      .exec<{ startedAt: number }>("SELECT startedAt FROM events WHERE state = 'sending' LIMIT 1")
      .toArray()[0]
    if (active) return active.startedAt + deliveryTimeout
    const { readyAt } = this.sql.exec<{ readyAt: number | null }>(
      `SELECT MIN(MAX(COALESCE(r.retryAt, 0), CASE
          WHEN events.vmId IN (SELECT value FROM json_each(s.vmIds)) THEN 0 ELSE COALESCE(s.retryAt, 0) END)) AS readyAt
       FROM events ${chatRetry} LEFT JOIN lease_snapshots s ON s.destination = events.destination
       WHERE state = 'queued' AND events.destination = ?`,
      this.destination,
    ).one()
    if (readyAt === null) return null
    const { count, oldest } = this.sql
      .exec<{
        count: number
        oldest: number | null
      }>(
        'SELECT COUNT(*) AS count, MIN(startedAt) AS oldest FROM authorizations WHERE startedAt > ?',
        now - minute,
      )
      .one()
    return Math.max(readyAt, count >= deliveriesPerMinute && oldest !== null ? oldest + minute : now)
  }

  claim(leasedVmIds: string[]): Claim | null {
    if (!leasedVmIds.length || this.invalidBreaker) return null
    return this.storage.transactionSync(() => {
      const now = Date.now()
      this.prune(now)
      this.sql.exec('DELETE FROM authorizations WHERE startedAt <= ?', now - minute)
      const { busy, recent } = this.sql
        .exec<{ busy: number; recent: number }>(
          `
        SELECT EXISTS (SELECT 1 FROM events WHERE state = 'sending') AS busy,
          (SELECT COUNT(*) FROM authorizations) AS recent
      `,
        )
        .one()
      if (busy || recent >= deliveriesPerMinute) return null

      const event = this.sql
        .exec<Delivery & { sessionId: string; vmId: string }>(
          `
        SELECT id, source, type, text, events.sessionId, events.vmId
        FROM events ${chatRetry}
        WHERE state = 'queued' AND events.destination = ? AND COALESCE(r.retryAt, 0) <= ?
          AND events.vmId IN (SELECT value FROM json_each(?)) AND NOT ${blockedByRule}
        ORDER BY MAX(createdAt, COALESCE(r.retryAt, 0)), createdAt, events.rowid LIMIT 1
      `,
          this.destination, now, JSON.stringify(leasedVmIds),
        )
        .toArray()[0]
      if (!event) return null

      const attempt = crypto.randomUUID()
      const grant = () => {
        this.sql.exec('INSERT INTO authorizations(startedAt) VALUES (?)', now)
        this.sql.exec(
          "UPDATE events SET state = 'sending', startedAt = ?, attempt = ?, outcome = NULL WHERE id = ?",
          now,
          attempt,
          event.id,
        )
        return { ...event, attempt }
      }
      return this.breaker ? this.breaker.authorize(event.source, attempt, now, grant) : grant()
    })
  }

  finish(id: string, attempt: string, outcome: Outcome): boolean {
    return this.storage.transactionSync(() => {
      const now = Date.now()
      this.prune(now)
      const current = this.sql
        .exec<{ source: string; sessionId: string; vmId: string; destination: string; outcome: Outcome | null; retryState: State }>(
          `
        SELECT source, sessionId, vmId, destination, outcome, CASE
          WHEN reason = 'message_retracted' THEN 'suppressed'
          WHEN createdAt + heldMs <= ? THEN 'expired'
          WHEN ${blockedByRule} THEN 'suppressed'
          ELSE 'queued' END AS retryState
        FROM events WHERE id = ? AND attempt = ?
      `,
          (this.holdSince ?? now) - pendingLifetime,
          id,
          attempt,
        )
        .toArray()[0]
      if (!current) return false
      if (current.outcome !== null) return current.outcome === outcome

      if (outcome === 'side_chat_missing') {
        const { destination, sessionId, vmId } = current
        this.sql.exec(
          'UPDATE side_chats SET active = 0 WHERE destination = ? AND sessionId = ? AND vmId = ? AND active = 1',
          destination, sessionId, vmId,
        )
        this.sql.exec(
          `UPDATE events SET state = 'suppressed', reason = 'side_chat_missing', text = ''
           WHERE state = 'queued' AND destination = ? AND sessionId = ? AND vmId = ?`,
          destination, sessionId, vmId,
        )
        this.sql.exec(
          "UPDATE events SET state = 'suppressed', reason = COALESCE(reason, ?), outcome = ?, text = '' WHERE id = ?",
          outcome, outcome, id,
        )
        return true
      }

      const state = outcome === 'not_sent' ? current.retryState : outcome
      this.sql.exec(
        `
        UPDATE events SET state = ?, outcome = ?, text = CASE WHEN ? = 'queued' THEN text ELSE '' END
        WHERE id = ?
      `,
        state,
        outcome,
        state,
        id,
      )
      if (state === 'queued') {
        this.breaker?.screenQueued(id, current.source)
        this.sql.exec(
          `INSERT OR REPLACE INTO delivery_retries (destination, vmId, sessionId, retryAt)
           SELECT destination, vmId, sessionId, ? FROM events WHERE id = ? AND state = 'queued'`,
          now + minute, id,
        )
      }
      return true
    })
  }

  status(id: string): Status | null {
    this.prune(Date.now())
    const row = this.sql
      .exec<Omit<Status, 'reason'> & { reason: ReceiptReason | null }>(
        `SELECT id, source, type, state, createdAt, CASE
          WHEN state = 'queued' AND destination IS NOT ? THEN 'destination_changed'
          ELSE reason END AS reason FROM events WHERE id = ?`,
        this.destination,
        id,
      )
      .toArray()[0]
    if (!row) return null
    const { reason, ...status } = row
    return reason ? { ...status, reason } : status
  }

  breakerStatus(): BreakerStatus {
    return this.breaker?.status() ?? { state: 'disabled' }
  }

  rearmBreaker(expectedGeneration: number) {
    return this.storage.transactionSync(() => {
      this.prune(Date.now())
      const ok = this.breaker?.rearm(expectedGeneration) ?? false
      return { ok, status: this.breakerStatus() }
    })
  }

  sources(): Rule[] {
    this.prune(Date.now())
    const rows = this.sql.exec<RuleRow>(`
      SELECT source, COALESCE(paused, 0) AS paused, COALESCE(types, '[]') AS types
      FROM (SELECT source FROM events UNION SELECT source FROM rules)
      LEFT JOIN rules USING (source) ORDER BY source
    `)
    return rows.toArray().map(decodeRule)
  }

  setPaused(source: string, paused: boolean): Rule {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO rules(source, paused) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET paused = excluded.paused',
        source,
        Number(paused),
      )
      return this.applyRule(source)
    })
  }

  setFilter(source: string, types: string[]): Rule {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO rules(source, types) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET types = excluded.types',
        source,
        JSON.stringify([...new Set(types)]),
      )
      return this.applyRule(source)
    })
  }

  private applyRule(source: string): Rule {
    this.prune(Date.now())
    this.suppressBlocked(source)
    return decodeRule(
      this.sql
        .exec<RuleRow>('SELECT source, paused, types FROM rules WHERE source = ?', source)
        .one(),
    )
  }

  private suppressBlocked(source: string): void {
    this.sql.exec(
      `
      UPDATE events SET state = 'suppressed', text = ''
      WHERE source = ? AND state = 'queued' AND ${blockedByRule}
    `,
      source,
    )
  }

  private prune(now: number): void {
    this.sql.exec('DELETE FROM lease_snapshots WHERE retryAt <= ?', now)
    this.sql.exec('DELETE FROM delivery_retries WHERE retryAt <= ?', now - pendingLifetime)
    this.sql.exec('DELETE FROM retractions WHERE receivedAt <= ?', now - historyLifetime)
    this.sql.exec(
      "UPDATE events SET state = 'expired', text = '' WHERE state = 'queued' AND createdAt + heldMs <= ?",
      (this.holdSince ?? now) - pendingLifetime,
    )
    this.sql.exec(
      "UPDATE events SET state = 'unknown', outcome = 'unknown', text = '' WHERE state = 'sending' AND startedAt <= ?",
      now - deliveryTimeout,
    )
    this.sql.exec(
      "DELETE FROM events WHERE createdAt <= ? AND state NOT IN ('queued', 'sending') AND createdAt + heldMs <= ?",
      now - historyLifetime,
      now - historyLifetime,
    )
  }
}

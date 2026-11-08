'use strict';

const crypto = require('node:crypto');

/**
 * Transactional Outbox: el evento se guarda en la misma transacción que el dato
 * de negocio y un despachador lo entrega después con reintentos y backoff.
 * Entrega al menos una vez: los consumidores deben ser idempotentes.
 */
const OUTBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'DEAD')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);
`;

function enqueue(db, target, payload, now = Date.now()) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO outbox (id, target, payload, status, next_attempt_at, created_at)
    VALUES (?, ?, ?, 'PENDING', ?, ?)`)
    .run(id, target, JSON.stringify({ ...payload, eventId: payload.eventId || id }), now, new Date(now).toISOString());
  return id;
}

function backoffMs(attempts, baseMs = 500, maxMs = 30000) {
  return Math.min(baseMs * 2 ** Math.max(attempts - 1, 0), maxMs);
}

class OutboxDispatcher {
  /** @param senders mapa target -> async (payload) => void; lanzar error provoca reintento. */
  constructor(db, senders, { maxAttempts = 20, baseMs = 500, maxMs = 30000, batch = 50, now = Date.now, metrics, log = () => {} } = {}) {
    Object.assign(this, { db, senders, maxAttempts, baseMs, maxMs, batch, now, metrics, log });
    this.running = false;
  }

  async tick() {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      const due = this.db.prepare(`SELECT * FROM outbox WHERE status = 'PENDING' AND next_attempt_at <= ?
        ORDER BY created_at LIMIT ?`).all(this.now(), this.batch);
      for (const row of due) {
        if (await this.#deliver(row)) delivered += 1;
      }
      if (this.metrics) this.metrics.gauge('outbox_pending', this.pending());
    } finally {
      this.running = false;
    }
    return delivered;
  }

  pending() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE status = 'PENDING'").get().c;
  }

  async #deliver(row) {
    try {
      const send = this.senders[row.target];
      if (!send) throw new Error(`Destino desconocido: ${row.target}`);
      await send(JSON.parse(row.payload));
      this.db.prepare("UPDATE outbox SET status = 'SENT', attempts = attempts + 1, last_error = NULL WHERE id = ?").run(row.id);
      if (this.metrics) this.metrics.inc('outbox_delivered_total');
      return true;
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= this.maxAttempts;
      this.db.prepare('UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
        .run(dead ? 'DEAD' : 'PENDING', attempts, this.now() + backoffMs(attempts, this.baseMs, this.maxMs), String(err.message), row.id);
      if (this.metrics) this.metrics.inc('outbox_delivery_failures_total');
      this.log('warn', 'outbox_delivery_failed', { id: row.id, target: row.target, attempts, dead, error: err.message });
      return false;
    }
  }

  start(intervalMs = 1000) {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log('error', 'outbox_tick_failed', { error: err.message }));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { OUTBOX_SCHEMA, enqueue, backoffMs, OutboxDispatcher };

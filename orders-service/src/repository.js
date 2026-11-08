'use strict';

const { DatabaseSync } = require('node:sqlite');
const { OUTBOX_SCHEMA } = require('./lib/outbox');

/** Capa de acceso a datos. Base de datos privada del servicio (SQLite). */
function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_name TEXT,
      status TEXT NOT NULL,
      total_cents INTEGER,
      payment_token TEXT,
      payment_reference TEXT,
      failure_reason TEXT,
      idempotency_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_due ON orders(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT NOT NULL REFERENCES orders(id),
      product_id TEXT NOT NULL,
      name TEXT,
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER,
      PRIMARY KEY (order_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS order_history (
      order_id TEXT NOT NULL REFERENCES orders(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      at TEXT NOT NULL
    );
    ${OUTBOX_SCHEMA}
  `);
  return db;
}

class OrderRepository {
  constructor(db) {
    this.db = db;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  insertOrder(o) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO orders
        (id, user_id, customer_email, customer_name, status, payment_token, idempotency_key, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`)
        .run(o.id, o.userId, o.email, o.name || null, o.paymentToken, o.idempotencyKey, o.nextAttemptAt, o.at, o.at);
      const item = this.db.prepare('INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)');
      for (const i of o.items) item.run(o.id, i.productId, i.quantity);
      this.db.prepare('INSERT INTO order_history (order_id, from_status, to_status, at) VALUES (?, NULL, ?, ?)').run(o.id, 'PENDING', o.at);
    });
  }

  #hydrate(row) {
    if (!row) return null;
    const items = this.db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(row.id).map((i) => ({
      productId: i.product_id, name: i.name, quantity: i.quantity, unitPriceCents: i.unit_price_cents,
    }));
    const history = this.db.prepare('SELECT from_status, to_status, at FROM order_history WHERE order_id = ? ORDER BY rowid').all(row.id)
      .map((h) => ({ from: h.from_status, to: h.to_status, at: h.at }));
    return {
      id: row.id,
      userId: row.user_id,
      customerEmail: row.customer_email,
      status: row.status,
      totalCents: row.total_cents,
      paymentToken: row.payment_token,
      paymentReference: row.payment_reference,
      failureReason: row.failure_reason,
      attempts: row.attempts,
      items,
      history,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  find(id) {
    return this.#hydrate(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
  }

  findByIdempotencyKey(userId, key) {
    return this.#hydrate(this.db.prepare('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?').get(userId, key));
  }

  listByUser(userId) {
    return this.db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(userId).map((r) => this.#hydrate(r));
  }

  listAll() {
    return this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all().map((r) => this.#hydrate(r));
  }

  setPricing(orderId, items, totalCents, reference) {
    const stmt = this.db.prepare('UPDATE order_items SET name = ?, unit_price_cents = ? WHERE order_id = ? AND product_id = ?');
    for (const i of items) stmt.run(i.name, i.unitPriceCents, orderId, i.productId);
    this.db.prepare('UPDATE orders SET total_cents = ?, payment_reference = ? WHERE id = ?').run(totalCents, reference, orderId);
  }

  /** Transición optimista: si otro proceso ya la hizo, aborta la transacción. */
  changeStatus(id, from, to, at, reason = null) {
    const done = this.db.prepare(`UPDATE orders SET status = ?, failure_reason = COALESCE(?, failure_reason), updated_at = ?,
      payment_token = CASE WHEN ? = 'PENDING' THEN NULL ELSE payment_token END
      WHERE id = ? AND status = ?`).run(to, reason, at, from, id, from).changes;
    if (done !== 1) throw new Error(`Transición concurrente en el pedido ${id}`);
    this.db.prepare('INSERT INTO order_history (order_id, from_status, to_status, at) VALUES (?, ?, ?, ?)').run(id, from, to, at);
  }

  scheduleRetry(id, attempts, nextAt, reason) {
    this.db.prepare('UPDATE orders SET attempts = ?, next_attempt_at = ?, failure_reason = ? WHERE id = ?').run(attempts, nextAt, reason, id);
  }

  duePending(now, limit) {
    return this.db.prepare("SELECT id FROM orders WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?")
      .all(now, limit).map((r) => r.id);
  }

  countPending() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'PENDING'").get().c;
  }
}

module.exports = { openDatabase, OrderRepository };

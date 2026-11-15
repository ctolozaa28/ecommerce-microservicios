'use strict';

const { DatabaseSync } = require('node:sqlite');

/** Capa de acceso a datos. Base de datos privada del servicio (SQLite). */
function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient);
  `);
  return db;
}

const view = (r) => ({
  id: r.id,
  eventId: r.event_id,
  type: r.type,
  recipient: r.recipient,
  subject: r.subject,
  body: r.body,
  status: r.status,
  attempts: r.attempts,
  createdAt: new Date(r.created_at).toISOString(),
  sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
});

class NotificationRepository {
  constructor(db) {
    this.db = db;
  }

  /** La restricción UNIQUE sobre event_id hace al consumidor idempotente. */
  insertIfNew(n) {
    return this.db.prepare(`INSERT OR IGNORE INTO notifications
      (id, event_id, type, recipient, subject, body, status, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
      .run(n.id, n.eventId, n.type, n.recipient, n.subject, n.body, n.at, n.at).changes > 0;
  }

  due(now, limit) {
    return this.db.prepare(`SELECT * FROM notifications WHERE status = 'PENDING' AND next_attempt_at <= ?
      ORDER BY created_at LIMIT ?`).all(now, limit).map(view);
  }

  markSent(id, at) {
    this.db.prepare("UPDATE notifications SET status = 'SENT', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?").run(at, id);
  }

  markFailure(id, attempts, final, nextAt, error) {
    this.db.prepare('UPDATE notifications SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
      .run(final ? 'FAILED' : 'PENDING', attempts, nextAt, error, id);
  }

  list(recipient) {
    return this.db.prepare('SELECT * FROM notifications WHERE recipient = ? ORDER BY created_at').all(recipient).map(view);
  }
}

module.exports = { openDatabase, NotificationRepository };

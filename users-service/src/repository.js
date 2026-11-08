'use strict';

const { DatabaseSync } = require('node:sqlite');
const { OUTBOX_SCHEMA } = require('./lib/outbox');

/** Capa de acceso a datos. Base de datos privada del servicio (SQLite). */
function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      role TEXT NOT NULL CHECK (role IN ('customer', 'admin')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ${OUTBOX_SCHEMA}
  `);
  return db;
}

class UserRepository {
  constructor(db) {
    this.db = db;
  }

  findByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  findById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  insert(u) {
    this.db.prepare(`INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(u.id, u.email, u.name, u.role, u.passwordHash, u.at, u.at);
  }

  updateProfile(id, { name, phone, address, at }) {
    this.db.prepare('UPDATE users SET name = ?, phone = ?, address = ?, updated_at = ? WHERE id = ?')
      .run(name, phone, address, at, id);
  }

  updatePassword(id, hash, at) {
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, at, id);
  }
}

module.exports = { openDatabase, UserRepository };

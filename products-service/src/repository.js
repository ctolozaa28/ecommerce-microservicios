'use strict';

const { DatabaseSync } = require('node:sqlite');

/** Capa de acceso a datos. Base de datos privada del servicio (SQLite). */
function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      stock INTEGER NOT NULL CHECK (stock >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('RESERVED', 'RELEASED')),
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

const toProduct = (r) => r && {
  id: r.id,
  name: r.name,
  description: r.description,
  priceCents: r.price_cents,
  stock: r.stock,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
};

class ProductRepository {
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

  insert(p) {
    this.db.prepare(`INSERT INTO products (id, name, description, price_cents, stock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, p.name, p.description, p.priceCents, p.stock, p.createdAt, p.updatedAt);
    return p;
  }

  find(id) {
    return toProduct(this.db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(id));
  }

  list({ search, limit, offset }) {
    const where = ['deleted_at IS NULL'];
    const args = [];
    if (search) {
      where.push('name LIKE ?');
      args.push(`%${search}%`);
    }
    const rows = this.db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')}
      ORDER BY created_at, id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return rows.map(toProduct);
  }

  update(p) {
    this.db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, stock = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`).run(p.name, p.description, p.priceCents, p.stock, p.updatedAt, p.id);
    return p;
  }

  softDelete(id, at) {
    return this.db.prepare('UPDATE products SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(at, id).changes > 0;
  }

  findReservation(id) {
    return this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  }

  decrementStock(productId, quantity, at) {
    return this.db.prepare(`UPDATE products SET stock = stock - ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND stock >= ?`).run(quantity, at, productId, quantity).changes > 0;
  }

  incrementStock(productId, quantity, at) {
    this.db.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').run(quantity, at, productId);
  }

  insertReservation(id, productId, quantity, status, at) {
    this.db.prepare(`INSERT INTO reservations (id, product_id, quantity, status, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, productId, quantity, status, at);
  }

  markReleased(id) {
    this.db.prepare("UPDATE reservations SET status = 'RELEASED' WHERE id = ?").run(id);
  }
}

module.exports = { openDatabase, ProductRepository };

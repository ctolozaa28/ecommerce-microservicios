'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const jwt = require('jsonwebtoken');
const { AppError } = require('./lib/http');
const { enqueue } = require('./lib/outbox');

const scrypt = promisify(crypto.scrypt);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const key = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(key, Buffer.from(hex, 'hex'));
}

function validateRegistration({ email, password, name } = {}) {
  if (typeof email !== 'string' || !EMAIL.test(email)) throw new AppError(400, 'INVALID_EMAIL', 'email inválido');
  if (typeof password !== 'string' || password.length < 8) {
    throw new AppError(400, 'WEAK_PASSWORD', 'password debe tener al menos 8 caracteres');
  }
  if (typeof name !== 'string' || name.trim().length < 2) throw new AppError(400, 'INVALID_NAME', 'name es obligatorio');
  return { email: email.toLowerCase(), password, name: name.trim() };
}

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, phone: u.phone, address: u.address, role: u.role, createdAt: u.created_at,
});

/** Lógica de negocio: registro, autenticación y perfiles de usuario. */
class UserService {
  constructor(db, repo, { jwtSecret, tokenTtl = '1h' }) {
    Object.assign(this, { db, repo, jwtSecret, tokenTtl });
  }

  async register(input, role = 'customer') {
    const { email, password, name } = validateRegistration(input);
    if (this.repo.findByEmail(email)) throw new AppError(409, 'EMAIL_TAKEN', 'El email ya está registrado');
    const passwordHash = await hashPassword(password);
    const user = { id: crypto.randomUUID(), email, name, role, passwordHash, at: new Date().toISOString() };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.repo.findByEmail(email)) throw new AppError(409, 'EMAIL_TAKEN', 'El email ya está registrado');
      this.repo.insert(user);
      enqueue(this.db, 'notifications', {
        type: 'user.registered', recipient: email, data: { name, userId: user.id },
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return publicUser(this.repo.findById(user.id));
  }

  /** Mensaje único ante cualquier fallo para no revelar qué cuentas existen. */
  async login({ email, password } = {}) {
    const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    if (typeof email !== 'string' || typeof password !== 'string') throw invalid;
    const user = this.repo.findByEmail(email.toLowerCase());
    if (!user || !(await verifyPassword(password, user.password_hash))) throw invalid;
    const token = jwt.sign(
      { email: user.email, name: user.name, role: user.role },
      this.jwtSecret,
      { subject: user.id, issuer: 'users-service', algorithm: 'HS256', expiresIn: this.tokenTtl },
    );
    return { token, user: publicUser(user) };
  }

  profile(id) {
    const user = this.repo.findById(id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    return publicUser(user);
  }

  updateProfile(id, input = {}) {
    const current = this.repo.findById(id);
    if (!current) throw new AppError(404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    const { name = current.name, phone = current.phone, address = current.address } = input;
    if (typeof name !== 'string' || name.trim().length < 2) throw new AppError(400, 'INVALID_NAME', 'name inválido');
    for (const v of [phone, address]) {
      if (v !== null && typeof v !== 'string') throw new AppError(400, 'INVALID_PROFILE', 'phone y address deben ser texto');
    }
    this.repo.updateProfile(id, { name: name.trim(), phone, address, at: new Date().toISOString() });
    return this.profile(id);
  }

  async changePassword(id, { currentPassword, newPassword } = {}) {
    const user = this.repo.findById(id);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new AppError(400, 'WEAK_PASSWORD', 'password debe tener al menos 8 caracteres');
    }
    this.repo.updatePassword(id, await hashPassword(newPassword), new Date().toISOString());
  }
}

module.exports = { UserService, hashPassword, verifyPassword, validateRegistration };

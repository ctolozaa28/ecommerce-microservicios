'use strict';

/** Utilidades de los scripts: arrancar y detener servicios como procesos independientes. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVICES = {
  products: { dir: 'products-service', port: 3101 },
  users: { dir: 'users-service', port: 3102 },
  orders: { dir: 'orders-service', port: 3103 },
  notifications: { dir: 'notifications-service', port: 3104 },
};
const url = (name) => `http://127.0.0.1:${SERVICES[name].port}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

class Cluster {
  constructor(extraEnv = {}) {
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecommerce-'));
    this.procs = new Map();
    this.extraEnv = extraEnv;
  }

  env(name, port = SERVICES[name].port) {
    return {
      ...process.env,
      LOG_LEVEL: 'silent',
      PORT: String(port),
      DB_PATH: path.join(this.dataDir, `${name}.db`),
      JWT_SECRET: 'script-secret',
      INTERNAL_KEY: 'script-key',
      PRODUCTS_URL: url('products'),
      NOTIFICATIONS_URL: url('notifications'),
      ADMIN_EMAIL: 'admin@tienda.test',
      ADMIN_PASSWORD: 'admin12345',
      WORKER_INTERVAL_MS: '100',
      OUTBOX_INTERVAL_MS: '100',
      OUTBOX_BASE_MS: '100',
      SAGA_RETRY_BASE_MS: '200',
      NODE_NO_WARNINGS: '1',
      ...this.extraEnv,
    };
  }

  async start(name, { port = SERVICES[name].port, key = name } = {}) {
    const proc = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(ROOT, SERVICES[name].dir), env: this.env(name, port), stdio: 'ignore',
    });
    this.procs.set(key, proc);
    await this.waitHealthy(port);
  }

  async waitHealthy(port) {
    for (let i = 0; i < 100; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
      } catch { /* aún arrancando */ }
      await sleep(100);
    }
    throw new Error(`Puerto ${port} no respondió`);
  }

  async kill(key) {
    const proc = this.procs.get(key);
    if (!proc) return;
    const done = new Promise((r) => { proc.once('exit', r); });
    proc.kill();
    await done;
    this.procs.delete(key);
  }

  async startAll() {
    for (const name of Object.keys(SERVICES)) await this.start(name);
  }

  async stopAll() {
    for (const key of [...this.procs.keys()]) await this.kill(key);
    await sleep(100);
    try { fs.rmSync(this.dataDir, { recursive: true, force: true }); } catch { /* Windows puede retener archivos */ }
  }
}

async function json(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function request(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function login(email, password) {
  return (await json(await request(url('users'), '/users/login', { method: 'POST', body: { email, password } }))).token;
}

async function registerCustomer(email) {
  const account = { email, password: 'clave-segura', name: 'Cliente de prueba' };
  await request(url('users'), '/users/register', { method: 'POST', body: account });
  return login(email, account.password);
}

async function createProduct(adminToken, name, priceCents, stock) {
  return json(await request(url('products'), '/products', { method: 'POST', token: adminToken, body: { name, priceCents, stock } }));
}

async function waitFor(check, { timeoutMs = 15000, stepMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Tiempo de espera agotado');
    await sleep(stepMs);
  }
}

class Report {
  constructor(title) {
    this.title = title;
    this.rows = [];
    console.log(`\n=== ${title} ===`);
  }

  check(label, ok, detail = '') {
    this.rows.push({ label, ok });
    console.log(`${ok ? 'OK   ' : 'FALLO'} ${label}${detail ? ` -> ${detail}` : ''}`);
  }

  finish() {
    const failed = this.rows.filter((r) => !r.ok).length;
    console.log(`\nResultado: ${this.rows.length - failed}/${this.rows.length} verificaciones correctas`);
    process.exitCode = failed ? 1 : 0;
  }
}

module.exports = {
  Cluster, SERVICES, url, sleep, json, request, login, registerCustomer, createProduct, waitFor, Report,
};

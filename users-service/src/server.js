'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { requireSafeConfig } = require('./lib/http');

const DEFAULTS = { jwtSecret: 'dev-only-jwt-secret', internalKey: 'dev-only-internal-key', adminPassword: 'admin12345' };
const config = {
  port: Number(process.env.PORT || 3002),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'users.db'),
  jwtSecret: process.env.JWT_SECRET || DEFAULTS.jwtSecret,
  internalKey: process.env.INTERNAL_KEY || DEFAULTS.internalKey,
  notificationsUrl: process.env.NOTIFICATIONS_URL || 'http://127.0.0.1:3004',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@tienda.test',
  adminPassword: process.env.ADMIN_PASSWORD || DEFAULTS.adminPassword,
  tokenTtl: process.env.TOKEN_TTL || '1h',
};
requireSafeConfig(config, DEFAULTS);
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const app = createApp(config);
const { service, dispatcher, log, close } = app.locals;

async function main() {
  await service.register({ email: config.adminEmail, password: config.adminPassword, name: 'Administrador' }, 'admin')
    .catch((err) => { if (err.code !== 'EMAIL_TAKEN') throw err; });
  dispatcher.start(Number(process.env.OUTBOX_INTERVAL_MS || 1000));
  const server = app.listen(config.port, () => log('info', 'started', { port: config.port }));
  const shutdown = () => server.close(() => { close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log('error', 'startup_failed', { error: err.message });
  process.exit(1);
});

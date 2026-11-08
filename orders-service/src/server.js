'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { requireSafeConfig } = require('./lib/http');

const DEFAULTS = { jwtSecret: 'dev-only-jwt-secret', internalKey: 'dev-only-internal-key' };
const config = {
  port: Number(process.env.PORT || 3003),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'orders.db'),
  jwtSecret: process.env.JWT_SECRET || DEFAULTS.jwtSecret,
  internalKey: process.env.INTERNAL_KEY || DEFAULTS.internalKey,
  productsUrl: process.env.PRODUCTS_URL || 'http://127.0.0.1:3001',
  notificationsUrl: process.env.NOTIFICATIONS_URL || 'http://127.0.0.1:3004',
  paymentUnavailableRate: Number(process.env.PAYMENT_UNAVAILABLE_RATE || 0),
  maxAttempts: Number(process.env.SAGA_MAX_ATTEMPTS || 8),
  retryBaseMs: Number(process.env.SAGA_RETRY_BASE_MS || 1000),
  outboxBaseMs: Number(process.env.OUTBOX_BASE_MS || 500),
};
requireSafeConfig(config, DEFAULTS);
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const app = createApp(config);
const { start, log, close } = app.locals;
start(Number(process.env.WORKER_INTERVAL_MS || 1000));
const server = app.listen(config.port, () => log('info', 'started', { port: config.port }));

const shutdown = () => server.close(() => { close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { requireSafeConfig } = require('./lib/http');

const DEFAULTS = { jwtSecret: 'dev-only-jwt-secret', internalKey: 'dev-only-internal-key' };
const config = {
  port: Number(process.env.PORT || 3004),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notifications.db'),
  jwtSecret: process.env.JWT_SECRET || DEFAULTS.jwtSecret,
  internalKey: process.env.INTERNAL_KEY || DEFAULTS.internalKey,
  emailFailureRate: Number(process.env.EMAIL_FAILURE_RATE || 0),
};
requireSafeConfig(config, DEFAULTS);
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const app = createApp(config);
const { service, log, close } = app.locals;
service.start(Number(process.env.WORKER_INTERVAL_MS || 500));
const server = app.listen(config.port, () => log('info', 'started', { port: config.port }));

const shutdown = () => server.close(() => { close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

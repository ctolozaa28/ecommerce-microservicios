'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { requireSafeConfig } = require('./lib/http');

const DEFAULTS = { jwtSecret: 'dev-only-jwt-secret', internalKey: 'dev-only-internal-key' };
const config = {
  port: Number(process.env.PORT || 3001),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'products.db'),
  jwtSecret: process.env.JWT_SECRET || DEFAULTS.jwtSecret,
  internalKey: process.env.INTERNAL_KEY || DEFAULTS.internalKey,
};
requireSafeConfig(config, DEFAULTS);
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const app = createApp(config);
const server = app.listen(config.port, () => app.locals.log('info', 'started', { port: config.port }));

function shutdown() {
  server.close(() => {
    app.locals.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

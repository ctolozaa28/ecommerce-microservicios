'use strict';

/** Arranca los cuatro servicios en sus puertos por defecto. Ctrl+C los detiene. */
const { spawn } = require('node:child_process');
const path = require('node:path');

const procs = ['products-service', 'users-service', 'orders-service', 'notifications-service'].map((dir) => spawn(
  process.execPath,
  ['src/server.js'],
  { cwd: path.join(__dirname, '..', dir), stdio: 'inherit' },
));

function stop() {
  for (const p of procs) p.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

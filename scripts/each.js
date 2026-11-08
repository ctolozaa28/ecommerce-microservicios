'use strict';

/** Ejecuta `npm install` o `npm test` en cada microservicio. */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const command = process.argv[2];
let failed = false;
for (const dir of ['products-service', 'users-service', 'orders-service', 'notifications-service']) {
  console.log(`\n=== ${dir}: npm ${command} ===`);
  const { status } = spawnSync('npm', [command], {
    cwd: path.join(__dirname, '..', dir), stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;

'use strict';

process.env.LOG_LEVEL = 'silent';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { hashPassword, verifyPassword, validateRegistration } = require('../src/service');
const { backoffMs, OutboxDispatcher, enqueue, OUTBOX_SCHEMA } = require('../src/lib/outbox');
const { DatabaseSync } = require('node:sqlite');

const SECRET = 'test-secret';

describe('contraseñas', () => {
  test('el hash no contiene la contraseña y se verifica', async () => {
    const h = await hashPassword('secreta123');
    assert.ok(!h.includes('secreta123'));
    assert.equal(await verifyPassword('secreta123', h), true);
    assert.equal(await verifyPassword('otra-clave', h), false);
  });
  test('dos hashes de la misma contraseña difieren (sal aleatoria)', async () => {
    assert.notEqual(await hashPassword('secreta123'), await hashPassword('secreta123'));
  });
});

describe('validateRegistration', () => {
  test('normaliza el email', () => {
    assert.equal(validateRegistration({ email: 'A@B.CO', password: '12345678', name: 'Ana' }).email, 'a@b.co');
  });
  for (const [label, input, code] of [
    ['email inválido', { email: 'x', password: '12345678', name: 'Ana' }, 'INVALID_EMAIL'],
    ['contraseña corta', { email: 'a@b.co', password: '123', name: 'Ana' }, 'WEAK_PASSWORD'],
    ['sin nombre', { email: 'a@b.co', password: '12345678' }, 'INVALID_NAME'],
  ]) {
    test(`rechaza ${label}`, () => assert.throws(() => validateRegistration(input), (e) => e.code === code));
  }
});

describe('outbox', () => {
  const fresh = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(OUTBOX_SCHEMA);
    return db;
  };
  test('backoff exponencial con tope', () => {
    assert.equal(backoffMs(1, 100, 1000), 100);
    assert.equal(backoffMs(3, 100, 1000), 400);
    assert.equal(backoffMs(10, 100, 1000), 1000);
  });
  test('entrega y marca como enviado', async () => {
    const db = fresh();
    const seen = [];
    enqueue(db, 't', { type: 'x' });
    const d = new OutboxDispatcher(db, { t: async (p) => { seen.push(p); } });
    assert.equal(await d.tick(), 1);
    assert.equal(seen[0].type, 'x');
    assert.ok(seen[0].eventId);
    assert.equal(d.pending(), 0);
  });
  test('un fallo reprograma y no se reintenta antes del backoff', async () => {
    const db = fresh();
    let t = 1000;
    let calls = 0;
    enqueue(db, 't', { type: 'x' }, t);
    const d = new OutboxDispatcher(db, { t: async () => { calls += 1; if (calls === 1) throw new Error('caído'); } }, { now: () => t, baseMs: 100 });
    assert.equal(await d.tick(), 0);
    assert.equal(d.pending(), 1);
    assert.equal(await d.tick(), 0);
    assert.equal(calls, 1);
    t += 100;
    assert.equal(await d.tick(), 1);
    assert.equal(d.pending(), 0);
  });
  test('tras agotar los intentos pasa a DEAD', async () => {
    const db = fresh();
    let t = 0;
    enqueue(db, 't', { type: 'x' }, t);
    const d = new OutboxDispatcher(db, { t: async () => { throw new Error('caído'); } }, { now: () => t, maxAttempts: 2, baseMs: 1 });
    await d.tick();
    t += 10;
    await d.tick();
    assert.equal(db.prepare('SELECT status FROM outbox').get().status, 'DEAD');
  });
});

describe('API de usuarios', () => {
  let app; let server; let base; const events = [];
  const post = (path, body, token) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const account = { email: 'ana@tienda.test', password: 'clave-segura', name: 'Ana' };

  before(async () => {
    app = createApp({ dbPath: ':memory:', jwtSecret: SECRET, internalKey: 'k', notify: async (e) => { events.push(e); } });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    app.locals.close();
  });

  test('registro devuelve 201, no filtra el hash y publica evento', async () => {
    const res = await post('/users/register', account);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.role, 'customer');
    assert.equal(body.password_hash, undefined);
    await app.locals.dispatcher.tick();
    assert.equal(events[0].type, 'user.registered');
    assert.equal(events[0].recipient, account.email);
  });

  test('email duplicado devuelve 409', async () => {
    assert.equal((await post('/users/register', account)).status, 409);
  });

  test('login emite un JWT verificable con las claims esperadas', async () => {
    const { token } = await (await post('/users/login', account)).json();
    const claims = jwt.verify(token, SECRET, { issuer: 'users-service' });
    assert.equal(claims.email, account.email);
    assert.equal(claims.role, 'customer');
  });

  test('login falla igual con email inexistente o clave errónea', async () => {
    const a = await post('/users/login', { email: 'nadie@x.co', password: 'zzzzzzzz' });
    const b = await post('/users/login', { email: account.email, password: 'zzzzzzzz' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(await a.json(), await b.json());
  });

  test('perfil: consulta y actualización exigen token', async () => {
    assert.equal((await fetch(`${base}/users/me`)).status, 401);
    const { token } = await (await post('/users/login', account)).json();
    const patch = await fetch(`${base}/users/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ phone: '555-1234', address: 'Calle 1' }),
    });
    assert.equal((await patch.json()).phone, '555-1234');
    const me = await (await fetch(`${base}/users/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(me.address, 'Calle 1');
  });

  test('cambio de contraseña invalida la anterior', async () => {
    const acc = { email: 'luis@tienda.test', password: 'clave-inicial', name: 'Luis' };
    await post('/users/register', acc);
    const { token } = await (await post('/users/login', acc)).json();
    assert.equal((await post('/users/me/password', { currentPassword: 'mala-clave', newPassword: 'nueva-clave' }, token)).status, 401);
    assert.equal((await post('/users/me/password', { currentPassword: acc.password, newPassword: 'nueva-clave' }, token)).status, 204);
    assert.equal((await post('/users/login', acc)).status, 401);
    assert.equal((await post('/users/login', { ...acc, password: 'nueva-clave' })).status, 200);
  });
});

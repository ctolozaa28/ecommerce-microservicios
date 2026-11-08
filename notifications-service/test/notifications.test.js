'use strict';

process.env.LOG_LEVEL = 'silent';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { render, SimulatedEmailSender } = require('../src/service');

const SECRET = 'test-secret';
const KEY = 'test-key';

describe('plantillas', () => {
  test('order.confirmed formatea el total en moneda', () => {
    const m = render('order.confirmed', { orderId: 'o1', totalCents: 12345 });
    assert.match(m.subject, /o1/);
    assert.match(m.body, /\$123\.45/);
  });
  test('un tipo desconocido se rechaza con 422', () => {
    assert.throws(() => render('nada', {}), (e) => e.status === 422);
  });
});

describe('SimulatedEmailSender', () => {
  test('falla según failureRate', async () => {
    const down = new SimulatedEmailSender({ failureRate: 1, random: () => 0.5 });
    await assert.rejects(down.send({ recipient: 'a@b.co', subject: 's' }));
    const up = new SimulatedEmailSender({ failureRate: 0, random: () => 0.5 });
    await up.send({ recipient: 'a@b.co', subject: 's' });
  });
});

describe('servicio de notificaciones', () => {
  let app; let server; let base; let fail = false; const delivered = [];
  const event = (eventId, extra = {}) => ({
    eventId, type: 'order.confirmed', recipient: 'ana@tienda.test', data: { orderId: 'o1', totalCents: 100 }, ...extra,
  });
  const postEvent = (body, key = KEY) => fetch(`${base}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': key }, body: JSON.stringify(body),
  });

  before(async () => {
    app = createApp({
      dbPath: ':memory:', jwtSecret: SECRET, internalKey: KEY,
      sender: { send: async (m) => { if (fail) throw new Error('smtp'); delivered.push(m); } },
    });
    app.locals.service.baseMs = 0;
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    app.locals.close();
  });

  test('acepta el evento con 202 sin enviar de forma síncrona', async () => {
    const res = await postEvent(event('e1'));
    assert.equal(res.status, 202);
    assert.equal(delivered.length, 0);
    assert.equal(await app.locals.service.tick(), 1);
    assert.equal(delivered.length, 1);
  });

  test('un evento duplicado no genera una segunda notificación', async () => {
    const res = await postEvent(event('e1'));
    assert.equal((await res.json()).duplicate, true);
    assert.equal(await app.locals.service.tick(), 0);
    assert.equal(delivered.length, 1);
  });

  test('reintenta tras un fallo de transporte', async () => {
    fail = true;
    await postEvent(event('e2'));
    assert.equal(await app.locals.service.tick(), 0);
    fail = false;
    assert.equal(await app.locals.service.tick(), 1);
  });

  test('marca FAILED al agotar los intentos', async () => {
    fail = true;
    await postEvent(event('e3', { recipient: 'falla@tienda.test' }));
    for (let i = 0; i < 5; i += 1) await app.locals.service.tick();
    fail = false;
    const [n] = app.locals.service.list('falla@tienda.test');
    assert.equal(n.status, 'FAILED');
    assert.equal(n.attempts, 5);
  });

  test('valida el evento y la clave interna', async () => {
    assert.equal((await postEvent(event('e4'), 'mala')).status, 401);
    assert.equal((await postEvent(event(''))).status, 400);
    assert.equal((await postEvent(event('e5', { recipient: 'x' }))).status, 400);
    assert.equal((await postEvent(event('e6', { type: 'desconocido' }))).status, 422);
  });

  test('cada usuario consulta solo sus notificaciones', async () => {
    const token = jwt.sign({ sub: 'u', email: 'ana@tienda.test', role: 'customer' }, SECRET, { issuer: 'users-service' });
    const list = await (await fetch(`${base}/notifications/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.ok(list.length >= 1);
    assert.ok(list.every((n) => n.recipient === 'ana@tienda.test'));
    assert.equal((await fetch(`${base}/notifications/me`)).status, 401);
  });
});

'use strict';

process.env.LOG_LEVEL = 'silent';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { canTransition, validateOrder } = require('../src/service');
const { SimulatedPaymentGateway, BusinessError, TransientError } = require('../src/clients');

const SECRET = 'test-secret';
const sign = (sub, role = 'customer') => jwt.sign({ sub, email: `${sub}@tienda.test`, name: sub, role }, SECRET, { issuer: 'users-service' });
const ana = sign('ana');
const luis = sign('luis');
const admin = sign('root', 'admin');

describe('reglas puras', () => {
  test('máquina de estados', () => {
    assert.equal(canTransition('CONFIRMED', 'SHIPPED'), true);
    assert.equal(canTransition('SHIPPED', 'DELIVERED'), true);
    assert.equal(canTransition('DELIVERED', 'CANCELLED'), false);
    assert.equal(canTransition('SHIPPED', 'CANCELLED'), false);
    assert.equal(canTransition('REJECTED', 'CONFIRMED'), false);
  });
  for (const [label, input, code] of [
    ['sin líneas', { items: [], paymentToken: 't' }, 'INVALID_ITEMS'],
    ['cantidad cero', { items: [{ productId: 'a', quantity: 0 }], paymentToken: 't' }, 'INVALID_QUANTITY'],
    ['producto repetido', { items: [{ productId: 'a', quantity: 1 }, { productId: 'a', quantity: 1 }], paymentToken: 't' }, 'DUPLICATE_ITEM'],
    ['sin token de pago', { items: [{ productId: 'a', quantity: 1 }] }, 'INVALID_PAYMENT'],
  ]) {
    test(`validateOrder rechaza ${label}`, () => assert.throws(() => validateOrder(input), (e) => e.code === code));
  }
});

describe('saga de pedidos', () => {
  let app; let server; let base; let products; let payments; let events; let released;
  const body = (token = 'tok_ok', items = [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }]) => ({ items, paymentToken: token });
  const post = (payload, token = ana, headers = {}) => fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(payload),
  });
  const flush = async () => { app.locals.db.exec("UPDATE outbox SET next_attempt_at = 0 WHERE status = 'PENDING'"); await app.locals.dispatcher.tick(); };

  before(async () => {
    products = {
      mode: 'ok',
      reserved: [],
      async reserve(productId, reservationId) {
        if (this.mode === 'down') throw new TransientError('Productos caído');
        if (this.mode === 'nostock' && productId === 'p2') throw new BusinessError('INSUFFICIENT_STOCK', 'Stock insuficiente');
        this.reserved.push(reservationId);
        return { unitPriceCents: 1000, name: productId };
      },
    };
    events = [];
    released = [];
    payments = new SimulatedPaymentGateway();
    app = createApp({
      dbPath: ':memory:', jwtSecret: SECRET, internalKey: 'k', products,
      payments,
      notify: async (e) => { events.push(e); },
      release: async (r) => { released.push(r.reservationId); },
      maxAttempts: 3, retryBaseMs: 1, outboxBaseMs: 1,
    });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    // Cada prueba parte sin eventos pendientes de la anterior.
    products.mode = 'ok';
    await flush();
    events.length = 0;
    released.length = 0;
  });
  after(async () => {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    app.locals.close();
  });

  test('flujo feliz: confirma, calcula total y publica order.confirmed', async () => {
    const res = await post(body());
    assert.equal(res.status, 201);
    const order = await res.json();
    assert.equal(order.status, 'CONFIRMED');
    assert.equal(order.totalCents, 3000);
    assert.equal(order.paymentToken, undefined);
    await flush();
    assert.equal(events[0].type, 'order.confirmed');
    assert.equal(events[0].recipient, 'ana@tienda.test');
  });

  test('sin stock: rechaza y libera lo ya reservado', async () => {
    products.mode = 'nostock';
    const res = await post(body());
    assert.equal(res.status, 409);
    assert.equal((await res.json()).status, 'REJECTED');
    await flush();
    assert.equal(released.length, 1);
    assert.match(released[0], /:p1$/);
    assert.equal(events[0].type, 'order.rejected');
  });

  test('pago rechazado: compensa todas las reservas', async () => {
    const res = await post(body('tok_declined'));
    assert.equal(res.status, 402);
    await flush();
    assert.equal(released.length, 2);
    assert.equal(events[0].type, 'order.payment_failed');
  });

  test('Productos caído (fallback): queda PENDING y se reconcilia al volver', async () => {
    products.mode = 'down';
    const res = await post(body());
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('retry-after'), '5');
    const { id, status } = await res.json();
    assert.equal(status, 'PENDING');
    products.mode = 'ok';
    app.locals.db.exec('UPDATE orders SET next_attempt_at = 0');
    await app.locals.service.reconcile();
    const after2 = await (await fetch(`${base}/orders/${id}`, { headers: { authorization: `Bearer ${ana}` } })).json();
    assert.equal(after2.status, 'CONFIRMED');
    assert.deepEqual(after2.history.map((h) => h.to), ['PENDING', 'CONFIRMED']);
  });

  test('pasarela intermitente: el reintento completa sin doble cargo', async () => {
    const res = await post(body('tok_flaky'));
    assert.equal(res.status, 202);
    const { id } = await res.json();
    app.locals.db.exec('UPDATE orders SET next_attempt_at = 0');
    await app.locals.service.reconcile();
    assert.equal(app.locals.repo.find(id).status, 'CONFIRMED');
    assert.equal(app.locals.repo.find(id).paymentReference, `PAY-${id}`);
  });

  test('agotados los reintentos: FAILED, libera y notifica', async () => {
    products.mode = 'down';
    const { id } = await (await post(body())).json();
    for (let i = 0; i < 3; i += 1) {
      app.locals.db.exec('UPDATE orders SET next_attempt_at = 0');
      await app.locals.service.reconcile();
    }
    assert.equal(app.locals.repo.find(id).status, 'FAILED');
    await flush();
    assert.equal(released.length, 2);
    assert.equal(events[0].type, 'order.failed');
  });

  test('Idempotency-Key: repetir la petición no crea otro pedido', async () => {
    const headers = { 'idempotency-key': 'k-1' };
    const a = await (await post(body(), ana, headers)).json();
    const b = await (await post(body(), ana, headers)).json();
    assert.equal(a.id, b.id);
  });

  test('datos de entrada inválidos devuelven 400 y sin token 401', async () => {
    assert.equal((await post({ items: [] })).status, 400);
    assert.equal((await fetch(`${base}/orders`, { method: 'POST' })).status, 401);
  });

  test('aislamiento: un cliente no ve pedidos ajenos, el admin sí', async () => {
    const { id } = await (await post(body())).json();
    const get = (t) => fetch(`${base}/orders/${id}`, { headers: { authorization: `Bearer ${t}` } });
    assert.equal((await get(ana)).status, 200);
    assert.equal((await get(luis)).status, 404);
    assert.equal((await get(admin)).status, 200);
    const mine = await (await fetch(`${base}/orders`, { headers: { authorization: `Bearer ${luis}` } })).json();
    assert.equal(mine.length, 0);
  });

  test('gestión de estado: enviar, entregar y rechazar transiciones inválidas', async () => {
    const { id } = await (await post(body())).json();
    const patch = (status, t = admin) => fetch(`${base}/orders/${id}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ status }),
    });
    assert.equal((await patch('SHIPPED', ana)).status, 403);
    assert.equal((await patch('NADA')).status, 400);
    assert.equal((await patch('DELIVERED')).status, 409);
    assert.equal((await patch('SHIPPED')).status, 200);
    assert.equal((await patch('DELIVERED')).status, 200);
    await flush();
    assert.deepEqual(events.filter((e) => e.type === 'order.status_changed').map((e) => e.data.status), ['SHIPPED', 'DELIVERED']);
  });

  test('cancelación: repone stock y reembolsa; no se puede cancelar dos veces', async () => {
    const { id } = await (await post(body())).json();
    await flush();
    released.length = 0;
    const cancel = () => fetch(`${base}/orders/${id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${ana}` } });
    assert.equal((await (await cancel()).json()).status, 'CANCELLED');
    assert.equal((await cancel()).status, 409);
    await flush();
    assert.equal(released.length, 2);
    assert.equal(payments.refunds.get(id).reference, `PAY-${id}`);
  });

  test('la métrica registra pedidos confirmados y latencia por ruta', async () => {
    const m = await (await fetch(`${base}/metrics`)).json();
    assert.ok(m.counters.orders_confirmed_total >= 1);
    assert.ok(m.routes['POST /orders'].requests >= 1);
  });
});

'use strict';

process.env.LOG_LEVEL = 'silent';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { validateProduct } = require('../src/service');
const { percentile, Metrics } = require('../src/lib/metrics');

const SECRET = 'test-secret';
const KEY = 'test-key';
const admin = jwt.sign({ sub: 'a', role: 'admin' }, SECRET, { issuer: 'users-service' });
const customer = jwt.sign({ sub: 'c', role: 'customer' }, SECRET, { issuer: 'users-service' });

describe('validateProduct', () => {
  test('acepta un producto válido y recorta el nombre', () => {
    const p = validateProduct({ name: '  Teclado ', priceCents: 1000, stock: 2 });
    assert.equal(p.name, 'Teclado');
    assert.equal(p.description, '');
  });
  for (const [label, input, code] of [
    ['nombre corto', { name: 'a', priceCents: 1, stock: 1 }, 'INVALID_NAME'],
    ['precio negativo', { name: 'ok', priceCents: -1, stock: 1 }, 'INVALID_PRICE'],
    ['precio decimal', { name: 'ok', priceCents: 1.5, stock: 1 }, 'INVALID_PRICE'],
    ['stock negativo', { name: 'ok', priceCents: 1, stock: -1 }, 'INVALID_STOCK'],
  ]) {
    test(`rechaza ${label}`, () => {
      assert.throws(() => validateProduct(input), (e) => e.code === code && e.status === 400);
    });
  }
});

describe('Metrics', () => {
  test('percentile usa rango más cercano', () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
    assert.equal(percentile([], 95), 0);
  });
  test('la tasa de errores solo cuenta 5xx', () => {
    const m = new Metrics('x');
    m.observe('GET', '/a', 200, 5);
    m.observe('GET', '/a', 404, 5);
    m.observe('GET', '/a', 500, 5);
    m.observe('GET', '/a', 503, 5);
    const s = m.snapshot();
    assert.equal(s.totals.errorRate, 0.5);
    assert.equal(s.totals.clientErrors, 1);
  });
});

describe('API de productos', () => {
  let app; let server; let base;
  const call = (path, { method = 'GET', body, token, key } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'x-internal-key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const seed = async (stock = 5) => (await call('/products', {
    method: 'POST', token: admin, body: { name: 'Mouse', priceCents: 2500, stock },
  })).json();

  before(async () => {
    app = createApp({ dbPath: ':memory:', jwtSecret: SECRET, internalKey: KEY });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    app.locals.close();
  });

  test('CRUD completo: crear, consultar, actualizar y eliminar', async () => {
    const p = await seed();
    assert.equal(p.priceCents, 2500);
    assert.equal((await (await call(`/products/${p.id}`)).json()).name, 'Mouse');
    const upd = await call(`/products/${p.id}`, { method: 'PUT', token: admin, body: { priceCents: 3000 } });
    assert.equal((await upd.json()).priceCents, 3000);
    assert.equal((await call(`/products/${p.id}`, { method: 'DELETE', token: admin })).status, 204);
    assert.equal((await call(`/products/${p.id}`)).status, 404);
  });

  test('la búsqueda filtra por nombre', async () => {
    await call('/products', { method: 'POST', token: admin, body: { name: 'Monitor único', priceCents: 1, stock: 1 } });
    const list = await (await call('/products?search=único')).json();
    assert.equal(list.length, 1);
  });

  test('solo un administrador puede crear', async () => {
    const body = { name: 'Nope', priceCents: 1, stock: 1 };
    assert.equal((await call('/products', { method: 'POST', body })).status, 401);
    assert.equal((await call('/products', { method: 'POST', body, token: customer })).status, 403);
    assert.equal((await call('/products', { method: 'POST', body, token: 'basura' })).status, 401);
  });

  test('JSON mal formado devuelve 400', async () => {
    const res = await fetch(`${base}/products`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` }, body: '{mal',
    });
    assert.equal(res.status, 400);
  });

  test('la reserva descuenta stock y es idempotente', async () => {
    const p = await seed(5);
    const reserve = () => call(`/internal/products/${p.id}/reservations`, {
      method: 'POST', key: KEY, body: { reservationId: 'r1', quantity: 2 },
    });
    assert.equal((await reserve()).status, 201);
    assert.equal((await reserve()).status, 201);
    assert.equal((await (await call(`/products/${p.id}`)).json()).stock, 3);
  });

  test('rechaza stock insuficiente sin modificar el inventario', async () => {
    const p = await seed(1);
    const res = await call(`/internal/products/${p.id}/reservations`, {
      method: 'POST', key: KEY, body: { reservationId: 'r2', quantity: 9 },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'INSUFFICIENT_STOCK');
    assert.equal((await (await call(`/products/${p.id}`)).json()).stock, 1);
  });

  test('la liberación repone stock una sola vez', async () => {
    const p = await seed(4);
    await call(`/internal/products/${p.id}/reservations`, { method: 'POST', key: KEY, body: { reservationId: 'r3', quantity: 4 } });
    const release = () => call(`/internal/products/${p.id}/reservations/r3`, { method: 'DELETE', key: KEY });
    assert.equal((await release()).status, 204);
    assert.equal((await release()).status, 204);
    assert.equal((await (await call(`/products/${p.id}`)).json()).stock, 4);
  });

  test('una reserva tardía tras su liberación es rechazada', async () => {
    const p = await seed(4);
    await call(`/internal/products/${p.id}/reservations/tardia`, { method: 'DELETE', key: KEY });
    const res = await call(`/internal/products/${p.id}/reservations`, { method: 'POST', key: KEY, body: { reservationId: 'tardia', quantity: 1 } });
    assert.equal(res.status, 409);
    assert.equal((await (await call(`/products/${p.id}`)).json()).stock, 4);
  });

  test('los endpoints internos exigen clave', async () => {
    const res = await call('/internal/products/x/reservations', { method: 'POST', body: { reservationId: 'z', quantity: 1 } });
    assert.equal(res.status, 401);
  });

  test('expone salud y métricas', async () => {
    assert.equal((await (await call('/health')).json()).status, 'UP');
    const m = await (await call('/metrics')).json();
    assert.ok(m.totals.requests > 0);
    assert.match(await (await call('/metrics?format=prometheus')).text(), /http_requests_total/);
  });
});

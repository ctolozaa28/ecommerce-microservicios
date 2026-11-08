'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { retry, CircuitBreaker, CircuitOpenError } = require('../src/lib/resilience');
const { ProductsClient, SimulatedPaymentGateway, BusinessError, TransientError } = require('../src/clients');

const noSleep = async () => {};

describe('retry', () => {
  test('reintenta hasta tener éxito', async () => {
    let calls = 0;
    const result = await retry(async () => { calls += 1; if (calls < 3) throw new Error('x'); return 'ok'; }, { sleep: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });
  test('no reintenta errores no transitorios', async () => {
    let calls = 0;
    await assert.rejects(retry(async () => { calls += 1; throw new Error('negocio'); }, { sleep: noSleep, isRetryable: () => false }));
    assert.equal(calls, 1);
  });
  test('agota los intentos y propaga el último error', async () => {
    let calls = 0;
    await assert.rejects(retry(async () => { calls += 1; throw new Error(`e${calls}`); }, { attempts: 2, sleep: noSleep }), /e2/);
  });
  test('el backoff crece exponencialmente', async () => {
    const waits = [];
    await assert.rejects(retry(async () => { throw new Error('x'); }, {
      attempts: 4, baseMs: 100, random: () => 1, sleep: async (ms) => { waits.push(ms); },
    }));
    assert.deepEqual(waits, [100, 200, 400]);
  });
});

describe('CircuitBreaker', () => {
  const failing = async () => { throw new Error('caído'); };
  const breaker = (now) => new CircuitBreaker('t', { failureThreshold: 2, resetTimeoutMs: 1000, now });

  test('se abre tras el umbral y falla sin invocar', async () => {
    const b = breaker(() => 0);
    await assert.rejects(b.exec(failing));
    assert.equal(b.state, 'CLOSED');
    await assert.rejects(b.exec(failing));
    assert.equal(b.state, 'OPEN');
    let invoked = false;
    await assert.rejects(b.exec(async () => { invoked = true; }), CircuitOpenError);
    assert.equal(invoked, false);
  });
  test('pasa a HALF_OPEN tras la espera y se cierra si la prueba funciona', async () => {
    let t = 0;
    const b = breaker(() => t);
    await assert.rejects(b.exec(failing));
    await assert.rejects(b.exec(failing));
    t = 1000;
    assert.equal(await b.exec(async () => 'ok'), 'ok');
    assert.equal(b.state, 'CLOSED');
  });
  test('vuelve a OPEN si la prueba falla', async () => {
    let t = 0;
    const b = breaker(() => t);
    await assert.rejects(b.exec(failing));
    await assert.rejects(b.exec(failing));
    t = 1000;
    await assert.rejects(b.exec(failing));
    assert.equal(b.state, 'OPEN');
  });
  test('en HALF_OPEN solo admite una llamada de prueba', async () => {
    let t = 0;
    const b = breaker(() => t);
    await assert.rejects(b.exec(failing));
    await assert.rejects(b.exec(failing));
    t = 1000;
    let release;
    const probe = b.exec(() => new Promise((r) => { release = r; }));
    await assert.rejects(b.exec(async () => 'segunda'), CircuitOpenError);
    release('ok');
    assert.equal(await probe, 'ok');
  });
  test('los errores de negocio no abren el circuito', async () => {
    const b = new CircuitBreaker('t', { failureThreshold: 1, shouldTrip: (e) => e.transient === true });
    await assert.rejects(b.exec(async () => { throw new Error('409'); }));
    assert.equal(b.state, 'CLOSED');
  });
});

describe('ProductsClient', () => {
  const response = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const client = (fetchFn, opts = {}) => new ProductsClient({ baseUrl: 'http://x', internalKey: 'k', baseMs: 1, fetchFn, ...opts });

  test('reintenta un 503 y luego tiene éxito', async () => {
    let calls = 0;
    const c = client(async () => { calls += 1; return calls < 3 ? response(503, {}) : response(201, { unitPriceCents: 5 }); });
    assert.equal((await c.reserve('p', 'r', 1)).unitPriceCents, 5);
    assert.equal(calls, 3);
  });
  test('un 409 es error de negocio y no se reintenta', async () => {
    let calls = 0;
    const c = client(async () => { calls += 1; return response(409, { error: { code: 'INSUFFICIENT_STOCK', message: 'sin stock' } }); });
    await assert.rejects(c.reserve('p', 'r', 1), (e) => e instanceof BusinessError && e.code === 'INSUFFICIENT_STOCK');
    assert.equal(calls, 1);
  });
  test('un error de red se traduce en TransientError', async () => {
    const c = client(async () => { throw new Error('ECONNREFUSED'); }, { attempts: 1 });
    await assert.rejects(c.reserve('p', 'r', 1), (e) => e instanceof TransientError);
  });
  test('tras fallos repetidos el circuito se abre y deja de llamar', async () => {
    let calls = 0;
    const c = client(async () => { calls += 1; throw new Error('caído'); }, { attempts: 1 });
    for (let i = 0; i < 5; i += 1) await assert.rejects(c.reserve('p', 'r', 1));
    assert.equal(c.breaker.state, 'OPEN');
    await assert.rejects(c.reserve('p', 'r', 1), CircuitOpenError);
    assert.equal(calls, 5);
  });
});

describe('SimulatedPaymentGateway', () => {
  test('aprueba y es idempotente por pedido', async () => {
    const g = new SimulatedPaymentGateway();
    const a = await g.charge({ orderId: 'o', amountCents: 10, token: 'tok_ok' });
    const b = await g.charge({ orderId: 'o', amountCents: 10, token: 'tok_ok' });
    assert.equal(a.approved, true);
    assert.equal(a, b);
  });
  test('rechaza tok_declined', async () => {
    assert.equal((await new SimulatedPaymentGateway().charge({ orderId: 'o', amountCents: 10, token: 'tok_declined' })).approved, false);
  });
  test('tok_flaky falla una vez y luego funciona', async () => {
    const g = new SimulatedPaymentGateway();
    await assert.rejects(g.charge({ orderId: 'o', amountCents: 10, token: 'tok_flaky' }), TransientError);
    assert.equal((await g.charge({ orderId: 'o', amountCents: 10, token: 'tok_flaky' })).approved, true);
  });
});

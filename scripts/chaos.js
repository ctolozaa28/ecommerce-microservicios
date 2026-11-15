'use strict';

/** Pruebas de resiliencia: se detienen servicios reales y se comprueba la recuperación. */
const {
  Cluster, url, json, request, login, registerCustomer, createProduct, waitFor, sleep, Report,
} = require('./harness');

async function main() {
  const cluster = new Cluster();
  const report = new Report('Pruebas de resiliencia con inyección de fallos');
  try {
    await cluster.startAll();
    const admin = await login('admin@tienda.test', 'admin12345');
    const ana = await registerCustomer(`ana.${Date.now()}@tienda.test`);
    const product = await createProduct(admin, 'Monitor', 10000, 100);
    const order = (paymentToken = 'tok_ok') => request(url('orders'), '/orders', {
      method: 'POST', token: ana, body: { items: [{ productId: product.id, quantity: 1 }], paymentToken },
    });
    const status = async (id) => (await json(await request(url('orders'), `/orders/${id}`, { token: ana }))).status;
    const metrics = async () => json(await request(url('orders'), '/metrics'));

    // Escenario 1
    console.log('\n-- Escenario 1: Notificaciones caído --');
    await cluster.kill('notifications');
    const t1 = Date.now();
    const res1 = await order();
    const o1 = await json(res1);
    report.check('E1. El pedido se confirma sin Notificaciones', res1.status === 201, `HTTP ${res1.status} en ${Date.now() - t1} ms`);
    await sleep(800);
    const pending = (await metrics()).gauges.outbox_pending;
    report.check('E1. El evento queda retenido en el outbox', pending >= 1, `outbox_pending=${pending}`);
    await cluster.start('notifications');
    const list = await waitFor(async () => {
      const items = await json(await request(url('notifications'), '/notifications/me', { token: ana }));
      return items.some((n) => n.type === 'order.confirmed' && n.subject.includes(o1.id)) ? items : null;
    }, { timeoutMs: 40000 });
    report.check('E1. Al volver el servicio la notificación se entrega', Boolean(list));

    // Escenario 2
    console.log('\n-- Escenario 2: Productos caído --');
    await cluster.kill('products');
    const t2 = Date.now();
    const res2 = await order();
    const o2 = await json(res2);
    report.check('E2. Fallback: pedido aceptado en PENDING', res2.status === 202 && o2.status === 'PENDING', `HTTP ${res2.status} tras reintentos, ${Date.now() - t2} ms`);
    report.check('E2. Se ejecutaron reintentos', (await metrics()).counters.products_retries_total >= 2, `reintentos=${(await metrics()).counters.products_retries_total}`);

    // Escenario 3 (con Productos aún caído)
    console.log('\n-- Escenario 3: circuit breaker --');
    const deferred = [];
    for (let i = 0; i < 5; i += 1) deferred.push((await json(await order())).id);
    const open = (await metrics()).gauges.products_circuit_open;
    report.check('E3. El circuito se abre tras fallos repetidos', open === 1, `products_circuit_open=${open}`);
    const t3 = Date.now();
    const res3 = await order();
    const fastMs = Date.now() - t3;
    deferred.push((await json(res3)).id);
    report.check('E3. Con el circuito abierto se falla rápido', res3.status === 202 && fastMs < 100, `${fastMs} ms`);

    // Recuperación
    await cluster.start('products');
    const all = [o2.id, ...deferred];
    await waitFor(async () => {
      const states = await Promise.all(all.map(status));
      return states.every((s) => s === 'CONFIRMED');
    }, { timeoutMs: 60000, stepMs: 300 });
    report.check('E2/E3. Al volver Productos, todos los pedidos se confirman', true, `${all.length} pedidos`);
    const stock = (await json(await request(url('products'), `/products/${product.id}`))).stock;
    report.check('E2/E3. Sin doble descuento de stock', stock === 100 - 1 - all.length, `stock=${stock}`);

    // Escenario 4
    console.log('\n-- Escenario 4: pasarela de pago intermitente --');
    const res4 = await order('tok_flaky');
    const o4 = await json(res4);
    report.check('E4. Pasarela no disponible difiere el pedido', res4.status === 202, `HTTP ${res4.status}`);
    await waitFor(async () => (await status(o4.id)) === 'CONFIRMED', { timeoutMs: 30000 });
    report.check('E4. El reintento confirma el pedido', true);

    // Escenario 5
    console.log('\n-- Escenario 5: Productos caído durante la compensación --');
    const before = (await json(await request(url('products'), `/products/${product.id}`))).stock;
    const res5a = await order('tok_ok');
    const o5 = await json(res5a);
    await cluster.kill('products');
    await request(url('orders'), `/orders/${o5.id}/cancel`, { method: 'POST', token: ana });
    await sleep(500);
    await cluster.start('products');
    const restored = await waitFor(async () => {
      const s = (await json(await request(url('products'), `/products/${product.id}`))).stock;
      return s === before ? s : null;
    }, { timeoutMs: 40000 });
    report.check('E5. La compensación se aplica al volver Productos', restored === before, `stock=${restored}`);

    const m = await metrics();
    console.log('\nContadores finales de Pedidos:', JSON.stringify(m.counters));
  } finally {
    await cluster.stopAll();
  }
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

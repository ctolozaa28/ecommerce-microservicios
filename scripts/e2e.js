'use strict';

/** Prueba de integración: los cuatro microservicios como procesos independientes. */
const {
  Cluster, url, json, request, login, registerCustomer, createProduct, waitFor, Report,
} = require('./harness');

async function main() {
  const cluster = new Cluster();
  const report = new Report('Prueba de integración extremo a extremo');
  try {
    await cluster.startAll();
    report.check('Los 4 servicios arrancan como procesos independientes', cluster.procs.size === 4);

    const admin = await login('admin@tienda.test', 'admin12345');
    const email = `ana.${Date.now()}@tienda.test`;
    const ana = await registerCustomer(email);
    report.check('Registro y autenticación emiten un JWT', Boolean(ana));

    const product = await createProduct(admin, 'Teclado mecánico', 4500, 10);
    report.check('Administrador crea un producto', Boolean(product.id));

    const notAllowed = await request(url('products'), '/products', { method: 'POST', token: ana, body: { name: 'x y', priceCents: 1, stock: 1 } });
    report.check('Un cliente no puede crear productos', notAllowed.status === 403, `HTTP ${notAllowed.status}`);

    const order = (paymentToken, quantity = 2) => request(url('orders'), '/orders', {
      method: 'POST', token: ana, body: { items: [{ productId: product.id, quantity }], paymentToken },
    });
    const stock = async () => (await json(await request(url('products'), `/products/${product.id}`))).stock;

    const confirmedRes = await order('tok_ok');
    const confirmed = await json(confirmedRes);
    report.check('Pedido confirmado', confirmedRes.status === 201 && confirmed.status === 'CONFIRMED', `total=${confirmed.totalCents}`);
    report.check('El total se calcula con el precio del catálogo', confirmed.totalCents === 9000);
    report.check('El stock se descuenta', (await stock()) === 8);

    const inbox = await waitFor(async () => {
      const list = await json(await request(url('notifications'), '/notifications/me', { token: ana }));
      return list.some((n) => n.type === 'order.confirmed' && n.status === 'SENT') ? list : null;
    });
    report.check('Se notifica la confirmación de forma asíncrona', inbox.some((n) => n.type === 'order.confirmed'));
    report.check('Se notifica el registro del usuario', inbox.some((n) => n.type === 'user.registered'));

    const noStockRes = await order('tok_ok', 999);
    report.check('Stock insuficiente rechaza el pedido', noStockRes.status === 409, `HTTP ${noStockRes.status}`);
    report.check('El stock no cambia tras el rechazo', (await stock()) === 8);

    const declinedRes = await order('tok_declined');
    report.check('Pago rechazado devuelve 402', declinedRes.status === 402);
    report.check('La compensación repone el stock', Boolean(await waitFor(async () => (await stock()) === 8)));

    const patch = (status) => request(url('orders'), `/orders/${confirmed.id}/status`, { method: 'PATCH', token: admin, body: { status } });
    report.check('Pedido pasa a SHIPPED', (await patch('SHIPPED')).status === 200);
    report.check('Pedido pasa a DELIVERED', (await patch('DELIVERED')).status === 200);
    report.check('Transición inválida rechazada', (await patch('SHIPPED')).status === 409);

    const toCancel = await json(await order('tok_ok', 3));
    const cancelled = await request(url('orders'), `/orders/${toCancel.id}/cancel`, { method: 'POST', token: ana });
    report.check('Pedido cancelado por su dueño', cancelled.status === 200);
    report.check('La cancelación repone el stock', Boolean(await waitFor(async () => (await stock()) === 8)));

    const metrics = await json(await request(url('orders'), '/metrics'));
    report.check('Pedidos expone latencia y tasa de errores', metrics.totals.requests > 0 && metrics.totals.errorRate === 0,
      `peticiones=${metrics.totals.requests}, p95=${metrics.totals.latencyMs.p95} ms, errorRate=${metrics.totals.errorRate}`);
  } finally {
    await cluster.stopAll();
  }
  report.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

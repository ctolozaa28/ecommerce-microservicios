'use strict';

const express = require('express');
const { Metrics } = require('./lib/metrics');
const { observability, createLogger, operationalRoutes, requireAuth, requireRole, notFound, errorHandler } = require('./lib/http');
const { OutboxDispatcher, enqueue } = require('./lib/outbox');
const { openDatabase, OrderRepository } = require('./repository');
const { OrderService } = require('./service');
const { ProductsClient, SimulatedPaymentGateway, BusinessError } = require('./clients');

/** El token de pago no debe salir nunca del servicio. */
const present = ({ paymentToken, ...order }) => order;
const HTTP_BY_STATUS = { CONFIRMED: 201, PENDING: 202, REJECTED: 409, PAYMENT_FAILED: 402, FAILED: 503 };

function notificationSender(url, internalKey) {
  return async (payload) => {
    const res = await fetch(`${url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': internalKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`Notificaciones respondió ${res.status}`);
  };
}

/** Capa de presentación: API REST de pedidos. */
function createApp(config) {
  const db = openDatabase(config.dbPath);
  const repo = new OrderRepository(db);
  const metrics = new Metrics('orders-service');
  const log = createLogger('orders-service');
  const products = config.products || new ProductsClient({
    baseUrl: config.productsUrl, internalKey: config.internalKey, metrics,
  });
  const payments = config.payments || new SimulatedPaymentGateway({ unavailableRate: config.paymentUnavailableRate || 0 });
  const service = new OrderService({
    repo,
    products,
    payments,
    metrics,
    log,
    enqueue: (target, payload) => enqueue(db, target, payload),
    maxAttempts: config.maxAttempts,
    retryBaseMs: config.retryBaseMs,
  });
  const releaseStock = async ({ productId, reservationId }) => {
    try {
      await products.release(productId, reservationId);
    } catch (err) {
      // Si el producto ya no admite la operación, reintentar no ayudará.
      if (!(err instanceof BusinessError)) throw err;
      log('warn', 'release_rechazado', { productId, reservationId, error: err.message });
    }
  };
  const dispatcher = new OutboxDispatcher(db, {
    notifications: config.notify || notificationSender(config.notificationsUrl, config.internalKey),
    'stock-release': config.release || releaseStock,
    'payment-refund': (refund) => payments.refund(refund),
  }, { metrics, log, baseMs: config.outboxBaseMs });
  const app = express();
  const auth = requireAuth(config.jwtSecret);

  app.use(express.json({ limit: '100kb' }));
  app.use(observability(metrics, log));
  operationalRoutes(app, metrics);

  app.post('/orders', auth, async (req, res) => {
    const order = await service.create(req.user, req.body, req.get('idempotency-key'));
    res.status(HTTP_BY_STATUS[order.status] || 200);
    if (order.status === 'PENDING') res.set('retry-after', '5');
    res.set('location', `/orders/${order.id}`);
    res.json(present(order));
  });
  app.get('/orders', auth, (req, res) => res.json(service.list(req.user).map(present)));
  app.get('/orders/:id', auth, (req, res) => res.json(present(service.get(req.params.id, req.user))));
  app.post('/orders/:id/cancel', auth, (req, res) => res.json(present(service.cancel(req.params.id, req.user))));
  app.patch('/orders/:id/status', auth, requireRole('admin'), (req, res) => {
    res.json(present(service.changeStatus(req.params.id, req.user, (req.body || {}).status)));
  });

  app.use(notFound);
  app.use(errorHandler(log));

  let reconciler;
  app.locals = {
    ...app.locals,
    db,
    repo,
    service,
    metrics,
    log,
    dispatcher,
    products,
    start: (intervalMs = 1000) => {
      dispatcher.start(intervalMs);
      reconciler = setInterval(() => {
        service.reconcile().catch((err) => log('error', 'reconcile_failed', { error: err.message }));
      }, intervalMs);
      reconciler.unref();
    },
    close: () => {
      clearInterval(reconciler);
      dispatcher.stop();
      db.close();
    },
  };
  return app;
}

module.exports = { createApp };

'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./lib/http');
const { backoffMs } = require('./lib/outbox');
const { BusinessError } = require('./clients');

const STATUS = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  FAILED: 'FAILED',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
});

/** Máquina de estados del pedido. */
const TRANSITIONS = {
  PENDING: ['CONFIRMED', 'REJECTED', 'PAYMENT_FAILED', 'FAILED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
};

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

function validateOrder({ items, paymentToken } = {}) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    throw new AppError(400, 'INVALID_ITEMS', 'items debe contener entre 1 y 50 líneas');
  }
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.productId !== 'string' || !item.productId) {
      throw new AppError(400, 'INVALID_ITEM', 'Cada línea requiere productId');
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new AppError(400, 'INVALID_QUANTITY', 'quantity debe ser un entero positivo');
    }
    if (seen.has(item.productId)) throw new AppError(400, 'DUPLICATE_ITEM', 'Un producto no puede repetirse en el pedido');
    seen.add(item.productId);
  }
  if (typeof paymentToken !== 'string' || !paymentToken) {
    throw new AppError(400, 'INVALID_PAYMENT', 'paymentToken es obligatorio');
  }
  return { items: items.map(({ productId, quantity }) => ({ productId, quantity })), paymentToken };
}

/**
 * Orquestador de la saga de creación de pedido:
 * reservar stock -> cobrar -> confirmar. Si un paso falla por negocio se compensa;
 * si falla por indisponibilidad el pedido queda PENDING y se reintenta (fallback).
 */
class OrderService {
  constructor({ repo, products, payments, enqueue, metrics, log = () => {}, now = Date.now, maxAttempts = 8, retryBaseMs = 1000 }) {
    Object.assign(this, { repo, products, payments, enqueue, metrics, log, now, maxAttempts, retryBaseMs });
    this.inFlight = new Set();
  }

  async create(user, input, idempotencyKey) {
    const { items, paymentToken } = validateOrder(input);
    if (idempotencyKey) {
      const previous = this.repo.findByIdempotencyKey(user.sub, idempotencyKey);
      if (previous) return previous;
    }
    const id = crypto.randomUUID();
    this.repo.insertOrder({
      id,
      userId: user.sub,
      email: user.email,
      name: user.name,
      items,
      paymentToken,
      idempotencyKey: idempotencyKey || null,
      at: new Date(this.now()).toISOString(),
      nextAttemptAt: this.now(),
    });
    await this.process(id);
    return this.repo.find(id);
  }

  /** Ejecuta la saga. Es seguro repetirla: reserva y cobro son idempotentes. */
  async process(orderId) {
    if (this.inFlight.has(orderId)) return;
    this.inFlight.add(orderId);
    try {
      const order = this.repo.find(orderId);
      if (!order || order.status !== STATUS.PENDING) return;
      await this.#runSaga(order);
    } finally {
      this.inFlight.delete(orderId);
    }
  }

  async #runSaga(order) {
    const reservationId = (item) => `${order.id}:${item.productId}`;
    const reserved = [];
    try {
      for (const item of order.items) {
        const r = await this.products.reserve(item.productId, reservationId(item), item.quantity);
        reserved.push(item);
        item.unitPriceCents = r.unitPriceCents;
        item.name = r.name;
      }
      const totalCents = order.items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
      const payment = await this.payments.charge({ orderId: order.id, amountCents: totalCents, token: order.paymentToken });
      if (!payment.approved) {
        this.#finish(order, STATUS.PAYMENT_FAILED, 'order.payment_failed', payment.reason, order.items);
        return;
      }
      this.repo.transaction(() => {
        this.repo.setPricing(order.id, order.items, totalCents, payment.reference);
        this.repo.changeStatus(order.id, STATUS.PENDING, STATUS.CONFIRMED, new Date(this.now()).toISOString());
        this.enqueue('notifications', {
          type: 'order.confirmed', recipient: order.customerEmail, data: { orderId: order.id, totalCents },
        });
      });
      if (this.metrics) this.metrics.inc('orders_confirmed_total');
    } catch (err) {
      if (err instanceof BusinessError) {
        this.#finish(order, STATUS.REJECTED, 'order.rejected', err.message, reserved);
        return;
      }
      if (!err.transient) throw err;
      this.#scheduleRetry(order, err);
    }
  }

  #scheduleRetry(order, err) {
    const attempts = order.attempts + 1;
    if (this.metrics) this.metrics.inc('orders_deferred_total');
    this.log('warn', 'saga_deferred', { orderId: order.id, attempts, error: err.message });
    if (attempts >= this.maxAttempts) {
      // Se libera todo lo que pudo reservarse en cualquier intento anterior.
      this.#finish(order, STATUS.FAILED, 'order.failed', 'servicio dependiente no disponible', order.items);
      return;
    }
    this.repo.scheduleRetry(order.id, attempts, this.now() + backoffMs(attempts, this.retryBaseMs, 30000), err.message);
  }

  /** Estado final + compensaciones + notificación en una sola transacción local. */
  #finish(order, status, eventType, reason, toRelease) {
    this.repo.transaction(() => {
      this.repo.changeStatus(order.id, STATUS.PENDING, status, new Date(this.now()).toISOString(), reason);
      for (const item of toRelease) {
        this.enqueue('stock-release', { productId: item.productId, reservationId: `${order.id}:${item.productId}` });
      }
      this.enqueue('notifications', {
        type: eventType, recipient: order.customerEmail, data: { orderId: order.id, reason },
      });
    });
    if (this.metrics) this.metrics.inc(`orders_${status.toLowerCase()}_total`);
  }

  /** Reconciliador: reanuda pedidos diferidos cuando vence su espera. */
  async reconcile() {
    const due = this.repo.duePending(this.now(), 50);
    for (const id of due) await this.process(id);
    if (this.metrics) this.metrics.gauge('orders_pending', this.repo.countPending());
    return due.length;
  }

  get(id, user) {
    const order = this.repo.find(id);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Pedido no encontrado');
    if (user.role !== 'admin' && order.userId !== user.sub) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Pedido no encontrado');
    }
    return order;
  }

  list(user) {
    return user.role === 'admin' ? this.repo.listAll() : this.repo.listByUser(user.sub);
  }

  /** Cambio administrativo de estado respetando la máquina de estados. */
  changeStatus(id, user, target) {
    const order = this.get(id, user);
    if (!Object.values(STATUS).includes(target)) throw new AppError(400, 'INVALID_STATUS', 'Estado desconocido');
    if (!canTransition(order.status, target) || order.status === STATUS.PENDING) {
      throw new AppError(409, 'INVALID_TRANSITION', `No se puede pasar de ${order.status} a ${target}`);
    }
    if (target === STATUS.CANCELLED) return this.cancel(id, user);
    this.repo.transaction(() => {
      this.repo.changeStatus(id, order.status, target, new Date(this.now()).toISOString());
      this.enqueue('notifications', {
        type: 'order.status_changed', recipient: order.customerEmail, data: { orderId: id, status: target },
      });
    });
    return this.repo.find(id);
  }

  cancel(id, user) {
    const order = this.get(id, user);
    if (!canTransition(order.status, STATUS.CANCELLED)) {
      throw new AppError(409, 'INVALID_TRANSITION', `No se puede cancelar un pedido en estado ${order.status}`);
    }
    this.repo.transaction(() => {
      this.repo.changeStatus(id, order.status, STATUS.CANCELLED, new Date(this.now()).toISOString());
      for (const item of order.items) {
        this.enqueue('stock-release', { productId: item.productId, reservationId: `${id}:${item.productId}` });
      }
      if (order.paymentReference) {
        this.enqueue('payment-refund', { orderId: id, reference: order.paymentReference, amountCents: order.totalCents });
      }
      this.enqueue('notifications', { type: 'order.cancelled', recipient: order.customerEmail, data: { orderId: id } });
    });
    return this.repo.find(id);
  }
}

module.exports = { OrderService, STATUS, canTransition, validateOrder };

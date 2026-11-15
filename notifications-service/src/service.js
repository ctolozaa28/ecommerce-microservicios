'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./lib/http');

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

/** Plantillas: agregar un tipo de evento no afecta a los productores. */
const TEMPLATES = {
  'user.registered': (d) => ({ subject: 'Bienvenido a la tienda', body: `Hola ${d.name}, tu cuenta fue creada correctamente.` }),
  'order.confirmed': (d) => ({ subject: `Pedido ${d.orderId} confirmado`, body: `Recibimos tu pago de ${money(d.totalCents)}. Tu pedido está confirmado.` }),
  'order.rejected': (d) => ({ subject: `Pedido ${d.orderId} rechazado`, body: `No fue posible procesar tu pedido: ${d.reason}.` }),
  'order.payment_failed': (d) => ({ subject: `Pago no aprobado del pedido ${d.orderId}`, body: `El pago fue rechazado: ${d.reason}. No se realizó ningún cargo.` }),
  'order.failed': (d) => ({ subject: `Pedido ${d.orderId} no procesado`, body: `Una falla temporal impidió completar tu pedido: ${d.reason}. No se realizó ningún cargo.` }),
  'order.cancelled': (d) => ({ subject: `Pedido ${d.orderId} cancelado`, body: 'Tu pedido fue cancelado y el inventario fue repuesto.' }),
  'order.status_changed': (d) => ({ subject: `Pedido ${d.orderId}: ${d.status}`, body: `El nuevo estado de tu pedido es ${d.status}.` }),
};

function render(type, data) {
  const template = TEMPLATES[type];
  if (!template) throw new AppError(422, 'UNKNOWN_EVENT', `Tipo de evento no soportado: ${type}`);
  return template(data || {});
}

/** Transporte simulado: registra el envío; failureRate permite ensayar fallos. */
class SimulatedEmailSender {
  constructor({ failureRate = 0, random = Math.random, log = () => {} } = {}) {
    Object.assign(this, { failureRate, random, log });
  }

  async send(message) {
    if (this.random() < this.failureRate) throw new Error('Servidor de correo simulado no disponible');
    this.log('info', 'email_simulado_enviado', { to: message.recipient, subject: message.subject });
  }
}

/** Lógica de negocio: bandeja de entrada idempotente y envío asíncrono. */
class NotificationService {
  constructor(repo, sender, { maxAttempts = 5, baseMs = 200, now = Date.now, metrics, log = () => {} } = {}) {
    Object.assign(this, { repo, sender, maxAttempts, baseMs, now, metrics, log });
    this.running = false;
  }

  accept(event = {}) {
    const { eventId, type, recipient, data } = event;
    if (typeof eventId !== 'string' || !eventId) throw new AppError(400, 'INVALID_EVENT', 'eventId es obligatorio');
    if (typeof recipient !== 'string' || !recipient.includes('@')) throw new AppError(400, 'INVALID_RECIPIENT', 'recipient inválido');
    const { subject, body } = render(type, data);
    const stored = this.repo.insertIfNew({
      id: crypto.randomUUID(), eventId, type, recipient, subject, body, at: this.now(),
    });
    if (this.metrics) this.metrics.inc(stored ? 'events_accepted_total' : 'events_duplicated_total');
    return { accepted: true, duplicate: !stored };
  }

  async tick() {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      for (const n of this.repo.due(this.now(), 50)) {
        try {
          await this.sender.send(n);
          this.repo.markSent(n.id, this.now());
          sent += 1;
          if (this.metrics) this.metrics.inc('notifications_sent_total');
        } catch (err) {
          const attempts = n.attempts + 1;
          this.repo.markFailure(n.id, attempts, attempts >= this.maxAttempts, this.now() + this.baseMs * 2 ** (attempts - 1), err.message);
          if (this.metrics) this.metrics.inc('notifications_send_failures_total');
          this.log('warn', 'envio_fallido', { id: n.id, attempts, error: err.message });
        }
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  list(recipient) {
    return this.repo.list(recipient);
  }

  start(intervalMs = 500) {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log('error', 'tick_failed', { error: err.message }));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { NotificationService, SimulatedEmailSender, render };

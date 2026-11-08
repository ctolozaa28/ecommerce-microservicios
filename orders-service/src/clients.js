'use strict';

const { retry, CircuitBreaker } = require('./lib/resilience');

class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class TransientError extends Error {
  constructor(message) {
    super(message);
    this.transient = true;
  }
}

/** Cliente REST de Productos con timeout, reintentos y circuit breaker. */
class ProductsClient {
  constructor({ baseUrl, internalKey, timeoutMs = 1500, attempts = 3, baseMs = 100, breaker, metrics, fetchFn = fetch }) {
    Object.assign(this, { baseUrl, internalKey, timeoutMs, attempts, baseMs, metrics, fetchFn });
    this.breaker = breaker || new CircuitBreaker('products', {
      shouldTrip: (err) => Boolean(err.transient),
      onStateChange: (state) => {
        if (metrics) {
          metrics.gauge('products_circuit_open', state === 'OPEN' ? 1 : 0);
          metrics.inc(`products_circuit_transitions_total_${state.toLowerCase()}`);
        }
      },
    });
  }

  async #request(method, path, body) {
    let res;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-internal-key': this.internalKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new TransientError(`Productos inaccesible: ${err.message}`);
    }
    if (res.status >= 500) throw new TransientError(`Productos respondió ${res.status}`);
    const payload = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const error = (payload && payload.error) || {};
      throw new BusinessError(error.code || 'PRODUCTS_ERROR', error.message || `Productos respondió ${res.status}`);
    }
    return payload;
  }

  #resilient(call) {
    return this.breaker.exec(() => retry(call, {
      attempts: this.attempts,
      baseMs: this.baseMs,
      isRetryable: (err) => Boolean(err.transient),
      onRetry: () => { if (this.metrics) this.metrics.inc('products_retries_total'); },
    }));
  }

  reserve(productId, reservationId, quantity) {
    return this.#resilient(() => this.#request('POST', `/internal/products/${encodeURIComponent(productId)}/reservations`, { reservationId, quantity }));
  }

  release(productId, reservationId) {
    return this.#request('DELETE', `/internal/products/${encodeURIComponent(productId)}/reservations/${encodeURIComponent(reservationId)}`);
  }
}

/** Fachada del sistema de pago simulado; se sustituye por un adaptador real sin tocar la saga. */
class SimulatedPaymentGateway {
  constructor({ unavailableRate = 0, random = Math.random } = {}) {
    Object.assign(this, { unavailableRate, random });
    this.processed = new Map();
    this.flakySeen = new Set();
  }

  /** Idempotente por orderId: un reintento nunca genera un doble cargo. */
  async charge({ orderId, amountCents, token }) {
    if (this.processed.has(orderId)) return this.processed.get(orderId);
    if (token === 'tok_flaky' && !this.flakySeen.has(orderId)) {
      this.flakySeen.add(orderId);
      throw new TransientError('Pasarela simulada no disponible');
    }
    if (this.random() < this.unavailableRate) throw new TransientError('Pasarela simulada no disponible');
    const declined = token === 'tok_declined' || !(amountCents > 0);
    const result = declined
      ? { approved: false, reason: token === 'tok_declined' ? 'tarjeta rechazada' : 'importe inválido' }
      : { approved: true, reference: `PAY-${orderId}` };
    this.processed.set(orderId, result);
    return result;
  }

  /** Idempotente por orderId: un evento repetido no devuelve dos veces. */
  async refund({ orderId, reference }) {
    this.refunds = this.refunds || new Map();
    if (!this.refunds.has(orderId)) this.refunds.set(orderId, { refunded: true, reference });
    return this.refunds.get(orderId);
  }
}

module.exports = { ProductsClient, SimulatedPaymentGateway, BusinessError, TransientError };

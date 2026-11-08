'use strict';

const sleepMs = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Reintenta fn con backoff exponencial y jitter si el error es transitorio. */
async function retry(fn, {
  attempts = 3, baseMs = 100, maxMs = 2000, isRetryable = () => true, sleep = sleepMs, random = Math.random, onRetry = () => {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      onRetry(err, attempt);
      const ceiling = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      await sleep(ceiling / 2 + random() * (ceiling / 2));
    }
  }
  throw lastError;
}

class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuito abierto: ${name}`);
    this.code = 'CIRCUIT_OPEN';
    this.transient = true;
  }
}

/**
 * Circuit Breaker con tres estados:
 * CLOSED (pasan las llamadas), OPEN (fallan de inmediato) y HALF_OPEN (una prueba).
 */
class CircuitBreaker {
  constructor(name, { failureThreshold = 5, resetTimeoutMs = 5000, now = Date.now, shouldTrip = () => true, onStateChange = () => {} } = {}) {
    Object.assign(this, { name, failureThreshold, resetTimeoutMs, now, shouldTrip, onStateChange });
    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  #transition(state) {
    if (this.state !== state) {
      this.state = state;
      this.onStateChange(state);
    }
  }

  async exec(fn) {
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt < this.resetTimeoutMs) throw new CircuitOpenError(this.name);
      this.#transition('HALF_OPEN');
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probing) throw new CircuitOpenError(this.name);
      this.probing = true;
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.probing = false;
      this.#transition('CLOSED');
      return result;
    } catch (err) {
      this.probing = false;
      if (!this.shouldTrip(err)) {
        // Un error de negocio prueba que el servicio responde.
        this.failures = 0;
        this.#transition('CLOSED');
        throw err;
      }
      this.failures += 1;
      if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
        this.openedAt = this.now();
        this.#transition('OPEN');
      }
      throw err;
    }
  }
}

module.exports = { retry, CircuitBreaker, CircuitOpenError };

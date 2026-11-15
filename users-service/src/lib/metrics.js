'use strict';

/**
 * Métricas de calidad en memoria: latencia (p50/p95/p99), tráfico y tasa de
 * errores por ruta. Se exponen en GET /metrics (JSON) y
 * GET /metrics?format=prometheus (texto).
 */
const WINDOW = 5000; // últimas N latencias por ruta

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

class Metrics {
  constructor(service, now = Date.now) {
    this.service = service;
    this.now = now;
    this.startedAt = now();
    this.routes = new Map();
    this.counters = new Map();
    this.gauges = new Map();
  }

  observe(method, route, status, ms) {
    const key = `${method} ${route}`;
    let r = this.routes.get(key);
    if (!r) {
      r = { requests: 0, clientErrors: 0, serverErrors: 0, latencies: [], next: 0 };
      this.routes.set(key, r);
    }
    r.requests += 1;
    if (status >= 500) r.serverErrors += 1;
    else if (status >= 400) r.clientErrors += 1;
    if (r.latencies.length < WINDOW) r.latencies.push(ms);
    else {
      r.latencies[r.next] = ms;
      r.next = (r.next + 1) % WINDOW;
    }
  }

  inc(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + by);
  }

  gauge(name, value) {
    this.gauges.set(name, value);
  }

  snapshot() {
    const routes = {};
    let total = 0;
    let serverErrors = 0;
    let clientErrors = 0;
    const all = [];
    for (const [key, r] of this.routes) {
      total += r.requests;
      serverErrors += r.serverErrors;
      clientErrors += r.clientErrors;
      all.push(...r.latencies);
      routes[key] = {
        requests: r.requests,
        clientErrors: r.clientErrors,
        serverErrors: r.serverErrors,
        errorRate: r.requests ? r.serverErrors / r.requests : 0,
        latencyMs: {
          p50: round(percentile(r.latencies, 50)),
          p95: round(percentile(r.latencies, 95)),
          p99: round(percentile(r.latencies, 99)),
        },
      };
    }
    return {
      service: this.service,
      uptimeSeconds: Math.round((this.now() - this.startedAt) / 1000),
      totals: {
        requests: total,
        clientErrors,
        serverErrors,
        errorRate: total ? serverErrors / total : 0,
        latencyMs: {
          p50: round(percentile(all, 50)),
          p95: round(percentile(all, 95)),
          p99: round(percentile(all, 99)),
        },
      },
      routes,
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  toPrometheus() {
    const s = this.snapshot();
    const lines = [];
    const label = (extra = '') => `{service="${s.service}"${extra}}`;
    lines.push(`http_requests_total${label()} ${s.totals.requests}`);
    lines.push(`http_server_errors_total${label()} ${s.totals.serverErrors}`);
    lines.push(`http_error_rate${label()} ${s.totals.errorRate}`);
    for (const q of ['p50', 'p95', 'p99']) {
      lines.push(`http_latency_ms${label(`,quantile="${q}"`)} ${s.totals.latencyMs[q]}`);
    }
    for (const [k, v] of Object.entries(s.counters)) lines.push(`${k}${label()} ${v}`);
    for (const [k, v] of Object.entries(s.gauges)) lines.push(`${k}${label()} ${v}`);
    return `${lines.join('\n')}\n`;
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { Metrics, percentile };

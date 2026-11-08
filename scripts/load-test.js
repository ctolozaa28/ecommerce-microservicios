'use strict';

/**
 * Prueba de carga: mide throughput, latencia y errores con carga creciente, y
 * compara lectura de catálogo con una y dos instancias (balanceo round-robin en el cliente).
 * Generador y servicios comparten máquina: los valores son comparativos, no absolutos.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  Cluster, SERVICES, url, json, request, login, registerCustomer, createProduct,
} = require('./harness');

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function run(label, concurrency, durationMs, call) {
  const latencies = [];
  let errors = 0;
  let next = 0;
  const end = Date.now() + durationMs;
  const start = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < end) {
      const t = performance.now();
      const i = next;
      next += 1;
      try {
        const res = await call(i);
        await res.arrayBuffer();
        if (res.status >= 500) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - t);
    }
  }));
  const seconds = (Date.now() - start) / 1000;
  const row = {
    escenario: label,
    concurrencia: concurrency,
    peticiones: latencies.length,
    rps: Math.round(latencies.length / seconds),
    p50_ms: Math.round(percentile(latencies, 50) * 10) / 10,
    p95_ms: Math.round(percentile(latencies, 95) * 10) / 10,
    p99_ms: Math.round(percentile(latencies, 99) * 10) / 10,
    tasa_error: latencies.length ? errors / latencies.length : 0,
  };
  console.log(JSON.stringify(row));
  return row;
}

async function main() {
  const durationMs = Number(process.env.LOAD_DURATION_MS || 8000);
  const cluster = new Cluster();
  const rows = [];
  try {
    await cluster.startAll();
    const admin = await login('admin@tienda.test', 'admin12345');
    const ana = await registerCustomer(`ana.${Date.now()}@tienda.test`);
    const product = await createProduct(admin, 'Producto de carga', 1000, 100000000);
    for (let i = 0; i < 49; i += 1) await createProduct(admin, `Producto ${i}`, 1000 + i, 100);

    const base1 = url('products');
    const secondPort = SERVICES.products.port + 10;
    const base2 = `http://127.0.0.1:${secondPort}`;

    for (const c of [1, 10, 50]) {
      rows.push(await run('GET /products (1 instancia)', c, durationMs, () => fetch(`${base1}/products`)));
    }
    await cluster.start('products', { port: secondPort, key: 'products-2' });
    for (const c of [10, 50]) {
      rows.push(await run('GET /products (2 instancias)', c, durationMs, (i) => fetch(`${i % 2 ? base2 : base1}/products`)));
    }
    await cluster.kill('products-2');
    for (const c of [1, 10, 25]) {
      rows.push(await run('POST /orders (saga completa)', c, durationMs, () => request(url('orders'), '/orders', {
        method: 'POST', token: ana, body: { items: [{ productId: product.id, quantity: 1 }], paymentToken: 'tok_ok' },
      })));
    }
    const orders = await json(await request(url('orders'), '/metrics'));
    const products = await json(await request(url('products'), '/metrics'));
    const out = {
      fecha: new Date().toISOString(),
      entorno: { nodo: process.version, plataforma: os.platform(), cpu: os.cpus()[0].model, nucleos: os.cpus().length, memoriaGB: Math.round(os.totalmem() / 2 ** 30), duracionPorEscenarioMs: durationMs },
      resultados: rows,
      metricasInternas: {
        pedidos: { totals: orders.totals, counters: orders.counters, gauges: orders.gauges, 'POST /orders': orders.routes['POST /orders'] },
        productos: { totals: products.totals },
      },
    };
    const file = path.join(__dirname, '..', 'docs', 'resultados-carga.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\nResultados guardados en ${file}`);
  } finally {
    await cluster.stopAll();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

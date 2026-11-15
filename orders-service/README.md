# Procesamiento de Pedidos (orders-service)

**Propósito.** Crea pedidos, valida stock, integra el pago simulado y gestiona el estado del pedido.

**Tecnologías.** Node.js 22 (>=22.13), Express 5, SQLite (`node:sqlite`), JWT (`jsonwebtoken`), `node:test`.

**Interacción.** Llama a Productos (REST con retry, circuit breaker y fallback) y publica eventos order.* hacia Notificaciones.

**API.** POST /orders, GET /orders, GET /orders/:id, POST /orders/:id/cancel; con rol admin: PATCH /orders/:id/status. Operación: GET /health, GET /metrics, GET /metrics?format=prometheus.

## Ejecución

```bash
npm install
npm start       # puerto 3003; configurable con PORT
npm test        # pruebas con cobertura
```

**Variables de entorno.** PORT, DB_PATH, JWT_SECRET, INTERNAL_KEY, LOG_LEVEL y las URL de los servicios de los que depende (consulta `src/server.js`).

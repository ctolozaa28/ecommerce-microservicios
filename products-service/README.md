# Gestión de Productos (products-service)

**Propósito.** Administra el catálogo (crear, actualizar, eliminar y consultar) y las reservas de inventario.

**Tecnologías.** Node.js 22 (>=22.13), Express 5, SQLite (`node:sqlite`), JWT (`jsonwebtoken`), `node:test`.

**Interacción.** Recibe de Pedidos las reservas y liberaciones de stock. No llama a otros servicios.

**API.** GET /products, GET /products/:id; con rol admin: POST /products, PUT /products/:id, DELETE /products/:id; internos: POST /internal/products/:id/reservations, DELETE /internal/products/:id/reservations/:reservationId. Operación: GET /health, GET /metrics, GET /metrics?format=prometheus.

## Ejecución

```bash
npm install
npm start       # puerto 3001; configurable con PORT
npm test        # pruebas con cobertura
```

**Variables de entorno.** PORT, DB_PATH, JWT_SECRET, INTERNAL_KEY, LOG_LEVEL y las URL de los servicios de los que depende (consulta `src/server.js`).

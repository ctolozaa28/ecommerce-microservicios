# Notificaciones (notifications-service)

**Propósito.** Envía notificaciones por correo simulado cuando ocurren acciones relevantes.

**Tecnologías.** Node.js 22 (>=22.13), Express 5, SQLite (`node:sqlite`), JWT (`jsonwebtoken`), `node:test`.

**Interacción.** Consume eventos de Usuarios y Pedidos de forma idempotente. No llama a otros servicios.

**API.** Interno: POST /events; con JWT: GET /notifications/me. Operación: GET /health, GET /metrics, GET /metrics?format=prometheus.

## Ejecución

```bash
npm install
npm start       # puerto 3004; configurable con PORT
npm test        # pruebas con cobertura
```

**Variables de entorno.** PORT, DB_PATH, JWT_SECRET, INTERNAL_KEY, LOG_LEVEL y las URL de los servicios de los que depende (consulta `src/server.js`).

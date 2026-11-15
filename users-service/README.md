# Gestión de Usuarios (users-service)

**Propósito.** Registro, autenticación con JWT y gestión de perfiles.

**Tecnologías.** Node.js 22 (>=22.13), Express 5, SQLite (`node:sqlite`), JWT (`jsonwebtoken`), `node:test`.

**Interacción.** Emite los JWT que validan los demás servicios y publica user.registered hacia Notificaciones.

**API.** POST /users/register, POST /users/login, GET /users/me, PATCH /users/me, POST /users/me/password. Operación: GET /health, GET /metrics, GET /metrics?format=prometheus.

## Ejecución

```bash
npm install
npm start       # puerto 3002; configurable con PORT
npm test        # pruebas con cobertura
```

**Variables de entorno.** PORT, DB_PATH, JWT_SECRET, INTERNAL_KEY, LOG_LEVEL y las URL de los servicios de los que depende (consulta `src/server.js`).

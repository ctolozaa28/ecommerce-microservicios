# Plataforma básica de comercio electrónico con microservicios

Implementación del Caso Práctico 103 de *Arquitectura de Software* (Maestría en Ingeniería de Software, Universidad CESUMA).

| Microservicio | Carpeta | Puerto | Responsabilidad | Base de datos propia |
|---|---|---|---|---|
| Gestión de Productos | `products-service` | 3001 | Catálogo y reservas de inventario | `products.db` |
| Gestión de Usuarios | `users-service` | 3002 | Registro, autenticación y perfiles | `users.db` |
| Procesamiento de Pedidos | `orders-service` | 3003 | Saga de pedido, pago simulado y estados | `orders.db` |
| Notificaciones | `notifications-service` | 3004 | Envío asíncrono de correo simulado | `notifications.db` |

## Requisitos

Node.js 22.13 o superior (usa `fetch`, `node:test` y `node:sqlite`). No necesita Docker ni otros servidores.

## Ejecución

```bash
npm run install:all   # instala las dependencias de los cuatro servicios
npm run start:all     # arranca los cuatro servicios
```

Cada servicio también se ejecuta por separado; consulta el `README.md` de su carpeta. Credenciales de administrador de desarrollo: `admin@tienda.test` / `admin12345` (configurables por entorno; en producción el servicio se niega a arrancar con los valores por defecto).

## Pruebas y evaluación

```bash
npm run test:all   # pruebas unitarias y de API con cobertura
npm run e2e        # integración con los cuatro servicios como procesos reales
npm run chaos      # detiene servicios y comprueba la recuperación
npm run load       # prueba de carga; escribe docs/resultados-carga.json
```

## Ejemplo de uso

```bash
TOKEN=$(curl -s -X POST localhost:3002/users/login -H 'content-type: application/json' \
  -d '{"email":"admin@tienda.test","password":"admin12345"}' | jq -r .token)

PRODUCT=$(curl -s -X POST localhost:3001/products -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Teclado","priceCents":4500,"stock":10}' | jq -r .id)

curl -s -X POST localhost:3003/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"items\":[{\"productId\":\"$PRODUCT\",\"quantity\":2}],\"paymentToken\":\"tok_ok\"}"

curl -s localhost:3004/notifications/me -H "authorization: Bearer $TOKEN"
curl -s localhost:3003/metrics
```

Tokens de pago simulados: `tok_ok` (aprobado), `tok_declined` (rechazado), `tok_flaky` (falla una vez y luego aprueba).

## Documentación

- `docs/arquitectura.md`: vistas, decisiones arquitectónicas y escalabilidad.
- `docs/diagramas/`: diagramas UML y el script que los genera.
- `docs/resultados-carga.json`: mediciones de la prueba de carga.

## Limitaciones conocidas

Esta es una implementación académica: SQLite local por servicio, secretos compartidos (HS256 y clave interna), HTTP sin TLS, sin límite de intentos de login y pasarela de pago con estado en memoria. `docs/arquitectura.md` describe cómo se resolverían en producción.

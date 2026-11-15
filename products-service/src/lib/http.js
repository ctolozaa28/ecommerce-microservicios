'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Registra latencia/estado en las métricas y propaga x-request-id (trazabilidad). */
function observability(metrics, log) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.set('x-request-id', req.id);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'sin_ruta';
      if (route !== '/metrics' && route !== '/health') {
        metrics.observe(req.method, route, res.statusCode, ms);
      }
      log('info', 'request', { requestId: req.id, method: req.method, route, status: res.statusCode, ms: Math.round(ms) });
    });
    next();
  };
}

function createLogger(service) {
  const silent = process.env.LOG_LEVEL === 'silent';
  return (level, msg, data = {}) => {
    if (silent) return;
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service, level, msg, ...data })}\n`);
  };
}

function operationalRoutes(app, metrics, isReady = () => true) {
  app.get('/health', (req, res) => {
    const ready = isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'UP' : 'DOWN', service: metrics.service });
  });
  app.get('/metrics', (req, res) => {
    if (req.query.format === 'prometheus') {
      res.type('text/plain').send(metrics.toPrometheus());
      return;
    }
    res.json(metrics.snapshot());
  });
}

function requireAuth(secret) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      next(new AppError(401, 'UNAUTHENTICATED', 'Se requiere un token Bearer'));
      return;
    }
    try {
      req.user = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'users-service' });
      next();
    } catch {
      next(new AppError(401, 'INVALID_TOKEN', 'Token inválido o expirado'));
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      next(new AppError(403, 'FORBIDDEN', `Se requiere el rol ${role}`));
      return;
    }
    next();
  };
}

/** Autenticación servicio a servicio mediante clave compartida. */
function requireInternalKey(key) {
  return (req, res, next) => {
    const given = Buffer.from(req.get('x-internal-key') || '');
    const expected = Buffer.from(key);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      next(new AppError(401, 'INVALID_INTERNAL_KEY', 'Clave interna inválida'));
      return;
    }
    next();
  };
}

function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'Recurso no encontrado'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(log) {
  return (err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400) {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON mal formado' } });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    log('error', 'unhandled', { requestId: req.id, error: err.message, stack: err.stack });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Error interno' } });
  };
}

function requireSafeConfig(config, defaults) {
  if (process.env.NODE_ENV !== 'production') return;
  for (const [name, def] of Object.entries(defaults)) {
    if (config[name] === def) throw new Error(`${name} debe definirse en producción`);
  }
}

module.exports = {
  AppError,
  observability,
  createLogger,
  operationalRoutes,
  requireAuth,
  requireRole,
  requireInternalKey,
  notFound,
  errorHandler,
  requireSafeConfig,
};

'use strict';

const express = require('express');
const { Metrics } = require('./lib/metrics');
const {
  observability, createLogger, operationalRoutes, requireAuth, requireRole,
  requireInternalKey, notFound, errorHandler,
} = require('./lib/http');
const { openDatabase, ProductRepository } = require('./repository');
const { ProductService } = require('./service');

/** Capa de presentación: expone la API REST y delega en ProductService. */
function createApp(config) {
  const db = openDatabase(config.dbPath);
  const service = new ProductService(new ProductRepository(db));
  const metrics = new Metrics('products-service');
  const log = createLogger('products-service');
  const app = express();
  const auth = requireAuth(config.jwtSecret);
  const admin = [auth, requireRole('admin')];
  const internal = requireInternalKey(config.internalKey);

  app.use(express.json({ limit: '100kb' }));
  app.use(observability(metrics, log));
  operationalRoutes(app, metrics);

  app.get('/products', (req, res) => res.json(service.list(req.query)));
  app.get('/products/:id', (req, res) => res.json(service.get(req.params.id)));
  app.post('/products', admin, (req, res) => res.status(201).json(service.create(req.body)));
  app.put('/products/:id', admin, (req, res) => res.json(service.update(req.params.id, req.body)));
  app.delete('/products/:id', admin, (req, res) => {
    service.remove(req.params.id);
    res.status(204).end();
  });

  app.post('/internal/products/:id/reservations', internal, (req, res) => {
    const { reservationId, quantity } = req.body || {};
    res.status(201).json(service.reserve(req.params.id, reservationId, quantity));
  });
  app.delete('/internal/products/:id/reservations/:reservationId', internal, (req, res) => {
    service.release(req.params.id, req.params.reservationId);
    res.status(204).end();
  });

  app.use(notFound);
  app.use(errorHandler(log));
  app.locals = { ...app.locals, db, service, metrics, log, close: () => db.close() };
  return app;
}

module.exports = { createApp };

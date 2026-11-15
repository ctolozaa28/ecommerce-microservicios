'use strict';

const express = require('express');
const { Metrics } = require('./lib/metrics');
const {
  observability, createLogger, operationalRoutes, requireAuth, requireInternalKey, notFound, errorHandler,
} = require('./lib/http');
const { openDatabase, NotificationRepository } = require('./repository');
const { NotificationService, SimulatedEmailSender } = require('./service');

/** Capa de presentación: recibe eventos (202) y consulta de notificaciones. */
function createApp(config) {
  const db = openDatabase(config.dbPath);
  const metrics = new Metrics('notifications-service');
  const log = createLogger('notifications-service');
  const sender = config.sender || new SimulatedEmailSender({ failureRate: config.emailFailureRate || 0, log });
  const service = new NotificationService(new NotificationRepository(db), sender, { metrics, log });
  const app = express();

  app.use(express.json({ limit: '100kb' }));
  app.use(observability(metrics, log));
  operationalRoutes(app, metrics);

  app.post('/events', requireInternalKey(config.internalKey), (req, res) => res.status(202).json(service.accept(req.body)));
  app.get('/notifications/me', requireAuth(config.jwtSecret), (req, res) => res.json(service.list(req.user.email)));

  app.use(notFound);
  app.use(errorHandler(log));
  app.locals = { ...app.locals, db, service, metrics, log, close: () => { service.stop(); db.close(); } };
  return app;
}

module.exports = { createApp };

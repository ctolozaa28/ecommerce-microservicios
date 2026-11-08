'use strict';

const express = require('express');
const { Metrics } = require('./lib/metrics');
const { observability, createLogger, operationalRoutes, requireAuth, notFound, errorHandler } = require('./lib/http');
const { OutboxDispatcher } = require('./lib/outbox');
const { openDatabase, UserRepository } = require('./repository');
const { UserService } = require('./service');

/** Entrega el evento a Notificaciones; cualquier respuesta no 2xx provoca reintento. */
function notificationSender(url, internalKey) {
  return async (payload) => {
    const res = await fetch(`${url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': internalKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`Notificaciones respondió ${res.status}`);
  };
}

/** Capa de presentación: API REST de usuarios. */
function createApp(config) {
  const db = openDatabase(config.dbPath);
  const repo = new UserRepository(db);
  const service = new UserService(db, repo, { jwtSecret: config.jwtSecret, tokenTtl: config.tokenTtl });
  const metrics = new Metrics('users-service');
  const log = createLogger('users-service');
  const dispatcher = new OutboxDispatcher(db, {
    notifications: config.notify || notificationSender(config.notificationsUrl, config.internalKey),
  }, { metrics, log });
  const app = express();
  const auth = requireAuth(config.jwtSecret);

  app.use(express.json({ limit: '100kb' }));
  app.use(observability(metrics, log));
  operationalRoutes(app, metrics);

  app.post('/users/register', async (req, res) => res.status(201).json(await service.register(req.body)));
  app.post('/users/login', async (req, res) => res.json(await service.login(req.body)));
  app.get('/users/me', auth, (req, res) => res.json(service.profile(req.user.sub)));
  app.patch('/users/me', auth, (req, res) => res.json(service.updateProfile(req.user.sub, req.body)));
  app.post('/users/me/password', auth, async (req, res) => {
    await service.changePassword(req.user.sub, req.body);
    res.status(204).end();
  });

  app.use(notFound);
  app.use(errorHandler(log));
  app.locals = {
    ...app.locals,
    db,
    service,
    metrics,
    log,
    dispatcher,
    close: () => { dispatcher.stop(); db.close(); },
  };
  return app;
}

module.exports = { createApp, notificationSender };

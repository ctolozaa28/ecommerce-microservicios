'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./lib/http');

/** Regla de validación pura: devuelve el producto normalizado o lanza 400. */
function validateProduct(input) {
  const { name, description = '', priceCents, stock } = input || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 120) {
    throw new AppError(400, 'INVALID_NAME', 'name debe tener entre 2 y 120 caracteres');
  }
  if (typeof description !== 'string' || description.length > 2000) {
    throw new AppError(400, 'INVALID_DESCRIPTION', 'description debe ser texto de hasta 2000 caracteres');
  }
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new AppError(400, 'INVALID_PRICE', 'priceCents debe ser un entero mayor o igual a 0');
  }
  if (!Number.isInteger(stock) || stock < 0) {
    throw new AppError(400, 'INVALID_STOCK', 'stock debe ser un entero mayor o igual a 0');
  }
  return { name: name.trim(), description, priceCents, stock };
}

/** Capa de lógica de negocio del catálogo y de las reservas de inventario. */
class ProductService {
  constructor(repo, now = () => new Date().toISOString()) {
    this.repo = repo;
    this.now = now;
  }

  create(input) {
    const at = this.now();
    return this.repo.insert({ id: crypto.randomUUID(), ...validateProduct(input), createdAt: at, updatedAt: at });
  }

  get(id) {
    const product = this.repo.find(id);
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Producto no encontrado');
    return product;
  }

  list({ search, limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return this.repo.list({ search, limit: safeLimit, offset: safeOffset });
  }

  update(id, input) {
    const current = this.get(id);
    const merged = validateProduct({ ...current, ...input });
    return this.repo.update({ ...current, ...merged, updatedAt: this.now() });
  }

  remove(id) {
    if (!this.repo.softDelete(id, this.now())) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Producto no encontrado');
    }
  }

  /**
   * Reserva idempotente: repetir la llamada con el mismo reservationId no
   * descuenta dos veces, lo que hace seguros los reintentos de Pedidos.
   */
  reserve(productId, reservationId, quantity) {
    if (!reservationId || typeof reservationId !== 'string') {
      throw new AppError(400, 'INVALID_RESERVATION', 'reservationId es obligatorio');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new AppError(400, 'INVALID_QUANTITY', 'quantity debe ser un entero positivo');
    }
    return this.repo.transaction(() => {
      const at = this.now();
      const existing = this.repo.findReservation(reservationId);
      if (existing) {
        if (existing.status === 'RELEASED') {
          throw new AppError(409, 'RESERVATION_RELEASED', 'La reserva ya fue liberada');
        }
        return this.#view(productId, reservationId);
      }
      const product = this.repo.find(productId);
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Producto no encontrado');
      if (!this.repo.decrementStock(productId, quantity, at)) {
        throw new AppError(409, 'INSUFFICIENT_STOCK', `Stock insuficiente para ${product.name}`);
      }
      this.repo.insertReservation(reservationId, productId, quantity, 'RESERVED', at);
      return this.#view(productId, reservationId);
    });
  }

  /**
   * Compensación idempotente. Si la liberación llega antes que una reserva
   * retrasada, deja una marca RELEASED para que esa reserva tardía sea rechazada.
   */
  release(productId, reservationId) {
    this.repo.transaction(() => {
      const at = this.now();
      const existing = this.repo.findReservation(reservationId);
      if (!existing) {
        this.repo.insertReservation(reservationId, productId, 0, 'RELEASED', at);
        return;
      }
      if (existing.status === 'RESERVED') {
        this.repo.incrementStock(existing.product_id, existing.quantity, at);
        this.repo.markReleased(reservationId);
      }
    });
  }

  #view(productId, reservationId) {
    const product = this.repo.find(productId);
    return {
      reservationId,
      productId,
      name: product ? product.name : null,
      unitPriceCents: product ? product.priceCents : null,
      status: 'RESERVED',
    };
  }
}

module.exports = { ProductService, validateProduct };

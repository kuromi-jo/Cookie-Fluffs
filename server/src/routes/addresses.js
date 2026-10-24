/**
 * @file addresses.js
 * @description Authenticated saved-address CRUD routes.
 */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { pool } from '../db.js';
import { validateAddressRequest } from '../address-validation.js';
import { createAddress, deleteAddress, listAddresses, setDefaultAddress, updateAddress } from '../address-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createAddressesRouter(dbPool = pool, actions = {
  listAddresses,
  createAddress,
  updateAddress,
  setDefaultAddress,
  deleteAddress,
}) {
  const router = Router();
  router.use(requireAuth);

  async function withClient(res, next, action) {
    if (!dbPool) return res.status(503).json({ message: 'Saved addresses are temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      return await action(client);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  }

  router.get('/', (req, res, next) => withClient(res, next, async (client) => {
    const addresses = await actions.listAddresses(client, req.userId);
    return res.json({ addresses });
  }));

  router.post('/', (req, res, next) => {
    const validation = validateAddressRequest(req.body, { allowDefault: true });
    if (Object.keys(validation.errors).length) {
      return res.status(400).json({ message: Object.values(validation.errors)[0], errors: validation.errors });
    }
    return withClient(res, next, async (client) => {
      const address = await actions.createAddress(client, req.userId, validation.value);
      return res.status(201).json(address);
    });
  });

  router.put('/:id', (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ message: 'Address not found.' });
    const validation = validateAddressRequest(req.body);
    if (Object.keys(validation.errors).length) {
      return res.status(400).json({ message: Object.values(validation.errors)[0], errors: validation.errors });
    }
    return withClient(res, next, async (client) => {
      const address = await actions.updateAddress(client, req.userId, req.params.id.toLowerCase(), validation.value);
      return res.json(address);
    });
  });

  router.put('/:id/default', (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ message: 'Address not found.' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
      return res.status(400).json({ message: 'Default-address requests must not include extra fields.' });
    }
    return withClient(res, next, async (client) => {
      const address = await actions.setDefaultAddress(client, req.userId, req.params.id.toLowerCase());
      return res.json(address);
    });
  });

  router.delete('/:id', (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ message: 'Address not found.' });
    return withClient(res, next, async (client) => {
      await actions.deleteAddress(client, req.userId, req.params.id.toLowerCase());
      return res.status(204).end();
    });
  });

  return router;
}

export default createAddressesRouter();

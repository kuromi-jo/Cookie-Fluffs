/**
 * @file vouchers.js
 * @description The signed-in customer's vouchers and checkout voucher previews.
 */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { listVouchers, previewVoucher } from '../voucher-service.js';

export function createVouchersRouter({ list = listVouchers, preview = previewVoucher } = {}) {
  const router = Router();
  router.use(requireAuth);

  // GET /api/vouchers
  router.get('/', async (req, res, next) => {
    try {
      res.json({ vouchers: await list(req.userId) });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/vouchers/preview { code, fulfillmentMethod }
  router.post('/preview', async (req, res, next) => {
    const { code, fulfillmentMethod } = req.body ?? {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ message: 'Enter a voucher code.' });
    }
    if (fulfillmentMethod !== undefined && fulfillmentMethod !== 'delivery' && fulfillmentMethod !== 'pickup') {
      return res.status(400).json({ message: 'Choose delivery or pickup.' });
    }
    try {
      res.json(await preview(req.userId, code, fulfillmentMethod));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      next(error);
    }
  });

  return router;
}

export default createVouchersRouter();

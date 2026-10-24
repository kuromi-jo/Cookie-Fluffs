/**
 * @file geography.js
 * @description Public, versioned geography data used by checkout selectors.
 */
import { Router } from 'express';
import { getNcrGeography } from '../geography.js';

const router = Router();

router.get('/ncr', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.json(getNcrGeography());
});

export default router;

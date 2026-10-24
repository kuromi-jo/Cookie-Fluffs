/**
 * @file payments.js
 * @description Customer-safe payment capability endpoint.
 */
import { Router } from 'express';
import { paymongoConfig, publicPaymentConfig } from '../payment-config.js';
import { addDemoCardCapability, demoPaymentConfig } from '../demo-payment-config.js';
import { addWalletDemoCapabilities, walletDemoConfig } from '../wallet-demo-config.js';

const router = Router();

router.get('/config', (_req, res) => res.json(
  addDemoCardCapability(
    addWalletDemoCapabilities(publicPaymentConfig(paymongoConfig()), walletDemoConfig()),
    demoPaymentConfig(),
  ),
));

export default router;

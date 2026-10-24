/**
 * @file index.js
 * @description Cookie Fluffs REST API.
 *   Ionic/Angular app  ->  this Express API  ->  Neon Postgres
 */
import express from 'express';
import cors from 'cors';
import { initDb, isDbConfigured, query } from './db.js';
import productsRouter from './routes/products.js';
import authRouter from './routes/auth.js';
import cartRouter from './routes/cart.js';
import contactRouter from './routes/contact.js';
import ordersRouter from './routes/orders.js';
import geographyRouter from './routes/geography.js';
import paymentsRouter from './routes/payments.js';
import paymongoWebhookRouter from './routes/paymongo-webhook.js';
import addressesRouter from './routes/addresses.js';
import favoritesRouter from './routes/favorites.js';
import preferencesRouter from './routes/preferences.js';

process.on('unhandledRejection', (reason) => console.error('[api] unhandled rejection:', reason));

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(cors());
app.use('/api/webhooks/paymongo', express.raw({ type: 'application/json', limit: '256kb' }), paymongoWebhookRouter);
app.use(express.json({ limit: '1mb' }));

// GET /api/health  (quick check that the API and database are reachable)
app.get('/api/health', async (_req, res) => {
  if (!isDbConfigured) return res.status(503).json({ ok: false, database: 'not configured' });
  try {
    await query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, database: err.message });
  }
});

app.use('/api/products', productsRouter);
app.use('/api/auth', authRouter);
app.use('/api/cart', cartRouter);
app.use('/api/contact', contactRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/geography', geographyRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/addresses', addressesRouter);
app.use('/api/favorites', favoritesRouter);
app.use('/api/preferences', preferencesRouter);

app.use('/api', (_req, res) => res.status(404).json({ message: 'Endpoint not found.' }));

// Error handler: friendly message to the app, full details in the terminal
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body must be valid JSON.' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({
    message: status >= 500 && !err.status ? 'Something went wrong on our side. Please try again.' : err.message,
  });
});

async function start() {
  if (!isDbConfigured) {
    console.warn('\n  [warning] DATABASE_URL is not set.');
    console.warn('     Open server/.env and paste your Neon connection string after DATABASE_URL=\n');
  } else {
    try {
      const { seeded } = await initDb();
      console.log(`  [ok] Connected to Neon. Tables ready${seeded ? `, added ${seeded} cookies to the menu` : ''}.`);
    } catch (err) {
      console.error('  [error] Could not connect to Neon:', err.message);
      console.error('    Check the DATABASE_URL in server/.env.\n');
    }
  }
  app.listen(PORT, () => console.log(`  Cookie Fluffs API running at http://localhost:${PORT}/api`));
}

start();

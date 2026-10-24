/**
 * @file order-operations-cli.js
 * @description Backend-only authenticated CLI for bakery order lifecycle operations.
 */
import crypto from 'node:crypto';
import { pool } from './db.js';
import {
  advanceOrderStatus,
  createOrderOperator,
  reviewOrderRefund,
  resolveCancellationRequest,
  revokeOrderOperator,
  rotateOrderOperatorCredential,
} from './order-lifecycle.js';

const [command, ...args] = process.argv.slice(2);
const credential = process.env.ORDER_OPERATOR_CREDENTIAL ?? '';
const newCredential = process.env.ORDER_OPERATOR_NEW_CREDENTIAL ?? '';
const operatorId = process.env.ORDER_OPERATOR_ID ?? '';
const refundReason = process.env.ORDER_REFUND_REASON ?? '';
const canManageRefunds = process.env.ORDER_OPERATOR_CAN_MANAGE_REFUNDS === 'true';

function usage() {
  console.error('Usage: order-operations <operator:create|operator:rotate|operator:revoke|status|cancellation|refund:review> ...');
  process.exitCode = 2;
}

async function run() {
  if (!pool) throw new Error('DATABASE_URL is required for order operations.');
  const client = await pool.connect();
  try {
    if (command === 'operator:create' && args.length === 1) {
      const result = await createOrderOperator(client, args[0], newCredential, { canManageRefunds });
      console.log(`Operator created: ${result.id} (${result.displayName})`);
      return;
    }
    if (command === 'operator:rotate' && args.length === 1) {
      const result = await rotateOrderOperatorCredential(client, args[0], credential, newCredential);
      console.log(`Operator credential rotated: ${result.id}`);
      return;
    }
    if (command === 'operator:revoke' && args.length === 1) {
      const result = await revokeOrderOperator(client, args[0], credential);
      console.log(`Operator revoked: ${result.id}`);
      return;
    }
    if (command === 'status' && (args.length === 2 || args.length === 3)) {
      const result = await advanceOrderStatus(
        client,
        { id: operatorId, credential },
        args[0],
        args[1],
        args[2] ?? crypto.randomUUID(),
      );
      console.log(`Order ${result.orderId} is now ${result.orderStatus}.`);
      return;
    }
    if (command === 'cancellation' && (args.length === 2 || args.length === 3)) {
      const result = await resolveCancellationRequest(
        client,
        { id: operatorId, credential },
        args[0],
        args[1],
        args[2] ?? crypto.randomUUID(),
      );
      console.log(`Cancellation request ${result.requestId} is ${result.status}.`);
      return;
    }
    if (command === 'refund:review' && (args.length === 2 || args.length === 3)) {
      const result = await reviewOrderRefund(
        client,
        { id: operatorId, credential },
        args[0],
        args[1],
        args[2] ?? crypto.randomUUID(),
        refundReason,
      );
      console.log(`Refund review ${result.refundId} is ${result.status}.`);
      return;
    }
    usage();
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error(`Order operation failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool?.end());

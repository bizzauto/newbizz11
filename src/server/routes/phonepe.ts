/**
 * PhonePe payment routes
 *
 * POST /api/phonepe/callback          — PhonePe server-to-server callback (public, X-VERIFY checked)
 * GET  /api/phonepe/status/:orderId   — frontend polls after redirect; server re-checks with PhonePe (auth)
 * POST /api/phonepe/create            — payment-links style direct initiate (auth)
 *
 * The ecommerce checkout flow uses /ecommerce/checkout (creates PhonePe txn
 * inline) and confirms via checkStatus here — the client redirect is NEVER
 * trusted on its own.
 */
import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import {
  verifyCallbackChecksum,
  decodeCallbackResponse,
  checkStatus,
} from '../services/phonepe.service.js';

const router = Router();

/**
 * Shared post-payment success handler: marks order paid (once), sends
 * confirmation WhatsApp/email. Idempotent — safe to call from both the
 * callback and the status poll.
 */
async function confirmOrderPaid(orderId: string, txnDetails: any): Promise<boolean> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { contact: { select: { id: true, name: true, phone: true, email: true } }, items: true },
  });
  if (!order) return false;
  if (order.paymentStatus === 'paid') return true; // idempotent

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      paymentStatus: 'paid',
      status: 'processing',
      gatewayData: {
        ...(order.gatewayData as any),
        phonepe: {
          state: txnDetails?.state,
          transactionId: txnDetails?.transactionId,
          instrument: txnDetails?.paymentInstrument?.type,
          paidAt: new Date().toISOString(),
        },
      },
    },
  });

  // Loyalty points (same business rule as Razorpay path)
  try {
    const program = await prisma.loyaltyProgram.findFirst({
      where: { businessId: updated.businessId, isActive: true },
    });
    if (program && updated.contactId) {
      const pointsEarned = Math.floor(updated.total * program.pointsPerRupee);
      await prisma.loyaltyPoints.create({
        data: {
          businessId: updated.businessId,
          contactId: updated.contactId,
          points: pointsEarned,
          type: 'earn',
          description: `Points earned for order ${updated.orderNumber}`,
          orderId: updated.id,
        },
      });
    }
  } catch {
    // Non-critical
  }

  // Confirmation messages (best effort)
  (async () => {
    try {
      const full = updated as any;
      const itemCount = (full.items || []).length;
      const message = `Thank you {name}! Payment received for order ${full.orderNumber} (₹${full.total}). ${itemCount} item${itemCount > 1 ? 's' : ''} ${itemCount > 1 ? 'are' : 'is'} being processed. We'll update you when it ships!`;
      const { WhatsAppSendRouter } = await import('../services/whatsapp-send-router.service.js');
      if (full.contact?.phone) {
        await WhatsAppSendRouter.sendText(full.businessId, full.contact.phone, message, {
          contactId: full.contact.id,
        }).catch(() => {});
      }
      if (full.contact?.email) {
        const { EmailService } = await import('../services/email.service.js');
        await EmailService.sendEmail(
          full.contact.email,
          `Payment confirmed - Order ${full.orderNumber}`,
          `<p>Hi ${full.contact?.name || 'Customer'},</p><p>Payment received for order <strong>${full.orderNumber}</strong> (₹${full.total}).</p><p>We'll update you when it ships!</p>`
        ).catch(() => {});
      }
    } catch (e: any) {
      console.warn('[PhonePe] confirmation message failed:', e?.message);
    }
  })();

  return true;
}

/** Find order id from PhonePe merchantTransactionId stored in gatewayData */
async function findOrderPhonePe(merchantTransactionId: string) {
  return prisma.order.findFirst({
    where: { gatewayData: { path: ['merchantTransactionId'], equals: merchantTransactionId } },
  });
}

// ==================== PUBLIC CALLBACK (server-to-server) ====================

router.post('/callback', async (req: Request, res: Response) => {
  try {
    const b64Response = req.body?.response;
    const xVerify = (req.headers['x-verify'] as string) || '';

    if (!b64Response) {
      return res.status(400).json({ success: false, error: 'Missing response payload' });
    }
    if (!verifyCallbackChecksum(b64Response, xVerify)) {
      return res.status(403).json({ success: false, error: 'Invalid checksum' });
    }

    const txn = decodeCallbackResponse(b64Response);
    const mtid = txn?.data?.merchantTransactionId;
    if (!mtid) {
      return res.status(400).json({ success: false, error: 'Missing merchantTransactionId' });
    }

    // Don't trust callback state alone — double-check via status API (defence in depth)
    const status = await checkStatus(mtid).catch(() => null);
    const state = status?.data?.state || txn?.data?.state;

    if (state === 'COMPLETED') {
      const order = await findOrderPhonePe(mtid);
      if (order) await confirmOrderPaid(order.id, status?.data || txn?.data);
      // PhonePe expects a simple 200; body content is not parsed by them
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ success: true, state });
  } catch (error: any) {
    console.error('[PhonePe] callback error:', error?.message);
    // Never leak internals to the gateway
    return res.status(200).json({ success: false });
  }
});

// ==================== AUTHENTICATED ====================

router.use(authenticate);

/**
 * GET /api/phonepe/status/:orderId — frontend polls this after the redirect.
 * Server asks PhonePe directly; client response is never trusted.
 */
router.get('/status/:orderId', async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, businessId: req.user.businessId },
    });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    if (order.paymentStatus === 'paid') {
      return res.json({ success: true, data: { state: 'COMPLETED', paymentStatus: 'paid' } });
    }

    const mtid = (order.gatewayData as any)?.merchantTransactionId;
    if (!mtid) return res.json({ success: true, data: { state: 'NOT_INITIATED', paymentStatus: order.paymentStatus } });

    const status = await checkStatus(mtid).catch((e: any) => ({ success: false, error: e?.message }));

    if (status?.success && status?.data?.state === 'COMPLETED') {
      await confirmOrderPaid(order.id, status.data);
      return res.json({ success: true, data: { state: 'COMPLETED', paymentStatus: 'paid' } });
    }

    return res.json({
      success: true,
      data: { state: status?.data?.state || 'PENDING', paymentStatus: order.paymentStatus },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/phonepe/create — direct initiate (payment-links / manual billing flows).
 * Body: { orderId?, amount, redirectPath? }
 */
router.post('/create', async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, amount, redirectPath } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount is required' });
    }

    const FRONTEND = process.env.FRONTEND_URL || 'https://bizzautoai.com';
    const phonepe = await import('../services/phonepe.service.js');
    const result = await phonepe.createPayment({
      amountInRupees: Number(amount),
      merchantTransactionId: phonepe.generateTransactionId('MT'),
      redirectUrl: `${FRONTEND}${redirectPath || '/dashboard?phonepe=return'}`,
      callbackUrl: `${process.env.BASE_URL || FRONTEND}/api/phonepe/callback`,
      userId: req.user.id,
      mobileNumber: (req.user as any)?.phone,
      notes: orderId ? { orderId } : undefined,
    });

    if (orderId) {
      const order = await prisma.order.findFirst({ where: { id: orderId, businessId: req.user.businessId } });
      if (order) {
        await prisma.order.update({
          where: { id: orderId },
          data: { gatewayData: { ...(order.gatewayData as any), merchantTransactionId: result.merchantTransactionId } },
        });
      }
    }

    res.json({ success: true, data: { redirectUrl: result.redirectUrl, merchantTransactionId: result.merchantTransactionId } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

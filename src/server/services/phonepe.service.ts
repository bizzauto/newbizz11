/**
 * PhonePe Payment Gateway Service
 *
 * Implements PhonePe Standard Checkout (v2 /pg/v1 API):
 *   - createPayment: base64 payload → /pg/v1/pay → redirect URL + txn id
 *   - verifyCallback: X-VERIFY header check on redirect/webhook (SHA256(payload + path) + salt)
 *   - checkStatus: /pg/v1/status for server-side confirmation (idempotent capture)
 *
 * Env (per-merchant or global):
 *   PHONEPE_MERCHANT_ID      (MID, e.g. M22ABCD12E3F4_UAT / production MID)
 *   PHONEPE_SALT_KEY         (salt index appended is PHONEPE_SALT_INDEX, default 1)
 *   PHONEPE_SALT_INDEX       (default 1)
 *   PHONEPE_ENV              'UAT' (sandbox) | 'PROD'  → selects host
 *
 * UAT host:  https://api-preprod.phonepe.com/apis/pg-sandbox
 * PROD host: https://api.phonepe.com/apis/hermes
 *
 * Safe lazy-init pattern (mirrors razorpay.service.ts): module import never
 * throws when keys are missing; first use throws 'PhonePe not configured'.
 */
import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../db.js';

const PHONEPE_MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const PHONEPE_SALT_KEY = process.env.PHONEPE_SALT_KEY;
const PHONEPE_SALT_INDEX = process.env.PHONEPE_SALT_INDEX || '1';
const PHONEPE_ENV = (process.env.PHONEPE_ENV || 'UAT').toUpperCase();

const HOSTS: Record<string, string> = {
  UAT: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  PROD: 'https://api.phonepe.com/apis/hermes',
};
const HOST = HOSTS[PHONEPE_ENV] || HOSTS.UAT;

if (!PHONEPE_MERCHANT_ID || !PHONEPE_SALT_KEY) {
  console.error(
    '[PhonePe] CRITICAL: PHONEPE_MERCHANT_ID and/or PHONEPE_SALT_KEY not set. PhonePe payments disabled. Set them in your Coolify environment variables.'
  );
} else {
  console.log(`[PhonePe] Initialized: merchant=${PHONEPE_MERCHANT_ID.substring(0, 6)}... env=${PHONEPE_ENV}`);
}

function assertConfigured(): void {
  if (!PHONEPE_MERCHANT_ID || !PHONEPE_SALT_KEY) {
    throw new Error('PhonePe not configured');
  }
}

/** X-VERIFY = SHA256(base64Path + saltKey) + '###' + saltIndex */
function checksumForPath(path: string): string {
  assertConfigured();
  const str = path + PHONEPE_SALT_KEY;
  return crypto.createHash('sha256').update(str).digest('hex') + '###' + PHONEPE_SALT_INDEX;
}

/** Callback checksum: SHA256(base64Response + saltKey) + '###' + saltIndex */
export function verifyCallbackChecksum(b64Response: string, receivedXVerify: string): boolean {
  assertConfigured();
  const expected = crypto
    .createHash('sha256')
    .update(b64Response + PHONEPE_SALT_KEY)
    .digest('hex') + '###' + PHONEPE_SALT_INDEX;
  const a = Buffer.from(receivedXVerify || '');
  const b = Buffer.from(expected);
  // timing-safe; lengths must match (wrong header length = reject)
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface PhonePeInitiateResult {
  merchantTransactionId: string;
  redirectUrl: string | null;
  instrumentResponse: any | null;
  raw: any;
}

/**
 * Create a PhonePe pay request.
 * amount is in RUPEES (paise conversion happens here: *100).
 * merchantTransactionId must be ≤ 36 chars, alphanumeric with -_.
 */
export async function createPayment(opts: {
  amountInRupees: number;
  merchantTransactionId: string;
  redirectUrl: string;
  callbackUrl: string;
  userId?: string;
  mobileNumber?: string;
  notes?: Record<string, string>;
}): Promise<PhonePeInitiateResult> {
  assertConfigured();
  const amountPaise = Math.round(opts.amountInRupees * 100);
  if (amountPaise <= 0) throw new Error('Amount must be positive');
  if (amountPaise > 10_00_00_000) throw new Error('Amount exceeds PhonePe max (₹10,00,000)');

  const payload = {
    merchantId: PHONEPE_MERCHANT_ID,
    merchantTransactionId: opts.merchantTransactionId,
    merchantUserId: opts.userId || 'MUA' + (opts.userId || 'GUEST').substring(0, 16),
    amount: amountPaise,
    redirectUrl: opts.redirectUrl,
    redirectMode: 'REDIRECT',
    callbackUrl: opts.callbackUrl,
    mobileNumber: (opts.mobileNumber || '').replace(/\D/g, '').slice(-10) || undefined,
    paymentInstrument: { type: 'PAY_PAGE' },
  };

  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const path = '/pg/v1/pay';
  const checksum = crypto
    .createHash('sha256')
    .update(b64 + path + PHONEPE_SALT_KEY)
    .digest('hex') + '###' + PHONEPE_SALT_INDEX;

  const response = await axios.post(
    `${HOST}${path}`,
    { request: b64 },
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-VERIFY': checksum,
      },
      timeout: 15000,
    }
  );

  const data = response.data;
  if (data?.success !== true) {
    throw new Error(`PhonePe pay failed: ${data?.message || data?.code || 'unknown'}`);
  }

  return {
    merchantTransactionId: opts.merchantTransactionId,
    redirectUrl: data?.data?.instrumentResponse?.redirectInfo?.url || null,
    instrumentResponse: data?.data?.instrumentResponse || null,
    raw: data,
  };
}

/**
 * Server-side status check (call on redirect return — never trust client).
 * Returns { success, code, data } where data contains state + instrument.
 */
export async function checkStatus(merchantTransactionId: string): Promise<any> {
  assertConfigured();
  const path = `/pg/v1/status/${PHONEPE_MERCHANT_ID}/${merchantTransactionId}`;
  const xVerify = checksumForPath(path);
  const response = await axios.get(`${HOST}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-VERIFY': xVerify,
      'X-MERCHANT-ID': PHONEPE_MERCHANT_ID as string,
    },
    timeout: 15000,
  });
  return response.data;
}

/** Generate a PhonePe-compliant transaction id (≤36 chars, [A-Za-z0-9_-]) */
export function generateTransactionId(prefix = 'MT'): string {
  return (prefix + Date.now().toString(36) + crypto.randomBytes(6).toString('hex'))
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 35);
}

/** Decode the callback's base64 transaction payload */
export function decodeCallbackResponse(b64Response: string): any {
  try {
    return JSON.parse(Buffer.from(b64Response, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export default {
  createPayment,
  checkStatus,
  verifyCallbackChecksum,
  decodeCallbackResponse,
  generateTransactionId,
};

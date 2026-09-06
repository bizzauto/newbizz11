/**
 * @jest-environment node
 *
 * WhatsApp Messaging Service Tests
 *
 * Tests the core WhatsApp service functions directly:
 *   - sendTextMessage
 *   - sendTemplate
 *   - verifyWebhookSignature
 *   - processQueue
 *
 * Mocks axios and prisma, following the pattern from evolution-api.service.test.ts.
 * IMPORTANT: jest.mock factory functions must use inline object literals (not variables)
 * because Jest hoists jest.mock calls above all other code. The prisma mock is accessed
 * via the imported `prisma` reference after mocking.
 */

import { WhatsAppService } from '../src/server/services/whatsapp.service';

// ======== Mocks ========

jest.mock('../src/server/db', () => ({
  prisma: {
    business: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    message: {
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    integration: {
      findFirst: jest.fn(),
    },
    campaign: {
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../src/server/utils/auth', () => ({
  encrypt: jest.fn((s: string) => `enc_${s}`),
  decrypt: jest.fn((s: string) => {
    if (s.startsWith('enc_')) return s.slice(4);
    return 'decrypted_token';
  }),
}));

// Import prisma AFTER mocks are set up; this is the mocked version
import { prisma } from '../src/server/db';
const mockedPrisma = prisma as any;

const BUSINESS_ID = 'biz-test-123';
const PHONE_NUMBER_ID = '123456789';
const ACCESS_TOKEN = 'test-wa-access-token';
const TO_NUMBER = '+91 98765 43210';

// Default business fixture returned by prisma.business.findUnique
const defaultBusiness = {
  waPhoneNumberId: PHONE_NUMBER_ID,
  waAccessToken: `enc_${ACCESS_TOKEN}`,
  totalMessages: 0,
};

describe('WhatsAppService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    mockedPrisma.business.findUnique.mockResolvedValue(defaultBusiness);
    mockedPrisma.message.create.mockResolvedValue({ id: 'msg-new-1' });
    mockedPrisma.business.update.mockResolvedValue({ totalMessages: 1 });

    // Default axios success response
    mockedAxios.post.mockResolvedValue({
      data: { messages: [{ id: 'wa-message-id-123' }] },
    });
  });

  // ==================== sendTextMessage ====================

  describe('sendTextMessage', () => {
    it('should send a text message and save to database', async () => {
      const result = await WhatsAppService.sendTextMessage(
        BUSINESS_ID,
        TO_NUMBER,
        'Hello from test!'
      );

      // Verify WhatsApp API call
      // Note: to is normalized to digits-only E.164 (Meta requirement) and the
      // payload carries recipient_type/preview_url — both intentional.
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining(`/${PHONE_NUMBER_ID}/messages`),
        expect.objectContaining({
          messaging_product: 'whatsapp',
          to: '919876543210',
          type: 'text',
          text: { body: 'Hello from test!', preview_url: true },
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${ACCESS_TOKEN}`,
          }),
        })
      );

      // Verify message saved
      expect(mockedPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            businessId: BUSINESS_ID,
            direction: 'outbound',
            type: 'text',
            content: 'Hello from test!',
            status: 'sent',
          }),
        })
      );

      // Verify business stats updated
      expect(mockedPrisma.business.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BUSINESS_ID },
          data: { totalMessages: { increment: 1 } },
        })
      );

      expect(result).toEqual({ messages: [{ id: 'wa-message-id-123' }] });
    });

    it('should throw error when WhatsApp is not configured', async () => {
      mockedPrisma.business.findUnique.mockResolvedValue({
        waPhoneNumberId: null,
        waAccessToken: null,
      });

      await expect(
        WhatsAppService.sendTextMessage(BUSINESS_ID, TO_NUMBER, 'Test')
      ).rejects.toThrow('WhatsApp not configured');
    });

    it('should save failed message record when API call fails', async () => {
      const apiError = new Error('Invalid phone number');
      (apiError as any).response = {
        data: { error: { message: 'Invalid number format' } },
      };
      mockedAxios.post.mockRejectedValue(apiError);

      await expect(
        WhatsAppService.sendTextMessage(BUSINESS_ID, 'invalid', 'Test')
      ).rejects.toThrow('Invalid phone number');

      // Failed message should still be saved
      expect(mockedPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: 'outbound',
            type: 'text',
            status: 'failed',
            error: 'Invalid number format',
          }),
        })
      );
    });

    it('should pass messageId as contactId when provided', async () => {
      await WhatsAppService.sendTextMessage(BUSINESS_ID, TO_NUMBER, 'Test', {
        messageId: 'contact-123',
      });

      expect(mockedPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contactId: 'contact-123',
          }),
        })
      );
    });

    it('should read waPhoneNumberId and waAccessToken from prisma', async () => {
      mockedPrisma.business.findUnique.mockResolvedValue({
        waPhoneNumberId: 'CUSTOM_PHONE_ID',
        waAccessToken: `enc_CUSTOM_TOKEN`,
      });

      await WhatsAppService.sendTextMessage(BUSINESS_ID, TO_NUMBER, 'Test');

      const axiosCall = mockedAxios.post.mock.calls[0];
      expect(axiosCall[0]).toContain('/CUSTOM_PHONE_ID/messages');
      expect(axiosCall[2].headers.Authorization).toBe('Bearer CUSTOM_TOKEN');
    });
  });

  // ==================== sendTemplate ====================

  describe('sendTemplateMessage', () => {
    const TEMPLATE_NAME = 'hello_world';
    const LANGUAGE = 'en';
    const VARIABLES = ['Test User'];

    it('should send a template message and save to database', async () => {
      const result = await WhatsAppService.sendTemplate(
        BUSINESS_ID,
        TO_NUMBER,
        TEMPLATE_NAME,
        LANGUAGE,
        VARIABLES
      );

      // Verify WhatsApp API call with template payload
      // Note: to is normalized to digits-only E.164 (Meta requirement).
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining(`/${PHONE_NUMBER_ID}/messages`),
        expect.objectContaining({
          messaging_product: 'whatsapp',
          to: '919876543210',
          type: 'template',
          template: expect.objectContaining({
            name: TEMPLATE_NAME,
            language: { code: LANGUAGE },
            components: [
              {
                type: 'body',
                parameters: [{ type: 'text', text: 'Test User' }],
              },
            ],
          }),
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${ACCESS_TOKEN}`,
          }),
        })
      );

      // Verify message saved with template metadata
      expect(mockedPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            businessId: BUSINESS_ID,
            direction: 'outbound',
            type: 'template',
            content: TEMPLATE_NAME,
            templateName: TEMPLATE_NAME,
            templateVars: VARIABLES,
            templateLanguage: LANGUAGE,
            status: 'sent',
          }),
        })
      );

      expect(mockedPrisma.business.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BUSINESS_ID },
          data: { totalMessages: { increment: 1 } },
        })
      );

      expect(result).toEqual({ messages: [{ id: 'wa-message-id-123' }] });
    });

    it('should throw error when WhatsApp is not configured', async () => {
      mockedPrisma.business.findUnique.mockResolvedValue({
        waPhoneNumberId: null,
        waAccessToken: null,
      });

      await expect(
        WhatsAppService.sendTemplate(BUSINESS_ID, TO_NUMBER, TEMPLATE_NAME)
      ).rejects.toThrow('WhatsApp not configured');
    });

    it('should send template without variables when none provided', async () => {
      await WhatsAppService.sendTemplate(BUSINESS_ID, TO_NUMBER, TEMPLATE_NAME, LANGUAGE);

      const axiosPayload = mockedAxios.post.mock.calls[0][1];
      // No variables → components block omitted entirely (valid for Meta; only
      // variable templates need a body components entry).
      expect(axiosPayload.template.components).toBeUndefined();
    });

    it('should use default language "en" when not specified', async () => {
      await WhatsAppService.sendTemplate(BUSINESS_ID, TO_NUMBER, TEMPLATE_NAME);

      const axiosPayload = mockedAxios.post.mock.calls[0][1];
      expect(axiosPayload.template.language.code).toBe('en');
    });
  });

  // ==================== verifyWebhookSignature ====================

  describe('verifyWebhookSignature', () => {
    it('should return true for valid signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'my-webhook-secret';

      // Generate the expected signature using the same method as the service
      const hash = require('crypto')
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
      const validSignature = `sha256=${hash}`;

      const result = WhatsAppService.verifyWebhookSignature(payload, validSignature, secret);
      expect(result).toBe(true);
    });

    it('should return false for invalid signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const result = WhatsAppService.verifyWebhookSignature(
        payload,
        'sha256=invalid_signature_here',
        'secret'
      );
      expect(result).toBe(false);
    });

    it('should return false when signature format is wrong', () => {
      const payload = JSON.stringify({ test: 'data' });
      const result = WhatsAppService.verifyWebhookSignature(
        payload,
        'wrong_format',
        'secret'
      );
      expect(result).toBe(false);
    });
  });

  // ==================== processQueue ====================

  describe('processQueue', () => {
    it('should process queued text messages in batches', async () => {
      const queuedMessages = [
        {
          id: 'q-1',
          businessId: BUSINESS_ID,
          type: 'text',
          content: 'Message 1',
          contactId: 'c-1',
          templateName: null,
          templateLanguage: null,
          templateVars: null,
          metadata: { to: TO_NUMBER, useProxy: false },
          createdAt: new Date('2025-01-01'),
        },
        {
          id: 'q-2',
          businessId: BUSINESS_ID,
          type: 'text',
          content: 'Message 2',
          contactId: null,
          templateName: null,
          templateLanguage: null,
          templateVars: null,
          metadata: { to: '+91 87654 32109', useProxy: false },
          createdAt: new Date('2025-01-01'),
        },
      ];

      mockedPrisma.message.findMany.mockResolvedValue(queuedMessages);
      mockedPrisma.message.create.mockResolvedValue({ id: 'sent-msg-1' });
      mockedPrisma.message.update.mockResolvedValue({});

      const processed = await WhatsAppService.processQueue(100);

      expect(processed).toBeGreaterThan(0);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(mockedPrisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // BullMQ-dispatched rows carry metadata.dispatchedVia='bullmq' and are
          // excluded here to prevent double sends (the worker owns those).
          where: {
            status: 'queued',
            NOT: { metadata: { path: ['dispatchedVia'], equals: 'bullmq' } },
          },
          take: 100,
        })
      );
    });

    it('should return 0 when no messages are queued', async () => {
      mockedPrisma.message.findMany.mockResolvedValue([]);

      const processed = await WhatsAppService.processQueue(100);

      expect(processed).toBe(0);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should mark message as failed after retries exhausted', async () => {
      const queuedMessages = [
        {
          id: 'q-retry-1',
          businessId: BUSINESS_ID,
          type: 'text',
          content: 'Fail message',
          contactId: null,
          templateName: null,
          templateLanguage: null,
          templateVars: null,
          metadata: {
            to: TO_NUMBER,
            useProxy: false,
            retryCount: 3,
            lastError: 'Previous error',
          },
          createdAt: new Date('2025-01-01'),
        },
      ];

      mockedPrisma.message.findMany.mockResolvedValue(queuedMessages);
      // Simulate failure again
      const apiError = new Error('Rate limited');
      (apiError as any).response = {
        data: { error: { message: 'Too many requests' } },
      };
      mockedAxios.post.mockRejectedValue(apiError);

      // The message has retryCount >= 3, so it should go to failed
      const processed = await WhatsAppService.processQueue(100);

      expect(mockedPrisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'q-retry-1' },
          data: expect.objectContaining({
            status: 'failed',
            error: 'Rate limited',
          }),
        })
      );
    });
  });
});

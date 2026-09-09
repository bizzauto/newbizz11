import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { BrevoEmailService } from '../services/brevo-email.service.js';

const router = Router();
router.use(authenticate);

/**
 * GET /api/email/brevo/status
 * Check Brevo configuration status
 */
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const integration = await prisma.integration.findUnique({
      where: { businessId_type: { businessId, type: 'brevo_email' } },
    });

    const connected = integration?.isActive || false;
    let accountInfo = null;

    if (connected) {
      const config = integration.config as any;
      // BYOK: per-call key (no env mutation)
      const result = await BrevoEmailService.getAccountInfo(config.apiKey);
      if (result.success) accountInfo = result.data;
    }

    return res.json({
      success: true,
      data: {
        configured: BrevoEmailService.isConfigured(),
        connected,
        accountInfo,
        defaultFromEmail: integration ? (integration.config as any)?.defaultFromEmail : null,
        lastSyncAt: integration?.lastSyncAt || null,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/brevo/connect
 * Save Brevo API key
 */
router.post('/connect', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { apiKey, defaultFromEmail, defaultFromName } = req.body;

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'API key is required' });
    }

    // Test connection — per-call key (no env mutation: concurrent requests
    // would race and test/save the WRONG account's key)
    const testResult = await BrevoEmailService.testConnection(apiKey);

    if (!testResult.success) {
      return res.status(400).json({ success: false, error: `Connection test failed: ${testResult.error}` });
    }

    // Save to Integration model
    await prisma.integration.upsert({
      where: { businessId_type: { businessId, type: 'brevo_email' } },
      create: {
        businessId,
        type: 'brevo_email',
        name: 'Brevo Email',
        config: {
          apiKey,
          defaultFromEmail: defaultFromEmail || testResult.data?.email || 'noreply@bizzauto.com',
          defaultFromName: defaultFromName || 'BizzAuto',
        },
        isActive: true,
      },
      update: {
        config: {
          apiKey,
          defaultFromEmail: defaultFromEmail || testResult.data?.email || 'noreply@bizzauto.com',
          defaultFromName: defaultFromName || 'BizzAuto',
        },
        isActive: true,
        lastError: null,
      },
    });

    return res.json({
      success: true,
      data: {
        message: 'Brevo connected successfully',
        email: testResult.data?.email,
        plan: testResult.data?.plan,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/brevo/disconnect
 * Remove Brevo integration
 */
router.post('/disconnect', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    await prisma.integration.deleteMany({
      where: { businessId, type: 'brevo_email' },
    });

    return res.json({
      success: true,
      data: { message: 'Brevo disconnected successfully' },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/brevo/send
 * Send a transactional email
 */
router.post('/send', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const integration = await prisma.integration.findUnique({
      where: { businessId_type: { businessId, type: 'brevo_email' } },
    });

    if (!integration || !integration.isActive) {
      return res.status(400).json({ success: false, error: 'Brevo not connected' });
    }

    const { to, subject, htmlContent } = req.body;

    if (!to || !subject || !htmlContent) {
      return res.status(400).json({ success: false, error: 'To, subject, and content are required' });
    }

    const config = integration.config as any;
    const originalKey = process.env.BREVO_API_KEY;
    process.env.BREVO_API_KEY = config.apiKey;

    const result = await BrevoEmailService.sendTransactionalEmail({
      to,
      subject,
      htmlContent,
      fromEmail: config.defaultFromEmail,
      fromName: config.defaultFromName,
    });

    if (originalKey) process.env.BREVO_API_KEY = originalKey;

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.json({
      success: true,
      data: { messageId: result.messageId, message: 'Email sent successfully' },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/email/brevo/lists
 * List Brevo contact lists
 */
router.get('/lists', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const integration = await prisma.integration.findUnique({
      where: { businessId_type: { businessId, type: 'brevo_email' } },
    });

    if (!integration || !integration.isActive) {
      return res.status(400).json({ success: false, error: 'Brevo not connected' });
    }

    const config = integration.config as any;
    const originalKey = process.env.BREVO_API_KEY;
    process.env.BREVO_API_KEY = config.apiKey;
    const result = await BrevoEmailService.listLists();
    if (originalKey) process.env.BREVO_API_KEY = originalKey;

    return res.json({ success: result.success, data: result.data, error: result.error });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/brevo/lists
 * Create a new contact list
 */
router.post('/lists', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const integration = await prisma.integration.findUnique({
      where: { businessId_type: { businessId, type: 'brevo_email' } },
    });

    if (!integration || !integration.isActive) {
      return res.status(400).json({ success: false, error: 'Brevo not connected' });
    }

    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'List name is required' });

    const config = integration.config as any;
    const originalKey = process.env.BREVO_API_KEY;
    process.env.BREVO_API_KEY = config.apiKey;
    const result = await BrevoEmailService.createList(name);
    if (originalKey) process.env.BREVO_API_KEY = originalKey;

    return res.json({ success: result.success, data: { id: result.id }, error: result.error });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/brevo/contacts/sync
 * Sync BizzAuto contacts to a Brevo list
 */
router.post('/contacts/sync', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const integration = await prisma.integration.findUnique({
      where: { businessId_type: { businessId, type: 'brevo_email' } },
    });

    if (!integration || !integration.isActive) {
      return res.status(400).json({ success: false, error: 'Brevo not connected' });
    }

    const { listId, limit = 100 } = req.body;
    if (!listId) return res.status(400).json({ success: false, error: 'List ID is required' });

    // Get contacts from BizzAuto
    const contacts = await prisma.contact.findMany({
      where: { businessId, email: { not: null } },
      take: limit,
      select: { email: true, name: true, phone: true },
    });

    const config = integration.config as any;
    const originalKey = process.env.BREVO_API_KEY;
    process.env.BREVO_API_KEY = config.apiKey;

    let synced = 0;
    let failed = 0;

    for (const contact of contacts) {
      if (!contact.email) continue;
      const result = await BrevoEmailService.createContact({
        email: contact.email,
        attributes: {
          FIRSTNAME: contact.name?.split(' ')[0] || '',
          LASTNAME: contact.name?.split(' ').slice(1).join(' ') || '',
          SMS: contact.phone || '',
        },
        listIds: [listId],
      });
      if (result.success) synced++;
      else failed++;
    }

    if (originalKey) process.env.BREVO_API_KEY = originalKey;

    // Update lastSyncAt
    await prisma.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date() },
    });

    return res.json({
      success: true,
      data: { synced, failed, total: contacts.length },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/brevo/test
 * Send a test email
 */
router.post('/test', async (req: AuthRequest, res: Response) => {
  try {
    const businessId = req.user?.businessId;
    if (!businessId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const integration = await prisma.integration.findUnique({
      where: { businessId_type: { businessId, type: 'brevo_email' } },
    });

    if (!integration || !integration.isActive) {
      return res.status(400).json({ success: false, error: 'Brevo not connected' });
    }

    const { to } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'Recipient email is required' });

    const config = integration.config as any;
    const originalKey = process.env.BREVO_API_KEY;
    process.env.BREVO_API_KEY = config.apiKey;

    const result = await BrevoEmailService.sendTransactionalEmail({
      to,
      subject: 'BizzAuto — Test Email',
      htmlContent: `
        <h2>✅ Brevo Integration Working!</h2>
        <p>This is a test email from BizzAuto CRM via Brevo.</p>
        <p>Your email integration is configured correctly.</p>
        <hr>
        <p style="color: #888; font-size: 12px;">Sent via BizzAuto CRM</p>
      `,
      fromEmail: config.defaultFromEmail,
      fromName: config.defaultFromName,
    });

    if (originalKey) process.env.BREVO_API_KEY = originalKey;

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.json({
      success: true,
      data: { message: 'Test email sent successfully' },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

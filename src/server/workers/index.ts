import '../dns-config.js'; // MUST be first: forces IPv4-first DNS so GBP/Google calls don't time out on broken IPv6 egress
import { Queue, Worker, Job } from 'bullmq';
import { WhatsAppSendRouter } from '../services/whatsapp-send-router.service.js';
import { EmailService } from '../services/email.service.js';
import { GoogleSheetsService } from '../services/google-sheets.service.js';
import { LeadCaptureService } from '../services/lead-capture.service.js';
import { GBPAutoPostService } from '../services/gbp-auto-post.service.js';
import { webhookDeliveryQueue, shutdownWebhookWorker } from '../services/webhook-retry.service.js';
import { scheduledMessageQueue, scheduledMessageWorker } from './scheduled-message.worker.js';
import { prisma } from '../db.js';
import { createRedisConnection } from '../utils/redis-connection.js';

// Redis connection (lazyConnect — status is 'waiting' until async connect resolves)
// bullMQ:true → no commandTimeout, because BullMQ uses long-polling blocking
// commands that would otherwise trip ioredis's per-command timeout and flood logs.
const redisConnection = createRedisConnection({ bullMQ: true });

/**
 * Don't gate on `redisConnection.status === 'ready'` at import time — the
 * connection is still 'waiting' here and would permanently disable all queues.
 * Gate instead on whether connect was *attempted* (a client object exists) and
 * re-check operability at call time via `isRedisOperational()`.
 */
const redisAvailable = redisConnection !== null;

if (!redisAvailable) {
  console.log('[Workers] Redis not configured — background jobs disabled. App will run without queues.');
}

const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800, count: 5000 },
};

// Queues (only created if Redis is available)
export const queues = redisAvailable ? {
  whatsappMessages: new Queue('whatsapp-messages', { connection: redisConnection, defaultJobOptions: DEFAULT_JOB_OPTS }),
  emails: new Queue('emails', { connection: redisConnection, defaultJobOptions: DEFAULT_JOB_OPTS }),
  socialPublish: new Queue('social-publish', { connection: redisConnection, defaultJobOptions: DEFAULT_JOB_OPTS }),
  googleSheetsSync: new Queue('google-sheets-sync', { connection: redisConnection, defaultJobOptions: DEFAULT_JOB_OPTS }),
  leadProcessing: new Queue('lead-processing', { connection: redisConnection, defaultJobOptions: DEFAULT_JOB_OPTS }),
  campaignScheduler: new Queue('campaign-scheduler', { connection: redisConnection, defaultJobOptions: DEFAULT_JOB_OPTS }),
  gbpAutoPost: new Queue('gbp-auto-post', { connection: redisConnection, defaultJobOptions: DEFAULT_JOB_OPTS }),
  webhookRetry: webhookDeliveryQueue,
} : {} as any;

// ==================== INDIA MART AUTOSYNC POLLER ====================
// Automatically pulls IndiaMART enquiry emails into the CRM so leads flow
// without manual intervention. The poller logic lives in
// services/indiamart-sync.service.ts (kept out of this heavy worker graph so
// it is cheaply unit-testable); we re-export it here for the worker entry.
export {
  indiamartAutosyncTick,
  startIndiaMARTAutosync,
  getIndiaMARTAutosyncState,
} from '../services/indiamart-sync.service.js';

// Campaign Dispatcher: registers a repeatable tick (every minute) on the
// campaign-scheduler queue so DB-scheduled campaigns fire automatically
// without any manual trigger. Idempotent via stable jobId.
let campaignDispatcherStarted = false;
export async function startCampaignDispatcher(): Promise<void> {
  if (!redisAvailable || campaignDispatcherStarted) return;
  const q = queues.campaignScheduler;
  if (!q) return;
  campaignDispatcherStarted = true;
  await q.add(
    'dispatch-due-campaigns',
    {},
    { repeat: { every: 60_000 }, jobId: 'campaign-dispatcher' }
  );
  console.log('📅 Campaign Dispatcher started (scans due campaigns every minute)');
}

// Social Post Dispatcher: repeatable tick (every minute) so scheduled posts
// actually publish without any manual trigger. Idempotent via stable jobId.
let socialDispatcherStarted = false;
export async function startSocialDispatcher(): Promise<void> {
  if (!redisAvailable || socialDispatcherStarted) return;
  const q = queues.socialPublish;
  if (!q) return;
  socialDispatcherStarted = true;
  await q.add(
    'dispatch-due-posts',
    {},
    { repeat: { every: 60_000 }, jobId: 'social-dispatcher' }
  );
  console.log('📅 Social Dispatcher started (scans due posts every minute)');
}

// Export shutdown for graceful worker teardown
export function shutdownAllWorkers(): Promise<void> {
  const workers = [whatsappWorker, emailWorker, socialPublishWorker, googleSheetsSyncWorker, leadProcessingWorker, campaignSchedulerWorker, gbpAutoPostWorker, scheduledMessageWorker];
  return Promise.allSettled(
    workers.map(w => w?.close())
  ).then(() => {});
}

// ==================== JOB WORKERS (only if Redis is available) ====================

let whatsappWorker: Worker | null = null;
let emailWorker: Worker | null = null;
let socialPublishWorker: Worker | null = null;
let googleSheetsSyncWorker: Worker | null = null;
let leadProcessingWorker: Worker | null = null;
let campaignSchedulerWorker: Worker | null = null;
let gbpAutoPostWorker: Worker | null = null;

if (redisAvailable) {

// WhatsApp Message Worker
whatsappWorker = new Worker(
  'whatsapp-messages',
  async (job: Job) => {
    // Handle scheduled messages
    if (job.name === 'scheduled-message') {
      const { scheduledMessageId, businessId } = job.data;
      const scheduled = await prisma.scheduledMessage.findUnique({
        where: { id: scheduledMessageId },
      });

      if (!scheduled || scheduled.status !== 'pending') {
        return { skipped: true, reason: 'Message no longer pending' };
      }

      try {
        let result;
        if (scheduled.type === 'text') {

          result = await WhatsAppSendRouter.sendText(businessId, scheduled.phone, scheduled.content || '', {
            messageId: scheduled.contactId || undefined,
          });
        } else if (scheduled.type === 'template') {

          result = await WhatsAppSendRouter.sendTemplate(
            businessId, scheduled.phone, {
              templateName: scheduled.templateName || '',
              language: scheduled.templateLanguage || 'en',
              variables: (scheduled.templateVars as unknown as string[]) || [],
            }
          );
        } else if (scheduled.type === 'media') {

          result = await WhatsAppSendRouter.sendMedia(
            businessId, scheduled.phone,
            scheduled.mediaUrl || '', (scheduled.mediaType || 'image') as 'image' | 'video' | 'document' | 'audio',
            scheduled.content || undefined,
          );
        }

        await prisma.scheduledMessage.update({
          where: { id: scheduledMessageId },
          data: {
            status: 'sent',
            sentAt: new Date(),

            waMessageId: result?.messages?.[0]?.id || result?.key?.id || result?.messageId,
          },
        });

        return { success: true, scheduledMessageId };
      } catch (error: any) {
        await prisma.scheduledMessage.update({
          where: { id: scheduledMessageId },
          data: {
            status: 'failed',
            error: error.message || 'Failed to send scheduled message',
          },
        });
        throw error;
      }
    }

    // Handle regular messages
    const { businessId, to, type, content, templateName, variables, contactId, useProxy, campaignId } = job.data;

    // Campaign sends rotate across the business's Evolution instance pool
    // (anti-ban number rotation); one-off/manual sends stay on the primary.
    const rotate = Boolean(campaignId);

    if (type === 'text') {
      return await WhatsAppSendRouter.sendText(businessId, to, content, {
        messageId: contactId,
        useProxy,
        rotate,
      });
    } else if (type === 'template') {
      return await WhatsAppSendRouter.sendTemplate(businessId, to, {
        templateName,
        language: 'en',
        variables,
      }, {
        useProxy,
        rotate,
      });
    } else if (type === 'media') {
      const { mediaUrl, mediaType, caption } = job.data;
      return await WhatsAppSendRouter.sendMedia(businessId, to, mediaUrl, mediaType, caption, {
        useProxy,
        rotate,
      });
    }
  },
  {
    connection: redisConnection,
    concurrency: 10,
  }
);

// Email Worker
emailWorker = new Worker(
  'emails',
  async (job: Job) => {
    const { businessId, to, subject, text, html, attachments } = job.data;

    // BYOK: business's own Brevo/SMTP first (their quota), platform as fallback
    return await EmailService.sendEmail(to, subject, html || text || '', undefined, 3, businessId);
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

// Social Media Publishing Worker
socialPublishWorker = new Worker(
  'social-publish',
  async (job: Job) => {
    // Dispatcher tick: scan DB for due scheduled posts and enqueue each.
    if (job.name === 'dispatch-due-posts') {
      const due = await prisma.post.findMany({
        where: { status: 'scheduled', scheduledAt: { lte: new Date() } },
        select: { id: true, businessId: true },
        take: 50,
      });
      for (const p of due) {
        await queues.socialPublish.add('publish', { postId: p.id, businessId: p.businessId });
      }
      if (due.length > 0) {
        console.log(`[SocialDispatcher] Dispatched ${due.length} due post(s)`);
      }
      return { dispatched: due.length };
    }

    const { postId, businessId } = job.data;

    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post || post.status !== 'scheduled') {
      throw new Error('Post not found or not scheduled');
    }

    // Publish to each platform
    const results: any = {};

    for (const platform of post.platforms) {
      try {
        if (platform === 'facebook') {
          results.facebook = await publishToFacebook(businessId, post);
        } else if (platform === 'instagram') {
          results.instagram = await publishToInstagram(businessId, post);
        } else if (platform === 'linkedin') {
          results.linkedin = await publishToLinkedIn(businessId, post);
        } else if (platform === 'twitter') {
          results.twitter = await publishToTwitter(businessId, post);
        } else if (platform === 'google_gbp') {
          results.google_gbp = await publishToGBP(businessId, post);
        }
      } catch (error: any) {
        results[platform] = { success: false, error: error.message };
      }
    }

    // Update post status
    await prisma.post.update({
      where: { id: postId },
      data: {
        status: 'published',
        publishedAt: new Date(),
        publishedIds: results as any,
      },
    });

    return results;
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

// Google Sheets Sync Worker
googleSheetsSyncWorker = new Worker(
  'google-sheets-sync',
  async (job: Job) => {
    const { businessId, type, options } = job.data;

    if (type === 'sync_contacts') {
      return await GoogleSheetsService.syncContacts(businessId, options);
    } else if (type === 'import_contacts') {
      return await GoogleSheetsService.importContacts(businessId, options);
    }
  },
  {
    connection: redisConnection,
    concurrency: 3,
  }
);

// Lead Processing Worker
leadProcessingWorker = new Worker(
  'lead-processing',
  async (job: Job) => {
    const { businessId, leadData, source } = job.data;

    if (!businessId || !source || !leadData) {
      throw new Error('Missing required fields: businessId, source, leadData');
    }

    let contact;

    // Process lead via LeadCaptureService based on source
    switch (source) {
      case 'indiamart':
        contact = await LeadCaptureService.captureIndiaMARTLead(businessId, {
          name: leadData.name || '',
          phone: leadData.phone || '',
          email: leadData.email,
          company: leadData.company,
          product: leadData.product || leadData.service,
          requirement: leadData.requirement || leadData.message,
          city: leadData.city,
          state: leadData.state,
        });
        break;
      case 'justdial':
        contact = await LeadCaptureService.captureJustDialLead(businessId, {
          name: leadData.name || '',
          phone: leadData.phone || '',
          email: leadData.email,
          service: leadData.service,
          location: leadData.location,
          message: leadData.message,
        });
        break;
      case 'facebook_ads':
        contact = await LeadCaptureService.captureFacebookLead(businessId, {
          name: leadData.name,
          phone: leadData.phone,
          email: leadData.email,
          formId: leadData.form_id || leadData.formId,
          adId: leadData.ad_id || leadData.adId,
          campaignId: leadData.campaign_id || leadData.campaignId,
          customFields: leadData.custom_fields || leadData.customFields,
        });
        break;
      case 'instagram_ads':
        contact = await LeadCaptureService.captureInstagramLead(businessId, {
          name: leadData.name,
          phone: leadData.phone,
          email: leadData.email,
          username: leadData.username,
          formId: leadData.form_id || leadData.formId,
          adId: leadData.ad_id || leadData.adId,
        });
        break;
      default:
        // Generic lead capture via upsert
        contact = await LeadCaptureService.upsertContact(businessId, {
          name: leadData.name || 'Website Lead',
          phone: leadData.phone || '',
          email: leadData.email,
          company: leadData.company,
          source,
          tags: [source.charAt(0).toUpperCase() + source.slice(1), 'Lead'],
          metadata: {
            ...leadData,
            capturedAt: new Date().toISOString(),
          },
        });
        break;
    }

    if (!contact) {
      throw new Error('Failed to process lead');
    }

    // Post-capture processing
    const results: any = {
      contactId: contact.id,
      source,
      processed: true,
    };

    // 1. Auto-assign lead to a sales rep
    try {
      const assignedUserId = await LeadCaptureService.autoAssignLead(businessId, contact.id, {
        roundRobin: true,
      });
      if (assignedUserId) {
        // Set the actual assignment on the contact (was only logged before —
        // contact.assignedTo stayed null and leads showed unassigned in CRM)
        await prisma.contact.update({
          where: { id: contact.id },
          data: { assignedTo: assignedUserId },
        }).catch(() => {});
        const assignee = await prisma.user.findUnique({
          where: { id: assignedUserId },
          select: { name: true, phone: true },
        });
        await prisma.activity.create({
          data: {
            businessId,
            contactId: contact.id,
            type: 'lead_assigned',
            title: 'Lead auto-assigned',
            content: `Lead from ${source} assigned to ${assignee?.name || 'team member'}`,
            createdBy: 'system',
            metadata: { source, assignedTo: assignedUserId, assignedBy: 'system' },
          },
        });
        results.assignedTo = assignedUserId;
        // Notify the assigned sales rep on WhatsApp (best-effort) + FCM push
        try {
          if (assignee?.phone) {
            const contactName = contact.name || 'New lead';
            const msg = `🎯 New lead assigned to you: ${contactName} (source: ${source}). Khologe CRM me details ke liye.`;
            const { WhatsAppSendRouter } = await import('../services/whatsapp-send-router.service.js');
            await WhatsAppSendRouter.sendText(businessId, assignee.phone, msg, {
              contactId: contact.id,
              applyAntiBan: false,
            });
            results.repNotified = true;
          }
        } catch (notifyErr: any) {
          console.warn('Rep WhatsApp notify failed:', notifyErr?.message);
        }
        // FCM mobile push to the assigned rep
        try {
          const { FcmService } = await import('../services/fcm.service.js');
          await FcmService.sendToUser(
            assignedUserId,
            '🎯 New Lead Assigned!',
            `${contact.name || 'New lead'} from ${source}. Open CRM for details.`,
            { url: '/crm' }
          );
        } catch (pushErr: any) {
          console.warn('Rep FCM push failed:', pushErr?.message);
        }
      }
    } catch (error: any) {
      console.error('Lead auto-assignment error:', error.message);
      results.assignmentError = error.message;
    }

    // 2. Create notifications for business users
    try {
      const businessUsers = await prisma.user.findMany({
        where: { businessId, isActive: true },
        select: { id: true },
      });
      for (const user of businessUsers) {
        await prisma.notification.create({
          data: {
            userId: user.id,
            businessId,
            type: 'lead_captured',
            title: `New lead from ${source}`,
            message: `${leadData.name || 'Someone'} reached out about ${leadData.product || leadData.service || 'your services'}`,
            entityType: 'lead',
            entityId: contact.id,
          },
        });
      }
    } catch (error: any) {
      console.error('Lead notification error:', error.message);
    }

    // 3. Update lead score if contact has enough data
    try {
      const scoreValue = calculateLeadScore(leadData);
      await prisma.leadScore.upsert({
        where: { businessId_contactId: { businessId, contactId: contact.id } },
        create: {
          contactId: contact.id,
          businessId,
          score: scoreValue.score,
          factors: scoreValue.factors as any,
        },
        update: {
          score: scoreValue.score,
          factors: scoreValue.factors as any,
          lastUpdated: new Date(),
        },
      });
      results.score = scoreValue.score;
    } catch (error: any) {
      console.error('Lead scoring error:', error.message);
    }

    return results;
  },
  {
    connection: redisConnection,
    concurrency: 10,
  }
);

/**
 * Calculate lead engagement score based on available data
 */
function calculateLeadScore(leadData: any): { score: number; factors: Array<{ factor: string; points: number }> } {
  let score = 30; // Base score
  const factors: Array<{ factor: string; points: number }> = [{ factor: 'base', points: 30 }];

  if (leadData.name && leadData.name.length > 0) {
    score += 10;
    factors.push({ factor: 'has_name', points: 10 });
  }
  if (leadData.phone) {
    score += 15;
    factors.push({ factor: 'has_phone', points: 15 });
  }
  if (leadData.email) {
    score += 15;
    factors.push({ factor: 'has_email', points: 15 });
  }
  if (leadData.company) {
    score += 10;
    factors.push({ factor: 'has_company', points: 10 });
  }
  if (leadData.product || leadData.service) {
    score += 10;
    factors.push({ factor: 'has_product_interest', points: 10 });
  }
  if (leadData.requirement || leadData.message) {
    score += 10;
    factors.push({ factor: 'has_detailed_requirement', points: 10 });
  }
  if (leadData.city || leadData.location) {
    score += 5;
    factors.push({ factor: 'has_location', points: 5 });
  }

  // Cap at 100
  score = Math.min(score, 100);

  return { score, factors };
}

// Campaign Scheduler Worker
campaignSchedulerWorker = new Worker(
  'campaign-scheduler',
  async (job: Job) => {
    // Dispatcher tick: scan DB for due scheduled campaigns and enqueue each.
    if (job.name === 'dispatch-due-campaigns') {
      const due = await prisma.campaign.findMany({
        where: { status: 'scheduled', scheduledAt: { lte: new Date() } },
        select: { id: true },
        take: 50,
      });
      for (const c of due) {
        await queues.campaignScheduler.add('run-campaign', { campaignId: c.id });
      }
      if (due.length > 0) {
        console.log(`[CampaignDispatcher] Dispatched ${due.length} due campaign(s)`);
      }
      return { dispatched: due.length };
    }

    const { campaignId } = job.data;

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new Error('Campaign not found');
    }

    // Get target contacts
    const contacts = await prisma.contact.findMany({
      where: {
        businessId: campaign.businessId,
        ...(campaign.targetTags?.length > 0 && {
          tags: { hasSome: campaign.targetTags },
        }),
      },
    });

    // Queue messages
    for (const contact of contacts) {
      await queues.whatsappMessages.add(
        'send_message',
        {
          businessId: campaign.businessId,
          to: contact.phone,
          type: 'template',
          templateName: campaign.templateName,
          variables: campaign.templateVars || [],
          contactId: contact.id,
          campaignId: campaign.id,
        },
        {
          delay: campaign.scheduledAt
            ? new Date(campaign.scheduledAt).getTime() - Date.now()
            : 0,
        }
      );
    }

    // Update campaign status
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'active',
        startedAt: new Date(),
        totalSent: contacts.length,
      },
    });

    return { queued: contacts.length };
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

/**
 * Social Media Publishing Functions
 */

async function publishToFacebook(businessId: string, post: any) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { fbPageId: true, fbAccessToken: true },
  });

  if (!business?.fbPageId || !business?.fbAccessToken) {
    throw new Error('Facebook not configured');
  }

  const axios = await import('axios');
  const { decrypt } = await import('../utils/auth.js');
  const accessToken = decrypt(business.fbAccessToken);

  const response = await axios.default.post(
    `https://graph.facebook.com/v18.0/${business.fbPageId}/feed`,
    {
      message: post.content,
      access_token: accessToken,
      ...(post.mediaUrls?.length > 0 && {
        attached_media: post.mediaUrls.map((url: string) => JSON.stringify({ url })),
      }),
    }
  );

  return { success: true, postId: response.data.id };
}

async function publishToInstagram(businessId: string, post: any) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { igUserId: true, igAccessToken: true },
  });

  if (!business?.igUserId || !business?.igAccessToken) {
    throw new Error('Instagram not configured');
  }

  const axios = await import('axios');
  const { decrypt } = await import('../utils/auth.js');
  const accessToken = decrypt(business.igAccessToken);
  const igBusinessId = business.igUserId;

  // Instagram requires two-step process: create container, then publish
  let creationId: string;

  if (post.mediaUrls && post.mediaUrls.length > 0) {
    const mediaUrl = post.mediaUrls[0];
    
    // Step 1: Create media container
    const containerRes = await axios.default.post(
      `https://graph.facebook.com/v18.0/${igBusinessId}/media`,
      {
        image_url: mediaUrl,
        caption: post.content || '',
        access_token: accessToken,
      }
    );
    
    creationId = containerRes.data.id;
    
    // Wait for media processing (Instagram needs time)
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Step 2: Publish the container
    const publishRes = await axios.default.post(
      `https://graph.facebook.com/v18.0/${igBusinessId}/media_publish`,
      {
        creation_id: creationId,
        access_token: accessToken,
      }
    );
    
    return { success: true, instagramPostId: publishRes.data.id };
  } else {
    throw new Error('Instagram requires media (image/video). Text-only posts not supported.');
  }
}

async function publishToLinkedIn(businessId: string, post: any) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { linkedinPageId: true, linkedinAccessToken: true },
  });

  if (!business?.linkedinPageId || !business?.linkedinAccessToken) {
    throw new Error('LinkedIn not configured');
  }

  const axios = await import('axios');
  const { decrypt } = await import('../utils/auth.js');
  const accessToken = decrypt(business.linkedinAccessToken);

  const response = await axios.default.post(
    'https://api.linkedin.com/v2/ugcPosts',
    {
      author: `urn:li:organization:${business.linkedinPageId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: post.content },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    }
  );

  return { success: true, postId: response.data.id };
}

async function publishToTwitter(businessId: string, post: any) {
  // Twitter API v2 implementation
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { twitterUserId: true, twitterAccessToken: true },
  });

  if (!business?.twitterUserId || !business?.twitterAccessToken) {
    throw new Error('Twitter not configured');
  }

  const axios = await import('axios');
  const { decrypt } = await import('../utils/auth.js');
  const accessToken = decrypt(business.twitterAccessToken);

  const response = await axios.default.post(
    'https://api.twitter.com/2/tweets',
    { text: post.content },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return { success: true, tweetId: response.data.data.id };
}

async function publishToGBP(businessId: string, post: any) {
  // Google Business Profile publishing
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { gbpAccountId: true, gbpLocationId: true, gbpAccessToken: true },
  });

  if (!business?.gbpAccountId || !business?.gbpAccessToken) {
    throw new Error('Google Business Profile not configured');
  }

  const axios = await import('axios');
  const { decrypt } = await import('../utils/auth.js');
  const accessToken = decrypt(business.gbpAccessToken);

  // GBP Posts API
  const response = await axios.default.post(
    `https://mybusiness.googleapis.com/v4/accounts/${business.gbpAccountId}/locations/${business.gbpLocationId}/localPosts`,
    {
      languageCode: 'en',
      summary: post.content.substring(0, 200),
      state: 'LIVE',
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return { success: true, postId: response.data.name };
}

// GBP Auto-Post Worker
gbpAutoPostWorker = new Worker(
  'gbp-auto-post',
  async (job: Job) => {
    const { type, businessId } = job.data;

    if (type === 'check-and-post') {
      // Get all businesses with GBP auto-post enabled
      const businesses = await prisma.business.findMany({
        where: {
          gbpAutoPostEnabled: true,
          gbpAccessToken: { not: null },
          gbpAccountId: { not: null },
          gbpLocationId: { not: null },
        },
        select: {
          id: true,
          name: true,
        },
      });

      const results: any[] = [];

      for (const business of businesses) {
        try {
          const result = await GBPAutoPostService.executeAutoPost(business.id);
          results.push({
            businessId: business.id,
            businessName: business.name,
            ...result,
          });
        } catch (error: any) {
          console.error(`Error processing auto-post for business ${business.id}:`, error.message);
          results.push({
            businessId: business.id,
            businessName: business.name,
            success: false,
            message: error.message,
          });
        }
      }

      return { checked: businesses.length, results };
    }

    if (type === 'post-business' && businessId) {
      return await GBPAutoPostService.executeAutoPost(businessId);
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

} // end if (redisAvailable)

/**
 * Export workers
 */
export const workers = {
  whatsapp: whatsappWorker,
  email: emailWorker,
  socialPublish: socialPublishWorker,
  googleSheetsSync: googleSheetsSyncWorker,
  leadProcessing: leadProcessingWorker,
  campaignScheduler: campaignSchedulerWorker,
  gbpAutoPost: gbpAutoPostWorker,
};

/**
 * Graceful shutdown
 */
export async function shutdownWorkers() {
  console.log('Shutting down workers...');
  
  if (!redisAvailable) {
    console.log('No Redis — no workers to shut down');
    return;
  }
  
  await Promise.all([
    whatsappWorker?.close(),
    emailWorker?.close(),
    socialPublishWorker?.close(),
    googleSheetsSyncWorker?.close(),
    leadProcessingWorker?.close(),
    campaignSchedulerWorker?.close(),
    gbpAutoPostWorker?.close(),
    shutdownWebhookWorker(),
  ]);

  await redisConnection?.quit();
  console.log('All workers shut down successfully');
}

// Shutdown is handled by the main server gracefulShutdown() which calls shutdownWorkers via webhook-retry.service

export default { queues, workers };

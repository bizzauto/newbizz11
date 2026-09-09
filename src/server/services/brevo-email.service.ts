import axios from 'axios';

/**
 * Brevo (Sendinblue) Email Service
 * Docs: https://developers.brevo.com/
 * Free tier: 300 emails/day
 */

const BREVO_API_URL = 'https://api.brevo.com/v3';

const BREVO_API_KEY = process.env.BREVO_API_KEY;

if (!BREVO_API_KEY) {
  console.warn('[Brevo] BREVO_API_KEY not set. Brevo email integration will be unavailable.');
}

/**
 * Brevo Email Service
 * Send transactional emails, manage contacts, and create campaigns
 */
export class BrevoEmailService {
  /**
   * Check if Brevo is configured
   */
  static isConfigured(): boolean {
    return !!BREVO_API_KEY;
  }

  /**
   * Get common headers for Brevo API
   */
  private static getHeaders(apiKey?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'api-key': apiKey || BREVO_API_KEY || '',
      Accept: 'application/json',
    };
  }

  /**
   * Send a transactional email
   *
   * BYOK: pass `apiKey` explicitly (the business's own Brevo key loaded from
   * its Integration record). NEVER mutate process.env per request — concurrent
   * sends would race and use each other's accounts.
   */
  static async sendTransactionalEmail(data: {
    apiKey?: string;
    to: string;
    subject: string;
    htmlContent: string;
    fromEmail?: string;
    fromName?: string;
    replyTo?: string;
    tags?: string[];
  }): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
  }> {
    try {
      const apiKey = data.apiKey || BREVO_API_KEY;
      if (!apiKey) {
        return { success: false, error: 'Brevo not configured: no API key (business integration or platform env)' };
      }
      const payload = {
        sender: {
          email: data.fromEmail || process.env.BREVO_DEFAULT_FROM_EMAIL || 'noreply@bizzauto.com',
          name: data.fromName || process.env.BREVO_DEFAULT_FROM_NAME || 'BizzAuto',
        },
        to: [{ email: data.to }],
        subject: data.subject,
        htmlContent: data.htmlContent,
        ...(data.replyTo ? { replyTo: { email: data.replyTo } } : {}),
        ...(data.tags ? { tags: data.tags } : {}),
      };

      const response = await axios.post(`${BREVO_API_URL}/smtp/email`, payload, {
        headers: this.getHeaders(apiKey),
        timeout: 30000,
      });

      return {
        success: true,
        messageId: response.data.messageId,
      };
    } catch (error: any) {
      // Rate limit (Brevo daily cap) surfaces as 429 — return it distinctly so
      // callers can queue/notify instead of retry-bombing.
      const status = error.response?.status;
      if (status === 429) {
        return { success: false, error: 'Brevo daily quota exceeded (300/day on free plan). Try tomorrow or upgrade your Brevo account.' };
      }
      console.error('[Brevo] Send email failed:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * Create a contact in Brevo
   */
  static async createContact(data: {
    email: string;
    attributes?: Record<string, string>;
    listIds?: number[];
    tags?: string[];
  }): Promise<{
    success: boolean;
    id?: number;
    error?: string;
  }> {
    try {
      const payload: any = {
        email: data.email,
        ...(data.attributes ? { attributes: data.attributes } : {}),
        ...(data.listIds ? { listIds: data.listIds } : {}),
        ...(data.tags ? { tags: data.tags } : {}),
      };

      const response = await axios.post(`${BREVO_API_URL}/contacts`, payload, {
        headers: this.getHeaders(),
        timeout: 15000,
      });

      return {
        success: true,
        id: response.data.id,
      };
    } catch (error: any) {
      // 409 = contact already exists, treat as success
      if (error.response?.status === 409) {
        return { success: true };
      }
      console.error('[Brevo] Create contact failed:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * Update a contact in Brevo
   */
  static async updateContact(email: string, data: {
    attributes?: Record<string, string>;
    listIds?: number[];
  }): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const encodedEmail = encodeURIComponent(email);
      const payload: any = {};
      if (data.attributes) payload.attributes = data.attributes;
      if (data.listIds) payload.listIds = data.listIds;

      await axios.put(`${BREVO_API_URL}/contacts/${encodedEmail}`, payload, {
        headers: this.getHeaders(),
        timeout: 15000,
      });

      return { success: true };
    } catch (error: any) {
      console.error('[Brevo] Update contact failed:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * List contact lists
   */
  static async listLists(): Promise<{
    success: boolean;
    data?: Array<{ id: number; name: string; totalContacts: number }>;
    error?: string;
  }> {
    try {
      const response = await axios.get(`${BREVO_API_URL}/contacts/lists`, {
        headers: this.getHeaders(),
        params: { limit: 50 },
        timeout: 15000,
      });

      return {
        success: true,
        data: response.data.lists?.map((list: any) => ({
          id: list.id,
          name: list.name,
          totalContacts: list.totalSubscribers || 0,
        })) || [],
      };
    } catch (error: any) {
      console.error('[Brevo] List lists failed:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a contact list
   */
  static async createList(name: string): Promise<{
    success: boolean;
    id?: number;
    error?: string;
  }> {
    try {
      const response = await axios.post(`${BREVO_API_URL}/contacts/lists`, {
        name,
        folderId: 1,
      }, {
        headers: this.getHeaders(),
        timeout: 15000,
      });

      return {
        success: true,
        id: response.data.id,
      };
    } catch (error: any) {
      console.error('[Brevo] Create list failed:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Create an email campaign
   */
  static async createCampaign(data: {
    name: string;
    subject: string;
    htmlContent: string;
    senderName: string;
    senderEmail: string;
    listIds: number[];
    scheduledAt?: string;
  }): Promise<{
    success: boolean;
    id?: number;
    error?: string;
  }> {
    try {
      const payload: any = {
        name: data.name,
        subject: data.subject,
        htmlContent: data.htmlContent,
        sender: {
          name: data.senderName,
          email: data.senderEmail,
        },
        recipients: {
          listIds: data.listIds,
        },
        ...(data.scheduledAt ? { scheduledAt: data.scheduledAt } : {}),
      };

      const response = await axios.post(`${BREVO_API_URL}/emailCampaigns`, payload, {
        headers: this.getHeaders(),
        timeout: 30000,
      });

      return {
        success: true,
        id: response.data.id,
      };
    } catch (error: any) {
      console.error('[Brevo] Create campaign failed:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Send an existing campaign
   */
  static async sendCampaign(campaignId: number): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      await axios.post(`${BREVO_API_URL}/emailCampaigns/${campaignId}/send`, {}, {
        headers: this.getHeaders(),
        timeout: 30000,
      });

      return { success: true };
    } catch (error: any) {
      console.error('[Brevo] Send campaign failed:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * List campaigns with stats
   */
  static async listCampaigns(): Promise<{
    success: boolean;
    data?: Array<{
      id: number;
      name: string;
      status: string;
      sentDate?: string;
      statistics?: { delivered: number; opened: number; clicked: number };
    }>;
    error?: string;
  }> {
    try {
      const response = await axios.get(`${BREVO_API_URL}/emailCampaigns`, {
        headers: this.getHeaders(),
        params: { limit: 20 },
        timeout: 15000,
      });

      return {
        success: true,
        data: response.data.campaigns?.map((c: any) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          sentDate: c.sentDate,
          statistics: c.statistics,
        })) || [],
      };
    } catch (error: any) {
      console.error('[Brevo] List campaigns failed:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get account info (for testing connection)
   */
  static async getAccountInfo(apiKey?: string): Promise<{
    success: boolean;
    data?: { email: string; plan: string; dailyLimit: number };
    error?: string;
  }> {
    try {
      const key = apiKey || BREVO_API_KEY;
      if (!key) {
        return { success: false, error: 'Brevo API key not configured' };
      }
      const response = await axios.get(`${BREVO_API_URL}/account`, {
        headers: this.getHeaders(key),
        timeout: 15000,
      });

      const account = response.data;
      return {
        success: true,
        data: {
          email: account.email,
          plan: account.plan?.[0]?.name || 'free',
          dailyLimit: 300, // Free tier limit
        },
      };
    } catch (error: any) {
      console.error('[Brevo] Get account info failed:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test connection
   */
  static async testConnection(apiKey?: string): Promise<{
    success: boolean;
    data?: { email: string; plan: string };
    error?: string;
  }> {
    try {
      const result = await this.getAccountInfo(apiKey);
      if (!result.success || !result.data) {
        return { success: false, error: result.error };
      }

      return {
        success: true,
        data: { email: result.data.email, plan: result.data.plan },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

export default BrevoEmailService;

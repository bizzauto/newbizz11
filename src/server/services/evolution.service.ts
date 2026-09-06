import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { circuitBreaker } from '../services/circuit-breaker.service.js';
import { spinAndPersonalize } from '../utils/spintax.js';

// Anti-ban settings
export interface AntiBanSettings {
  enabled: boolean;
  messageDelayMs: number;
  groupMessageDelayMs: number;
  randomDelayMs: number;
  maxMessagesPerDay: number;
}

export const DEFAULT_ANTI_BAN_SETTINGS: AntiBanSettings = {
  enabled: true,
  messageDelayMs: 2000,
  groupMessageDelayMs: 5000,
  randomDelayMs: 1000,
  maxMessagesPerDay: 100,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGroupJid(to: string): boolean {
  return to.includes('@g.us') || to.includes('@g.chat');
}

// Number rotation (multi-account round-robin, Saasyto-style)
export interface RotationInstance {
  instanceName: string;
  baseUrl?: string; // optional — falls back to primary config
  apiKey?: string;  // optional — falls back to primary config
}

export interface RotationSettings {
  enabled: boolean;
  pool: RotationInstance[];
}

const DEFAULT_ROTATION_SETTINGS: RotationSettings = { enabled: false, pool: [] };

/**
 * Evolution API Service
 * 
 * Integrates with Evolution API (https://github.com/EvolutionAPI/evolution-api)
 * for WhatsApp Web-based messaging via QR code scanning.
 * 
 * Supports: Instance management, QR code, send text/media/template,
 * webhook events, group management, profile settings.
 */
export class EvolutionApiService {
  /**
   * Get Evolution API config for a business
   */
  private static async getConfig(businessId: string): Promise<{
    baseUrl: string;
    apiKey: string;
    instanceName: string;
  }> {
    // First, try to get config from database (user-configured via UI)
    const integration = await prisma.integration.findFirst({
      where: { businessId, type: 'evolution_api', isActive: true },
    });

    if (integration) {
      const config = integration.config as any;
      return {
        baseUrl: config.baseUrl || '',
        apiKey: config.apiKey || '',
        instanceName: config.instanceName || `biz_${businessId.slice(-8)}`,
      };
    }

    // FALLBACK: Read from environment variables as system default
    const envBaseUrl = process.env.EVOLUTION_API_URL;
    const envApiKey = process.env.EVOLUTION_API_KEY;
    const envInstanceName = process.env.EVOLUTION_INSTANCE_NAME;

    if (envBaseUrl && envApiKey) {
      return {
        baseUrl: envBaseUrl,
        apiKey: envApiKey,
        instanceName: envInstanceName || `biz_${businessId.slice(-8)}`,
      };
    }

    throw new Error('Evolution API not configured. Set EVOLUTION_API_URL and EVOLUTION_API_KEY in .env or configure via UI.');
  }

  /**
   * Create a new Evolution API instance
   */
  static async createInstance(businessId: string, options: {
    baseUrl?: string;
    apiKey?: string;
    instanceName?: string;
    webhookUrl?: string;
    phone?: string;
  }): Promise<any> {
    if (!options.baseUrl || !options.apiKey) {
      const internalConfig = await this.getConfig(businessId);
      options.baseUrl = options.baseUrl || internalConfig.baseUrl;
      options.apiKey = options.apiKey || internalConfig.apiKey;
      options.instanceName = options.instanceName || internalConfig.instanceName;
    }
    const instanceName = options.instanceName || `biz_${businessId.slice(-8)}`;
    const phone = options.phone || '919999999999';

    try {
      const response = await axios.post(
        `${options.baseUrl}/instance/create`,
        {
          instanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
          number: phone,
          rejectCall: false,
          groupsIgnore: true,
          alwaysOnline: true,
          readMessages: true,
          readStatus: true,
          syncFullHistory: false,
          webhook: options.webhookUrl ? {
            url: options.webhookUrl,
            webhookByEvents: true,
            events: [
              'QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT',
              'MESSAGES_UPDATE', 'SEND_MESSAGE', 'CONTACTS_UPSERT',
              'CHATS_UPSERT', 'CHATS_UPDATE', 'PRESENCE_UPDATE',
              'GROUPS_UPSERT', 'GROUP_UPDATE', 'GROUP_PARTICIPANTS_UPDATE',
            ],
          } : undefined,
        },
        {
          headers: { 'Content-Type': 'application/json', apikey: options.apiKey },
        }
      );

      await prisma.integration.upsert({
        where: { id: `evo_${businessId}` },
        create: {
          id: `evo_${businessId}`,
          businessId,
          type: 'evolution_api',
          name: 'Evolution API',
          config: {
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            instanceName,
            instanceId: response.data.instance?.id || '',
            status: 'created',
          },
          isActive: true,
        },
        update: {
          config: {
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            instanceName,
            instanceId: response.data.instance?.id || '',
            status: 'created',
          },
          isActive: true,
        },
      });

      return response.data;
    } catch (error: any) {
      const isAlreadyExists = error.response?.status === 403 && 
        (error.response?.data?.response?.message?.[0]?.includes('already in use') 
         || error.response?.data?.error === 'Forbidden');

      if (isAlreadyExists) {
        console.log('Evolution API instance already exists, saving config...');
        await prisma.integration.upsert({
          where: { id: `evo_${businessId}` },
          create: {
            id: `evo_${businessId}`,
            businessId,
            type: 'evolution_api',
            name: 'Evolution API',
            config: {
              baseUrl: options.baseUrl, apiKey: options.apiKey,
              instanceName, instanceId: '', status: 'exists',
            },
            isActive: true,
          },
          update: {
            config: {
              baseUrl: options.baseUrl, apiKey: options.apiKey,
              instanceName, instanceId: '', status: 'exists',
            },
            isActive: true,
          },
        });
        return { success: true, message: 'Instance already exists', instanceName };
      }

      console.error('Evolution API create instance error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to create Evolution API instance');
    }
  }

  /**
   * Extract QR code data from an Evolution API response.
   */
  private static extractQR(d: any): string {
    if (typeof d === 'string') return d;
    if (d?.base64) return d.base64;
    if (d?.qrcode?.base64Image) return d.qrcode.base64Image;
    if (d?.qrcode?.code) return d.qrcode.code;
    if (d?.code) return d.code;
    if (d?.pairingCode) return d.pairingCode;
    return '';
  }

  /**
   * Connect to Evolution API and get QR code.
   * 
   * Strategy (Evolution API v2 compatible):
   * 1. Delete any existing instance (cleanup, suppress errors)
   * 2. Wait 3 seconds for cleanup to propagate
   * 3. Create a fresh instance via POST /instance/create
   * 4. Wait 2 seconds for instance to initialize
   * 5. Get QR code via GET /instance/connect/:name (with retries)
   * 6. If connect returns no QR, try /instance/qrcode/:name as fallback
   * 
   * Accepts optional instanceName from frontend; falls back to configured name.
   */
  static async connectInstance(businessId: string, instanceName?: string, phone?: string, mobile = false): Promise<{
    qrCode: string;
    qrCodeBase64?: string;
    status: string;
    pairingCode?: string;
    pairingUnsupported?: boolean;
  }> {
    const config = await this.getConfig(businessId);
    const resolvedInstanceName = instanceName || config.instanceName;

    // Resolve phone number: explicit param > existing Integration config > default placeholder
    let resolvedPhone = phone || '';
    if (!resolvedPhone) {
      try {
        const existingIntegration = await prisma.integration.findFirst({
          where: { businessId, type: 'evolution_api' },
        });
        if (existingIntegration) {
          const existingConfig = existingIntegration.config as any;
          resolvedPhone = existingConfig.phone || '';
        }
      } catch (e: any) {
        console.warn('[Evolution] Could not resolve phone from existing integration:', e?.message || e);
      }
    }
    if (!resolvedPhone) {
      resolvedPhone = '919999999999'; // placeholder — user should update in settings
    }

    console.log(`[Evolution] === Starting connect for: ${resolvedInstanceName} ===`);

    // Step 1: Delete any existing instance (cleanup, suppress errors)
    try {
      await axios.delete(
        `${config.baseUrl}/instance/delete/${resolvedInstanceName}`,
        { headers: { apikey: config.apiKey }, timeout: 10000 }
      );
      console.log(`[Evolution] Deleted existing instance: ${resolvedInstanceName}`);
    } catch (e: any) {
      console.log(`[Evolution] Delete ${resolvedInstanceName} (may not exist): ${e?.response?.status || e.message}`);
    }

    // Also clean up any OTHER stale instances for this business
    try {
      const allInstances = await axios.get(
        `${config.baseUrl}/instance/fetchInstances`,
        { headers: { apikey: config.apiKey }, timeout: 10000 }
      );
      const staleInstances = (allInstances.data || []).filter((inst: any) => 
        inst.name !== resolvedInstanceName && 
        inst.connectionStatus !== 'open' &&
        inst._count?.Message === 0
      );
      for (const stale of staleInstances.slice(0, 5)) {
        try {
          await axios.delete(
            `${config.baseUrl}/instance/delete/${stale.name}`,
            { headers: { apikey: config.apiKey }, timeout: 5000 }
          );
          console.log(`[Evolution] Cleaned stale instance: ${stale.name}`);
        } catch (e: any) {
          console.warn(`[Evolution] Failed to clean stale instance ${stale.name}: ${e?.response?.status || e?.message}`);
        }
      }
    } catch (e: any) {
      console.warn('[Evolution] Stale-instance cleanup skipped:', e?.response?.status || e?.message);
    }

    // Step 2: Wait 3 seconds for cleanup to propagate
    console.log('[Evolution] Waiting 3s for cleanup...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Create fresh instance
    console.log(`[Evolution] Creating instance: ${resolvedInstanceName}`);
    let createResult: any;
    try {
      createResult = await axios.post(
        `${config.baseUrl}/instance/create`,
        {
          instanceName: resolvedInstanceName,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS',
          number: resolvedPhone,
          rejectCall: false, groupsIgnore: true,
          alwaysOnline: true, readMessages: true, readStatus: true,
          syncFullHistory: false,
        },
        {
          headers: { 'Content-Type': 'application/json', apikey: config.apiKey },
          timeout: 30000,
        }
      );
      console.log('[Evolution] Instance created successfully');
    } catch (createErr: any) {
      // If instance already exists, that's fine — continue to connect
      const status = createErr?.response?.status;
      if (status === 403 || status === 409) {
        console.log('[Evolution] Instance already exists, proceeding to connect...');
      } else {
        throw new Error(`Failed to create instance: ${createErr?.response?.data?.message || createErr.message}`);
      }
    }

    // Step 4: Wait 2 seconds for instance to initialize
    console.log('[Evolution] Waiting 2s for instance initialization...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 5: Get QR code via connect endpoint (with 2 retries)
    console.log(`[Evolution] Connecting instance: ${resolvedInstanceName}`);
    let connectResponse: any = null;
    let lastError: any = null;

    // On mobile we MUST use the pairing-code flow: a phone cannot scan a QR shown
    // on its own screen. A pairing code is requested with `?number=<phone>` on
    // GET /instance/connect/:name — Evolution then returns a top-level
    // `pairingCode` (e.g. "ABCD-EFGH") instead of (or alongside) the QR. This
    // requires the USER'S REAL WhatsApp number; the placeholder is NEVER sent as a
    // pairing number (that would bind the code to a fake number and trigger the
    // known `{"count":0}` bug). Desktop keeps the plain QR flow.
    const isPlaceholderPhone = (p: string) =>
      !p || p.replace(/\D/g, '') === '919999999999' || p.replace(/\D/g, '').length < 10;
    const pairingNumber =
      mobile && !isPlaceholderPhone(resolvedPhone) ? resolvedPhone.replace(/\D/g, '') : '';
    const connectUrl = pairingNumber
      ? `${config.baseUrl}/instance/connect/${resolvedInstanceName}?number=${encodeURIComponent(pairingNumber)}`
      : `${config.baseUrl}/instance/connect/${resolvedInstanceName}`;
    const connectCall = () =>
      axios.get(connectUrl, { headers: { apikey: config.apiKey }, timeout: 30000 });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        connectResponse = await connectCall();
        console.log(`[Evolution] Connect attempt ${attempt} succeeded`);
        break;
      } catch (err: any) {
        lastError = err;
        console.error(`[Evolution] Connect attempt ${attempt} failed:`, err?.response?.data || err.message);
        if (attempt < 3) {
          const waitTime = attempt * 2000;
          console.log(`[Evolution] Retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!connectResponse) {
      // Mobile-only safety net: if the pairing-code request failed (e.g. older
      // Evolution that doesn't support phone-number linking), fall back to a QR
      // so the modal still renders something the user can act on, instead of a
      // dead-end error. The UI flags this and tells the user to scan from
      // another device.
      if (mobile) {
        try {
          console.log('[Evolution] Pairing-code request failed; falling back to QR for mobile.');
          connectResponse = await axios.get(
            `${config.baseUrl}/instance/connect/${resolvedInstanceName}`,
            { headers: { apikey: config.apiKey }, timeout: 30000 }
          );
        } catch (fallbackErr: any) {
          console.error('[Evolution] Mobile QR fallback also failed:', fallbackErr?.response?.data || fallbackErr.message);
        }
      }
      if (!connectResponse) {
        throw new Error(
          `Failed to connect after 3 attempts: ${lastError?.response?.data?.message || lastError?.message || 'Unknown error'}`
        );
      }
    }

    const data = connectResponse?.data;
    console.log('[Evolution] Connect response:', JSON.stringify({ hasBase64: !!data?.base64, hasCode: !!data?.code, count: data?.count }).substring(0, 200));

    // Step 6: Extract QR (base64 image or raw "2@" QR string) and pairing code.
    // Evolution returns the human pairing code in `pairingCode` (e.g. "ABCD-EFGH")
    // when `?number=<phone>` is passed on the GET connect call; the QR lives in
    // `base64` or raw `code` (starts with "2@"). The pairing code is NOT base64,
    // so never treat it as a QR.
    const qrBase64 = data?.base64 || data?.qrcode?.base64Image || '';
    const rawQR =
      typeof data?.code === 'string' &&
      (data.code.startsWith('2@') || data.code.startsWith('iVBOR') || data.code.startsWith('data:'))
        ? data.code
        : '';
    const pairingCodeVal =
      typeof data?.pairingCode === 'string' &&
      /^[A-Z0-9]{4,8}-?[A-Z0-9]{4,8}$/i.test(data.pairingCode.trim())
        ? data.pairingCode.trim()
        : '';
    const qrCodeRaw = qrBase64 || rawQR;

    if (!qrCodeRaw && !pairingCodeVal) {
      // If connect returned { count: 0 }, try /instance/qrcode/:name as fallback
      if (data?.count === 0 || data?.count === undefined) {
        console.log('[Evolution] No QR from connect, trying qrcode fallback endpoint...');
        try {
          const qrResponse = await axios.get(
            `${config.baseUrl}/instance/qrcode/${resolvedInstanceName}`,
            { headers: { apikey: config.apiKey }, timeout: 15000 }
          );
          const fallbackQR = this.extractQR(qrResponse.data);
          if (fallbackQR) {
            console.log('[Evolution] QR fallback succeeded');
            await this.saveIntegrationConfig(businessId, config, resolvedInstanceName, qrResponse.data?.instance?.id || '');
            const isBase64Image = fallbackQR.startsWith('data:') || fallbackQR.startsWith('iVBOR');
            return { qrCode: fallbackQR, qrCodeBase64: isBase64Image ? fallbackQR : undefined, pairingCode: undefined, status: 'scanning', pairingUnsupported: mobile };
          }
        } catch (qrErr: any) {
          console.error('[Evolution] QR fallback also failed:', qrErr?.response?.data || qrErr.message);
        }
      }

      // Last resort: try waiting a bit and connecting again (QR may need time to generate)
      console.log('[Evolution] Final attempt: waiting 3s then retrying connect...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      try {
        const finalRes = await axios.get(
          `${config.baseUrl}/instance/connect/${resolvedInstanceName}`,
          { headers: { apikey: config.apiKey }, timeout: 30000 }
        );
        const finalQR = this.extractQR(finalRes.data);
        if (finalQR) {
          console.log('[Evolution] Final attempt succeeded!');
          await this.saveIntegrationConfig(businessId, config, resolvedInstanceName, finalRes.data?.instance?.id || '');
          const isBase64Image = finalQR.startsWith('data:') || finalQR.startsWith('iVBOR');
          return { qrCode: finalQR, qrCodeBase64: isBase64Image ? finalQR : undefined, pairingCode: undefined, status: 'scanning', pairingUnsupported: mobile };
        }
      } catch (finalErr: any) {
        console.error('[Evolution] Final attempt failed:', finalErr?.response?.data || finalErr.message);
      }

      throw new Error('No QR code returned from Evolution API. The instance may be stuck. Try refreshing after a few seconds.');
    }

    // Step 7: Save integration config to DB
    const instanceId = data?.instance?.id || createResult?.data?.instance?.id || '';
    await this.saveIntegrationConfig(businessId, config, resolvedInstanceName, instanceId, resolvedPhone);

    const isBase64Image =
      qrCodeRaw.startsWith('data:') || qrCodeRaw.startsWith('iVBOR') || qrCodeRaw.startsWith('2@');
    const isPairingCode = !!pairingCodeVal;
    console.log(`[Evolution] === Connect complete for: ${resolvedInstanceName} ===`);
    return {
      qrCode: qrCodeRaw,
      qrCodeBase64: isBase64Image ? qrCodeRaw : undefined,
      pairingCode: isPairingCode ? pairingCodeVal : undefined,
      status: 'scanning',
      pairingUnsupported: mobile && !isPairingCode,
    };
  }

  /**
   * Save Evolution API integration config to DB
   */
  private static async saveIntegrationConfig(
    businessId: string,
    config: { baseUrl: string; apiKey: string; instanceName: string },
    resolvedInstanceName: string,
    instanceId: string,
    phone?: string
  ): Promise<void> {
    await prisma.integration.upsert({
      where: { id: `evo_${businessId}` },
      create: {
        id: `evo_${businessId}`, businessId,
        type: 'evolution_api', name: 'Evolution API',
        config: {
          baseUrl: config.baseUrl, apiKey: config.apiKey,
          instanceName: resolvedInstanceName, instanceId,
          phone: phone || '',
          status: 'scanning',
        },
        isActive: true,
      },
      update: {
        config: {
          baseUrl: config.baseUrl, apiKey: config.apiKey,
          instanceName: resolvedInstanceName, instanceId,
          phone: phone || '',
          status: 'scanning',
        },
        isActive: true,
      },
    });
  }

  /**
   * Get connection status
   */
  static async getConnectionStatus(businessId: string): Promise<{
    status: 'disconnected' | 'scanning' | 'connected';
    phone?: string;
    profileName?: string;
    profilePicUrl?: string;
  }> {
    try {
      const config = await this.getConfig(businessId);

      // Try to check actual connection state from Evolution API
      try {
        const response = await axios.get(
          `${config.baseUrl}/instance/connectionState/${config.instanceName}`,
          { headers: { apikey: config.apiKey }, timeout: 10000 }
        );

        const state = response.data?.instance?.state || 'close';

        if (state === 'open') {
          let phone = '';
          let profileName = '';
          let profilePicUrl = '';

          try {
            const fetchRes = await axios.get(
              `${config.baseUrl}/instance/fetchInstances?instanceName=${config.instanceName}`,
              { headers: { apikey: config.apiKey }, timeout: 10000 }
            );
            const instanceData = Array.isArray(fetchRes.data) ? fetchRes.data[0] : fetchRes.data;
            phone = instanceData?.instance?.phone || instanceData?.phone || '';
            profileName = instanceData?.instance?.profileName || instanceData?.profileName || profileName;
          } catch (e: any) {
            console.warn(`[Evolution] Could not fetch instance details for ${config.instanceName}: ${e?.response?.status || e?.message}`);
          }

          try {
            const profileRes = await axios.post(
              `${config.baseUrl}/chat/fetchProfilePictureUrl/${config.instanceName}`,
              { number: '' },
              { headers: { apikey: config.apiKey }, timeout: 10000 }
            );
            profilePicUrl = profileRes.data?.profilePictureUrl || '';
          } catch (e: any) {
            console.warn(`[Evolution] Could not fetch profile picture for ${config.instanceName}: ${e?.response?.status || e?.message}`);
          }

          await this.updateStatus(businessId, 'connected');
          return { status: 'connected', phone, profileName, profilePicUrl };
        } else if (state === 'connecting' || state === 'pairing' || state === 'syncing') {
          return { status: 'scanning' };
        } else {
          return { status: 'disconnected' };
        }
      } catch (apiError: any) {
        // Evolution API unreachable or instance not found — fall back to DB cached status
        console.log(`[Evolution] Status check failed for ${config.instanceName}: ${apiError?.response?.status || apiError.message}`);

        // Read cached status from Integration config
        const integration = await prisma.integration.findFirst({
          where: { businessId, type: 'evolution_api' },
        });
        if (integration) {
          const cachedConfig = integration.config as any;
          const cachedStatus = cachedConfig?.status || 'disconnected';
          return { status: cachedStatus as any };
        }

        return { status: 'disconnected' };
      }
    } catch {
      return { status: 'disconnected' };
    }
  }

  /**
   * Disconnect / logout instance
   */
  static async disconnectInstance(businessId: string): Promise<void> {
    const config = await this.getConfig(businessId);
    try {
      await axios.delete(
        `${config.baseUrl}/instance/logout/${config.instanceName}`,
        { headers: { apikey: config.apiKey } }
      );
      await this.updateStatus(businessId, 'disconnected');
    } catch (error: any) {
      console.error('Evolution API disconnect error:', error.response?.data || error.message);
      throw new Error('Failed to disconnect instance');
    }
  }

  /**
   * Delete instance
   */
  static async deleteInstance(businessId: string): Promise<void> {
    const config = await this.getConfig(businessId);
    try {
      await axios.delete(
        `${config.baseUrl}/instance/delete/${config.instanceName}`,
        { headers: { apikey: config.apiKey } }
      );
      await prisma.integration.updateMany({
        where: { businessId, type: 'evolution_api' },
        data: { isActive: false },
      });
    } catch (error: any) {
      console.error('Evolution API delete error:', error.response?.data || error.message);
      throw new Error('Failed to delete instance');
    }
  }

  // ==================== ANTI-BAN SETTINGS ====================

  static async getAntiBanSettings(businessId: string): Promise<AntiBanSettings> {
    try {
      const integration = await prisma.integration.findFirst({ where: { businessId, type: 'evolution_api', isActive: true } });
      const config = (integration?.config as any) || {};
      return { ...DEFAULT_ANTI_BAN_SETTINGS, ...(config.antiBanSettings || {}) };
    } catch {
      return { ...DEFAULT_ANTI_BAN_SETTINGS };
    }
  }

  static async saveAntiBanSettings(businessId: string, settings: Partial<AntiBanSettings>): Promise<void> {
    const integration = await prisma.integration.findFirst({ where: { businessId, type: 'evolution_api', isActive: true } });
    if (!integration) return;
    const config = integration.config as any;
    config.antiBanSettings = { ...(config.antiBanSettings || {}), ...settings };
    await prisma.integration.update({ where: { id: integration.id }, data: { config } });
  }

  static async checkDailyLimit(businessId: string, settings: AntiBanSettings): Promise<boolean> {
    if (!settings.enabled || settings.maxMessagesPerDay <= 0) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const count = await prisma.message.count({
      where: { businessId, direction: 'outbound', createdAt: { gte: today } },
    });
    return count >= settings.maxMessagesPerDay;
  }

  // ==================== NUMBER ROTATION ====================

  // In-memory round-robin pointer per business. Losing it on restart is fine —
  // any start index distributes load the same way.
  private static rotationIndex = new Map<string, number>();

  private static nextRotationIndex(businessId: string, size: number): number {
    const cur = this.rotationIndex.get(businessId) ?? -1;
    const next = (cur + 1) % size;
    this.rotationIndex.set(businessId, next);
    return next;
  }

  static async getRotationSettings(businessId: string): Promise<RotationSettings> {
    try {
      const integration = await prisma.integration.findFirst({ where: { businessId, type: 'evolution_api', isActive: true } });
      const config = (integration?.config as any) || {};
      const pool = Array.isArray(config.rotationSettings?.pool) ? config.rotationSettings.pool : [];
      return { enabled: !!config.rotationSettings?.enabled, pool };
    } catch {
      return { ...DEFAULT_ROTATION_SETTINGS, pool: [] };
    }
  }

  static async saveRotationSettings(businessId: string, patch: Partial<RotationSettings>): Promise<void> {
    const integration = await prisma.integration.findFirst({ where: { businessId, type: 'evolution_api', isActive: true } });
    if (!integration) throw new Error('Evolution API not configured yet — connect first');
    const config = integration.config as any;
    config.rotationSettings = {
      ...(config.rotationSettings || {}),
      ...patch,
    };
    await prisma.integration.update({ where: { id: integration.id }, data: { config } });
  }

  /**
   * Resolve which instance should send the next message.
   * rotate=false (default) → primary instance (conversation replies, auto-replies).
   * rotate=true (campaigns/outreach) → round-robin across primary + pool.
   */
  private static async getSendTarget(businessId: string, rotate: boolean): Promise<{
    baseUrl: string; apiKey: string; instanceName: string;
  }> {
    const primary = await this.getConfig(businessId);
    if (!rotate) return primary;

    const rot = await this.getRotationSettings(businessId);
    const targets = [
      primary,
      ...rot.pool
        .filter((p) => p.instanceName)
        .map((p) => ({
          baseUrl: p.baseUrl || primary.baseUrl,
          apiKey: p.apiKey || primary.apiKey,
          instanceName: p.instanceName,
        })),
    ].filter((t) => t.baseUrl && t.apiKey && t.instanceName);

    if (targets.length <= 1) return primary;
    return targets[this.nextRotationIndex(businessId, targets.length)];
  }

  // ==================== MESSAGING ====================

  /**
   * Render a message template: {name}/{phone}/{business} + spintax variation.
   * Looks up the contact by phone so bulk campaigns get unique, personalized
   * messages (top anti-ban signal). Falls back to raw template on any failure.
   */
  private static async renderMessage(businessId: string, to: string, template: string): Promise<string> {
    try {
      const cleanPhone = to.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
      let name: string | null = null;
      if (!isGroupJid(to)) {
        const contact = await prisma.contact.findFirst({
          where: { businessId, phone: { in: [to, cleanPhone] } },
          select: { name: true },
        });
        name = contact?.name || null;
      }
      let businessName: string | null = null;
      const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
      businessName = business?.name || null;
      return spinAndPersonalize(template, { name, phone: cleanPhone, business: businessName });
    } catch {
      return template;
    }
  }

  /**
   * Send text message
   */
  static async sendText(
    businessId: string,
    to: string,
    message: string,
    options: { delay?: number; linkPreview?: boolean; applyAntiBan?: boolean; rotate?: boolean; contactId?: string } = {}
  ): Promise<any> {
    const config = await this.getSendTarget(businessId, options.rotate === true);
    const isGroup = isGroupJid(to);
    const formattedNumber = isGroup ? to : this.formatPhone(to);
    const idempotencyKey = crypto.randomUUID();
    const rendered = await this.renderMessage(businessId, to, message);

    if (options.applyAntiBan !== false) {
      const settings = await this.getAntiBanSettings(businessId);
      if (settings.enabled) {
        const baseDelay = isGroup ? settings.groupMessageDelayMs : settings.messageDelayMs;
        const jitter = settings.randomDelayMs > 0 ? Math.random() * settings.randomDelayMs : 0;
        await sleep(baseDelay + jitter);
      }
      if (await this.checkDailyLimit(businessId, settings)) {
        throw new Error('Daily message limit reached');
      }
    }

    try {
      const response = await circuitBreaker.execute(
        'evolution-api',
        () => axios.post(
          `${config.baseUrl}/message/sendText/${config.instanceName}`,
          { number: formattedNumber, text: rendered, delay: options.delay || 0, linkPreview: options.linkPreview ?? true, optionsId: idempotencyKey },
          { headers: { apikey: config.apiKey }, timeout: 15000 }
        ),
        { timeoutMs: 15000 }
      );

      await prisma.message.create({
        data: { businessId, contactId: options.contactId, direction: 'outbound', type: 'text', content: rendered, waMessageId: response.data?.key?.id, status: 'sent' },
      });
      await prisma.business.update({ where: { id: businessId }, data: { totalMessages: { increment: 1 } } });

      return response.data;
    } catch (error: any) {
      await prisma.message.create({
        data: { businessId, contactId: options.contactId, direction: 'outbound', type: 'text', content: rendered, status: 'failed', error: error.response?.data?.message || error.message },
      });
      throw error;
    }
  }

  /**
   * Send media message
   */
  static async sendMedia(
    businessId: string,
    to: string,
    mediaUrl: string,
    mediaType: 'image' | 'video' | 'document' | 'audio',
    caption?: string,
    options: { delay?: number; applyAntiBan?: boolean; rotate?: boolean } = {}
  ): Promise<any> {
    const config = await this.getSendTarget(businessId, options.rotate === true);
    const isGroup = isGroupJid(to);
    const formattedNumber = isGroup ? to : this.formatPhone(to);
    const renderedCaption = caption ? await this.renderMessage(businessId, to, caption) : caption;

    if (options.applyAntiBan !== false) {
      const settings = await this.getAntiBanSettings(businessId);
      if (settings.enabled) {
        const baseDelay = isGroup ? settings.groupMessageDelayMs : settings.messageDelayMs;
        const jitter = settings.randomDelayMs > 0 ? Math.random() * settings.randomDelayMs : 0;
        await sleep(baseDelay + jitter);
      }
      if (await this.checkDailyLimit(businessId, settings)) {
        throw new Error('Daily message limit reached');
      }
    }

    try {
      const response = await circuitBreaker.execute(
        'evolution-api',
        () => axios.post(
          `${config.baseUrl}/message/sendMedia/${config.instanceName}`,
          { number: formattedNumber, mediatype: mediaType, media: { url: mediaUrl }, delay: options.delay || 0, ...(renderedCaption ? { caption: renderedCaption } : {}) },
          { headers: { apikey: config.apiKey }, timeout: 15000 }
        ),
        { timeoutMs: 15000 }
      );

      await prisma.message.create({
        data: { businessId, direction: 'outbound', type: mediaType, content: renderedCaption || '', mediaUrl, mediaType, waMessageId: response.data?.key?.id, status: 'sent' },
      });
      await prisma.business.update({ where: { id: businessId }, data: { totalMessages: { increment: 1 } } });
      return response.data;
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Send template / button message
   */
  static async sendTemplate(
    businessId: string,
    to: string,
    template: {
      text: string;
      footer?: string;
      buttons: Array<{ type: 'reply' | 'url' | 'call'; title: string; url?: string; phone?: string }>;
    },
    options: { delay?: number; applyAntiBan?: boolean; rotate?: boolean } = {}
  ): Promise<any> {
    const config = await this.getSendTarget(businessId, options.rotate === true);
    const isGroup = isGroupJid(to);
    const formattedNumber = isGroup ? to : this.formatPhone(to);
    const renderedText = await this.renderMessage(businessId, to, template.text);

    if (options.applyAntiBan !== false) {
      const settings = await this.getAntiBanSettings(businessId);
      if (settings.enabled) {
        const baseDelay = isGroup ? settings.groupMessageDelayMs : settings.messageDelayMs;
        const jitter = settings.randomDelayMs > 0 ? Math.random() * settings.randomDelayMs : 0;
        await sleep(baseDelay + jitter);
      }
    }
try {
      const response = await circuitBreaker.execute(
        'evolution-api',
        () => axios.post(
          `${config.baseUrl}/message/sendButtons/${config.instanceName}`,
          {
            number: formattedNumber,
            text: renderedText,
            footer: template.footer || '',
            buttons: template.buttons.map((btn, i) => ({
              index: i + 1,
              type: btn.type === 'reply' ? 'replyButton' : btn.type === 'url' ? 'urlButton' : 'callButton',
              title: btn.title, ...(btn.url ? { url: btn.url } : {}), ...(btn.phone ? { phone: btn.phone } : {}),
            })),
            delay: options.delay || 0,
          },
          { headers: { apikey: config.apiKey }, timeout: 15000 }
        ),
        { timeoutMs: 15000 }
      );
      await prisma.message.create({
        data: { businessId, direction: 'outbound', type: 'template', content: renderedText, interactiveType: 'button', waMessageId: response.data?.key?.id, status: 'sent' },
      });
      return response.data;
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Bulk send messages with rate limiting.
   * Anti-ban: uses per-business settings (delay + group delay + jitter + daily
   * cap). Each queued message stores its per-message delay so the worker that
   * drains the queue sleeps between sends. The daily cap trims the batch.
   */
  static async bulkSend(
    businessId: string,
    messages: Array<{ to: string; type: 'text' | 'template'; content: string; templateData?: any; contactId?: string }>,
    options: { delayBetween?: number; campaignId?: string } = {}
  ): Promise<{ queued: number; estimatedTime: string; skippedDailyLimit: number }> {
    const { campaignId } = options;
    const settings = await this.getAntiBanSettings(businessId);

    // Effective per-message delay: explicit param wins, else anti-ban base + jitter
    const baseDelay = options.delayBetween ?? (settings.enabled ? settings.messageDelayMs : 2000);
    const jitter = settings.enabled ? settings.randomDelayMs : 0;

    // Daily cap: trim the batch so we never queue past the remaining allowance
    let batch = messages;
    let skippedDailyLimit = 0;
    if (settings.enabled && settings.maxMessagesPerDay > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sentToday = await prisma.message.count({
        where: { businessId, direction: 'outbound', createdAt: { gte: today } },
      });
      const remaining = Math.max(0, settings.maxMessagesPerDay - sentToday);
      if (batch.length > remaining) {
        skippedDailyLimit = batch.length - remaining;
        batch = batch.slice(0, remaining);
        console.log(`[Evolution] bulkSend: daily limit — queued ${batch.length}, skipped ${skippedDailyLimit}`);
      }
    }

    if (batch.length === 0) {
      return { queued: 0, estimatedTime: '0s', skippedDailyLimit };
    }

    const queued = await prisma.$transaction(
      batch.map((msg) => {
        const perMsgDelay = Math.round(baseDelay + (jitter > 0 ? Math.random() * jitter : 0));
        return prisma.message.create({
          data: { businessId, contactId: msg.contactId, campaignId, direction: 'outbound', type: msg.type, content: msg.content, status: 'queued', metadata: { provider: 'evolution_api', to: msg.to, templateData: msg.templateData, delayBetween: perMsgDelay, antiBan: settings.enabled, retryCount: 0, queuedAt: new Date().toISOString() } },
        });
      })
    );

    if (campaignId) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { totalSent: { increment: batch.length }, targetContacts: { increment: batch.length } },
      });
    }

    const totalSeconds = Math.ceil((batch.length * baseDelay) / 1000);
    const estimatedTime = totalSeconds < 60 ? `${totalSeconds}s` : `${Math.ceil(totalSeconds / 60)}m ${totalSeconds % 60}s`;

    return { queued: batch.length, estimatedTime, skippedDailyLimit };
  }

  // ==================== CONTACTS & CHATS ====================

  static async fetchChats(businessId: string): Promise<any[]> {
    const config = await this.getConfig(businessId);
    try {
      const response = await axios.post(`${config.baseUrl}/chat/findChats/${config.instanceName}`, {}, { headers: { apikey: config.apiKey } });
      return response.data || [];
    } catch { return []; }
  }

  static async fetchMessages(businessId: string, remoteJid: string, options: { limit?: number; offset?: number } = {}): Promise<any[]> {
    const config = await this.getConfig(businessId);
    try {
      const response = await axios.post(`${config.baseUrl}/chat/findMessages/${config.instanceName}`, { where: { key: { remoteJid } }, limit: options.limit || 50 }, { headers: { apikey: config.apiKey } });
      return response.data || [];
    } catch { return []; }
  }

  static async checkNumber(businessId: string, number: string): Promise<{ exists: boolean; jid: string }> {
    const config = await this.getConfig(businessId);
    try {
      const response = await axios.post(`${config.baseUrl}/chat/whatsappNumbers/${config.instanceName}`, { numbers: [number.replace(/\D/g, '')] }, { headers: { apikey: config.apiKey } });
      const result = response.data?.[0];
      return { exists: result?.exists || false, jid: result?.jid || '' };
    } catch { return { exists: false, jid: '' }; }
  }

  // ==================== WEBHOOK ====================

  static async processWebhook(businessId: string, payload: any): Promise<void> {
    const event = payload.event;
    switch (event) {
      case 'CONNECTION_UPDATE': {
        const state = payload.data?.status;
        if (state === 'open') await this.updateStatus(businessId, 'connected');
        else if (state === 'close') await this.updateStatus(businessId, 'disconnected');
        break;
      }
      case 'QRCODE_UPDATED': {
        await this.updateStatus(businessId, 'scanning');
        break;
      }
      case 'MESSAGES_UPSERT': {
        const msg = payload.data;
        if (msg.key?.fromMe) return;
        const from = msg.key?.remoteJid?.replace('@s.whatsapp.net', '') || '';
        const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
        if (!content && !msg.message?.imageMessage && !msg.message?.audioMessage) return;

        let contact = await prisma.contact.findFirst({ where: { businessId, phone: from } });
        if (!contact) {
          contact = await prisma.contact.create({
            data: { businessId, name: `WhatsApp ${from}`, phone: from, source: 'whatsapp', tags: ['WhatsApp Lead', 'Auto-Captured'], whatsappOptIn: true, lastActivity: new Date(), lastMessageAt: new Date() },
          });
          console.log(`[Evolution] New lead created: ${from}`);
          await prisma.activity.create({
            data: { businessId, contactId: contact.id, type: 'lead_captured', title: 'New lead from WhatsApp', content: 'Auto-captured from Evolution API message', metadata: { source: 'evolution', phone: from }, createdBy: 'system' },
          });
        } else {
          await prisma.contact.update({ where: { id: contact.id }, data: { lastMessageAt: new Date(), lastActivity: new Date() } });
        }

        const msgType = msg.message?.conversation || msg.message?.extendedTextMessage ? 'text' : msg.message?.imageMessage ? 'image' : msg.message?.videoMessage ? 'video' : msg.message?.audioMessage ? 'audio' : msg.message?.documentMessage ? 'document' : 'text';
        await prisma.message.create({ data: { businessId, contactId: contact.id, direction: 'inbound', type: msgType, content, waMessageId: msg.key?.id, status: 'received' } });

        // Flow builder: visual flows take priority over AI auto-reply
        if (content) {
          import('./whatsapp-flow-engine.service.js')
            .then(({ handleIncomingForFlows }) => handleIncomingForFlows(businessId, contact.id, from, content))
            .then((handled) => { if (!handled) return import('./ai-auto-reply.service.js').then(({ handleIncomingMessage }) => handleIncomingMessage(businessId, from, content, msg.key?.id)); })
            .catch((e) => console.warn('[Evolution] flow/auto-reply hook:', e?.message));
        }
        break;
      }
      case 'MESSAGES_UPDATE': {
        const statusData = payload.data;
        const waMessageId = statusData?.key?.id;
        const status = statusData?.status;
        if (waMessageId && status) {
          const statusMap: Record<string, string> = { '0': 'sent', '1': 'delivered', '2': 'read', '3': 'read' };
          await prisma.message.updateMany({ where: { waMessageId }, data: { status: statusMap[status] || status, statusTimestamp: new Date() } });
        }
        break;
      }
    }
  }

  // ==================== HELPERS ====================

  private static formatPhone(phone: string): string {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = `91${cleaned}`;
    return cleaned;
  }

  private static async updateStatus(businessId: string, status: string): Promise<void> {
    const integration = await prisma.integration.findFirst({ where: { businessId, type: 'evolution_api' } });
    if (integration) {
      const config = integration.config as any;
      await prisma.integration.update({ where: { id: integration.id }, data: { config: { ...config, status } } });
    }
  }

  static async saveConfig(businessId: string, config: { baseUrl: string; apiKey: string; instanceName?: string; phone?: string }): Promise<void> {
    await prisma.integration.upsert({
      where: { id: `evo_${businessId}` },
      create: { id: `evo_${businessId}`, businessId, type: 'evolution_api', name: 'Evolution API', config: { ...config, instanceName: config.instanceName || `biz_${businessId.slice(-8)}`, phone: config.phone || '', status: 'disconnected' }, isActive: true },
      update: { config: { ...config, instanceName: config.instanceName || `biz_${businessId.slice(-8)}`, phone: config.phone || '', status: 'disconnected' }, isActive: true },
    });
  }

  static async getPublicConfig(businessId: string): Promise<{ configured: boolean; status: string; instanceName: string; baseUrl: string; apiKey: string; phone: string }> {
    const integration = await prisma.integration.findFirst({ where: { businessId, type: 'evolution_api' } });
    if (integration) {
      const config = integration.config as any;
      return { configured: true, status: config.status || 'disconnected', instanceName: config.instanceName || '', baseUrl: config.baseUrl || '', apiKey: config.apiKey || '', phone: config.phone || '' };
    }
    const envBaseUrl = process.env.EVOLUTION_API_URL;
    const envApiKey = process.env.EVOLUTION_API_KEY;
    if (envBaseUrl && envApiKey) {
      return { configured: true, status: 'disconnected', instanceName: process.env.EVOLUTION_INSTANCE_NAME || `biz_${businessId.slice(-8)}`, baseUrl: envBaseUrl, apiKey: envApiKey, phone: '' };
    }
    return { configured: false, status: 'disconnected', instanceName: '', baseUrl: '', apiKey: '', phone: '' };
  }
}

export default EvolutionApiService;

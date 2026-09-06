import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { GBPAutoPostService } from '../services/gbp-auto-post.service.js';
import { GoogleBusinessApi, GBPQuotaError } from '../services/google-business-api.service.js';
import { exchangeGoogleToken } from '../services/google-oauth.service.js';
import { encrypt, decrypt } from '../utils/auth.js';
import axios from 'axios';

const router = Router();

// ── Single, deterministic redirect URI for the entire OAuth flow ──
// Previous dynamic derivation from `Host` / `x-forwarded-proto` headers was
// fragile: the /auth/url (AJAX) and /auth/callback (browser redirect) legs
// can arrive under different proxy hops, producing subtly different URIs.
// Google requires them to be BYTE-IDENTICAL or it returns `invalid_grant`.
// Using a fixed value here (with env-var override for dev) eliminates that
// class of bug entirely. Register the exact value in Google Cloud Console →
// Credentials → Authorized redirect URIs.
const GBP_REDIRECT_URI = (() => {
  const raw = process.env.GOOGLE_BUSINESS_REDIRECT_URL;
  // If the env var is a FULL URL (contains "://"), use it directly.
  if (raw && raw.includes('://')) return raw;
  // If it's a bare hostname (legacy), fall back to production default.
  return 'https://bizzautoai.com/api/google-business/auth/callback';
})();

// Google Business OAuth scopes
const GBP_SCOPES = [
  'https://www.googleapis.com/auth/business.manage',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

// Defensive redirect: never attempt to send a second response on a request
// whose headers were already flushed. A stray second res.redirect throws
// ERR_HTTP_HEADERS_SENT which nginx surfaces to the user as a 502 Bad Gateway.
// Always go through this instead of calling res.redirect directly.
function safeRedirect(res: Response, url: string): void {
  if (res.headersSent) {
    console.warn('[GBP] safeRedirect skipped — headers already sent');
    return;
  }
  res.redirect(url);
}

// ── Helper: Refresh expired GBP access token ──
// Returns:
//   - the fresh access token on success
//   - null when the business is simply not connected (no tokens)
//   - THROWS when the refresh token is DEAD (Google 401 invalid_grant). The
//     caller (getValidAccessToken) then clears the stored GBP tokens so the
//     UI flips to "Not Connected" and the user can re-connect with a fresh
//     OAuth flow. Previously a dead refresh token returned null and the app
//     looped forever: "Refreshing expired access token → 401 → null →
//     GOOGLE_BUSINESS_NOT_CONNECTED" while the DB kept the stale tokens.
async function refreshGBPToken(businessId: string): Promise<string | null> {
  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { gbpAccessToken: true, gbpRefreshToken: true, gbpTokenExpiry: true },
    });
    if (!business?.gbpAccessToken || !business?.gbpRefreshToken) return null;

    // Check if token is still valid (with 5 min buffer)
    if (business.gbpTokenExpiry && business.gbpTokenExpiry.getTime() > Date.now() + 5 * 60 * 1000) {
      return decrypt(business.gbpAccessToken);
    }

    // Token expired or about to expire — refresh it
    console.log('[GBP] Refreshing expired access token for business:', businessId);
    const refreshToken = decrypt(business.gbpRefreshToken);
    let tokenResponse: any;
    try {
      tokenResponse = await exchangeGoogleToken({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      const gErr = err?.response?.data ?? {};
      // A 401 with invalid_grant / bad_verification_code means the refresh
      // token is REVOKED or belongs to a different OAuth client. Retrying is
      // pointless — the only recovery is a fresh OAuth connect. Mark it dead:
      // drop the stored tokens so /status reports "not connected" and the
      // frontend shows the Connect button again. Fail fast instead of the
      // previous silent-null endless loop.
      if (status === 401 || (gErr.error === 'invalid_grant' || gErr.error === 'invalid_client')) {
        console.error('[GBP] Refresh token REVOKED/INVALID (401) — clearing stored GBP tokens for business:', businessId, JSON.stringify(gErr));
        await prisma.business
          .update({
            where: { id: businessId },
            data: {
              gbpAccessToken: null,
              gbpRefreshToken: null,
              gbpTokenExpiry: null,
              gbpAccountId: null,
              gbpLocationId: null,
            },
          })
          .catch((e) => console.warn('[GBP] failed to clear dead tokens:', e?.message));
        const deadErr = new Error('GBP_REFRESH_TOKEN_REVOKED');
        (deadErr as any).gbpCleared = true;
        throw deadErr;
      }
      console.warn('[GBP] refresh exchange failed (non-401, keeping tokens):', status, JSON.stringify(gErr));
      throw err;
    }

    const refreshData = tokenResponse?.access_token ? tokenResponse : tokenResponse?.data;
    const { access_token, expires_in } = refreshData;
    await prisma.business.update({
      where: { id: businessId },
      data: {
        gbpAccessToken: encrypt(access_token),
        gbpTokenExpiry: new Date(Date.now() + expires_in * 1000),
      },
    });
    console.log('[GBP] Token refreshed successfully');
    return access_token;
  } catch (err: any) {
    // Re-throw the "revoked" marker so getValidAccessToken can react; log
    // everything else as before but still surface it.
    if (err?.message === 'GBP_REFRESH_TOKEN_REVOKED') throw err;
    console.error('[GBP] Token refresh failed:', err?.message);
    return null;
  }
}

// ── Helper: Get valid access token (auto-refresh if needed) ──
async function getValidAccessToken(businessId: string): Promise<string> {
  const token = await refreshGBPToken(businessId);
  if (!token) throw new Error('GOOGLE_BUSINESS_NOT_CONNECTED');
  return token;
}

// ── Helper: Recover account/location enrichment ──
// The OAuth connect flow saves the access token FIRST and enriches
// account/location best-effort afterward (Google throttles the mybusiness
// APIs → 429). If that enrichment was throttled, gbpAccountId/locationId stay
// null and the reviews/posts features can't work. This helper recovers the
// enrichment on demand, returns a typed result (so the frontend / an explicit
// endpoint can surface the real Google error instead of failing silently), and
// persists what it finds.
interface GBPEnrichResult {
  ok: boolean;
  accountId: string | null;
  locationId: string | null;
  error?: string;
  status?: number;
}

/**
 * Rate-limit guard. Google throttles `mybusinessaccountmanagement.googleapis.com`
 * to a handful of requests PER MINUTE per project. The previous code fired this
 * enrichment on every /status poll; the frontend polls every ~15s plus reloads
 * plus manual "Sync now", which blew straight past that quota and locked us in a
 * permanent 429 loop (the connect banner never cleared because enrichment kept
 * failing). We fix it here at the source:
 *   1. Never call Google more than once per ENRICH_COOLDOWN_MS per business.
 *   2. Cache the last result so /status can report the *real* Google error
 *      without re-calling Google at all during the cooldown window.
 * This makes the retry cadence server-enforced and independent of how
 * aggressively the frontend polls.
 *
 * Enrichment is a ONE-TIME recovery: once it succeeds, gbpAccountId is saved and
 * /status stops firing it entirely. So a long cooldown costs nothing — we just
 * retry gently every 2 minutes until Google's quota window opens. Even a
 * freshly-lifted quota (project was TEST-mode, billing enabled, still warming
 * up) is never exceeded: max 2 calls (accounts + locations) per 2 min.
 */
const ENRICH_COOLDOWN_MS = 120_000;
const lastEnrichAttemptAt = new Map<string, number>();
const lastEnrichResult = new Map<string, { result: GBPEnrichResult; at: number }>();

function clearEnrichCache(businessId: string): void {
  lastEnrichAttemptAt.delete(businessId);
  lastEnrichResult.delete(businessId);
}

async function enrichGBPAccountIfMissing(businessId: string): Promise<GBPEnrichResult> {
  const result: GBPEnrichResult = { ok: false, accountId: null, locationId: null };
  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { gbpAccountId: true, gbpLocationId: true },
    });
    if (business?.gbpAccountId) {
      return { ok: true, accountId: business.gbpAccountId, locationId: business.gbpLocationId };
    }

    // COOLDOWN: if we already attempted (and cached a result) within the window,
    // return the cached outcome instead of hammering Google again. This is what
    // stops the 429 storm — even a misbehaving client can't exceed one call/min.
    const now = Date.now();
    const lastAt = lastEnrichAttemptAt.get(businessId) ?? 0;
    const cached = lastEnrichResult.get(businessId);
    if (cached && now - lastAt < ENRICH_COOLDOWN_MS) {
      return cached.result;
    }
    lastEnrichAttemptAt.set(businessId, now);

    // Obtain a VALID access token. The stored access token expires in ~1h; using
    // it raw after expiry returns a Google 401 ("invalid authentication
    // credentials"). getValidAccessToken is the ONLY path that refreshes an
    // expired token via the refresh token, so we MUST go through it here rather
    // than decrypting gbpAccessToken directly (the previous bug). It throws if
    // the business isn't connected or the refresh fails — that's caught below
    // and surfaced as the enrichment error.
    const accessToken = await getValidAccessToken(businessId);
    const accounts = await GoogleBusinessApi.getAccounts(accessToken);
    if (accounts.length === 0) {
      result.error = 'Google returned no Business Profile accounts for this Google account';
      lastEnrichResult.set(businessId, { result, at: now });
      return result;
    }

    const account = accounts[0];
    const accountId = account.name?.replace('accounts/', '') || account.accountId;
    let locationId: string | null = null;
    try {
      const locations = await GoogleBusinessApi.getLocations(accessToken, accountId);
      if (locations.length > 0) {
        locationId = locations[0].name?.replace(`accounts/${accountId}/locations/`, '') || locations[0].locationId;
      }
    } catch (locErr: unknown) {
      console.warn('[GBP] enrichment locations lookup failed (non-fatal):', getErrorMessage(locErr));
    }
    await prisma.business
      .update({ where: { id: businessId }, data: { gbpAccountId: accountId, gbpLocationId: locationId } })
      .catch((e: unknown) => console.warn('[GBP] enrichment save skipped (non-fatal):', getErrorMessage(e)));
    result.accountId = accountId;
    result.locationId = locationId;
    result.ok = true;
    lastEnrichResult.set(businessId, { result, at: now });
    console.log('[GBP] enrichment succeeded — accountId:', accountId, 'locationId:', locationId);
  } catch (err: unknown) {
    // Throttle/403/401: surface so the caller can explain it. Retried after the
    // cooldown window resets (next /status or /enrich call past the cooldown).
    const status = (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;
    result.status = status;
    result.error = getErrorMessage(err);
    const now = Date.now();
    lastEnrichAttemptAt.set(businessId, now);
    lastEnrichResult.set(businessId, { result, at: now });
    console.warn('[GBP] enrichment attempt failed:', status, result.error);
  }
  return result;
}

// Store OAuth state temporarily (in production, use Redis)
const oauthStates = new Map<string, { businessId: string; expiresAt: number }>();

// Lazy cleanup: purge expired states on each access instead of setInterval
function cleanupExpiredStates() {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (val.expiresAt < now) oauthStates.delete(key);
  }
}

/** Network error codes that mean "the server could not reach Google at all". */
const GBP_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN', // DNS lookup failed
  'ECONNREFUSED', // reachable but nothing listening (often a block)
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Walk an error tree and return the most specific low-level `code` we can find.
 * For an `AggregateError` (Node undici wraps all failed connection attempts in
 * one), we look at each inner error's `.code` / `.cause.code` — that is the real
 * signal: ENOTFOUND = DNS, ECONNREFUSED = firewall/block, ETIMEDOUT = dropped.
 */
function getErrorCode(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && e.code) return e.code;
  if (e.cause) {
    const causeCode = getErrorCode(e.cause);
    if (causeCode) return causeCode;
  }
  if (err instanceof AggregateError) {
    for (const inner of err.errors ?? []) {
      const innerCode = getErrorCode(inner);
      if (innerCode) return innerCode;
    }
  }
  return undefined;
}

/**
 * Return true if the error is a network-level failure (server could not reach
 * Google), as opposed to an HTTP/auth failure (4xx/5xx from Google).
 */
function isNetworkFailure(err: unknown): boolean {
  return GBP_NETWORK_CODES.has(getErrorCode(err) ?? '') || err instanceof AggregateError;
}

/**
 * Extract a human-readable message from any thrown value. GBP connect was
 * previously swallowing errors as `unknown` whenever the thrown value had no
 * `.message` (e.g. a string, a plain object, or an axios error without a
 * populated `.response.data.error_description`). This guarantees we always get
 * something actionable instead of a blank "unknown".
 *
 * Also unwraps `AggregateError` (Node undici's "All connection attempts failed"
 * wrapper) so we surface the underlying DNS/connection cause instead of a
 * useless "no message".
 */
function getErrorMessage(err: unknown): string {
  if (err == null) return 'Unknown error (no details)';
  if (typeof err === 'string') return err;

  // AggregateError: "All connection attempts failed" — unwrap to the real cause.
  if (err instanceof AggregateError) {
    const inner = (err.errors ?? [])
      .map((e) => getErrorMessage(e))
      .filter((m): m is string => !!m && m !== 'Unknown error (no details)');
    const code = getErrorCode(err);
    const detail = inner.length ? inner.join('; ') : err.message || 'no inner errors';
    return `AggregateError: ${detail}${code ? ` [code=${code}]` : ''}`;
  }

  if (err instanceof Error) {
    const code = getErrorCode(err);
    return code ? `${err.name}: ${err.message} (code: ${code})` : (err.message || `${err.name}: no message`);
  }

  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.error_description === 'string' && e.error_description) return e.error_description;
    if (typeof e.error === 'string' && e.error) return e.error;
    const code = typeof e.code === 'string' ? e.code : undefined;
    if (code) return `Error code: ${code}`;
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unparseable error object';
    }
  }
  return String(err);
}

// ── GET /api/google-business/auth/url — Generate OAuth URL ──
router.get('/auth/url', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = GBP_REDIRECT_URI;

    if (!clientId) {
      return res.status(500).json({ success: false, error: 'Google Client ID not configured' });
    }

    // Generate state token
    const state = Buffer.from(JSON.stringify({
      businessId: req.user.businessId,
      timestamp: Date.now(),
    })).toString('base64');

    cleanupExpiredStates();
    oauthStates.set(state, { businessId: req.user.businessId, expiresAt: Date.now() + 10 * 60 * 1000 });

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GBP_SCOPES);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    res.json({ success: true, data: { url: authUrl.toString() } });
  } catch (error: any) {
    console.error('GBP auth URL error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate auth URL' });
  }
});

// ── GET /api/google-business/auth/callback — OAuth Callback ──
// NOTE: every response goes through safeRedirect so a stray second response can
// never throw ERR_HTTP_HEADERS_SENT (which nginx surfaces as a 502). The connect
// flow is kept deliberately FAST: token exchange, then accounts, then a
// best-effort locations lookup — no slow userinfo round-trip. Retry budgets in
// google-business-api.service.ts are sized to keep the whole flow under nginx's
// 60s proxy_read_timeout.
router.get('/auth/callback', async (req: AuthRequest, res: Response) => {
  // Declared at handler scope (NOT inside try) so the catch block can reference
  // it when building the error redirect. A previous version declared it inside
  // the try block, which made `redirectUri` a ReferenceError in the catch path
  // — that produced the "invalid_grant → 502" symptom.
  const redirectUri = GBP_REDIRECT_URI;
  const frontendBase = process.env.FRONTEND_URL || 'https://bizzautoai.com';
  try {
    const { code, state, error } = req.query;

    if (error) {
      return safeRedirect(res, `${frontendBase}/google-business?error=${error}`);
    }

    if (!code || !state) {
      return safeRedirect(res, `${frontendBase}/google-business?error=missing_params`);
    }

    // Validate state - try Map first, then decode directly
    cleanupExpiredStates();
    let stateData = oauthStates.get(state as string);
    if (!stateData || stateData.expiresAt < Date.now()) {
      // Fallback: decode state directly (handles Docker restart / Map loss)
      try {
        const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString());
        if (decoded.businessId && decoded.timestamp && Date.now() - decoded.timestamp < 30 * 60 * 1000) {
          stateData = { businessId: decoded.businessId, expiresAt: Date.now() + 10 * 60 * 1000 };
          console.log('[GBP] State recovered from decoded token:', stateData.businessId);
        }
      } catch {}
    }
    if (!stateData) {
      return safeRedirect(res, `${frontendBase}/google-business?error=invalid_state`);
    }
    oauthStates.delete(state as string);

    // Exchange code for tokens (with retry/timeout on transient network failures)
    console.log('[GBP] Exchanging code for tokens — redirect_uri:', redirectUri, 'client_id:', process.env.GOOGLE_CLIENT_ID?.substring(0, 20) + '...');
    let tokenResponse: any;
    try {
      tokenResponse = await exchangeGoogleToken({
        code: code as string,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
    } catch (tokenErr: any) {
      const googleErr = tokenErr?.response?.data || {};
      console.error('[GBP] Token exchange FAILED:', {
        status: tokenErr?.response?.status,
        error: googleErr.error || getErrorMessage(tokenErr),
        error_description: googleErr.error_description,
        redirect_uri: redirectUri,
        code: (code as string)?.substring(0, 10) + '...',
      });
      // Re-throw so the outer catch handles the redirect
      throw tokenErr;
    }

    // Handle both formats: direct data or wrapped in .data
    const tokenData = tokenResponse?.access_token ? tokenResponse : tokenResponse?.data;
    if (!tokenData?.access_token) {
      // SECURITY: never stringify tokenResponse — partial logs can leak tokens.
      console.error('[GBP] Token exchange returned no access_token. Keys present:', Object.keys(tokenData || tokenResponse || {}));
      throw new Error('Token exchange failed: no access_token in response');
    }
    console.log('[GBP] Token exchange OK — has access_token:', !!tokenData.access_token, 'has refresh_token:', !!tokenData.refresh_token, 'expires_in:', tokenData.expires_in);
    const { access_token, refresh_token, expires_in } = tokenData;

    // SAVE THE TOKEN FIRST so the business is always connected — even if Google
    // throttles the downstream mybusiness calls (TEST-mode apps return 429
    // aggressively ~1 req/15s). A throttle on accounts/locations must NEVER fail
    // the connect. We enrich accountId/locationId best-effort afterwards and the
    // frontend retries enrichment once quota resets.
    console.log('[GBP] Saving token — businessId:', stateData.businessId);
    try {
      await prisma.business.update({
        where: { id: stateData.businessId },
        data: {
          gbpAccessToken: encrypt(access_token),
          gbpRefreshToken: refresh_token ? encrypt(refresh_token) : undefined,
          gbpTokenExpiry: new Date(Date.now() + expires_in * 1000),
        },
      });
    } catch (dbErr: unknown) {
      console.error('[GBP] DATABASE SAVE FAILED:', getErrorMessage(dbErr), (dbErr as { stack?: string })?.stack);
      return safeRedirect(res, `${frontendBase}/google-business?error=db_save_failed&msg=${encodeURIComponent(getErrorMessage(dbErr))}`);
    }

    // Best-effort account + location enrichment. Throttling/403/401 here is
    // NON-FATAL — the token is already saved above, so the user is connected.
    let accountId: string | null = null;
    let locationId: string | null = null;
    try {
      const accounts = await GoogleBusinessApi.getAccounts(access_token);
      if (accounts.length > 0) {
        const account = accounts[0];
        accountId = account.name?.replace('accounts/', '') || account.accountId;
        console.log('[GBP] Found account:', accountId, 'total accounts:', accounts.length);
        try {
          const locations = await GoogleBusinessApi.getLocations(access_token, accountId);
          if (locations.length > 0) {
            locationId = locations[0].name?.replace(`accounts/${accountId}/locations/`, '') || locations[0].locationId;
          }
        } catch (locErr: any) {
          console.warn('[GBP] locations lookup skipped (non-fatal):', locErr?.message);
        }
        await prisma.business
          .update({
            where: { id: stateData.businessId },
            data: { gbpAccountId: accountId, gbpLocationId: locationId },
          })
          .catch((e) => console.warn('[GBP] enrichment save skipped (non-fatal):', getErrorMessage(e)));
      } else {
        console.warn('[GBP] Google returned no accounts for this token');
      }
    } catch (apiErr: any) {
      const status = apiErr?.status ?? apiErr?.response?.status;
      console.warn(`[GBP] accounts lookup throttled/blocked (non-fatal, token already saved): ${status}`, getErrorMessage(apiErr));
    }

    console.log('[GBP] ✅ Connected (token saved). accountId:', accountId, 'locationId:', locationId);
    // Redirect to frontend with success — connect NEVER fails on Google throttling.
    return safeRedirect(res, `${frontendBase}/google-business?connected=true`);
  } catch (error: any) {
    console.error('[GBP] callback error:', getErrorMessage(error));
    console.error('[GBP] callback error code:', getErrorCode(error));
    console.error('[GBP] callback error stack:', error?.stack);
    console.error('[GBP] callback raw:', JSON.stringify(error, Object.getOwnPropertyNames(error || {}))?.substring(0, 1000));
    console.error('[GBP] callback query:', JSON.stringify(req.query));
    console.error('[GBP] callback env check:', {
      clientIdSet: !!process.env.GOOGLE_CLIENT_ID,
      clientSecretSet: !!process.env.GOOGLE_CLIENT_SECRET,
      redirectUrlSet: !!process.env.GOOGLE_BUSINESS_REDIRECT_URL,
      clientIdPrefix: process.env.GOOGLE_CLIENT_ID?.substring(0, 20),
    });
    if (error?.response?.status === 403) {
      safeRedirect(res, `${frontendBase}/google-business?error=api_not_enabled`);
    } else if (error?.response?.status === 401) {
      safeRedirect(res, `${frontendBase}/google-business?error=token_expired`);
    } else if (error?.response?.status === 400) {
      // Google returned Bad Request on the token exchange. Most common reasons:
      //  - invalid_grant / bad_verification_code → the OAuth code was already
      //    used or expired (happens when the user refreshes the callback URL).
      //  - redirect_uri_mismatch → the registered redirect URI doesn't match.
      const gErr: { error?: string; error_description?: string } = error?.response?.data || {};
      const reason = gErr.error || 'invalid_request';
      const desc = gErr.error_description || '';
      if (reason === 'invalid_grant' || reason === 'bad_verification_code') {
        // `invalid_grant` is AMBIGUOUS. It means ONE of:
        //   (a) code already used / expired (user refreshed the callback page), OR
        //   (b) redirect_uri mismatch between what we sent and what's registered, OR
        //   (c) the client_id / client_secret pair is wrong.
        // We surface the exact redirect_uri the server used so the user can compare
        // it against Google Cloud Console → Credentials → Authorized redirect URIs.
        const detail = `Google rejected the OAuth code (invalid_grant). Server used redirect_uri: ${redirectUri}. This usually means (1) you refreshed the page after Google redirected back — click Connect again WITHOUT refreshing, or (2) this redirect_uri is NOT registered in Google Cloud Console → APIs & Services → Credentials → OAuth Client → Authorized redirect URIs. Add it exactly (https, no www, no trailing slash) and retry.`;
        safeRedirect(res, `${frontendBase}/google-business?error=code_already_used&msg=${encodeURIComponent(detail)}`);
      } else if (reason === 'redirect_uri_mismatch') {
        safeRedirect(res, `${frontendBase}/google-business?error=redirect_mismatch&msg=${encodeURIComponent(`Google says the redirect URI doesn't match what's registered: ${desc}. Register this exact URI in Google Cloud Console: ${redirectUri}`)}`);
      } else {
        safeRedirect(res, `${frontendBase}/google-business?error=token_400&msg=${encodeURIComponent(`Google rejected the token request [${reason}]: ${desc}`)}`);
      }
    } else if (isNetworkFailure(error)) {
      // Server could NOT reach Google at all (DNS/connection). Surface a clear,
      // actionable message so the user knows this is infra, not their config.
      const errCode = getErrorCode(error) ?? 'UNKNOWN';
      const hintByCode: Record<string, string> = {
        ENOTFOUND: 'DNS lookup for oauth2.googleapis.com failed — the server cannot resolve Google hosts. Check the container DNS / network egress.',
        EAI_AGAIN: 'DNS lookup for Google hosts timed out — check the container DNS config.',
        ECONNREFUSED: 'Connection to Google was refused — an outbound firewall/proxy is likely blocking traffic. If the server requires a proxy for external calls, it must be wired into the GBP token exchange.',
        ETIMEDOUT: 'Connection to Google timed out — outbound traffic to Google is being dropped. Check firewall / egress rules.',
      };
      const hint = hintByCode[errCode] ?? 'The server could not establish a network connection to Google. Check the container network egress.';
      safeRedirect(res, `${frontendBase}/google-business?error=gbp_network_error&msg=${encodeURIComponent(`Network failure reaching Google [code=${errCode}]. ${hint}`)}`);
    } else {
      const msg = getErrorMessage(error);
      // If we STILL couldn't extract anything, send diagnostic context instead
      // of a blank "unknown" so the real cause is never lost.
      const fallbackMsg = !msg || msg === 'unknown'
        ? `Empty error object caught. query=${JSON.stringify(req.query)} clientId=${!!process.env.GOOGLE_CLIENT_ID} secret=${!!process.env.GOOGLE_CLIENT_SECRET}`
        : msg;
      safeRedirect(res, `${frontendBase}/google-business?error=callback_failed&msg=${encodeURIComponent(fallbackMsg)}`);
    }
  }
});

// ── GET /api/google-business/setup-check — Validate configuration ──
router.get('/setup-check', authenticate, async (req: AuthRequest, res: Response) => {
  const checks: Record<string, { ok: boolean; message: string; fix?: string }> = {};

  // 1. Check env vars
  const redirectUri = process.env.GOOGLE_BUSINESS_REDIRECT_URL || 'https://bizzautoai.com/api/google-business/auth/callback';
  const authRedirectUri = process.env.GOOGLE_AUTH_REDIRECT_URL || 'https://bizzautoai.com/api/auth/google/callback';
  checks.clientId = {
    ok: !!process.env.GOOGLE_CLIENT_ID,
    message: process.env.GOOGLE_CLIENT_ID ? `GOOGLE_CLIENT_ID is set (${process.env.GOOGLE_CLIENT_ID.substring(0, 20)}...)` : 'GOOGLE_CLIENT_ID is missing',
    fix: 'Set GOOGLE_CLIENT_ID in your .env file',
  };
  checks.clientSecret = {
    ok: !!process.env.GOOGLE_CLIENT_SECRET,
    message: process.env.GOOGLE_CLIENT_SECRET ? 'GOOGLE_CLIENT_SECRET is set' : 'GOOGLE_CLIENT_SECRET is missing',
    fix: 'Set GOOGLE_CLIENT_SECRET in your .env file',
  };
  checks.redirectUri = {
    ok: true,
    message: `Google Business redirect URI: ${redirectUri}`,
    fix: 'Make sure this EXACT URI is in Google Cloud Console → Credentials → OAuth 2.0 Client → Authorized redirect URIs',
  };
  checks.authRedirectUri = {
    ok: true,
    message: `Google Sign-In redirect URI: ${authRedirectUri}`,
    fix: 'Make sure this EXACT URI is also in Google Cloud Console → Authorized redirect URIs',
  };
  checks.jsOrigin = {
    ok: true,
    message: 'Authorized JavaScript origin should be: https://bizzautoai.com',
    fix: 'Add this to Google Cloud Console → Credentials → OAuth 2.0 Client → Authorized JavaScript origins',
  };

  // 2. Check if connected
  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: { gbpAccessToken: true, gbpRefreshToken: true, gbpAccountId: true, gbpLocationId: true, gbpTokenExpiry: true },
  });
  checks.connected = {
    ok: !!(business?.gbpAccessToken && business?.gbpAccountId),
    message: business?.gbpAccessToken ? 'Connected to Google Business' : 'Not connected',
  };
  checks.tokenValid = {
    ok: !!(business?.gbpTokenExpiry && business.gbpTokenExpiry.getTime() > Date.now()),
    message: business?.gbpTokenExpiry
      ? (business.gbpTokenExpiry.getTime() > Date.now() ? 'Token is valid' : 'Token expired (will auto-refresh)')
      : 'No token available',
  };
  checks.hasRefreshToken = {
    ok: !!business?.gbpRefreshToken,
    message: business?.gbpRefreshToken ? 'Refresh token available' : 'No refresh token (re-auth needed)',
  };

  // 3. If connected, test the API access
  if (business?.gbpAccessToken && business?.gbpAccountId) {
    try {
      const accessToken = await getValidAccessToken(req.user.businessId);
      await GoogleBusinessApi.getAccounts(accessToken);
      checks.apiAccess = { ok: true, message: 'Google Business Profile API access confirmed' };
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const isQuota = err instanceof GBPQuotaError;
      checks.apiAccess = {
        ok: false,
        message: status === 403
          ? 'API access denied (403) — APIs need approval from Google'
          : status === 401
            ? 'API authentication failed (401) — token invalid'
            : status === 429 || isQuota
              ? 'Google API rate limit hit (429) — app likely in TEST mode or billing not enabled'
              : `API error: ${status || err?.message}`,
        fix: status === 403
          ? 'Go to https://console.cloud.google.com → APIs & Services → Enable these APIs: Google Business Profile APIs (Business Information API, Reviews API, LocalPosts API). Then submit OAuth consent screen for verification.'
          : status === 429
            ? 'Enable Cloud Billing on the OAuth client project and publish/verify the OAuth consent screen. Google throttles TEST apps to ~1 req/15s.'
            : undefined,
      };
    }
  }

  const allOk = Object.values(checks).every(c => c.ok);
  res.json({ success: true, data: { allOk, checks } });
});

// Get Google Business connection status
router.get('/status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: {
        gbpAccessToken: true,
        gbpRefreshToken: true,
        gbpAccountId: true,
        gbpLocationId: true,
        gbpTokenExpiry: true,
        name: true,
      },
    });

    // A business is "connected" the moment Google returns a valid access token
    // and we persist it. The downstream account/location enrichment is BEST-EFFORT
    // (Google TEST-mode apps throttle the mybusiness APIs to ~1 req/15s and return
    // 429), so gbpAccountId/locationId may still be null even though the OAuth
    // connect SUCCEEDED. Requiring gbpAccountId here made /status report
    // "not connected" right after a successful connect, which is why the frontend
    // banner flipped back to "Not Connected". Tokens are still valid without the
    // enrichment, so treat a saved access token as connected.
    const isConnected = !!business?.gbpAccessToken;
    const needsEnrichment = isConnected && !business?.gbpAccountId;

    // Fire-and-forget: if the connect flow's best-effort enrichment was throttled
    // by Google, recover the account/location on a later /status poll. enrichment
    // enforces its own per-business cooldown (see enrichGBPAccountIfMissing), so
    // this is safe even under aggressive polling — it will simply return the
    // cached result instead of calling Google again during the cooldown window.
    // This must NOT block the status response — enrichment is optional.
    if (needsEnrichment) {
      void enrichGBPAccountIfMissing(req.user.businessId);
    }

    // Surface the most recent enrichment outcome (incl. the REAL Google error,
    // e.g. quota/429) so the UI can show a precise message instead of guessing.
    const cached = lastEnrichResult.get(req.user.businessId);
    const enrichError = cached?.result.ok ? null : cached?.result.error ?? null;
    const enrichStatus = cached?.result.ok ? null : cached?.result.status ?? null;

    res.json({
      success: true,
      data: {
        connected: isConnected,
        needsEnrichment,
        enrichError,
        enrichStatus,
        accountId: business?.gbpAccountId || null,
        locationId: business?.gbpLocationId || null,
        businessName: business?.name || null,
        hasRefreshToken: !!business?.gbpRefreshToken,
        tokenValid: business?.gbpTokenExpiry ? business.gbpTokenExpiry.getTime() > Date.now() : false,
      },
    });
  } catch (error: any) {
    console.error('GBP status error:', error);
    res.status(500).json({ success: false, error: 'Failed to get status', details: error.message });
  }
});

// Connect Google Business Profile
router.post('/connect', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { accessToken, accountId, locationId } = req.body;

    if (!accessToken || !accountId) {
      return res.status(400).json({
        success: false,
        error: 'accessToken and accountId are required',
      });
    }

    const { encrypt } = await import('../utils/auth.js');

    await prisma.business.update({
      where: { id: req.user.businessId },
      data: {
        gbpAccessToken: encrypt(accessToken),
        gbpAccountId: accountId,
        gbpLocationId: locationId || null,
      },
    });

    res.json({
      success: true,
      message: 'Google Business Profile connected successfully',
    });
  } catch (error: any) {
    console.error('GBP connect error:', error);
    res.status(500).json({ success: false, error: 'Failed to connect', details: error.message });
  }
});

// Disconnect Google Business Profile
router.post('/disconnect', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    clearEnrichCache(req.user.businessId);
    await prisma.business.update({
      where: { id: req.user.businessId },
      data: {
        gbpAccessToken: null,
        gbpRefreshToken: null,
        gbpTokenExpiry: null,
        gbpAccountId: null,
        gbpLocationId: null,
      },
    });

    res.json({
      success: true,
      message: 'Google Business Profile disconnected successfully',
    });
  } catch (error: any) {
    console.error('GBP disconnect error:', error);
    res.status(500).json({ success: false, error: 'Failed to disconnect', details: error.message });
  }
});

// Recover account/location enrichment on demand.
// The OAuth connect flow saves the token first and enriches best-effort, so a
// successful connect can still have a null gbpAccountId/locationId when Google
// TEST-mode throttles the mybusiness APIs (429). Features (reviews/posts) need
// both, so this lets the frontend explicitly retry the enrichment AFTER the
// throttle window clears, and surfaces the real Google error instead of failing
// silently. Returns the resulting account/location + status so the UI can show
// a precise message.
router.post('/enrich', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccessToken: true, gbpAccountId: true, gbpLocationId: true },
    });
    if (!business?.gbpAccessToken) {
      return res.status(400).json({ success: false, error: 'Google Business not connected' });
    }
    if (business.gbpAccountId) {
      return res.json({
        success: true,
        alreadyEnriched: true,
        data: { accountId: business.gbpAccountId, locationId: business.gbpLocationId },
      });
    }
    const enrichment = await enrichGBPAccountIfMissing(req.user.businessId);
    if (!enrichment.ok) {
      return res.status(424).json({
        success: false,
        error: enrichment.error || 'Enrichment failed',
        status: enrichment.status,
      });
    }
    return res.json({
      success: true,
      data: { accountId: enrichment.accountId, locationId: enrichment.locationId },
    });
  } catch (error: unknown) {
    console.error('[GBP] /enrich error:', getErrorMessage(error));
    res.status(500).json({ success: false, error: 'Failed to sync Business Profile', details: getErrorMessage(error) });
  }
});

// Get Google Business Profile locations
router.get('/locations', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccountId: true },
    });

    if (!business?.gbpAccountId) {
      return res.status(400).json({ success: false, error: 'Google Business not connected' });
    }

    const accessToken = await getValidAccessToken(req.user.businessId);

    const response = await axios.get(
      `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${business.gbpAccountId}/locations`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json({ success: true, data: response.data.locations || [] });
  } catch (error: any) {
    console.error('GBP locations fetch error:', error?.response?.status, error?.message);
    res.status(500).json({ success: false, error: 'Failed to fetch locations', details: error.message });
  }
});

// Get Google Business reviews
router.get('/reviews', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccountId: true, gbpLocationId: true },
    });

    if (!business?.gbpAccountId || !business?.gbpLocationId) {
      return res.status(400).json({ success: false, error: 'Google Business not connected. Please connect first.' });
    }

    const accessToken = await getValidAccessToken(req.user.businessId);

    // Reviews API — use v4 (v1 equivalent not available)
    const reviews = await GoogleBusinessApi.getReviews(
      accessToken,
      business.gbpAccountId,
      business.gbpLocationId
    );

    res.json({ success: true, data: reviews });
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    console.error('GBP reviews fetch error:', status, error?.message);
    if (error instanceof GBPQuotaError && status === 429) {
      res.status(429).json({ success: false, error: 'Google Business Profile API rate limit reached. Wait a moment and retry.' });
    } else if (status === 403) {
      res.status(400).json({ success: false, error: 'Google Business Profile API not enabled. Please enable APIs in Google Cloud Console.' });
    } else if (status === 401) {
      res.status(401).json({ success: false, error: 'Authentication expired. Please reconnect Google Business.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to fetch reviews', details: error.message });
    }
  }
});

// Reply to Google Business review
router.post('/reviews/:reviewId/reply', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { reply } = req.body;
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccountId: true, gbpLocationId: true },
    });

    if (!business?.gbpAccountId || !business?.gbpLocationId) {
      return res.status(400).json({ success: false, error: 'Google Business not connected' });
    }

    const accessToken = await getValidAccessToken(req.user.businessId);

    await axios.put(
      `https://mybusiness.googleapis.com/v4/accounts/${business.gbpAccountId}/locations/${business.gbpLocationId}/reviews/${req.params.reviewId}/reply`,
      { comment: reply },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    res.json({ success: true, message: 'Reply posted' });
  } catch (error: any) {
    console.error('GBP review reply error:', error?.response?.status, error?.response?.data || error?.message);
    const status = error?.response?.status;
    if (status === 403) {
      res.status(400).json({ success: false, error: 'API not enabled. Please enable Google Business Profile APIs in Cloud Console.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to post reply', details: error.message });
    }
  }
});

// Create Google Business post
router.post('/posts', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { content, mediaUrl, callToAction } = req.body;
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccountId: true, gbpLocationId: true },
    });

    if (!business?.gbpAccountId || !business?.gbpLocationId) {
      return res.status(400).json({ success: false, error: 'Google Business not connected' });
    }

    const accessToken = await getValidAccessToken(req.user.businessId);

    const postData: any = {
      languageCode: 'en',
      summary: content.substring(0, 200),
      state: 'LIVE',
    };

    if (mediaUrl) {
      postData.media = [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrl }];
    }

    if (callToAction) {
      postData.action = {
        actionType: callToAction.type,
        url: callToAction.url,
      };
    }

    const response = await axios.post(
      `https://mybusiness.googleapis.com/v4/accounts/${business.gbpAccountId}/locations/${business.gbpLocationId}/localPosts`,
      postData,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    res.json({ success: true, data: response.data });
  } catch (error: any) {
    console.error('GBP post creation error:', error?.response?.status, error?.response?.data || error?.message);
    const status = error?.response?.status;
    if (status === 403) {
      res.status(400).json({ success: false, error: 'API not enabled. Please enable Google Business Profile APIs in Cloud Console.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to create post', details: error.message });
    }
  }
});

// Get Google Business posts
router.get('/posts', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccountId: true, gbpLocationId: true },
    });

    if (!business?.gbpAccountId || !business?.gbpLocationId) {
      return res.status(400).json({ success: false, error: 'Google Business not connected' });
    }

    const accessToken = await getValidAccessToken(req.user.businessId);

    const posts = await GoogleBusinessApi.getPosts(
      accessToken,
      business.gbpAccountId,
      business.gbpLocationId
    );

    res.json({ success: true, data: posts });
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    console.error('GBP posts fetch error:', status, error?.message);
    if (error instanceof GBPQuotaError && status === 429) {
      res.status(429).json({ success: false, error: 'Google Business Profile API rate limit reached. Wait a moment and retry.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to fetch posts', details: error.message });
    }
  }
});

// Delete Google Business post
router.delete('/posts/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccountId: true, gbpLocationId: true },
    });

    if (!business?.gbpAccountId || !business?.gbpLocationId) {
      return res.status(400).json({ success: false, error: 'Google Business not connected' });
    }

    const accessToken = await getValidAccessToken(req.user.businessId);

    await axios.delete(
      `https://mybusiness.googleapis.com/v4/accounts/${business.gbpAccountId}/locations/${business.gbpLocationId}/localPosts/${req.params.id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (error: any) {
    console.error('GBP post delete error:', error?.response?.status, error?.message);
    res.status(500).json({ success: false, error: 'Failed to delete post', details: error.message });
  }
});

// Get Google Business statistics
router.get('/stats', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAccountId: true, gbpLocationId: true },
    });

    if (!business?.gbpAccountId || !business?.gbpLocationId) {
      return res.status(400).json({ success: false, error: 'Google Business not connected' });
    }

    const accessToken = await getValidAccessToken(req.user.businessId);

    const insights = await GoogleBusinessApi.getInsights(
      accessToken,
      business.gbpAccountId,
      business.gbpLocationId
    );

    res.json({ success: true, data: insights });
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    console.error('GBP stats fetch error:', status, error?.message);
    if (error instanceof GBPQuotaError && status === 429) {
      res.status(429).json({ success: false, error: 'Google Business Profile API rate limit reached. Wait a moment and retry.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to fetch statistics', details: error.message });
    }
  }
});

// ==================== AUTO-POST ENDPOINTS ====================

// Get auto-post configuration
router.get('/auto-post/config', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const config = await GBPAutoPostService.getConfig(req.user.businessId);
    res.json({ success: true, data: config });
  } catch (error: any) {
    console.error('GBP auto-post config error:', error);
    res.status(500).json({ success: false, error: 'Failed to get config', details: error.message });
  }
});

// Update auto-post configuration
router.put('/auto-post/config', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { enabled, time, timezone, days } = req.body;
    const config = await GBPAutoPostService.updateConfig(req.user.businessId, {
      enabled,
      time,
      timezone,
      days,
    });
    res.json({ success: true, data: config });
  } catch (error: any) {
    console.error('GBP auto-post config update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update config', details: error.message });
  }
});

// Get auto-post templates
router.get('/auto-post/templates', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const config = await GBPAutoPostService.getConfig(req.user.businessId);
    res.json({ success: true, data: config.templates });
  } catch (error: any) {
    console.error('GBP auto-post templates error:', error);
    res.status(500).json({ success: false, error: 'Failed to get templates', details: error.message });
  }
});

// Add auto-post template
router.post('/auto-post/templates', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, content, mediaUrl, callToAction, tags } = req.body;

    if (!name || !content) {
      return res.status(400).json({
        success: false,
        error: 'name and content are required',
      });
    }

    const template = await GBPAutoPostService.addTemplate(req.user.businessId, {
      name,
      content,
      mediaUrl,
      callToAction,
      tags,
    });

    res.json({ success: true, data: template });
  } catch (error: any) {
    console.error('GBP auto-post template add error:', error);
    res.status(500).json({ success: false, error: 'Failed to add template', details: error.message });
  }
});

// Update auto-post template
router.put('/auto-post/templates/:templateId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, content, mediaUrl, callToAction, tags } = req.body;
    const template = await GBPAutoPostService.updateTemplate(
      req.user.businessId,
      req.params.templateId,
      { name, content, mediaUrl, callToAction, tags }
    );
    res.json({ success: true, data: template });
  } catch (error: any) {
    console.error('GBP auto-post template update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update template', details: error.message });
  }
});

// Delete auto-post template
router.delete('/auto-post/templates/:templateId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await GBPAutoPostService.deleteTemplate(req.user.businessId, req.params.templateId);
    res.json({ success: true, message: 'Template deleted successfully' });
  } catch (error: any) {
    console.error('GBP auto-post template delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete template', details: error.message });
  }
});

// Manually trigger auto-post (for testing)
router.post('/auto-post/trigger', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await GBPAutoPostService.executeAutoPost(req.user.businessId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('GBP auto-post trigger error:', error);
    res.status(500).json({ success: false, error: 'Failed to trigger auto-post', details: error.message });
  }
});

// Get auto-post status
router.get('/auto-post/status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const config = await GBPAutoPostService.getConfig(req.user.businessId);
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { gbpAutoPostLastPosted: true },
    });

    res.json({
      success: true,
      data: {
        enabled: config.enabled,
        time: config.time,
        timezone: config.timezone,
        days: config.days,
        templatesCount: config.templates.length,
        lastPosted: business?.gbpAutoPostLastPosted || null,
      },
    });
  } catch (error: any) {
    console.error('GBP auto-post status error:', error);
    res.status(500).json({ success: false, error: 'Failed to get status', details: error.message });
  }
});

export default router;

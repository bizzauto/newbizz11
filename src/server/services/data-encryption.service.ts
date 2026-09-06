import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

/**
 * Data Encryption Service
 * Encrypts/decrypts sensitive customer data at rest
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 64;

// Use ENCRYPTION_KEY env var (same as auth.ts).
// In dev, persist to .encryption.key so encrypted data survives restarts.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || getDevEncryptionKey();

function getDevEncryptionKey(): string {
  const keyFile = path.resolve(process.cwd(), '.encryption.key');
  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, 'utf8').trim();
      if (existing.length === 64) {
        return existing;
      }
    }
  } catch (e: any) {
    // WARNING: failing to READ an existing key file is a data-loss risk —
    // a fresh key would make previously encrypted rows unreadable.
    console.error('[DataEncryption] CRITICAL: cannot read encryption key file:', keyFile, e?.message);
  }
  const newKey = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile, newKey, 'utf8');
  } catch (e: any) {
    // Without persistence every restart generates a NEW key → existing
    // encrypted data (phones/emails) becomes permanently undecryptable.
    console.error('[DataEncryption] CRITICAL: cannot persist dev encryption key — encrypted data WILL be unreadable after restart. Fix file permissions on:', keyFile, e?.message);
  }
  return newKey;
}

/**
 * Encrypt sensitive data (phone, email, address, etc.)
 */
export function encryptData(plaintext: string): string {
  if (!plaintext) return plaintext;
  
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  // Combine salt + iv + tag + encrypted data
  return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt sensitive data
 */
export function decryptData(ciphertext: string): string {
  if (!ciphertext || !ciphertext.includes(':')) return ciphertext;
  
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 4) return ciphertext;
    
    const [saltHex, ivHex, tagHex, encrypted] = parts;
    
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('[Encryption] Decryption failed:', error);
    return ciphertext; // Return as-is if decryption fails
  }
}

/**
 * Check if a value is encrypted
 */
export function isEncrypted(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && 
         parts.every(p => /^[a-f0-9]+$/.test(p)) &&
         parts[0].length === SALT_LENGTH * 2;
}

/**
 * Encrypt sensitive fields in an object
 */
export function encryptFields(obj: any, fields: string[]): any {
  if (!obj || typeof obj !== 'object') return obj;
  
  const encrypted = { ...obj };
  
  for (const field of fields) {
    if (encrypted[field] && typeof encrypted[field] === 'string' && !isEncrypted(encrypted[field])) {
      encrypted[field] = encryptData(encrypted[field]);
    }
  }
  
  return encrypted;
}

/**
 * Decrypt sensitive fields in an object
 */
export function decryptFields(obj: any, fields: string[]): any {
  if (!obj || typeof obj !== 'object') return obj;
  
  const decrypted = { ...obj };
  
  for (const field of fields) {
    if (decrypted[field] && typeof decrypted[field] === 'string' && isEncrypted(decrypted[field])) {
      decrypted[field] = decryptData(decrypted[field]);
    }
  }
  
  return decrypted;
}

// Sensitive fields that should be encrypted in the database
export const SENSITIVE_CONTACT_FIELDS = ['phone', 'email'];
export const SENSITIVE_ORDER_FIELDS = ['gatewayData'];
export const SENSITIVE_ADDRESS_FIELDS = ['phone', 'address'];

/**
 * Hash sensitive data for comparison (one-way)
 */
export function hashData(data: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(data, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify hashed data
 */
export function verifyHash(data: string, hashed: string): boolean {
  const [salt, hash] = hashed.split(':');
  const verifyHash = crypto.scryptSync(data, salt, 64).toString('hex');
  return hash === verifyHash;
}

/**
 * Generate a secure token for GDPR data export
 */
export function generateExportToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Sanitize phone number for storage (keep only digits)
 */
export function sanitizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate Indian phone number
 */
export function isValidIndianPhone(phone: string): boolean {
  const cleaned = phone.replace(/\D/g, '');
  return /^[6-9]\d{9}$/.test(cleaned);
}
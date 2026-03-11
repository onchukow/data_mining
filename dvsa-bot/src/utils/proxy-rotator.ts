import { createChildLogger } from './logger';
import { settings } from '../config/settings';

const log = createChildLogger('proxy-rotator');

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Manages proxy rotation for browser sessions.
 * Supports residential and mobile proxy providers.
 * Sticky session: 5-10 minutes per IP.
 * Auto-rotate on 403/429 responses.
 */
export class ProxyRotator {
  private currentProxy: ProxyConfig | null = null;
  private lastRotation: number = 0;
  private stickyDurationMs: number;
  private errorCount: number = 0;

  constructor(stickyDurationMs: number = 5 * 60 * 1000) {
    this.stickyDurationMs = stickyDurationMs;
  }

  /**
   * Get the current proxy config for Playwright.
   * Returns undefined if no proxy is configured.
   */
  getProxy(): ProxyConfig | undefined {
    const proxyUrl = settings.proxy.url;
    if (!proxyUrl) {
      return undefined;
    }

    const now = Date.now();
    const elapsed = now - this.lastRotation;

    // Rotate if sticky session expired or too many errors
    if (!this.currentProxy || elapsed > this.stickyDurationMs || this.errorCount >= 3) {
      this.currentProxy = this.parseProxyUrl(proxyUrl);
      this.lastRotation = now;
      this.errorCount = 0;
      log.info({ proxyServer: this.currentProxy.server }, 'Proxy rotated');
    }

    return this.currentProxy;
  }

  /**
   * Report an error — triggers rotation after threshold.
   */
  reportError(statusCode?: number): void {
    this.errorCount++;
    if (statusCode === 403 || statusCode === 429) {
      log.warn({ statusCode, errorCount: this.errorCount }, 'Rate limited, forcing proxy rotation');
      this.forceRotate();
    }
  }

  /**
   * Force immediate proxy rotation.
   */
  forceRotate(): void {
    this.currentProxy = null;
    this.errorCount = 0;
    this.lastRotation = 0;
    log.info('Forced proxy rotation');
  }

  private parseProxyUrl(url: string): ProxyConfig {
    try {
      const parsed = new URL(url);
      const config: ProxyConfig = {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
      };
      if (parsed.username) {
        // For sticky sessions, some providers use session ID in username
        // Append random session suffix for rotation
        const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        config.username = parsed.username.includes('session-')
          ? parsed.username
          : `${parsed.username}-${sessionId}`;
        config.password = parsed.password || undefined;
      }
      return config;
    } catch {
      // Fallback: treat as plain server string
      return { server: url };
    }
  }
}

// Singleton instance
export const proxyRotator = new ProxyRotator();

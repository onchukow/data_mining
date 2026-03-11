import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { settings } from '../config/settings';
import { proxyRotator } from '../utils/proxy-rotator';
import { generateFingerprint, getStealthScripts } from '../utils/fingerprint';
import { withRetry } from '../utils/retry';
import fs from 'fs';
import path from 'path';

const log = createChildLogger('playwright-session');

export class PlaywrightSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sessionStartTime: number = 0;
  private screenshotCounter: number = 0;

  async init(): Promise<Page> {
    const fingerprint = generateFingerprint();
    const proxy = proxyRotator.getProxy();

    log.info({ fingerprint: { userAgent: fingerprint.userAgent, viewport: fingerprint.viewport }, hasProxy: !!proxy }, 'Initializing browser session');

    const launchOptions: Record<string, unknown> = {
      headless: process.env.NODE_ENV === 'production',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
      ],
    };

    if (proxy) {
      launchOptions.proxy = {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      };
    }

    this.browser = await chromium.launch(launchOptions);

    this.context = await this.browser.newContext({
      userAgent: fingerprint.userAgent,
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      colorScheme: fingerprint.colorScheme,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      geolocation: { latitude: 51.5074, longitude: -0.1278 }, // London
      permissions: ['geolocation'],
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
    });

    this.page = await this.context.newPage();

    // Inject stealth scripts before any navigation
    await this.page.addInitScript(getStealthScripts());

    // Set session start time
    this.sessionStartTime = Date.now();

    // Ensure screenshot directory exists
    const screenshotDir = settings.logging.screenshotDir;
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    log.info('Browser session initialized');
    return this.page;
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('Browser session not initialized. Call init() first.');
    }
    return this.page;
  }

  /**
   * Check if the session has expired (DVSA timeout ~20 min).
   */
  isSessionExpired(): boolean {
    if (!this.sessionStartTime) return true;
    return Date.now() - this.sessionStartTime > settings.session.timeoutMs;
  }

  /**
   * Take a screenshot for debugging.
   */
  async screenshot(label: string): Promise<string> {
    if (!this.page) return '';

    this.screenshotCounter++;
    const filename = `${this.screenshotCounter.toString().padStart(4, '0')}_${label}_${Date.now()}.png`;
    const filepath = path.join(settings.logging.screenshotDir, filename);

    try {
      await this.page.screenshot({ path: filepath, fullPage: true });
      log.debug({ filepath, label }, 'Screenshot saved');
      return filepath;
    } catch (error) {
      log.error({ error, label }, 'Failed to take screenshot');
      return '';
    }
  }

  /**
   * Navigate to URL with retry and Cloudflare handling.
   */
  async navigateTo(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void> {
    if (!this.page) throw new Error('Session not initialized');

    await withRetry(async () => {
      const response = await this.page!.goto(url, {
        waitUntil: options?.waitUntil ?? 'domcontentloaded',
        timeout: 30000,
      });

      if (response) {
        const status = response.status();
        if (status === 403 || status === 429) {
          proxyRotator.reportError(status);
          throw new Error(`HTTP ${status} - possible rate limit or block`);
        }
      }

      // Check for Cloudflare challenge
      const isChallenge = await this.detectCloudflareChallenge();
      if (isChallenge) {
        log.warn({ url }, 'Cloudflare challenge detected, waiting...');
        await this.screenshot('cloudflare_challenge');
        // Wait for challenge to resolve (Turnstile auto-solve or manual)
        await this.page!.waitForNavigation({ timeout: 60000 }).catch(() => {});
        // Re-check
        const stillChallenge = await this.detectCloudflareChallenge();
        if (stillChallenge) {
          throw new Error('Cloudflare challenge not resolved');
        }
      }

      await this.screenshot(`navigate_${url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50)}`);
    }, { maxRetries: 2, baseDelayMs: 3000, multiplier: 2 });
  }

  /**
   * Detect if current page is a Cloudflare challenge.
   */
  private async detectCloudflareChallenge(): Promise<boolean> {
    if (!this.page) return false;
    try {
      const title = await this.page.title();
      const content = await this.page.content();
      return title.includes('Just a moment') ||
        content.includes('cf-challenge') ||
        content.includes('cf_chl_opt') ||
        content.includes('turnstile');
    } catch {
      return false;
    }
  }

  /**
   * Wait for an element using accessible selectors (resilient to DOM changes).
   */
  async waitForElement(selector: string, options?: { timeout?: number; state?: 'visible' | 'attached' }): Promise<void> {
    if (!this.page) throw new Error('Session not initialized');
    await this.page.waitForSelector(selector, {
      timeout: options?.timeout ?? 15000,
      state: options?.state ?? 'visible',
    });
  }

  /**
   * Click using text-based selector (resilient to DOM changes).
   */
  async clickByText(text: string, options?: { exact?: boolean }): Promise<void> {
    if (!this.page) throw new Error('Session not initialized');
    await this.page.getByText(text, { exact: options?.exact ?? false }).click();
  }

  /**
   * Click using role-based selector.
   */
  async clickByRole(role: 'button' | 'link' | 'checkbox' | 'radio', name: string): Promise<void> {
    if (!this.page) throw new Error('Session not initialized');
    await this.page.getByRole(role, { name }).click();
  }

  /**
   * Fill input by label text (GOV.UK forms use labels extensively).
   */
  async fillByLabel(label: string, value: string): Promise<void> {
    if (!this.page) throw new Error('Session not initialized');
    await this.page.getByLabel(label).fill(value);
  }

  /**
   * Restart the browser session (for session expiry or errors).
   */
  async restart(): Promise<Page> {
    log.info('Restarting browser session');
    await this.close();
    return this.init();
  }

  /**
   * Close the browser and clean up.
   */
  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.page = null;
      this.sessionStartTime = 0;
      log.info('Browser session closed');
    } catch (error) {
      log.error({ error }, 'Error closing browser session');
    }
  }
}

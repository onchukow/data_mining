import { Page } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { settings } from '../config/settings';
import { withRetry } from '../utils/retry';

const log = createChildLogger('captcha-solver');

interface CaptchaSolution {
  token: string;
  taskId: string;
}

/**
 * Handles CAPTCHA solving for Cloudflare Turnstile challenges.
 * Integrates with 2captcha or capsolver APIs.
 */
export class CaptchaSolver {
  private apiKey: string;
  private service: '2captcha' | 'capsolver';

  constructor() {
    this.apiKey = settings.captcha.apiKey;
    this.service = settings.captcha.service;
  }

  /**
   * Detect and solve Turnstile CAPTCHA on the current page.
   */
  async solveTurnstile(page: Page, siteUrl: string): Promise<string | null> {
    if (!this.apiKey) {
      log.warn('No CAPTCHA API key configured, skipping solve');
      return null;
    }

    // Find Turnstile site key from page
    const siteKey = await this.extractTurnstileSiteKey(page);
    if (!siteKey) {
      log.info('No Turnstile CAPTCHA detected on page');
      return null;
    }

    log.info({ siteKey, siteUrl, service: this.service }, 'Solving Turnstile CAPTCHA');

    try {
      const solution = await withRetry(
        () => this.requestSolution(siteKey, siteUrl),
        { maxRetries: 2, baseDelayMs: 5000, multiplier: 2 }
      );

      // Inject the token into the page
      await page.evaluate((token) => {
        const turnstileCallback = (window as Record<string, unknown>).turnstileCallback as ((token: string) => void) | undefined;
        if (turnstileCallback) {
          turnstileCallback(token);
        }

        // Also try setting the response input
        const inputs = document.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]');
        inputs.forEach(input => {
          input.value = token;
        });
      }, solution.token);

      log.info({ taskId: solution.taskId }, 'Turnstile CAPTCHA solved');
      return solution.token;
    } catch (error) {
      log.error({ error }, 'Failed to solve Turnstile CAPTCHA');
      return null;
    }
  }

  private async extractTurnstileSiteKey(page: Page): Promise<string | null> {
    try {
      return await page.evaluate(() => {
        // Look for Turnstile widget
        const widget = document.querySelector('[data-sitekey]');
        if (widget) {
          return widget.getAttribute('data-sitekey');
        }

        // Look in script tags
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const match = script.textContent?.match(/sitekey['":\s]+(['"]([\w-]+)['"])/);
          if (match) return match[2];
        }

        return null;
      });
    } catch {
      return null;
    }
  }

  private async requestSolution(siteKey: string, siteUrl: string): Promise<CaptchaSolution> {
    if (this.service === '2captcha') {
      return this.solve2Captcha(siteKey, siteUrl);
    }
    return this.solveCapsolver(siteKey, siteUrl);
  }

  private async solve2Captcha(siteKey: string, siteUrl: string): Promise<CaptchaSolution> {
    // Submit task
    const createResponse = await fetch('https://2captcha.com/in.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        key: this.apiKey,
        method: 'turnstile',
        sitekey: siteKey,
        pageurl: siteUrl,
        json: '1',
      }),
    });

    const createResult = await createResponse.json() as { status: number; request: string };
    if (createResult.status !== 1) {
      throw new Error(`2captcha create task failed: ${createResult.request}`);
    }

    const taskId = createResult.request;
    log.info({ taskId }, '2captcha task created, polling for result...');

    // Poll for result (max 120 seconds)
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const resultResponse = await fetch(
        `https://2captcha.com/res.php?key=${this.apiKey}&action=get&id=${taskId}&json=1`
      );
      const result = await resultResponse.json() as { status: number; request: string };

      if (result.status === 1) {
        return { token: result.request, taskId };
      }

      if (result.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2captcha error: ${result.request}`);
      }
    }

    throw new Error('2captcha timeout: solution not ready after 120 seconds');
  }

  private async solveCapsolver(siteKey: string, siteUrl: string): Promise<CaptchaSolution> {
    // Submit task
    const createResponse = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: this.apiKey,
        task: {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: siteUrl,
          websiteKey: siteKey,
        },
      }),
    });

    const createResult = await createResponse.json() as { errorId: number; taskId: string; errorDescription?: string };
    if (createResult.errorId !== 0) {
      throw new Error(`Capsolver create task failed: ${createResult.errorDescription}`);
    }

    const taskId = createResult.taskId;
    log.info({ taskId }, 'Capsolver task created, polling for result...');

    // Poll for result
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const resultResponse = await fetch('https://api.capsolver.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: this.apiKey,
          taskId,
        }),
      });

      const result = await resultResponse.json() as { status: string; solution?: { token: string }; errorDescription?: string };

      if (result.status === 'ready' && result.solution) {
        return { token: result.solution.token, taskId };
      }

      if (result.status !== 'processing') {
        throw new Error(`Capsolver error: ${result.errorDescription ?? result.status}`);
      }
    }

    throw new Error('Capsolver timeout: solution not ready after 120 seconds');
  }
}

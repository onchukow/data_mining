import { Page } from 'playwright';
import { createChildLogger } from '../utils/logger';
import { PlaywrightSession } from './playwright-session';

const log = createChildLogger('payment-handler');

export type PaymentMode = 'manual' | 'semi_auto';

export interface PaymentResult {
  success: boolean;
  confirmationRef?: string;
  screenshotPath?: string;
  error?: string;
  requiresManualAction: boolean;
}

/**
 * Handles the GOV.UK Pay payment flow.
 *
 * Strategy: SEMI-AUTOMATIC payment.
 * 1. Bot fills everything up to the payment page
 * 2. Takes screenshot and notifies user via Telegram
 * 3. User completes payment manually (3D Secure requires human interaction)
 * 4. Bot monitors for confirmation page
 *
 * Full automation of payment is NOT recommended due to:
 * - 3D Secure requiring biometric/app-based verification
 * - Bank fraud detection systems
 * - Legal/ToS implications
 */
export class PaymentHandler {
  private session: PlaywrightSession;

  constructor(session: PlaywrightSession) {
    this.session = session;
  }

  /**
   * Handle the payment page — capture details and wait for manual completion.
   */
  async handlePayment(page: Page): Promise<PaymentResult> {
    log.info('Payment page reached');

    // Take screenshot of payment page
    const screenshotPath = await this.session.screenshot('payment_page');

    // Extract payment page URL for deep link
    const paymentUrl = page.url();
    log.info({ paymentUrl }, 'Payment URL captured');

    // Determine the amount
    const amount = await this.extractAmount(page);
    log.info({ amount }, 'Payment amount detected');

    return {
      success: false,
      screenshotPath,
      requiresManualAction: true,
      error: 'Payment requires manual completion',
    };
  }

  /**
   * Wait for payment confirmation after manual completion.
   * Monitors the page for up to 10 minutes.
   */
  async waitForConfirmation(page: Page, timeoutMs: number = 600000): Promise<PaymentResult> {
    log.info({ timeoutMs }, 'Waiting for payment confirmation...');

    try {
      // Wait for the confirmation page — GOV.UK shows "Booking confirmed" or similar
      await page.waitForFunction(
        () => {
          const body = document.body?.textContent?.toLowerCase() ?? '';
          return body.includes('booking confirmed') ||
            body.includes('booking complete') ||
            body.includes('confirmation') ||
            body.includes('reference number');
        },
        { timeout: timeoutMs, polling: 5000 }
      );

      const screenshotPath = await this.session.screenshot('payment_confirmed');

      // Extract confirmation reference
      const confirmationRef = await this.extractConfirmationRef(page);

      log.info({ confirmationRef }, 'Payment confirmed');

      return {
        success: true,
        confirmationRef,
        screenshotPath,
        requiresManualAction: false,
      };
    } catch {
      const screenshotPath = await this.session.screenshot('payment_timeout');
      log.warn('Payment confirmation timeout');

      return {
        success: false,
        screenshotPath,
        requiresManualAction: true,
        error: 'Payment confirmation timeout — check manually',
      };
    }
  }

  /**
   * Detect if current page is a payment page.
   */
  async isPaymentPage(page: Page): Promise<boolean> {
    try {
      const url = page.url();
      const content = await page.content();
      return url.includes('payments.service.gov.uk') ||
        content.includes('Enter card details') ||
        content.includes('card-no') ||
        content.includes('Card number');
    } catch {
      return false;
    }
  }

  private async extractAmount(page: Page): Promise<string> {
    try {
      return await page.evaluate(() => {
        // GOV.UK Pay shows amount prominently
        const amountEl = document.querySelector('.payment-summary__amount, .govuk-payment-summary__amount, [data-testid="amount"]');
        if (amountEl) return amountEl.textContent?.trim() ?? 'unknown';

        // Fallback: search for £ amount pattern
        const body = document.body.textContent ?? '';
        const match = body.match(/£(\d+\.?\d*)/);
        return match ? `£${match[1]}` : 'unknown';
      });
    } catch {
      return 'unknown';
    }
  }

  private async extractConfirmationRef(page: Page): Promise<string | undefined> {
    try {
      return await page.evaluate(() => {
        // Look for reference number on confirmation page
        const refEl = document.querySelector('.govuk-panel__body, [data-testid="reference"]');
        if (refEl) {
          const match = refEl.textContent?.match(/\d{6,}/);
          return match ? match[0] : refEl.textContent?.trim();
        }

        // Fallback: search in page text
        const body = document.body.textContent ?? '';
        const match = body.match(/reference[:\s]+(\d{6,})/i);
        return match ? match[1] : undefined;
      });
    } catch {
      return undefined;
    }
  }
}

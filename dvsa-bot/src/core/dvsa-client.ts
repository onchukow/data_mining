import { Page } from 'playwright';
import { PlaywrightSession } from '../browser/playwright-session';
import { CaptchaSolver } from '../browser/captcha-solver';
import { createChildLogger } from '../utils/logger';
import { settings } from '../config/settings';
import { withRetry } from '../utils/retry';

const log = createChildLogger('dvsa-client');

export interface AvailableDate {
  date: string;       // YYYY-MM-DD
  slotsAvailable: boolean;
}

export interface AvailableSlot {
  date: string;        // YYYY-MM-DD
  time: string;        // HH:MM
  testCentre: string;
}

/**
 * DVSA Client — manages browser-based interaction with the DVSA booking system.
 *
 * Two modes:
 * A) Change existing booking: https://www.gov.uk/change-driving-test
 * B) New booking: https://www.gov.uk/book-driving-test
 *
 * All interactions go through Playwright (real browser) due to
 * Cloudflare protection on DVSA pages.
 */
export class DvsaClient {
  private session: PlaywrightSession;
  private captchaSolver: CaptchaSolver;
  private isLoggedIn: boolean = false;

  constructor(session: PlaywrightSession) {
    this.session = session;
    this.captchaSolver = new CaptchaSolver();
  }

  /**
   * Login to the "change booking" flow.
   * Requires booking reference + last 4 digits of licence number.
   */
  async loginToChangeBooking(bookingRef: string, licenceNumber: string): Promise<boolean> {
    const page = this.session.getPage();

    log.info('Navigating to change booking page');
    await this.session.navigateTo(settings.dvsa.changeBookingUrl);

    // Handle potential Cloudflare challenge
    await this.handleCaptchaIfPresent(page);
    await this.session.screenshot('change_booking_start');

    try {
      // Click "Start now" button on the GOV.UK start page
      await page.getByRole('button', { name: /start now/i }).click();
      await page.waitForLoadState('domcontentloaded');
      await this.session.screenshot('change_booking_form');

      // Fill booking reference
      await page.getByLabel(/booking reference/i).fill(bookingRef);

      // Fill last 4 digits of licence number
      const last4 = licenceNumber.slice(-4);
      await page.getByLabel(/licence number/i).fill(last4);

      await this.session.screenshot('change_booking_filled');

      // Submit
      await page.getByRole('button', { name: /continue|sign in|find booking/i }).click();
      await page.waitForLoadState('domcontentloaded');

      await this.session.screenshot('change_booking_result');

      // Check for errors
      const hasError = await page.locator('.govuk-error-summary, .error-summary').count() > 0;
      if (hasError) {
        const errorText = await page.locator('.govuk-error-summary, .error-summary').textContent();
        log.error({ errorText }, 'Login failed — error on page');
        return false;
      }

      this.isLoggedIn = true;
      log.info('Successfully logged in to change booking');
      return true;
    } catch (error) {
      log.error({ error }, 'Failed to login to change booking');
      await this.session.screenshot('change_booking_error');
      return false;
    }
  }

  /**
   * Navigate to the "Change appointment" flow after login.
   */
  async navigateToChangeAppointment(): Promise<boolean> {
    if (!this.isLoggedIn) {
      log.error('Not logged in — cannot change appointment');
      return false;
    }

    const page = this.session.getPage();

    try {
      // Click "Change appointment" or similar link/button
      await page.getByRole('link', { name: /change.*appointment|change.*date|change.*time/i }).click();
      await page.waitForLoadState('domcontentloaded');
      await this.session.screenshot('change_appointment_page');
      return true;
    } catch (error) {
      log.error({ error }, 'Failed to navigate to change appointment');
      await this.session.screenshot('change_appointment_error');
      return false;
    }
  }

  /**
   * Search for available dates at a specific test centre.
   * DVSA shows availability by MONTH — this gets the calendar view.
   */
  async getAvailableDates(testCentre: string): Promise<AvailableDate[]> {
    const page = this.session.getPage();
    const dates: AvailableDate[] = [];

    try {
      // Select test centre if needed
      await this.selectTestCentre(page, testCentre);
      await this.session.screenshot(`available_dates_${testCentre.replace(/\s/g, '_')}`);

      // Parse calendar — DVSA uses a calendar widget showing available dates
      // Available dates are typically highlighted/clickable, unavailable are greyed out
      const dateElements = await page.locator(
        '[data-testid="available-date"], .BookingCalendar-date--open, .available, a[data-date]'
      ).all();

      for (const el of dateElements) {
        const dateStr = await el.getAttribute('data-date') ?? await el.textContent();
        if (dateStr) {
          dates.push({
            date: this.parseDate(dateStr),
            slotsAvailable: true,
          });
        }
      }

      // Fallback: parse calendar cells if data attributes not found
      if (dates.length === 0) {
        const calendarCells = await page.locator(
          '.BookingCalendar-date a, td.available a, .day-picker-day--available'
        ).all();

        for (const cell of calendarCells) {
          const href = await cell.getAttribute('href');
          const text = await cell.textContent();
          if (href || text) {
            const dateMatch = (href ?? text ?? '').match(/(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              dates.push({ date: dateMatch[1], slotsAvailable: true });
            }
          }
        }
      }

      log.info({ testCentre, datesFound: dates.length }, 'Available dates retrieved');
      return dates;
    } catch (error) {
      log.error({ error, testCentre }, 'Failed to get available dates');
      await this.session.screenshot('available_dates_error');
      return [];
    }
  }

  /**
   * Get specific time slots for a given date.
   * This is the SECOND request — called after finding an available date.
   */
  async getAvailableSlots(testCentre: string, date: string): Promise<AvailableSlot[]> {
    const page = this.session.getPage();
    const slots: AvailableSlot[] = [];

    try {
      // Click on the date in the calendar
      const dateLink = page.locator(`a[data-date="${date}"], a[href*="${date}"]`).first();
      if (await dateLink.count() > 0) {
        await dateLink.click();
      } else {
        // Fallback: click by text content
        const dayNum = parseInt(date.split('-')[2], 10).toString();
        await page.getByText(dayNum, { exact: true }).click();
      }

      await page.waitForLoadState('domcontentloaded');
      await this.session.screenshot(`slots_${date}`);

      // Parse time slots
      const slotElements = await page.locator(
        '[data-testid="time-slot"], .SlotPicker-slot, .time-slot, input[type="radio"][name*="slot"], label[for*="slot"]'
      ).all();

      for (const el of slotElements) {
        const timeText = await el.textContent();
        const timeMatch = timeText?.match(/(\d{1,2}:\d{2})\s*(am|pm)?/i);
        if (timeMatch) {
          let time = timeMatch[1];
          if (timeMatch[2]) {
            time = this.to24Hour(time, timeMatch[2]);
          }
          slots.push({ date, time, testCentre });
        }
      }

      // Fallback: look for time in any list items or labels
      if (slots.length === 0) {
        const timeElements = await page.locator('li, label').all();
        for (const el of timeElements) {
          const text = await el.textContent();
          const match = text?.match(/(\d{1,2}:\d{2})\s*(am|pm)/i);
          if (match) {
            slots.push({
              date,
              time: this.to24Hour(match[1], match[2]),
              testCentre,
            });
          }
        }
      }

      log.info({ testCentre, date, slotsFound: slots.length }, 'Available time slots retrieved');
      return slots;
    } catch (error) {
      log.error({ error, testCentre, date }, 'Failed to get available slots');
      await this.session.screenshot('slots_error');
      return [];
    }
  }

  /**
   * Select a slot and confirm the booking change.
   * Must be executed FAST (<3 seconds) due to race conditions.
   */
  async selectAndConfirmSlot(slot: AvailableSlot): Promise<boolean> {
    const page = this.session.getPage();

    try {
      // Select the time slot (radio button or clickable element)
      const slotSelector = page.locator(
        `input[value*="${slot.time}"], [data-time="${slot.time}"], label:has-text("${slot.time}")`
      ).first();

      if (await slotSelector.count() > 0) {
        await slotSelector.click();
      } else {
        // Direct text click
        await page.getByText(slot.time).click();
      }

      await this.session.screenshot('slot_selected');

      // Submit / Continue — execute as fast as possible
      const submitBtn = page.getByRole('button', { name: /continue|confirm|book/i });
      await submitBtn.click();
      await page.waitForLoadState('domcontentloaded');

      await this.session.screenshot('slot_confirmed_step1');

      // There may be a confirmation page — confirm again
      const confirmBtn = page.getByRole('button', { name: /confirm|yes|change/i });
      if (await confirmBtn.count() > 0) {
        await confirmBtn.click();
        await page.waitForLoadState('domcontentloaded');
      }

      await this.session.screenshot('slot_confirmed_final');

      // Check for success
      const pageText = await page.textContent('body');
      const isSuccess = pageText?.toLowerCase().includes('booking confirmed') ||
        pageText?.toLowerCase().includes('appointment changed') ||
        pageText?.toLowerCase().includes('successfully');

      if (isSuccess) {
        log.info({ slot }, 'Slot booked successfully');
        return true;
      }

      // Check for "slot taken" error
      const isTaken = pageText?.toLowerCase().includes('no longer available') ||
        pageText?.toLowerCase().includes('already been taken');

      if (isTaken) {
        log.warn({ slot }, 'Slot was taken by another user');
        return false;
      }

      log.warn({ slot }, 'Uncertain booking result — check screenshot');
      return false;
    } catch (error) {
      log.error({ error, slot }, 'Failed to select and confirm slot');
      await this.session.screenshot('slot_confirm_error');
      return false;
    }
  }

  /**
   * Navigate to new booking flow.
   */
  async startNewBooking(): Promise<boolean> {
    const page = this.session.getPage();

    try {
      await this.session.navigateTo(settings.dvsa.newBookingUrl);
      await this.handleCaptchaIfPresent(page);

      // Click "Start now"
      await page.getByRole('button', { name: /start now/i }).click();
      await page.waitForLoadState('domcontentloaded');
      await this.session.screenshot('new_booking_start');

      return true;
    } catch (error) {
      log.error({ error }, 'Failed to start new booking');
      await this.session.screenshot('new_booking_error');
      return false;
    }
  }

  getIsLoggedIn(): boolean {
    return this.isLoggedIn;
  }

  /**
   * Handle CAPTCHA if present on current page.
   */
  private async handleCaptchaIfPresent(page: Page): Promise<void> {
    await withRetry(async () => {
      const hasCaptcha = await page.locator('.cf-turnstile, [data-sitekey], iframe[src*="turnstile"]').count() > 0;
      if (hasCaptcha) {
        log.info('CAPTCHA detected, attempting to solve');
        await this.captchaSolver.solveTurnstile(page, page.url());
      }
    }, { maxRetries: 1, baseDelayMs: 2000 });
  }

  private async selectTestCentre(page: Page, testCentre: string): Promise<void> {
    // Try to find and select the test centre
    const centreInput = page.locator('input[name*="centre"], input[name*="search"], #test-centre-search');
    if (await centreInput.count() > 0) {
      await centreInput.first().fill(testCentre);
      // Wait for autocomplete/results
      await page.waitForTimeout(1000);

      // Click on matching result
      const result = page.locator(`[data-testid="centre-result"], li, option`).filter({ hasText: testCentre }).first();
      if (await result.count() > 0) {
        await result.click();
      }

      // Submit selection
      const submitBtn = page.getByRole('button', { name: /find|search|continue/i });
      if (await submitBtn.count() > 0) {
        await submitBtn.click();
        await page.waitForLoadState('domcontentloaded');
      }
    }
  }

  private parseDate(raw: string): string {
    // Try ISO format first
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

    // Try DD/MM/YYYY
    const dmyMatch = raw.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (dmyMatch) {
      return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
    }

    // Try parsing as Date
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }

    return raw;
  }

  private to24Hour(time: string, ampm: string): string {
    const [hours, minutes] = time.split(':').map(Number);
    let h = hours;
    if (ampm.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
    return `${h.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }
}

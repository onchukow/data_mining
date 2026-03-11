import { Page } from 'playwright';
import { PlaywrightSession } from '../browser/playwright-session';
import { DvsaClient } from './dvsa-client';
import { PaymentHandler, PaymentResult } from '../browser/payment-handler';
import { createChildLogger } from '../utils/logger';
import { settings, type TestType } from '../config/settings';
import { sleep } from '../utils/retry';

const log = createChildLogger('form-filler');

export interface FormData {
  testType: TestType;
  licenceNumber: string;
  title: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  postcode: string;
  instructorPrn?: string;
  specialNeeds?: {
    welshLanguage?: boolean;
    extraTime?: boolean;
  };
}

export interface NewBookingResult {
  success: boolean;
  reachedPayment: boolean;
  paymentResult?: PaymentResult;
  error?: string;
  screenshotPath?: string;
}

/**
 * Fills the DVSA new booking form (multi-step wizard).
 *
 * Steps:
 * 1. Test type selection (car/motorcycle/lgv/pcv)
 * 2. Driving licence number
 * 3. Personal details (auto-populated from licence, sometimes manual)
 * 4. Instructor details (optional)
 * 5. Special requirements
 * 6. Test centre selection
 * 7. Date and time selection
 * 8. Payment (delegated to PaymentHandler)
 *
 * DVSA validates at step 2:
 * - Valid provisional licence
 * - Theory test passed (and not expired — 2 year validity)
 * - No existing booking
 */
export class FormFiller {
  private session: PlaywrightSession;
  private client: DvsaClient;
  private paymentHandler: PaymentHandler;

  constructor(session: PlaywrightSession) {
    this.session = session;
    this.client = new DvsaClient(session);
    this.paymentHandler = new PaymentHandler(session);
  }

  /**
   * Fill the complete new booking form.
   * Returns when payment page is reached (or on error).
   */
  async fillNewBookingForm(formData: FormData, targetCentre: string, targetDate?: string): Promise<NewBookingResult> {
    const page = this.session.getPage();

    try {
      // Start new booking flow
      const started = await this.client.startNewBooking();
      if (!started) {
        return { success: false, reachedPayment: false, error: 'Failed to start booking flow' };
      }

      // Step 1: Test type
      await this.selectTestType(page, formData.testType);

      // Step 2: Licence number
      const licenceValid = await this.enterLicenceNumber(page, formData.licenceNumber);
      if (!licenceValid) {
        return {
          success: false,
          reachedPayment: false,
          error: 'Licence validation failed — check provisional licence status and theory test',
        };
      }

      // Step 3: Personal details (may be auto-populated)
      await this.fillPersonalDetails(page, formData);

      // Step 4: Instructor PRN (optional)
      if (formData.instructorPrn) {
        await this.fillInstructorDetails(page, formData.instructorPrn);
      } else {
        await this.skipOptionalStep(page);
      }

      // Step 5: Special requirements
      if (formData.specialNeeds) {
        await this.fillSpecialNeeds(page, formData.specialNeeds);
      } else {
        await this.skipOptionalStep(page);
      }

      // Step 6: Test centre
      await this.selectTestCentre(page, targetCentre, formData.postcode);

      // Step 7: Date and time — handled by slot monitor + booking engine
      // At this point, the page should show the calendar
      await this.session.screenshot('form_calendar_reached');

      // If a target date is specified, select it
      if (targetDate) {
        await this.client.getAvailableSlots(targetCentre, targetDate);
      }

      // Step 8: Check if we've reached payment
      const isPayment = await this.paymentHandler.isPaymentPage(page);
      if (isPayment) {
        const paymentResult = await this.paymentHandler.handlePayment(page);
        return {
          success: paymentResult.success,
          reachedPayment: true,
          paymentResult,
        };
      }

      return {
        success: true,
        reachedPayment: false,
        screenshotPath: await this.session.screenshot('form_completed'),
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ error: err.message }, 'Form filling failed');
      const screenshotPath = await this.session.screenshot('form_error');

      return {
        success: false,
        reachedPayment: false,
        error: err.message,
        screenshotPath,
      };
    }
  }

  /**
   * Step 1: Select test type.
   */
  private async selectTestType(page: Page, testType: TestType): Promise<void> {
    log.info({ testType }, 'Selecting test type');

    const typeLabels: Record<TestType, string> = {
      car: 'Car',
      motorcycle: 'Motorcycle',
      lgv: 'Large goods vehicle',
      pcv: 'Passenger carrying vehicle',
    };

    const label = typeLabels[testType];

    // Try radio button first
    const radio = page.getByLabel(new RegExp(label, 'i'));
    if (await radio.count() > 0) {
      await radio.click();
    } else {
      // Fallback: click text
      await page.getByText(label).click();
    }

    await this.clickContinue(page);
    await this.session.screenshot('step1_test_type');
  }

  /**
   * Step 2: Enter driving licence number.
   * DVSA validates: provisional licence exists, theory test passed, no existing booking.
   */
  private async enterLicenceNumber(page: Page, licenceNumber: string): Promise<boolean> {
    log.info('Entering licence number');

    await page.getByLabel(/licence number|driving licence/i).fill(licenceNumber);
    await this.clickContinue(page);
    await this.session.screenshot('step2_licence');

    // Check for validation errors
    const errorSummary = page.locator('.govuk-error-summary');
    if (await errorSummary.count() > 0) {
      const errorText = await errorSummary.textContent();
      log.error({ errorText }, 'Licence validation failed');

      // Check specific error types
      if (errorText?.toLowerCase().includes('theory test')) {
        log.error('Theory test has expired or not passed');
      }
      if (errorText?.toLowerCase().includes('existing booking')) {
        log.error('User already has an existing booking — use reschedule mode');
      }
      if (errorText?.toLowerCase().includes('provisional')) {
        log.error('No valid provisional licence found');
      }

      return false;
    }

    return true;
  }

  /**
   * Step 3: Personal details.
   * Usually auto-populated from DVLA records via licence number.
   * Sometimes requires manual input.
   */
  private async fillPersonalDetails(page: Page, formData: FormData): Promise<void> {
    log.info('Filling personal details');

    // Check if details are already populated
    const titleField = page.getByLabel(/title/i);
    const needsManualInput = await titleField.count() > 0 &&
      (await titleField.inputValue()) === '';

    if (needsManualInput) {
      log.info('Manual personal details entry required');

      // Title
      const titleSelect = page.getByLabel(/title/i);
      if (await titleSelect.count() > 0) {
        await titleSelect.selectOption(formData.title);
      }

      // First name
      const firstNameField = page.getByLabel(/first name/i);
      if (await firstNameField.count() > 0) {
        await firstNameField.fill(formData.firstName);
      }

      // Last name
      const lastNameField = page.getByLabel(/last name|surname/i);
      if (await lastNameField.count() > 0) {
        await lastNameField.fill(formData.lastName);
      }

      // Date of birth
      const dobFields = await page.locator('input[name*="dob"], input[name*="date-of-birth"], input[name*="day"], input[name*="month"], input[name*="year"]').all();
      if (dobFields.length >= 3) {
        const dob = formData.dateOfBirth;
        await dobFields[0].fill(dob.getDate().toString());
        await dobFields[1].fill((dob.getMonth() + 1).toString());
        await dobFields[2].fill(dob.getFullYear().toString());
      } else {
        // Single date field
        const dobField = page.getByLabel(/date of birth/i);
        if (await dobField.count() > 0) {
          const dob = formData.dateOfBirth;
          await dobField.fill(
            `${dob.getDate().toString().padStart(2, '0')}/${(dob.getMonth() + 1).toString().padStart(2, '0')}/${dob.getFullYear()}`
          );
        }
      }
    } else {
      log.info('Personal details auto-populated from DVLA records');
    }

    await this.clickContinue(page);
    await this.session.screenshot('step3_personal_details');
  }

  /**
   * Step 4: Instructor PRN.
   */
  private async fillInstructorDetails(page: Page, prn: string): Promise<void> {
    log.info({ prn }, 'Filling instructor details');

    // Select "Yes" for having an instructor
    const yesRadio = page.getByLabel(/yes/i);
    if (await yesRadio.count() > 0) {
      await yesRadio.click();
    }

    const prnField = page.getByLabel(/instructor|PRN|reference/i);
    if (await prnField.count() > 0) {
      await prnField.fill(prn);
    }

    await this.clickContinue(page);
    await this.session.screenshot('step4_instructor');
  }

  /**
   * Step 5: Special needs.
   */
  private async fillSpecialNeeds(page: Page, needs: NonNullable<FormData['specialNeeds']>): Promise<void> {
    log.info({ needs }, 'Filling special needs');

    if (needs.welshLanguage) {
      const welshCheckbox = page.getByLabel(/welsh/i);
      if (await welshCheckbox.count() > 0) {
        await welshCheckbox.check();
      }
    }

    if (needs.extraTime) {
      const extraTimeCheckbox = page.getByLabel(/extra time|additional time/i);
      if (await extraTimeCheckbox.count() > 0) {
        await extraTimeCheckbox.check();
      }
    }

    await this.clickContinue(page);
    await this.session.screenshot('step5_special_needs');
  }

  /**
   * Step 6: Test centre selection.
   */
  private async selectTestCentre(page: Page, centreName: string, postcode: string): Promise<void> {
    log.info({ centreName, postcode }, 'Selecting test centre');

    // Enter postcode to search
    const postcodeField = page.getByLabel(/postcode|post code|location/i);
    if (await postcodeField.count() > 0) {
      await postcodeField.fill(postcode);
      await this.clickContinue(page);
      await page.waitForLoadState('domcontentloaded');
      await sleep(1000);
    }

    // Select the specific centre from results
    const centreLink = page.locator(`a, button, label, input`).filter({ hasText: centreName }).first();
    if (await centreLink.count() > 0) {
      await centreLink.click();
    } else {
      // Fallback: look for a radio button or link with matching text
      await page.getByText(centreName).first().click();
    }

    await this.clickContinue(page);
    await this.session.screenshot('step6_test_centre');
  }

  /**
   * Skip an optional step by clicking Continue/No.
   */
  private async skipOptionalStep(page: Page): Promise<void> {
    // Try "No" radio first
    const noRadio = page.getByLabel(/no/i);
    if (await noRadio.count() > 0) {
      await noRadio.click();
    }

    await this.clickContinue(page);
  }

  /**
   * Click the Continue/Next button on the current step.
   */
  private async clickContinue(page: Page): Promise<void> {
    const btn = page.getByRole('button', { name: /continue|next|submit/i });
    if (await btn.count() > 0) {
      await btn.click();
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

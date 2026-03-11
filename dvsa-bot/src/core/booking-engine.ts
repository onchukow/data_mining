import { DvsaClient } from './dvsa-client';
import { SlotCandidate } from './slot-monitor';
import { PlaywrightSession } from '../browser/playwright-session';
import { SlotHistory } from '../storage/slot-history';
import { BookingStateManager } from '../storage/booking-state';
import { createChildLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';

const log = createChildLogger('booking-engine');

export interface BookingResult {
  success: boolean;
  slot: SlotCandidate;
  bookingRef?: string;
  error?: string;
  screenshotPath?: string;
}

/**
 * Handles the booking/rescheduling logic.
 *
 * For rescheduling (change existing booking):
 * 1. Already logged in via DvsaClient
 * 2. Navigate to "Change appointment"
 * 3. Select test centre (or keep current)
 * 4. Select date from calendar
 * 5. Select time slot
 * 6. Confirm — NO payment required
 *
 * CRITICAL: Steps 4-6 must execute in <3 seconds (race condition).
 *
 * For new booking:
 * Delegates to FormFiller + PaymentHandler.
 */
export class BookingEngine {
  private client: DvsaClient;
  private session: PlaywrightSession;
  private slotHistory: SlotHistory;
  private stateManager: BookingStateManager;

  constructor(
    session: PlaywrightSession,
    slotHistory: SlotHistory,
    stateManager: BookingStateManager
  ) {
    this.session = session;
    this.client = new DvsaClient(session);
    this.slotHistory = slotHistory;
    this.stateManager = stateManager;
  }

  /**
   * Attempt to book the best available slot from a list of candidates.
   * Tries each slot in order until one succeeds.
   */
  async bookBestSlot(candidates: SlotCandidate[]): Promise<BookingResult> {
    if (candidates.length === 0) {
      return {
        success: false,
        slot: { date: '', time: '', testCentre: '', score: 0 },
        error: 'No candidates provided',
      };
    }

    log.info({ candidateCount: candidates.length, best: candidates[0] }, 'Attempting to book best slot');

    for (const slot of candidates) {
      const result = await this.attemptBooking(slot);
      if (result.success) {
        return result;
      }

      // Slot was taken — try next one
      log.info({ slot, error: result.error }, 'Slot booking failed, trying next');

      // Record as missed
      const historyId = this.slotHistory.recordSlot({
        testCentre: slot.testCentre,
        date: slot.date,
        time: slot.time,
        status: 'missed',
      });
      log.debug({ historyId }, 'Slot recorded as missed');
    }

    return {
      success: false,
      slot: candidates[0],
      error: 'All candidate slots were taken',
    };
  }

  /**
   * Attempt to book a specific slot via the reschedule flow.
   */
  async attemptReschedule(slot: SlotCandidate, bookingRef: string, licenceNumber: string): Promise<BookingResult> {
    log.info({ slot, bookingRef }, 'Attempting reschedule');

    // Check if booking is too close
    if (this.stateManager.isBookingTooSoon(bookingRef)) {
      return {
        success: false,
        slot,
        error: 'Current booking is within 3 working days — cannot reschedule',
      };
    }

    try {
      // Ensure we're logged in
      if (!this.client.getIsLoggedIn()) {
        const loggedIn = await this.client.loginToChangeBooking(bookingRef, licenceNumber);
        if (!loggedIn) {
          return {
            success: false,
            slot,
            error: 'Failed to login to change booking',
          };
        }
      }

      // Navigate to change appointment
      const navigated = await this.client.navigateToChangeAppointment();
      if (!navigated) {
        return {
          success: false,
          slot,
          error: 'Failed to navigate to change appointment page',
        };
      }

      // Get available dates for the target centre
      const dates = await this.client.getAvailableDates(slot.testCentre);
      const targetDate = dates.find(d => d.date === slot.date);

      if (!targetDate) {
        return {
          success: false,
          slot,
          error: `Date ${slot.date} not available at ${slot.testCentre}`,
        };
      }

      // Get slots for the target date
      const availableSlots = await this.client.getAvailableSlots(slot.testCentre, slot.date);
      const targetSlot = availableSlots.find(s => s.time === slot.time);

      if (!targetSlot) {
        return {
          success: false,
          slot,
          error: `Time ${slot.time} not available on ${slot.date}`,
        };
      }

      // FAST EXECUTION: select and confirm (<3 seconds)
      const confirmed = await this.client.selectAndConfirmSlot(slot);

      if (confirmed) {
        // Update state
        this.stateManager.updateBookingDate(bookingRef, slot.date, slot.time, slot.testCentre);

        const screenshotPath = await this.session.screenshot('booking_confirmed');

        log.info({ slot, bookingRef }, 'Reschedule successful');

        return {
          success: true,
          slot,
          bookingRef,
          screenshotPath,
        };
      }

      return {
        success: false,
        slot,
        error: 'Slot confirmation failed — may have been taken',
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ error: err.message, slot }, 'Reschedule attempt failed');
      await this.session.screenshot('reschedule_error');

      return {
        success: false,
        slot,
        error: err.message,
      };
    }
  }

  /**
   * Internal: attempt to book a single slot.
   */
  private async attemptBooking(slot: SlotCandidate): Promise<BookingResult> {
    try {
      const confirmed = await withRetry(
        () => this.client.selectAndConfirmSlot(slot),
        { maxRetries: 1, baseDelayMs: 1000, multiplier: 2 }
      );

      if (confirmed) {
        const screenshotPath = await this.session.screenshot('booking_success');

        // Record in history
        this.slotHistory.recordSlot({
          testCentre: slot.testCentre,
          date: slot.date,
          time: slot.time,
          status: 'booked',
        });

        return {
          success: true,
          slot,
          screenshotPath,
        };
      }

      return {
        success: false,
        slot,
        error: 'Confirmation failed',
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        slot,
        error: err.message,
      };
    }
  }
}

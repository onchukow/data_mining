import { DvsaClient, AvailableSlot } from './dvsa-client';
import { PlaywrightSession } from '../browser/playwright-session';
import { SlotHistory } from '../storage/slot-history';
import { BookingStateManager } from '../storage/booking-state';
import { createChildLogger } from '../utils/logger';
import { sleep } from '../utils/retry';
import {
  settings,
  getEffectiveInterval,
  isMaintenanceWindow,
  isNightMode,
  isPeakCancellationHour,
  type DayOfWeek,
  type MonitorConfig,
  type TimeRange,
} from '../config/settings';

const log = createChildLogger('slot-monitor');

export interface SlotCandidate extends AvailableSlot {
  score: number; // Higher = better match
}

/**
 * Polling loop that monitors DVSA for available test slots.
 *
 * Algorithm:
 * 1. For each test centre (by priority):
 *    a. Request calendar month view → find available dates
 *    b. For each available date matching criteria → request time slots
 *    c. Filter by preferred times
 * 2. Score and rank found slots
 * 3. Emit events for found slots
 *
 * Rate limiting: 60-120s between checks with jitter.
 * Night mode (00:00-06:00): 3x interval.
 * Maintenance (Sun 00:00-06:00): pause completely.
 */
export class SlotMonitor {
  private client: DvsaClient;
  private session: PlaywrightSession;
  private slotHistory: SlotHistory;
  private stateManager: BookingStateManager;
  private config: MonitorConfig;
  private running: boolean = false;
  private paused: boolean = false;
  private onSlotFound: ((slots: SlotCandidate[]) => Promise<void>) | null = null;
  private onError: ((error: Error, consecutive: number) => void) | null = null;
  private consecutiveErrors: number = 0;

  constructor(
    session: PlaywrightSession,
    slotHistory: SlotHistory,
    stateManager: BookingStateManager,
    config: MonitorConfig
  ) {
    this.session = session;
    this.client = new DvsaClient(session);
    this.slotHistory = slotHistory;
    this.stateManager = stateManager;
    this.config = config;
  }

  /**
   * Register callback for when slots are found.
   */
  onSlotsFound(handler: (slots: SlotCandidate[]) => Promise<void>): void {
    this.onSlotFound = handler;
  }

  /**
   * Register callback for monitoring errors.
   */
  onMonitorError(handler: (error: Error, consecutive: number) => void): void {
    this.onError = handler;
  }

  /**
   * Start the monitoring loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('Monitor is already running');
      return;
    }

    this.running = true;
    this.stateManager.setMonitoringValue('isRunning', true);

    log.info({
      centres: this.config.testCentres,
      dateRange: {
        from: this.config.earliestDate.toISOString().split('T')[0],
        to: this.config.latestDate.toISOString().split('T')[0],
      },
      mode: this.config.mode,
      autoBook: this.config.autoBook,
    }, 'Starting slot monitor');

    // Login if in reschedule mode
    if (this.config.mode === 'reschedule' && this.config.currentBookingRef && this.config.licenceNumber) {
      // Check if booking is too soon to reschedule
      if (this.stateManager.isBookingTooSoon(this.config.currentBookingRef)) {
        log.error('Current booking is within 3 working days — cannot reschedule');
        this.running = false;
        return;
      }

      const loggedIn = await this.client.loginToChangeBooking(
        this.config.currentBookingRef,
        this.config.licenceNumber
      );
      if (!loggedIn) {
        log.error('Failed to login — aborting monitor');
        this.running = false;
        return;
      }
    } else if (this.config.mode === 'new_booking') {
      const started = await this.client.startNewBooking();
      if (!started) {
        log.error('Failed to start new booking flow — aborting monitor');
        this.running = false;
        return;
      }
    }

    // Main polling loop
    while (this.running) {
      try {
        // Check if paused
        if (this.paused) {
          log.debug('Monitor is paused');
          await sleep(5000);
          continue;
        }

        // Check maintenance window
        if (isMaintenanceWindow()) {
          log.info('DVSA maintenance window — pausing until 06:00 UTC');
          await sleep(60000); // Check again in 1 minute
          continue;
        }

        // Check session expiry
        if (this.session.isSessionExpired()) {
          log.info('Session expired, restarting browser');
          await this.session.restart();

          // Re-login
          if (this.config.mode === 'reschedule' && this.config.currentBookingRef && this.config.licenceNumber) {
            await this.client.loginToChangeBooking(this.config.currentBookingRef, this.config.licenceNumber);
          }
        }

        // Perform check
        const slots = await this.checkAllCentres();

        if (slots.length > 0) {
          this.consecutiveErrors = 0;
          this.stateManager.resetConsecutiveErrors();
          this.stateManager.incrementCounter('slotsFoundCount');

          // Record in history
          for (const slot of slots) {
            if (!this.slotHistory.hasSlotBeenSeen(slot.testCentre, slot.date, slot.time)) {
              this.slotHistory.recordSlot({
                testCentre: slot.testCentre,
                date: slot.date,
                time: slot.time,
                status: 'found',
              });
            }
          }

          // Notify
          if (this.onSlotFound) {
            await this.onSlotFound(slots);
          }
        }

        this.stateManager.incrementCounter('checksCount');
        this.stateManager.setMonitoringValue('lastCheckAt', new Date().toISOString());
        this.consecutiveErrors = 0;
        this.stateManager.resetConsecutiveErrors();

      } catch (error) {
        this.consecutiveErrors++;
        this.stateManager.incrementCounter('errorsCount');
        this.stateManager.incrementCounter('consecutiveErrors');

        const err = error instanceof Error ? error : new Error(String(error));
        log.error({ error: err.message, consecutiveErrors: this.consecutiveErrors }, 'Monitor check failed');

        this.onError?.(err, this.consecutiveErrors);

        // If too many consecutive errors, pause and alert
        if (this.consecutiveErrors >= 5) {
          log.error('5+ consecutive errors — pausing monitor for 5 minutes');
          await sleep(300000);
          this.consecutiveErrors = 0;
        }
      }

      // Wait before next check
      const interval = getEffectiveInterval();
      const mode = isNightMode() ? 'night' : isPeakCancellationHour() ? 'peak' : 'normal';
      log.debug({ intervalMs: interval, mode }, 'Waiting before next check');
      await sleep(interval);
    }
  }

  /**
   * Stop the monitoring loop.
   */
  stop(): void {
    this.running = false;
    this.stateManager.setMonitoringValue('isRunning', false);
    log.info('Monitor stopped');
  }

  /**
   * Pause monitoring (resumes with resume()).
   */
  pause(): void {
    this.paused = true;
    this.stateManager.setMonitoringValue('isPaused', true);
    log.info('Monitor paused');
  }

  /**
   * Resume monitoring after pause.
   */
  resume(): void {
    this.paused = false;
    this.stateManager.setMonitoringValue('isPaused', false);
    log.info('Monitor resumed');
  }

  isRunning(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Update monitoring configuration at runtime.
   */
  updateConfig(updates: Partial<MonitorConfig>): void {
    Object.assign(this.config, updates);
    log.info({ updates }, 'Monitor config updated');
  }

  /**
   * Check all configured test centres for available slots.
   */
  private async checkAllCentres(): Promise<SlotCandidate[]> {
    const allSlots: SlotCandidate[] = [];

    for (const centre of this.config.testCentres) {
      log.info({ centre }, 'Checking test centre');

      // Step 1: Get available dates (calendar month view)
      const dates = await this.client.getAvailableDates(centre);

      // Filter dates by criteria
      const validDates = dates.filter(d => this.isDateInRange(d.date) && this.isPreferredDay(d.date));

      if (validDates.length === 0) {
        log.debug({ centre }, 'No matching dates found');
        continue;
      }

      // Rate limit: wait between date check and slot check
      await sleep(2000 + Math.random() * 3000);

      // Step 2: Get time slots for each valid date
      for (const dateInfo of validDates.slice(0, 5)) { // Max 5 dates per centre per check
        const slots = await this.client.getAvailableSlots(centre, dateInfo.date);

        // Filter by preferred time
        const matchingSlots = slots.filter(s => this.isPreferredTime(s.time));

        // Score and add
        for (const slot of matchingSlots) {
          allSlots.push({
            ...slot,
            score: this.scoreSlot(slot),
          });
        }

        // Rate limit between slot requests
        await sleep(1000 + Math.random() * 2000);
      }
    }

    // Sort by score (highest first)
    allSlots.sort((a, b) => b.score - a.score);

    if (allSlots.length > 0) {
      log.info({
        slotsFound: allSlots.length,
        bestSlot: allSlots[0],
      }, 'Slots found');
    }

    return allSlots;
  }

  /**
   * Score a slot based on preferences.
   * Higher score = better match.
   * Priority: earliest date → preferred time → preferred centre.
   */
  private scoreSlot(slot: AvailableSlot): number {
    let score = 1000;

    // Earlier date = higher score
    const slotDate = new Date(slot.date);
    const daysFromNow = Math.floor((slotDate.getTime() - Date.now()) / (86400000));
    score -= daysFromNow; // Earlier = higher

    // Preferred time bonus
    const [hours] = slot.time.split(':').map(Number);
    if (hours >= 9 && hours <= 11) score += 50;  // Morning sweet spot
    if (hours >= 8 && hours <= 14) score += 20;   // Working hours
    if (hours >= 7 && hours <= 8) score += 10;    // Early morning

    // Centre priority bonus (first in list = highest priority)
    const centreIndex = this.config.testCentres.indexOf(slot.testCentre);
    if (centreIndex >= 0) {
      score += (this.config.testCentres.length - centreIndex) * 10;
    }

    return score;
  }

  private isDateInRange(dateStr: string): boolean {
    const date = new Date(dateStr);
    return date >= this.config.earliestDate && date <= this.config.latestDate;
  }

  private isPreferredDay(dateStr: string): boolean {
    if (this.config.preferredDays.length === 0) return true;

    const date = new Date(dateStr);
    const dayNames: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[date.getDay()];
    return this.config.preferredDays.includes(dayName);
  }

  private isPreferredTime(time: string): boolean {
    if (this.config.preferredTimeSlots.length === 0) return true;

    return this.config.preferredTimeSlots.some((range: TimeRange) =>
      time >= range.start && time <= range.end
    );
  }
}

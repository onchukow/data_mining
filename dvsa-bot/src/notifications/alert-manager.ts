import { createChildLogger } from '../utils/logger';
import { SlotCandidate } from '../core/slot-monitor';
import { BookingResult } from '../core/booking-engine';

const log = createChildLogger('alert-manager');

export type AlertPriority = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Alert {
  priority: AlertPriority;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

export type AlertHandler = (alert: Alert) => Promise<void>;

/**
 * Manages alert priorities and deduplication.
 * Prevents notification spam by rate-limiting and deduplicating alerts.
 */
export class AlertManager {
  private handlers: AlertHandler[] = [];
  private recentAlerts: Map<string, number> = new Map(); // key -> timestamp
  private cooldownMs: number;

  constructor(cooldownMs: number = 30000) {
    this.cooldownMs = cooldownMs;
  }

  /**
   * Register an alert handler (e.g., Telegram sender).
   */
  onAlert(handler: AlertHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Alert: new slots found.
   */
  async alertSlotsFound(slots: SlotCandidate[]): Promise<void> {
    if (slots.length === 0) return;

    const best = slots[0];
    const key = `slot_${best.testCentre}_${best.date}_${best.time}`;

    if (this.isDuplicate(key)) {
      log.debug({ key }, 'Duplicate alert suppressed');
      return;
    }

    const slotLines = slots.slice(0, 5).map(s =>
      `  📍 ${s.testCentre}\n  📅 ${this.formatDate(s.date)} | ⏰ ${s.time}`
    ).join('\n\n');

    await this.emit({
      priority: 'critical',
      title: `🟢 SLOT${slots.length > 1 ? 'S' : ''} FOUND!`,
      message: slots.length === 1
        ? `📍 Centre: ${best.testCentre}\n📅 Date: ${this.formatDate(best.date)}\n⏰ Time: ${best.time}`
        : `${slots.length} slots found:\n\n${slotLines}`,
      data: { slots, bestSlot: best },
    });
  }

  /**
   * Alert: booking successful.
   */
  async alertBookingSuccess(result: BookingResult): Promise<void> {
    await this.emit({
      priority: 'critical',
      title: '✅ BOOKING CONFIRMED!',
      message: [
        `📍 Centre: ${result.slot.testCentre}`,
        `📅 Date: ${this.formatDate(result.slot.date)}`,
        `⏰ Time: ${result.slot.time}`,
        result.bookingRef ? `🔖 Ref: ${result.bookingRef}` : '',
      ].filter(Boolean).join('\n'),
      data: { result },
    });
  }

  /**
   * Alert: booking failed.
   */
  async alertBookingFailed(result: BookingResult): Promise<void> {
    await this.emit({
      priority: 'high',
      title: '❌ BOOKING FAILED',
      message: [
        `📍 Centre: ${result.slot.testCentre}`,
        `📅 Date: ${this.formatDate(result.slot.date)}`,
        `⏰ Time: ${result.slot.time}`,
        `❗ Error: ${result.error ?? 'Unknown error'}`,
      ].join('\n'),
      data: { result },
    });
  }

  /**
   * Alert: payment requires manual action.
   */
  async alertPaymentRequired(screenshotPath?: string): Promise<void> {
    await this.emit({
      priority: 'critical',
      title: '💳 PAYMENT REQUIRED',
      message: 'Bot reached payment page. Please complete payment manually.\n\nOpen noVNC at http://localhost:6080 to complete the payment.',
      data: { screenshotPath },
    });
  }

  /**
   * Alert: monitor errors.
   */
  async alertMonitorError(error: Error, consecutiveErrors: number): Promise<void> {
    // Only alert on 3+ consecutive errors to avoid noise
    if (consecutiveErrors < 3) return;

    const key = `error_${consecutiveErrors}`;
    if (this.isDuplicate(key)) return;

    await this.emit({
      priority: consecutiveErrors >= 5 ? 'critical' : 'high',
      title: `⚠️ MONITOR ERROR (${consecutiveErrors}x)`,
      message: `${consecutiveErrors} consecutive errors.\nLatest: ${error.message}\n\n${consecutiveErrors >= 5 ? 'Monitor paused for 5 minutes.' : 'Monitor will retry.'}`,
      data: { error: error.message, consecutiveErrors },
    });
  }

  /**
   * Alert: theory test expiry warning.
   */
  async alertTheoryTestExpiry(): Promise<void> {
    await this.emit({
      priority: 'critical',
      title: '⚠️ THEORY TEST EXPIRY',
      message: 'Theory test may be expired or invalid. Cannot proceed with booking.\nPlease check your theory test certificate.',
    });
  }

  /**
   * Alert: booking too soon to reschedule.
   */
  async alertBookingTooSoon(): Promise<void> {
    await this.emit({
      priority: 'high',
      title: '⚠️ CANNOT RESCHEDULE',
      message: 'Current booking is within 3 working days. DVSA does not allow rescheduling.\nMonitor has been stopped.',
    });
  }

  /**
   * Info: status update.
   */
  async alertStatusUpdate(message: string): Promise<void> {
    await this.emit({
      priority: 'info',
      title: 'ℹ️ Status Update',
      message,
    });
  }

  private async emit(alert: Omit<Alert, 'timestamp'>): Promise<void> {
    const fullAlert: Alert = { ...alert, timestamp: new Date() };
    log.info({ alert: fullAlert }, 'Emitting alert');

    for (const handler of this.handlers) {
      try {
        await handler(fullAlert);
      } catch (error) {
        log.error({ error, alertTitle: alert.title }, 'Alert handler failed');
      }
    }
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    const lastSent = this.recentAlerts.get(key);
    if (lastSent && now - lastSent < this.cooldownMs) {
      return true;
    }
    this.recentAlerts.set(key, now);

    // Clean old entries
    for (const [k, v] of this.recentAlerts) {
      if (now - v > this.cooldownMs * 10) {
        this.recentAlerts.delete(k);
      }
    }

    return false;
  }

  private formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  }
}

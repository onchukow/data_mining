import { PlaywrightSession } from './browser/playwright-session';
import { SlotMonitor, SlotCandidate } from './core/slot-monitor';
import { BookingEngine } from './core/booking-engine';
import { FormFiller } from './core/form-filler';
import { SlotHistory } from './storage/slot-history';
import { BookingStateManager } from './storage/booking-state';
import { AlertManager } from './notifications/alert-manager';
import { TelegramBot } from './notifications/telegram-bot';
import { createChildLogger } from './utils/logger';
import { settings, getMonitorConfig } from './config/settings';
import fs from 'fs';
import path from 'path';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('=== DVSA Booking Bot Starting ===');
  log.info({
    mode: settings.monitor.mode,
    centres: settings.monitor.testCentres,
    dateRange: {
      from: settings.monitor.earliestDate.toISOString().split('T')[0],
      to: settings.monitor.latestDate.toISOString().split('T')[0],
    },
    autoBook: settings.monitor.autoBook,
    checkIntervalMs: settings.monitor.checkIntervalMs,
  }, 'Configuration loaded');

  // Ensure data directory exists
  const dataDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Ensure screenshot directory exists
  if (!fs.existsSync(settings.logging.screenshotDir)) {
    fs.mkdirSync(settings.logging.screenshotDir, { recursive: true });
  }

  // Initialize components
  const slotHistory = new SlotHistory();
  const stateManager = new BookingStateManager();
  const alertManager = new AlertManager();
  const session = new PlaywrightSession();
  const config = getMonitorConfig();

  // Save initial booking state if in reschedule mode
  if (config.mode === 'reschedule' && config.currentBookingRef && config.licenceNumber) {
    const existingBooking = stateManager.getActiveBooking();
    if (!existingBooking) {
      stateManager.saveBooking({
        bookingRef: config.currentBookingRef,
        licenceNumber: config.licenceNumber,
        testCentre: 'Unknown',
        testDate: 'Unknown',
        testTime: 'Unknown',
        status: 'active',
      });
    }

    // Check booking proximity
    if (stateManager.isBookingTooSoon(config.currentBookingRef)) {
      log.error('Current booking is within 3 working days — cannot reschedule');
      await alertManager.alertBookingTooSoon();
    }
  }

  // Initialize Telegram bot
  const telegramBot = new TelegramBot(alertManager, slotHistory, stateManager);

  // Initialize browser session
  log.info('Initializing browser session...');
  await session.init();

  // Initialize monitor
  const monitor = new SlotMonitor(session, slotHistory, stateManager, config);
  const bookingEngine = new BookingEngine(session, slotHistory, stateManager);

  // Connect Telegram to monitor
  telegramBot.setMonitor(monitor);

  // Register slot found handler
  monitor.onSlotsFound(async (slots: SlotCandidate[]) => {
    // Notify about found slots
    await alertManager.alertSlotsFound(slots);

    // Auto-book if enabled
    if (config.autoBook && slots.length > 0) {
      log.info({ slotCount: slots.length }, 'Auto-booking enabled, attempting to book best slot');

      if (config.mode === 'reschedule' && config.currentBookingRef && config.licenceNumber) {
        const result = await bookingEngine.attemptReschedule(
          slots[0],
          config.currentBookingRef,
          config.licenceNumber
        );

        if (result.success) {
          await alertManager.alertBookingSuccess(result);
          // Continue monitoring for even better slots (optional)
        } else {
          await alertManager.alertBookingFailed(result);
        }
      } else if (config.mode === 'new_booking') {
        // For new booking, just alert — full flow needs FormFiller + payment
        await alertManager.alertPaymentRequired();
      }
    }
  });

  // Register error handler
  monitor.onMonitorError(async (error: Error, consecutive: number) => {
    await alertManager.alertMonitorError(error, consecutive);
  });

  // Start Telegram bot
  await telegramBot.start();

  // Start monitoring
  log.info('Starting slot monitor...');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');

    monitor.stop();
    telegramBot.stop();
    await session.close();
    slotHistory.close();
    stateManager.close();

    log.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    log.fatal({ error }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled rejection');
  });

  // Start the monitor (blocking call)
  await monitor.start();
}

main().catch((error) => {
  log.fatal({ error }, 'Fatal error in main');
  process.exit(1);
});

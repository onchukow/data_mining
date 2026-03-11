import { Telegraf, Context } from 'telegraf';
import { createChildLogger } from '../utils/logger';
import { settings } from '../config/settings';
import { Alert, AlertManager } from './alert-manager';
import { SlotHistory } from '../storage/slot-history';
import { BookingStateManager } from '../storage/booking-state';
import { SlotMonitor } from '../core/slot-monitor';
import { getAllCentreNames } from '../config/test-centres';
import fs from 'fs';

const log = createChildLogger('telegram-bot');

/**
 * Telegram bot for user notifications and commands.
 *
 * Commands:
 * /start    — Welcome + setup info
 * /status   — Current monitoring status
 * /centres  — List monitored test centres
 * /add      — Add a test centre
 * /remove   — Remove a test centre
 * /dates    — Show date range
 * /setdates — Change date range
 * /pause    — Pause monitoring
 * /resume   — Resume monitoring
 * /history  — Recent found slots
 * /book     — Enable auto-booking
 * /manual   — Notification-only mode
 * /logs     — Last 20 log lines
 */
export class TelegramBot {
  private bot: Telegraf;
  private chatId: string;
  private alertManager: AlertManager;
  private slotHistory: SlotHistory;
  private stateManager: BookingStateManager;
  private monitor: SlotMonitor | null = null;

  constructor(
    alertManager: AlertManager,
    slotHistory: SlotHistory,
    stateManager: BookingStateManager
  ) {
    this.bot = new Telegraf(settings.telegram.botToken);
    this.chatId = settings.telegram.chatId;
    this.alertManager = alertManager;
    this.slotHistory = slotHistory;
    this.stateManager = stateManager;

    this.registerCommands();
    this.registerAlertHandler();
  }

  /**
   * Set the slot monitor reference for pause/resume commands.
   */
  setMonitor(monitor: SlotMonitor): void {
    this.monitor = monitor;
  }

  /**
   * Start the Telegram bot.
   */
  async start(): Promise<void> {
    if (!settings.telegram.botToken) {
      log.warn('Telegram bot token not configured, skipping');
      return;
    }

    try {
      await this.bot.launch();
      log.info('Telegram bot started');

      // Send startup message
      await this.sendMessage('🤖 DVSA Bot started and monitoring for slots...');
    } catch (error) {
      log.error({ error }, 'Failed to start Telegram bot');
    }
  }

  /**
   * Stop the Telegram bot.
   */
  stop(): void {
    this.bot.stop();
    log.info('Telegram bot stopped');
  }

  /**
   * Send a text message to the configured chat.
   */
  async sendMessage(text: string, options?: { parse_mode?: 'HTML' | 'Markdown' }): Promise<void> {
    if (!this.chatId) return;

    try {
      await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: options?.parse_mode ?? 'HTML',
      });
    } catch (error) {
      log.error({ error }, 'Failed to send Telegram message');
    }
  }

  /**
   * Send a photo (screenshot) to the configured chat.
   */
  async sendScreenshot(filepath: string, caption?: string): Promise<void> {
    if (!this.chatId || !filepath) return;

    try {
      if (fs.existsSync(filepath)) {
        await this.bot.telegram.sendPhoto(
          this.chatId,
          { source: filepath },
          { caption }
        );
      }
    } catch (error) {
      log.error({ error, filepath }, 'Failed to send screenshot');
    }
  }

  private registerCommands(): void {
    // /start
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🤖 <b>DVSA Booking Bot</b>\n\n' +
        'I monitor DVSA for available driving test slots and can auto-book them for you.\n\n' +
        '<b>Commands:</b>\n' +
        '/status — Current monitoring status\n' +
        '/centres — Monitored test centres\n' +
        '/add &lt;centre&gt; — Add a test centre\n' +
        '/remove &lt;centre&gt; — Remove a test centre\n' +
        '/dates — Current date range\n' +
        '/setdates &lt;from&gt; &lt;to&gt; — Change date range\n' +
        '/pause — Pause monitoring\n' +
        '/resume — Resume monitoring\n' +
        '/history — Recent found slots\n' +
        '/book — Enable auto-booking\n' +
        '/manual — Notification only\n' +
        '/logs — Last 20 log lines',
        { parse_mode: 'HTML' }
      );
    });

    // /status
    this.bot.command('status', async (ctx) => {
      const state = this.stateManager.getMonitoringState();
      const booking = this.stateManager.getActiveBooking();
      const stats = this.slotHistory.getStats();

      let statusEmoji = '🔴';
      let statusText = 'Stopped';
      if (state.isRunning && !state.isPaused) {
        statusEmoji = '🟢';
        statusText = 'Running';
      } else if (state.isPaused) {
        statusEmoji = '🟡';
        statusText = 'Paused';
      }

      let message = `${statusEmoji} <b>Status: ${statusText}</b>\n\n`;
      message += `📊 Checks: ${state.checksCount}\n`;
      message += `🔍 Slots found: ${stats.found}\n`;
      message += `✅ Booked: ${stats.booked}\n`;
      message += `❌ Missed: ${stats.missed}\n`;
      message += `⚠️ Errors: ${state.errorsCount}\n`;

      if (state.lastCheckAt) {
        message += `\n🕐 Last check: ${new Date(state.lastCheckAt).toLocaleString('en-GB')}\n`;
      }

      if (booking) {
        message += `\n📋 <b>Current Booking:</b>\n`;
        message += `📍 ${booking.testCentre}\n`;
        message += `📅 ${booking.testDate}\n`;
        message += `⏰ ${booking.testTime}\n`;
        message += `🔖 Ref: ${booking.bookingRef}\n`;
      }

      await ctx.reply(message, { parse_mode: 'HTML' });
    });

    // /centres
    this.bot.command('centres', async (ctx) => {
      const centres = settings.monitor.testCentres;
      const list = centres.map((c, i) => `${i + 1}. ${c}`).join('\n');
      await ctx.reply(
        `📍 <b>Monitored Test Centres:</b>\n\n${list}\n\nUse /add or /remove to modify.`,
        { parse_mode: 'HTML' }
      );
    });

    // /add <centre>
    this.bot.command('add', async (ctx) => {
      const centreName = ctx.message.text.replace('/add', '').trim();
      if (!centreName) {
        const available = getAllCentreNames().slice(0, 10).join('\n');
        await ctx.reply(`Usage: /add Centre Name\n\nAvailable centres:\n${available}\n...`);
        return;
      }

      if (!settings.monitor.testCentres.includes(centreName)) {
        settings.monitor.testCentres.push(centreName);
        this.monitor?.updateConfig({ testCentres: [...settings.monitor.testCentres] });
        await ctx.reply(`✅ Added: ${centreName}`);
      } else {
        await ctx.reply(`Already monitoring: ${centreName}`);
      }
    });

    // /remove <centre>
    this.bot.command('remove', async (ctx) => {
      const centreName = ctx.message.text.replace('/remove', '').trim();
      if (!centreName) {
        await ctx.reply('Usage: /remove Centre Name');
        return;
      }

      const index = settings.monitor.testCentres.indexOf(centreName);
      if (index >= 0) {
        settings.monitor.testCentres.splice(index, 1);
        this.monitor?.updateConfig({ testCentres: [...settings.monitor.testCentres] });
        await ctx.reply(`✅ Removed: ${centreName}`);
      } else {
        await ctx.reply(`Not found: ${centreName}`);
      }
    });

    // /dates
    this.bot.command('dates', async (ctx) => {
      const from = settings.monitor.earliestDate.toISOString().split('T')[0];
      const to = settings.monitor.latestDate.toISOString().split('T')[0];
      await ctx.reply(
        `📅 <b>Date Range:</b>\n\nFrom: ${from}\nTo: ${to}\n\nUse /setdates YYYY-MM-DD YYYY-MM-DD to change.`,
        { parse_mode: 'HTML' }
      );
    });

    // /setdates <from> <to>
    this.bot.command('setdates', async (ctx) => {
      const parts = ctx.message.text.replace('/setdates', '').trim().split(/\s+/);
      if (parts.length !== 2) {
        await ctx.reply('Usage: /setdates 2026-04-01 2026-08-31');
        return;
      }

      const [from, to] = parts;
      const fromDate = new Date(from);
      const toDate = new Date(to);

      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        await ctx.reply('Invalid date format. Use YYYY-MM-DD.');
        return;
      }

      this.monitor?.updateConfig({ earliestDate: fromDate, latestDate: toDate });
      await ctx.reply(`✅ Date range updated: ${from} → ${to}`);
    });

    // /pause
    this.bot.command('pause', async (ctx) => {
      this.monitor?.pause();
      await ctx.reply('⏸ Monitoring paused. Use /resume to continue.');
    });

    // /resume
    this.bot.command('resume', async (ctx) => {
      this.monitor?.resume();
      await ctx.reply('▶️ Monitoring resumed.');
    });

    // /history
    this.bot.command('history', async (ctx) => {
      const slots = this.slotHistory.getRecentSlots(10);
      if (slots.length === 0) {
        await ctx.reply('No slots found yet.');
        return;
      }

      const lines = slots.map(s => {
        const statusEmoji = s.status === 'booked' ? '✅' : s.status === 'missed' ? '❌' : '🔍';
        return `${statusEmoji} ${s.testCentre} | ${s.date} ${s.time} | ${s.status}`;
      });

      await ctx.reply(
        `📜 <b>Recent Slots:</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML' }
      );
    });

    // /book
    this.bot.command('book', async (ctx) => {
      this.monitor?.updateConfig({ autoBook: true });
      await ctx.reply('🤖 Auto-booking ENABLED. Bot will automatically book the best matching slot.');
    });

    // /manual
    this.bot.command('manual', async (ctx) => {
      this.monitor?.updateConfig({ autoBook: false });
      await ctx.reply('📩 Manual mode. Bot will only send notifications — no auto-booking.');
    });

    // /logs
    this.bot.command('logs', async (ctx) => {
      await ctx.reply('📋 Check logs via:\n<code>docker-compose logs -f dvsa-bot --tail=20</code>', {
        parse_mode: 'HTML',
      });
    });
  }

  private registerAlertHandler(): void {
    this.alertManager.onAlert(async (alert: Alert) => {
      const priorityEmoji: Record<string, string> = {
        critical: '🔴',
        high: '🟠',
        medium: '🟡',
        low: '🔵',
        info: 'ℹ️',
      };

      const emoji = priorityEmoji[alert.priority] ?? '';
      const message = `${emoji} <b>${alert.title}</b>\n\n${alert.message}`;

      await this.sendMessage(message);

      // Send screenshot if available
      const screenshotPath = alert.data?.screenshotPath as string | undefined;
      if (screenshotPath) {
        await this.sendScreenshot(screenshotPath, alert.title);
      }
    });
  }
}

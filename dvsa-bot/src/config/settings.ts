import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export type TestType = 'car' | 'motorcycle' | 'lgv' | 'pcv';
export type BotMode = 'reschedule' | 'new_booking';
export type CaptchaService = '2captcha' | 'capsolver';
export type ProxyType = 'residential' | 'mobile';

export interface TimeRange {
  start: string; // HH:MM
  end: string;   // HH:MM
}

export interface MonitorConfig {
  testCentres: string[];
  earliestDate: Date;
  latestDate: Date;
  preferredDays: DayOfWeek[];
  preferredTimeSlots: TimeRange[];
  checkIntervalMs: number;
  jitterMs: number;
  mode: BotMode;
  autoBook: boolean;
  currentBookingRef?: string;
  licenceNumber?: string;
}

export interface ApplicantDetails {
  title: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  postcode: string;
  licenceNumber: string;
  instructorPrn?: string;
}

export interface PaymentDetails {
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  cardholderName: string;
  billingAddress: {
    line1: string;
    city: string;
    postcode: string;
    country: 'GB';
  };
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}

function parseDays(raw: string): DayOfWeek[] {
  const valid: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return raw
    .split(',')
    .map(d => d.trim().toLowerCase() as DayOfWeek)
    .filter(d => valid.includes(d));
}

export const settings = {
  dvsa: {
    licenceNumber: getEnv('DVSA_LICENCE_NUMBER', ''),
    bookingRef: getEnvOptional('DVSA_BOOKING_REF'),
    changeBookingUrl: 'https://www.gov.uk/change-driving-test',
    newBookingUrl: 'https://www.gov.uk/book-driving-test',
  },

  applicant: {
    title: getEnv('APPLICANT_TITLE', 'Mr'),
    firstName: getEnv('APPLICANT_FIRST_NAME', ''),
    lastName: getEnv('APPLICANT_LAST_NAME', ''),
    dateOfBirth: new Date(getEnv('APPLICANT_DOB', '1990-01-01')),
    postcode: getEnv('APPLICANT_POSTCODE', ''),
    instructorPrn: getEnvOptional('INSTRUCTOR_PRN'),
  },

  monitor: {
    testCentres: getEnv('TEST_CENTRES', 'London (Morden)').split(',').map(s => s.trim()),
    earliestDate: new Date(getEnv('EARLIEST_DATE', new Date().toISOString().split('T')[0])),
    latestDate: new Date(getEnv('LATEST_DATE', '2026-12-31')),
    preferredDays: parseDays(getEnv('PREFERRED_DAYS', 'monday,tuesday,wednesday,thursday,friday')),
    preferredTimeSlots: [{
      start: getEnv('PREFERRED_TIME_START', '08:00'),
      end: getEnv('PREFERRED_TIME_END', '17:00'),
    }] as TimeRange[],
    checkIntervalMs: parseInt(getEnv('CHECK_INTERVAL_MS', '75000'), 10),
    jitterMs: 15000,
    mode: getEnv('MODE', 'reschedule') as BotMode,
    autoBook: getEnv('AUTO_BOOK', 'false') === 'true',
    testType: getEnv('TEST_TYPE', 'car') as TestType,
  },

  telegram: {
    botToken: getEnv('TELEGRAM_BOT_TOKEN', ''),
    chatId: getEnv('TELEGRAM_CHAT_ID', ''),
  },

  captcha: {
    apiKey: getEnv('CAPTCHA_API_KEY', ''),
    service: getEnv('CAPTCHA_SERVICE', '2captcha') as CaptchaService,
  },

  proxy: {
    url: getEnvOptional('PROXY_URL'),
    type: getEnv('PROXY_TYPE', 'residential') as ProxyType,
  },

  logging: {
    level: getEnv('LOG_LEVEL', 'info'),
    screenshotDir: getEnv('SCREENSHOT_DIR', '/tmp/screenshots'),
  },

  // DVSA maintenance window: Sunday 00:00-06:00 GMT
  maintenance: {
    dayOfWeek: 0, // Sunday
    startHour: 0,
    endHour: 6,
  },

  // Session timeout ~20 minutes
  session: {
    timeoutMs: 18 * 60 * 1000, // 18 min to be safe
    maxRetries: 3,
  },

  // Rate limiting safety
  rateLimit: {
    minIntervalMs: 45000,
    maxIntervalMs: 120000,
    nightModeMultiplier: 3, // 3x interval during 00:00-06:00
    nightStartHour: 0,
    nightEndHour: 6,
    peakStartHours: [6, 17],  // Peak cancellation hours
    peakEndHours: [9, 20],
  },
} as const;

export function getMonitorConfig(): MonitorConfig {
  return {
    testCentres: [...settings.monitor.testCentres],
    earliestDate: settings.monitor.earliestDate,
    latestDate: settings.monitor.latestDate,
    preferredDays: [...settings.monitor.preferredDays],
    preferredTimeSlots: [...settings.monitor.preferredTimeSlots],
    checkIntervalMs: settings.monitor.checkIntervalMs,
    jitterMs: settings.monitor.jitterMs,
    mode: settings.monitor.mode,
    autoBook: settings.monitor.autoBook,
    currentBookingRef: settings.dvsa.bookingRef,
    licenceNumber: settings.dvsa.licenceNumber,
  };
}

export function isMaintenanceWindow(): boolean {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  return utcDay === settings.maintenance.dayOfWeek &&
    utcHour >= settings.maintenance.startHour &&
    utcHour < settings.maintenance.endHour;
}

export function isNightMode(): boolean {
  const hour = new Date().getUTCHours();
  return hour >= settings.rateLimit.nightStartHour && hour < settings.rateLimit.nightEndHour;
}

export function isPeakCancellationHour(): boolean {
  const hour = new Date().getUTCHours();
  return settings.rateLimit.peakStartHours.some((start, i) =>
    hour >= start && hour < settings.rateLimit.peakEndHours[i]
  );
}

export function getEffectiveInterval(): number {
  let interval = settings.monitor.checkIntervalMs;
  if (isNightMode()) {
    interval *= settings.rateLimit.nightModeMultiplier;
  }
  // Add jitter: ±jitterMs
  const jitter = (Math.random() * 2 - 1) * settings.monitor.jitterMs;
  return Math.max(settings.rateLimit.minIntervalMs, interval + jitter);
}

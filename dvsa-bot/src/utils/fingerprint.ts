import { createChildLogger } from './logger';

const log = createChildLogger('fingerprint');

export interface BrowserFingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  colorScheme: 'light' | 'dark' | 'no-preference';
  deviceScaleFactor: number;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1680, height: 1050 },
  { width: 2560, height: 1440 },
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a randomized but realistic browser fingerprint.
 * Keeps locale as en-GB and timezone as Europe/London (UK-specific).
 */
export function generateFingerprint(): BrowserFingerprint {
  const fingerprint: BrowserFingerprint = {
    userAgent: randomChoice(USER_AGENTS),
    viewport: randomChoice(VIEWPORTS),
    locale: 'en-GB',                    // Always UK
    timezoneId: 'Europe/London',        // Always UK
    colorScheme: randomChoice(['light', 'dark', 'no-preference'] as const),
    deviceScaleFactor: randomChoice([1, 1, 1, 2]), // Most common is 1
  };

  log.debug({ fingerprint }, 'Generated browser fingerprint');
  return fingerprint;
}

/**
 * Apply anti-detection measures via page.evaluate().
 * Hides common automation indicators.
 */
export function getStealthScripts(): string {
  return `
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // Override chrome detection
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : originalQuery(parameters);

    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-GB', 'en-US', 'en'],
    });

    // Override platform consistency
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
    });
  `;
}

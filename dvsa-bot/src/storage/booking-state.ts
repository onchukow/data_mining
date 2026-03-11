import Database from 'better-sqlite3';
import path from 'path';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('booking-state');

export interface BookingState {
  bookingRef: string;
  licenceNumber: string;
  testCentre: string;
  testDate: string;       // ISO date
  testTime: string;       // HH:MM
  status: 'active' | 'rescheduled' | 'cancelled';
  lastChecked: string;    // ISO timestamp
  createdAt: string;      // ISO timestamp
}

export interface MonitoringState {
  isRunning: boolean;
  isPaused: boolean;
  lastCheckAt: string | null;
  checksCount: number;
  errorsCount: number;
  consecutiveErrors: number;
  slotsFoundCount: number;
}

export class BookingStateManager {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.resolve(__dirname, '../../data/state.db');
    this.db = new Database(resolvedPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS booking_state (
        booking_ref TEXT PRIMARY KEY,
        licence_number TEXT NOT NULL,
        test_centre TEXT NOT NULL,
        test_date TEXT NOT NULL,
        test_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_checked TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS monitoring_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    log.info('Booking state database initialized');
  }

  // Booking management

  saveBooking(booking: Omit<BookingState, 'lastChecked' | 'createdAt'>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO booking_state (booking_ref, licence_number, test_centre, test_date, test_time, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(booking.bookingRef, booking.licenceNumber, booking.testCentre, booking.testDate, booking.testTime, booking.status);
    log.info({ booking }, 'Booking saved');
  }

  getActiveBooking(): BookingState | null {
    const stmt = this.db.prepare(`
      SELECT booking_ref as bookingRef, licence_number as licenceNumber,
             test_centre as testCentre, test_date as testDate, test_time as testTime,
             status, last_checked as lastChecked, created_at as createdAt
      FROM booking_state
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return (stmt.get() as BookingState) ?? null;
  }

  updateBookingDate(bookingRef: string, newDate: string, newTime: string, newCentre?: string): void {
    const stmt = this.db.prepare(`
      UPDATE booking_state
      SET test_date = ?, test_time = ?, test_centre = COALESCE(?, test_centre), last_checked = datetime('now')
      WHERE booking_ref = ?
    `);
    stmt.run(newDate, newTime, newCentre ?? null, bookingRef);
    log.info({ bookingRef, newDate, newTime, newCentre }, 'Booking date updated');
  }

  markRescheduled(bookingRef: string): void {
    const stmt = this.db.prepare(`
      UPDATE booking_state SET status = 'rescheduled' WHERE booking_ref = ?
    `);
    stmt.run(bookingRef);
  }

  // Monitoring state

  getMonitoringState(): MonitoringState {
    const defaults: MonitoringState = {
      isRunning: false,
      isPaused: false,
      lastCheckAt: null,
      checksCount: 0,
      errorsCount: 0,
      consecutiveErrors: 0,
      slotsFoundCount: 0,
    };

    const stmt = this.db.prepare('SELECT key, value FROM monitoring_state');
    const rows = stmt.all() as { key: string; value: string }[];

    for (const row of rows) {
      if (row.key in defaults) {
        const key = row.key as keyof MonitoringState;
        if (typeof defaults[key] === 'boolean') {
          (defaults as Record<string, unknown>)[key] = row.value === 'true';
        } else if (typeof defaults[key] === 'number') {
          (defaults as Record<string, unknown>)[key] = parseInt(row.value, 10);
        } else {
          (defaults as Record<string, unknown>)[key] = row.value;
        }
      }
    }

    return defaults;
  }

  setMonitoringValue(key: keyof MonitoringState, value: string | number | boolean): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO monitoring_state (key, value) VALUES (?, ?)
    `);
    stmt.run(key, String(value));
  }

  incrementCounter(key: 'checksCount' | 'errorsCount' | 'consecutiveErrors' | 'slotsFoundCount'): void {
    const state = this.getMonitoringState();
    this.setMonitoringValue(key, state[key] + 1);
  }

  resetConsecutiveErrors(): void {
    this.setMonitoringValue('consecutiveErrors', 0);
  }

  /**
   * Check if the current booking is within 3 working days (cannot reschedule).
   */
  isBookingTooSoon(bookingRef?: string): boolean {
    const booking = bookingRef
      ? this.getBookingByRef(bookingRef)
      : this.getActiveBooking();

    if (!booking) return false;

    const testDate = new Date(booking.testDate);
    const now = new Date();
    let workingDays = 0;
    const current = new Date(now);

    while (current < testDate) {
      current.setDate(current.getDate() + 1);
      const day = current.getDay();
      if (day !== 0 && day !== 6) {
        workingDays++;
      }
    }

    return workingDays < 3;
  }

  private getBookingByRef(ref: string): BookingState | null {
    const stmt = this.db.prepare(`
      SELECT booking_ref as bookingRef, licence_number as licenceNumber,
             test_centre as testCentre, test_date as testDate, test_time as testTime,
             status, last_checked as lastChecked, created_at as createdAt
      FROM booking_state
      WHERE booking_ref = ?
    `);
    return (stmt.get(ref) as BookingState) ?? null;
  }

  close(): void {
    this.db.close();
    log.info('Booking state database closed');
  }
}

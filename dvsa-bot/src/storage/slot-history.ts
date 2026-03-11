import Database from 'better-sqlite3';
import path from 'path';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('slot-history');

export interface SlotRecord {
  id?: number;
  testCentre: string;
  date: string;         // ISO date: YYYY-MM-DD
  time: string;         // HH:MM
  foundAt: string;      // ISO timestamp
  status: 'found' | 'booked' | 'missed' | 'skipped';
  bookingRef?: string;
}

export class SlotHistory {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.resolve(__dirname, '../../data/slots.db');
    this.db = new Database(resolvedPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slot_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_centre TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        found_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'found',
        booking_ref TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_slot_date ON slot_history(date);
      CREATE INDEX IF NOT EXISTS idx_slot_centre ON slot_history(test_centre);
      CREATE INDEX IF NOT EXISTS idx_slot_status ON slot_history(status);
    `);
    log.info('Slot history database initialized');
  }

  recordSlot(slot: Omit<SlotRecord, 'id' | 'foundAt'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO slot_history (test_centre, date, time, status, booking_ref)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(slot.testCentre, slot.date, slot.time, slot.status, slot.bookingRef ?? null);
    log.info({ slot, id: result.lastInsertRowid }, 'Slot recorded');
    return result.lastInsertRowid as number;
  }

  updateStatus(id: number, status: SlotRecord['status'], bookingRef?: string): void {
    const stmt = this.db.prepare(`
      UPDATE slot_history SET status = ?, booking_ref = COALESCE(?, booking_ref) WHERE id = ?
    `);
    stmt.run(status, bookingRef ?? null, id);
    log.info({ id, status, bookingRef }, 'Slot status updated');
  }

  getRecentSlots(limit: number = 20): SlotRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, test_centre as testCentre, date, time, found_at as foundAt, status, booking_ref as bookingRef
      FROM slot_history
      ORDER BY found_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as SlotRecord[];
  }

  hasSlotBeenSeen(testCentre: string, date: string, time: string): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM slot_history
      WHERE test_centre = ? AND date = ? AND time = ?
    `);
    const row = stmt.get(testCentre, date, time) as { count: number };
    return row.count > 0;
  }

  getBookedSlots(): SlotRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, test_centre as testCentre, date, time, found_at as foundAt, status, booking_ref as bookingRef
      FROM slot_history
      WHERE status = 'booked'
      ORDER BY date ASC
    `);
    return stmt.all() as SlotRecord[];
  }

  getStats(): { total: number; booked: number; missed: number; found: number } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed,
        SUM(CASE WHEN status = 'found' THEN 1 ELSE 0 END) as found
      FROM slot_history
    `);
    return stmt.get() as { total: number; booked: number; missed: number; found: number };
  }

  close(): void {
    this.db.close();
    log.info('Slot history database closed');
  }
}

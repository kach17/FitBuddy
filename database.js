import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

let db;
// In-memory store for pending sessions (RAM)
const pendingSessions = new Map();

export async function initDB() {
  const SQL = await initSqlJs();
  
  if (existsSync('fitness.db')) {
    db = new SQL.Database(readFileSync('fitness.db'));
  } else {
    db = new SQL.Database();
  }
  
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      last_activity_type TEXT,
      default_city TEXT,
      stats TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      location TEXT,
      city TEXT,
      message_id TEXT,
      thread_id TEXT
    );
    CREATE TABLE IF NOT EXISTS attendance (
      event_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
  `);
  
  try { db.run(`ALTER TABLE users ADD COLUMN stats TEXT DEFAULT '{}'`); } catch (e) {}
  try { db.run(`DROP TABLE IF EXISTS pending_sessions;`); } catch(e) {}

  saveDB();
}

function saveDB() {
  writeFileSync('fitness.db', db.export());
}

function queryObj(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];
  return result[0].values.map(row => 
    result[0].columns.reduce((obj, col, idx) => { obj[col] = row[idx]; return obj; }, {})
  );
}

// -----------------------------
// In-Memory Session Management
// -----------------------------
export const savePendingSession = (sessionId, hostId, activity, timestamp, location, city) => 
  pendingSessions.set(sessionId, { sessionId, hostId, activity, timestamp, location, city, createdAt: Date.now() });

export const getPendingSession = id => pendingSessions.get(id) || null;

export const updatePendingSession = (id, updates) => {
  const s = pendingSessions.get(id);
  if (s) Object.assign(s, updates);
};

export const deletePendingSession = id => pendingSessions.delete(id);

export function cleanOldSessions() {
  const old = Date.now() - 3600000;
  for (const [id, s] of pendingSessions) {
    if (s.createdAt < old) pendingSessions.delete(id);
  }
}

// -----------------------------
// Core Database Operations
// -----------------------------

function getUserStateObj(userId) {
  const res = queryObj('SELECT stats FROM users WHERE user_id = ?', [userId]);
  if (res.length === 0) {
    db.run('INSERT OR IGNORE INTO users (user_id) VALUES (?)', [userId]);
    return {};
  }
  try { return JSON.parse(res[0].stats || '{}'); } catch { return {}; }
}

function saveUserStateObj(userId, stats) {
  db.run('UPDATE users SET stats = ? WHERE user_id = ?', [JSON.stringify(stats), userId]);
  saveDB();
}

export const getUserDefaults = userId => queryObj('SELECT last_activity_type, default_city FROM users WHERE user_id = ?', [userId])[0] || null;

export function saveUserDefaults(userId, activity, city) {
  db.run(`
    INSERT INTO users (user_id, last_activity_type, default_city) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_activity_type = excluded.last_activity_type, default_city = excluded.default_city
  `, [userId, activity, city]);
  saveDB();
}

export function saveUserPreference(userId, activity, tag) {
  let stats = getUserStateObj(userId);
  stats.preference = stats.preference || {};
  stats.preference[activity] = tag;
  saveUserStateObj(userId, stats);
}

export function incrementUserStat(userId, category, activityType) {
  let stats = getUserStateObj(userId);
  stats[category] = stats[category] || {};
  stats[category][activityType] = (stats[category][activityType] || 0) + 1;
  saveUserStateObj(userId, stats);
}

export const getUserStats = userId => getUserStateObj(userId);

export function createEvent(hostId, activity, timestamp, location, city) {
  db.run(`INSERT INTO events (host_id, activity_type, timestamp, location, city) VALUES (?, ?, ?, ?, ?)`, 
    [hostId, activity, timestamp, location, city]);
  const eventId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  incrementUserStat(hostId, 'hosted', activity);
  return eventId;
}

export function updateEventDiscordIds(eventId, messageId, threadId) {
  db.run(`UPDATE events SET message_id = ?, thread_id = ? WHERE event_id = ?`, [messageId, threadId, eventId]);
  saveDB();
}

export function deleteEvent(eventId) {
  db.run(`DELETE FROM attendance WHERE event_id = ?`, [eventId]);
  db.run(`DELETE FROM events WHERE event_id = ?`, [eventId]);
  saveDB();
}

export const getActiveEvents = () => queryObj(`SELECT * FROM events`);

export function getEventParticipants(eventId) {
  const events = queryObj(`SELECT activity_type FROM events WHERE event_id = ?`, [eventId]);
  if (events.length === 0) return [];
  
  return queryObj(`SELECT user_id FROM attendance WHERE event_id = ?`, [eventId]).map(({ user_id }) => {
    const stats = getUserStats(user_id);
    const totalAttended = Object.values(stats.attended || {}).reduce((sum, val) => sum + val, 0);
    return {
      userId: user_id,
      totalAttended,
      vibe: stats.preference?.[events[0].activity_type] || stats.tribe?.[events[0].activity_type] || null
    };
  });
}

export function logAttendance(eventId, userId) {
  try {
    db.run(`INSERT INTO attendance (event_id, user_id) VALUES (?, ?)`, [eventId, userId]);
    const events = queryObj(`SELECT activity_type FROM events WHERE event_id = ?`, [eventId]);
    if (events.length > 0) incrementUserStat(userId, 'attended', events[0].activity_type);
    else saveDB();
    return true;
  } catch { return false; }
}

export function removeAttendance(eventId, userId) {
  try {
    db.run(`DELETE FROM attendance WHERE event_id = ? AND user_id = ?`, [eventId, userId]);
    const events = queryObj(`SELECT activity_type FROM events WHERE event_id = ?`, [eventId]);
    if (events.length > 0) {
      let stats = getUserStateObj(userId);
      if (stats.attended?.[events[0].activity_type] > 0) {
        stats.attended[events[0].activity_type]--;
        saveUserStateObj(userId, stats);
      }
    }
    saveDB();
    return true;
  } catch { return false; }
}

export const getEventAttendanceCount = eventId => 
  queryObj(`SELECT COUNT(*) as count FROM attendance WHERE event_id = ?`, [eventId])[0]?.count || 0;

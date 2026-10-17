const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "history.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    filename TEXT,
    determination TEXT,
    summary TEXT,
    result TEXT,
    review TEXT,
    reviewedAt TEXT
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO history (id, timestamp, filename, determination, summary, result, review, reviewedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectAllStmt = db.prepare(`SELECT * FROM history ORDER BY timestamp DESC`);
const selectOneStmt = db.prepare(`SELECT * FROM history WHERE id = ?`);
const updateReviewStmt = db.prepare(`UPDATE history SET review = ?, reviewedAt = ? WHERE id = ?`);
const trimStmt = db.prepare(`
  DELETE FROM history WHERE id NOT IN (
    SELECT id FROM history ORDER BY timestamp DESC LIMIT ?
  )
`);

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    filename: row.filename,
    determination: row.determination,
    summary: row.summary,
    result: row.result ? JSON.parse(row.result) : null,
    review: row.review,
    reviewedAt: row.reviewedAt,
  };
}

function insertHistory(entry) {
  insertStmt.run(
    entry.id,
    entry.timestamp,
    entry.filename,
    entry.determination,
    entry.summary,
    JSON.stringify(entry.result),
    entry.review,
    entry.reviewedAt
  );
}

function getAllHistory() {
  return selectAllStmt.all().map(rowToEntry);
}

function getHistoryById(id) {
  return rowToEntry(selectOneStmt.get(id));
}

function updateReview(id, review, reviewedAt) {
  updateReviewStmt.run(review, reviewedAt, id);
  return getHistoryById(id);
}

function trimHistory(maxRows) {
  trimStmt.run(maxRows);
}

module.exports = {
  insertHistory,
  getAllHistory,
  getHistoryById,
  updateReview,
  trimHistory,
};

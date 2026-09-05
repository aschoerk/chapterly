const crypto = require('crypto');
const { argon2id, argon2Verify } = require('hash-wasm');
const db = require('./db');

const ARGON2_OPTIONS = {
  parallelism: 1,
  iterations: process.env.NODE_ENV === 'test' ? 1 : 2,
  memorySize: process.env.NODE_ENV === 'test' ? 4096 : 19456,
  hashLength: 32,
  outputType: 'encoded'
};

function normalizeOptional(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    phoneNumber: row.phone_number || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return argon2id({
    password,
    salt,
    ...ARGON2_OPTIONS
  });
}

async function verifyPassword(hash, password) {
  if (!hash || !password) return false;
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

function assertUserExists(userId) {
  if (userId === undefined || userId === null || userId === '') return true;
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  return !!row;
}

function findUserByLogin({ username, email, phoneNumber }) {
  const uname = normalizeOptional(username);
  const mail = normalizeOptional(email);
  const phone = normalizeOptional(phoneNumber);

  if (uname) {
    const byName = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (byName) return byName;
  }
  if (mail) {
    const byMail = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(mail);
    if (byMail) return byMail;
  }
  if (phone) {
    const byPhone = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phone);
    if (byPhone) return byPhone;
  }
  return null;
}

function findConflictingUser({ username, email, phoneNumber, excludeId }) {
  const uname = normalizeOptional(username);
  const mail = normalizeOptional(email);
  const phone = normalizeOptional(phoneNumber);

  if (uname) {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (row && row.id !== excludeId) return { field: 'username', row };
  }
  if (mail) {
    const row = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(mail);
    if (row && row.id !== excludeId) return { field: 'email', row };
  }
  if (phone) {
    const row = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phone);
    if (row && row.id !== excludeId) return { field: 'phoneNumber', row };
  }
  return null;
}

module.exports = {
  ARGON2_OPTIONS,
  normalizeOptional,
  mapUser,
  hashPassword,
  verifyPassword,
  assertUserExists,
  findUserByLogin,
  findConflictingUser
};

/**
 * ODBC-Connector für sellify OnTour.
 * Verwaltet einen Connection-Pool pro Profil.
 *
 * Profil-Objekt:
 *   { id: string, dsn: string, database: string }
 */

let odbc;
try { odbc = require('odbc'); } catch {
  // odbc ist eine optionale native Abhängigkeit – nur nötig wenn ODBC genutzt wird
}

// Pool-Cache und Initialisierungssperren: profileId → Pool / Promise
const _pools = {};
const _locks = {};

function connString(profile) {
  return `DSN=${profile.dsn};DATABASE=${profile.database};`;
}

function requireOdbc() {
  if (!odbc) throw new Error('Das npm-Paket "odbc" ist nicht installiert. Bitte mit "npm install odbc" nachinstallieren.');
}

async function getPool(profile) {
  requireOdbc();
  if (_pools[profile.id]) return _pools[profile.id];

  if (!_locks[profile.id]) {
    _locks[profile.id] = (async () => {
      if (_pools[profile.id]) return;
      _pools[profile.id] = await odbc.pool({
        connectionString: connString(profile),
        initialSize:   2,
        incrementSize: 2,
        maxSize:       10,
      });
    })().finally(() => { delete _locks[profile.id]; });
  }

  await _locks[profile.id];
  return _pools[profile.id];
}

/**
 * Führt eine SQL-Abfrage aus.
 * @param {object} profile  Verbindungsprofil { id, dsn, database }
 * @param {string} sql      SQL-Abfrage mit ? als Platzhalter
 * @param {any[]}  params   Parameter
 */
async function query(profile, sql, params = []) {
  const pool = await getPool(profile);
  return pool.query(sql, params);
}

/**
 * Testet eine Verbindung ohne den Pool zu verwenden.
 * @returns {Promise<string>} Tatsächlicher Datenbankname
 */
async function testConnection(profile) {
  requireOdbc();
  const conn = await odbc.connect(connString(profile));
  const rows = await conn.query('SELECT DB_NAME() AS db');
  await conn.close();
  return rows[0]?.db || profile.database;
}

/**
 * Schließt den Pool für ein Profil (z. B. beim Profilwechsel).
 */
async function closePool(profile) {
  if (_pools[profile.id]) {
    try { await _pools[profile.id].close(); } catch {}
    delete _pools[profile.id];
  }
}

module.exports = { query, testConnection, closePool };

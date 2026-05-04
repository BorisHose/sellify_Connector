/**
 * sellify-connector
 *
 * Stellt zwei unabhängige Verbindungstypen bereit:
 *   - odbc: direkter SQL-Zugriff via ODBC-DSN
 *   - rest: Zugriff über die sellify OnTour REST API
 *
 * Beide Module nehmen ein Profil-Objekt entgegen – die Konfiguration
 * (welches Profil aktiv ist, wo Credentials gespeichert werden) bleibt
 * vollständig in der aufrufenden Anwendung.
 */

const odbc = require('./src/odbc');
const rest = require('./src/rest');

module.exports = { odbc, rest };

# sellify-connector

Node.js-Paket für den Zugriff auf **sellify OnTour** – wahlweise über ODBC (direkter SQL-Zugriff) oder über die **sellify REST API**.

Die Konfiguration (Zugangsdaten, Profilauswahl) liegt vollständig in deiner Anwendung. Das Paket stellt nur die Verbindungslogik bereit.

---

## Installation

```bash
npm install git+https://github.com/<euer-org>/sellify-connector.git
```

Nur bei Nutzung des ODBC-Connectors zusätzlich:

```bash
npm install odbc
```

---

## Verwendung

### REST-Verbindung

```js
const { rest } = require('sellify-connector');

const profile = {
  id:        'meine-app',          // frei wählbar, dient als Cache-Schlüssel
  baseUrl:   'https://mein-server:4714',
  username:  'BENUTZERNAME',
  password:  'PASSWORT',
  client_Id: 'App',                // von der API vergeben – bei Bedarf weglassen
};

// Verbindung testen
await rest.testConnection(profile);

// Kontakte laden
const kontakte = await rest.getContacts(profile);
// → [{ id, name, city, address, associate, category, ... }, ...]

// Einzelnen Kontakt mit Personen laden
const kontakt = await rest.getContact(profile, 42);
// → { id, name, phones, emails, persons: [...], ... }

// Personen
const personen = await rest.getPersons(profile);

// Projekte
const projekte = await rest.getProjects(profile);

// Mitarbeiter (Benutzer)
const mitarbeiter = await rest.getAssociates(profile);

// Personen-Foto als Buffer
const foto = await rest.getPersonPhoto(profile, 15);
if (foto) {
  // foto.data        → Buffer
  // foto.contentType → 'image/jpeg'
}
```

#### Eigene / custom Endpunkte

Für Endpunkte, die nicht durch die Standard-Funktionen abgedeckt sind:

```js
// Einzelner Request
const result = await rest.get(profile, '/my-custom-endpoint', { param1: 'wert' });

// Paginiert (alle Seiten automatisch)
const all = await rest.getAll(profile, '/my-custom-list', { filter: 'aktiv' });
```

---

### ODBC-Verbindung

Erfordert einen konfigurierten ODBC-DSN auf dem System sowie das npm-Paket `odbc`.

```js
const { odbc } = require('sellify-connector');

const profile = {
  id:       'meine-db',           // frei wählbar, dient als Pool-Schlüssel
  dsn:      'sellify_boris',      // ODBC-DSN-Name
  database: 'sellifyOnTour_Boris',
};

// Verbindung testen
const dbName = await odbc.testConnection(profile);

// SQL-Abfrage
const rows = await odbc.query(profile, 'SELECT * FROM contact WHERE contact_id = ?', [42]);

// Pool schließen (z. B. beim Beenden der App oder Profilwechsel)
await odbc.closePool(profile);
```

---

## Profil-Objekte

### REST-Profil

| Feld        | Typ    | Pflicht | Beschreibung                              |
|-------------|--------|---------|-------------------------------------------|
| `id`        | string | ja      | Eindeutige ID (Cache-Schlüssel)           |
| `baseUrl`   | string | ja      | Basis-URL der API inkl. Port              |
| `username`  | string | ja      | Benutzername                              |
| `password`  | string | ja      | Passwort                                  |
| `client_Id` | string | nein    | Client-Identifier, von API vergeben       |

### ODBC-Profil

| Feld       | Typ    | Pflicht | Beschreibung                              |
|------------|--------|---------|-------------------------------------------|
| `id`       | string | ja      | Eindeutige ID (Pool-Schlüssel)            |
| `dsn`      | string | ja      | ODBC-DSN-Name (Systemdatenquelle)         |
| `database` | string | ja      | Datenbankname                             |

---

## Hinweise

- **Token-Cache**: Der REST-Connector cached den Bearer-Token im Speicher und erneuert ihn automatisch vor Ablauf oder bei HTTP 401.
- **Login-Sperre**: Parallele Anfragen beim Start lösen nur einen einzigen Login-Request aus – alle weiteren warten auf dessen Ergebnis.
- **Rate-Limiting (429)**: Bei HTTP 429 wartet der Connector 6 Sekunden und versucht es bis zu 3-mal erneut.
- **Timeout**: Alle HTTP-Requests haben ein Timeout von 30 Sekunden.
- **ODBC-Pool**: Pro Profil-ID wird ein eigener Connection-Pool verwaltet. Das Paket `odbc` muss nur installiert sein, wenn ODBC tatsächlich genutzt wird.
- **self-signed Zertifikate**: Werden für die REST-Verbindung akzeptiert (`rejectUnauthorized: false`).

---

## Versionierung

Dieses Paket folgt [Semantic Versioning](https://semver.org/lang/de/).  
Breaking Changes führen zu einer Major-Version (z. B. `1.x.x` → `2.0.0`).  
Neue Features und Bugfixes erhöhen Minor bzw. Patch.

Um eine bestimmte Version zu verwenden:

```json
"sellify-connector": "github:<euer-org>/sellify-connector#v1.0.0"
```

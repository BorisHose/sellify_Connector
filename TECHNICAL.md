# Technische Beschreibung – sellify-connector

## Überblick

`sellify-connector` ist ein **Node.js-Bibliothekspaket** für den Zugriff auf sellify OnTour-Daten. Es abstrahiert zwei grundlegend unterschiedliche Verbindungswege hinter einer einheitlichen API: direkten Datenbankzugriff via ODBC und den Zugriff über die sellify REST API.

---

## Programmiersprache und Laufzeitumgebung

| Eigenschaft       | Wert                          |
|-------------------|-------------------------------|
| Sprache           | JavaScript (CommonJS)         |
| Laufzeit          | Node.js ≥ 16                  |
| Modulsystem       | CommonJS (`require` / `module.exports`) |
| Paketmanager      | npm                           |
| Native Abhängigkeit | `odbc` (optional, nur für ODBC-Verbindungen) |

Es werden ausschließlich Node.js-Boardmittel (`https`, `http`) sowie das optionale native Modul `odbc` verwendet. Es gibt keine weiteren Laufzeitabhängigkeiten.

---

## Architektur

Das Paket folgt einer **zweischichtigen Modularchitektur**:

```
index.js
├── src/odbc.js      ODBC-Connector
└── src/rest.js      REST-Connector
```

Beide Module sind vollständig voneinander unabhängig. Der Einstiegspunkt `index.js` re-exportiert sie unter den Schlüsseln `odbc` und `rest`.

### Designprinzip: Profil als Parameter

Beide Connectoren halten keinen eigenen globalen Konfigurationszustand. Alle Funktionen erwarten ein **Profil-Objekt** als ersten Parameter. Die aufrufende Anwendung ist verantwortlich für die Konfigurationsverwaltung (Speicherort, Auswahl des aktiven Profils). Das erlaubt den gleichzeitigen Betrieb mehrerer Verbindungen innerhalb derselben Anwendung.

---

## Modul: `src/odbc.js`

### Zweck
Direkter SQL-Zugriff auf eine sellify-OnTour-Datenbank über einen ODBC-DSN.

### Abhängigkeit
Das npm-Paket `odbc` wird lazy geladen – ein `require`-Fehler wird nur ausgelöst, wenn ODBC-Funktionen tatsächlich aufgerufen werden.

### Kernmuster: Pool-Cache mit Initialisierungssperre

Pro Profil-ID wird genau ein Connection-Pool angelegt und im Speicher gehalten. Eine asynchrone Sperre (`_locks`) verhindert, dass parallele Aufrufe mehrere Pools für dieselbe Verbindung initialisieren.

```
Aufruf query(profile, sql)
    │
    ▼
_pools[profile.id] vorhanden?
    ├── ja  → Pool direkt verwenden
    └── nein → _locks[profile.id] vorhanden?
                   ├── ja  → warten bis Lock aufgelöst
                   └── nein → neuen Pool anlegen (Lock setzen → Pool erstellen → Lock freigeben)
```

### Öffentliche Funktionen

| Funktion | Beschreibung |
|---|---|
| `query(profile, sql, params)` | Führt eine parametrisierte SQL-Abfrage aus |
| `testConnection(profile)` | Öffnet eine Einzelverbindung, fragt `DB_NAME()` ab, schließt sie |
| `closePool(profile)` | Schließt den Pool für ein Profil (z. B. bei Profilwechsel) |

---

## Modul: `src/rest.js`

### Zweck
Zugriff auf sellify OnTour über die HTTP-REST-API. Übernimmt Authentifizierung, Token-Verwaltung, Paginierung und Datenmapping.

### HTTP-Schicht

Alle HTTP-Anfragen laufen über zwei interne Funktionen:

- **`rawRequest`** – JSON-Requests (GET/POST), 30-Sekunden-Timeout, unterstützt Query-Parameter und Request-Body, akzeptiert self-signed TLS-Zertifikate.
- **`rawBinaryRequest`** – Binäre Antworten (Bilder), gibt `Buffer` + `contentType` zurück.

Beide Funktionen sind nicht exportiert und gelten als interne Implementierungsdetails.

### Authentifizierung: OAuth2 Password Grant

Die API verwendet OAuth2 mit dem `password`-Grant-Type. Der Login-Endpunkt erwartet:

```
POST /login
{ grant_type: "password", username, password, client_Id? }
```

Bei Erfolg liefert die API ein `access_token` mit einer Gültigkeitsdauer (`expires_in`). Das Token wird als Bearer-Token in allen Folgeaufrufen mitgeschickt.

### Token-Cache mit Login-Sperre

```
Aufruf getToken(profile)
    │
    ▼
Token im Cache und noch gültig?
    ├── ja  → Token zurückgeben
    └── nein → _loginLocks[profile.id] vorhanden?
                   ├── ja  → warten (anderer Request loggt gerade ein)
                   └── nein → Login durchführen (Lock setzen → login() → Token cachen → Lock freigeben)
```

Dieses Muster verhindert, dass parallele Requests beim Anwendungsstart mehrere simultane Login-Anfragen auslösen – was bei dieser API zu HTTP 429 (Rate-Limiting) führt.

### Rate-Limit-Behandlung (HTTP 429)

Bei einer 429-Antwort während des Logins wartet der Connector 6 Sekunden und wiederholt den Versuch. Maximal 3 Versuche.

### Auto-Retry bei HTTP 401

Jeder authentifizierte GET-Request (`apiGet`) prüft den HTTP-Statuscode. Bei 401 wird der gecachte Token verworfen, ein neuer Login durchgeführt und der Request einmalig wiederholt.

### Paginierung

`apiGetAll` ruft einen Endpunkt in Seiten von 500 Einträgen ab, bis eine Seite weniger als 500 Einträge liefert. Verschiedene Antwortformate werden unterstützt (`array`, `{ items }`, `{ value }`, `{ data }`).

### Field-Mapper

Die REST-API liefert Felder in verschiedenen Namenskonventionen (camelCase, snake_case, verschachtelte Objekte). Die internen Mapper-Funktionen normalisieren die Rohdaten auf ein einheitliches, flaches Format:

| Mapper | Eingabe | Ausgabe |
|---|---|---|
| `mapContactListItem` | REST-Kontaktobjekt | `{ id, name, city, address, associate, ... }` |
| `mapContactDetail` | Kontakt + Personen-Array | Kontakt mit `phones`, `emails`, `persons[]` |
| `mapPersonListItem` | REST-Personenobjekt | `{ id, firstname, lastname, display_name, ... }` |
| `mapProject` | REST-Projektobjekt | `{ id, name, project_number, status, type, ... }` |

### Öffentliche Funktionen

| Funktion | Endpunkt | Beschreibung |
|---|---|---|
| `getContacts(profile)` | `GET /contacts` | Alle Firmen, alphabetisch sortiert |
| `getContact(profile, id)` | `GET /contacts/:id` + `/persons` | Einzelne Firma mit Personen |
| `getPersons(profile)` | `GET /persons` | Alle Personen |
| `getProjects(profile)` | `GET /projects` | Alle Projekte |
| `getFavorites(profile)` | `/contacts?favorite=true` oder `/users/self` | Favoritenkontakte |
| `getAssociates(profile)` | `GET /users` | Mitarbeiter/Benutzer |
| `getPersonPhoto(profile, id)` | `GET /persons/:id/picture` | Foto als `{ data: Buffer, contentType }` |
| `testConnection(profile)` | `POST /login` | Verbindungstest, cached Token bei Erfolg |
| `invalidateToken(profileId)` | – | Token aus Cache entfernen (z. B. bei Logout) |
| `get(profile, path, params)` | beliebig | Roher authentifizierter GET-Request |
| `getAll(profile, path, params)` | beliebig | Paginierter GET-Request, alle Seiten |

---

## Datenfluss (REST, exemplarisch)

```
Anwendung ruft rest.getContacts(profile) auf
    │
    ▼
apiGetAll(profile, '/contacts')
    │
    ▼
apiGet(profile, '/contacts', { offset: 0, limit: 500 })
    │
    ▼
getToken(profile)  →  Token-Cache oder Login
    │
    ▼
rawRequest(baseUrl, '/contacts', { Authorization: Bearer ... })
    │
    ▼
HTTP GET  →  JSON-Antwort
    │
    ▼
Paginierungsschleife bis items.length < 500
    │
    ▼
items.map(mapContactListItem)
    │
    ▼
Sortierung nach Name (de)
    │
    ▼
Ergebnis-Array an Anwendung
```

---

## Erweiterbarkeit

Für Endpunkte, die nicht durch die Standard-Funktionen abgedeckt sind (z. B. kundenspezifische Erweiterungen der sellify-API), stehen `rest.get()` und `rest.getAll()` zur Verfügung. Diese nutzen denselben Token-Cache und dieselbe Retry-Logik wie die eingebauten Funktionen.

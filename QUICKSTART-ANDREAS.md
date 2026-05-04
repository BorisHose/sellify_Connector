# Kurzanleitung: sellify-connector einbinden

Dieses Paket stellt einen fertigen Connector für die **sellify OnTour REST API** bereit –
Token-Handling, Rate-Limiting und alle Standard-Endpunkte sind bereits implementiert.

---

## 1. Paket installieren

```bash
npm install git+https://github.com/boris-hose/sellify-connector.git
```

Für eine bestimmte Version (empfohlen für Produktivumgebungen):

```bash
npm install git+https://github.com/boris-hose/sellify-connector.git#v1.0.0
```

---

## 2. Profil-Objekt anlegen

Das Paket hat keine eigene Konfigurationsdatei – du übergibst die Zugangsdaten direkt beim Aufruf. Wo du sie speicherst (`.env`, eigene JSON-Datei, Datenbank) ist dir überlassen.

```js
const profile = {
  id:        'meine-app',                          // frei wählbar
  baseUrl:   'https://sellifyontour.example.com:4714',
  username:  'DEIN_BENUTZERNAME',
  password:  'DEIN_PASSWORT',
  client_Id: 'App',                                // von Boris erfragen
};
```

> **Tipp:** Lege die Zugangsdaten in eine `.env`-Datei und lese sie mit `process.env` ein – niemals Passwörter im Code committen.

---

## 3. Los geht's

```js
const { rest } = require('sellify-connector');

// Verbindung testen
await rest.testConnection(profile);
console.log('Verbindung OK');

// Kontakte laden
const kontakte = await rest.getContacts(profile);
console.log(kontakte[0]);
// { id: 4, name: 'Mustermann GmbH', city: 'Hamburg', address: '...', ... }

// Einzelnen Kontakt mit Personen
const detail = await rest.getContact(profile, 42);
console.log(detail.persons);

// Personen
const personen = await rest.getPersons(profile);

// Projekte
const projekte = await rest.getProjects(profile);

// Mitarbeiter/Benutzer
const mitarbeiter = await rest.getAssociates(profile);
```

---

## 4. Eigene / custom Endpunkte

Wenn deine sellify-Instanz individuelle Endpunkte hat, kannst du diese direkt aufrufen –
das Token-Handling läuft automatisch:

```js
// Einzelner Request (GET)
const result = await rest.get(profile, '/my-custom-endpoint', { filter: 'aktiv' });

// Paginierter Request (holt alle Seiten automatisch)
const all = await rest.getAll(profile, '/my-custom-list');
```

---

## 5. Rückgabeformat (Kurzübersicht)

| Funktion            | Rückgabe                                                  |
|---------------------|-----------------------------------------------------------|
| `getContacts()`     | `[{ id, name, city, address, associate, category, ... }]` |
| `getContact(id)`    | `{ ...kontakt, phones, emails, persons: [...] }`          |
| `getPersons()`      | `[{ id, firstname, lastname, display_name, ... }]`        |
| `getProjects()`     | `[{ id, name, project_number, status, type, ... }]`       |
| `getAssociates()`   | `[{ associate_id, firstname, lastname, retired }]`        |
| `getPersonPhoto(id)`| `{ data: Buffer, contentType: 'image/jpeg' }` oder `null` |

---

## 6. Updates einspielen

```bash
npm update sellify-connector
```

Oder auf eine neue Version pinnen:

```json
"sellify-connector": "github:boris-hose/sellify-connector#v1.1.0"
```

---

## Fragen?

Wende dich an **Boris Hose** – er hat den Connector entwickelt und kennt die API-Details.

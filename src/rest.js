/**
 * REST-Connector für sellify OnTour.
 * Authentifiziert sich per POST /login (OAuth2 Password Grant, Bearer-Token),
 * cached den Token pro Profil und erneuert ihn automatisch bei HTTP 401.
 *
 * Profil-Objekt:
 *   { id: string, baseUrl: string, username: string, password: string, client_Id?: string }
 */

const https = require('https');
const http  = require('http');

// Token-Cache: profileId → { token, expiry }
const _tokenCache = {};
// Login-Sperre: verhindert parallele Login-Requests für dasselbe Profil
const _loginLocks = {};

// ── Low-level HTTP ──────────────────────────────────────────────────────────

function rawRequest(baseUrl, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    if (opts.params) {
      Object.entries(opts.params).forEach(([k, v]) => {
        if (v != null) url.searchParams.set(k, String(v));
      });
    }
    const isHttps = url.protocol === 'https:';
    const lib  = isHttps ? https : http;
    const body = opts.body ? JSON.stringify(opts.body) : undefined;
    const reqOpts = {
      hostname:           url.hostname,
      port:               url.port || (isHttps ? 443 : 80),
      path:               url.pathname + url.search,
      method:             opts.method || 'GET',
      rejectUnauthorized: false,   // self-signed Zertifikate erlauben
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(opts.headers || {}),
      },
    };
    const req = lib.request(reqOpts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 204) return resolve({ status: 204, body: null });
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.setTimeout(30000, () => {
      req.destroy(new Error(`Timeout (30s): ${reqOpts.method} ${reqOpts.path}`));
    });
    req.on('error', err => {
      console.error('[sellify-connector] Request-Fehler:', err.message);
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

// Binäre Antwort (Bilder) als Buffer abrufen
function rawBinaryRequest(baseUrl, path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqOpts = {
      hostname:           url.hostname,
      port:               url.port || (isHttps ? 443 : 80),
      path:               url.pathname + url.search,
      method:             'GET',
      rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        'image/*,application/octet-stream',
      },
    };
    const req = lib.request(reqOpts, res => {
      if (res.statusCode === 404 || res.statusCode === 204) return resolve(null);
      if (res.statusCode === 401) return resolve({ status: 401 });
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status:      res.statusCode,
        data:        Buffer.concat(chunks),
        contentType: res.headers['content-type'] || 'image/jpeg',
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function login(profile, attempt = 1) {
  const reqBody = {
    grant_type: 'password',
    username:   profile.username,
    password:   profile.password,
    ...(profile.client_Id && { client_Id: profile.client_Id }),
  };
  const r = await rawRequest(profile.baseUrl, '/login', { method: 'POST', body: reqBody });

  // Rate-Limit: 6 Sekunden warten und nochmal versuchen (max. 3 Versuche)
  if (r.status === 429 && attempt < 4) {
    console.warn(`[sellify-connector] Rate-Limit (429) – warte 6s, Versuch ${attempt}/3`);
    await new Promise(res => setTimeout(res, 6000));
    return login(profile, attempt + 1);
  }

  if (r.status !== 200 || !r.body?.access_token) {
    const msg = r.body?.message || r.body?.error || JSON.stringify(r.body);
    console.error('[sellify-connector] Login fehlgeschlagen', {
      url:      `${profile.baseUrl}/login`,
      status:   r.status,
      sent:     { ...reqBody, password: '***' },
      response: r.body,
    });
    throw new Error(`Login fehlgeschlagen (HTTP ${r.status}): ${msg}`);
  }
  return { token: r.body.access_token, expiresIn: r.body.expires_in || 3300 };
}

async function getToken(profile) {
  const cached = _tokenCache[profile.id];
  if (cached && cached.expiry > Date.now()) return cached.token;

  // Nur ein Login-Request gleichzeitig pro Profil – alle anderen warten
  if (!_loginLocks[profile.id]) {
    _loginLocks[profile.id] = (async () => {
      const c = _tokenCache[profile.id];
      if (c && c.expiry > Date.now()) return;
      const { token, expiresIn } = await login(profile);
      _tokenCache[profile.id] = { token, expiry: Date.now() + (expiresIn - 60) * 1000 };
    })().finally(() => { delete _loginLocks[profile.id]; });
  }

  await _loginLocks[profile.id];
  return _tokenCache[profile.id].token;
}

/**
 * Löscht den gecachten Token für ein Profil (z. B. bei Logout oder Profilwechsel).
 */
function invalidateToken(profileId) {
  delete _tokenCache[profileId];
}

// ── Authenticated GET mit Auto-Retry bei 401 ──────────────────────────────

async function apiGet(profile, path, params) {
  const token = await getToken(profile);
  let r = await rawRequest(profile.baseUrl, path, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  if (r.status === 401) {
    invalidateToken(profile.id);
    const fresh = await getToken(profile);
    r = await rawRequest(profile.baseUrl, path, {
      headers: { Authorization: `Bearer ${fresh}` },
      params,
    });
  }
  if (r.status >= 400) {
    const msg = r.body?.message || r.body?.error || JSON.stringify(r.body);
    throw new Error(`REST ${r.status} – ${path}: ${msg}`);
  }
  return r.body;
}

// Alle Seiten eines paginierten Endpunkts abrufen
async function apiGetAll(profile, path, extraParams = {}) {
  const limit = 100;
  let offset  = 0;
  const all   = [];
  for (;;) {
    const page  = await apiGet(profile, path, { ...extraParams, offset, limit });
    const items = Array.isArray(page) ? page
      : (page?.items ?? page?.value ?? page?.data ?? []);
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return all;
}

// ── Field-Mapper ────────────────────────────────────────────────────────────

function mapPhone(ph) {
  const number = ph.value || ph.phone || ph.number || ph.phoneNumber || ph.phone_number || '';
  const label  = ph.description || ph.type || ph.label || ph.phone_type || 'Festnetz';
  return { number, label };
}

function mapAddress(addr) {
  if (!addr) return '';
  const line = addr.line1 || addr.address1 || addr.street_address || addr.streetAddress || addr.street || '';
  const zip  = addr.zipCode || addr.zip_code || addr.zip || addr.postalCode || addr.postal_code || '';
  const city = addr.city || addr.cityName || addr.city_name || '';
  return [line, zip, city].filter(Boolean).join(', ');
}

function nameFromAssociate(a) {
  if (!a) return '';
  return a.fullName || a.fullname
    || [a.firstName || a.firstname || a.first_name,
        a.lastName  || a.lastname  || a.last_name].filter(Boolean).join(' ')
    || '';
}

function resolveListValue(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.value || v.name || v.displayValue || v.display_value || String(v.id || '');
}

// ── Kontakte (Firmen) ───────────────────────────────────────────────────────

function mapContactListItem(c) {
  return {
    id:         c.id || c.contactId || c.contact_id,
    contact_id: c.id || c.contactId || c.contact_id,
    name:       c.name || '',
    department: c.department || '',
    orgNr:      c.orgNr || c.org_nr || c.organizationNumber || c.organization_number || c.vatId || '',
    country:    c.address?.country || c.country || '',
    city:       c.address?.city    || c.city    || '',
    address:    mapAddress(c.address),
    associate:  nameFromAssociate(c.associate || c.responsiblePerson || c.responsible_person),
    category:   resolveListValue(c.category),
    business:   resolveListValue(c.business),
  };
}

function mapContactDetail(c, persons) {
  const phones   = (c.phones   || []).map(mapPhone);
  const emails   = (c.emails   || []).map(e => e.value || e.emailAddress || e.email_address || e).filter(Boolean);
  const websites = (c.urls || c.websites || []).map(u => u.value || u.url || u).filter(Boolean);

  const mainAssoc  = nameFromAssociate(c.associate || c.responsiblePerson || c.responsible_person);
  const mainCat    = resolveListValue(c.category);
  const mainBiz    = resolveListValue(c.business);

  return {
    ...mapContactListItem(c),
    phones, emails, websites,
    associate:  mainAssoc,
    associates: mainAssoc ? [mainAssoc] : [],
    category:   mainCat,
    categories: mainCat ? [mainCat] : [],
    business:   mainBiz,
    businesses: mainBiz ? [mainBiz] : [],
    persons: (persons || []).map(p => ({
      id:         p.id || p.personId || p.person_id,
      person_id:  p.id || p.personId || p.person_id,
      contact_id: c.id || c.contactId || c.contact_id,
      firstname:  p.firstName || p.firstname || p.first_name || '',
      lastname:   p.lastName  || p.lastname  || p.last_name  || '',
      mrmrs:      p.mrmrs || '',
      title:      p.title || '',
      department: p.department || '',
      phones: (p.phones || []).map(mapPhone),
      emails: (p.emails || []).map(e => e.value || e.emailAddress || e.email_address || e).filter(Boolean),
    })),
  };
}

// ── Personen ────────────────────────────────────────────────────────────────

function mapPersonListItem(p, contactMap) {
  const contactId   = p.contactId || p.contact_id || p.contact?.id || 0;
  const contactName = p.contact?.name || (contactMap && contactMap[contactId]) || p.contactName || p.contact_name || '';
  const firstname   = p.firstName || p.firstname || p.first_name || '';
  const lastname    = p.lastName  || p.lastname  || p.last_name  || '';
  return {
    id:           p.id || p.personId || p.person_id,
    person_id:    p.id || p.personId || p.person_id,
    contact_id:   contactId,
    firstname,
    lastname,
    display_name: [firstname, lastname].filter(Boolean).join(' ') || '(ohne Name)',
    contact_name: contactName,
    mrmrs:        p.mrmrs || '',
    title:        p.title || '',
    department:   p.department || '',
    phones:       [],
    emails:       [],
  };
}

// ── Projekte ────────────────────────────────────────────────────────────────

function mapProject(p) {
  return {
    id:             p.id || p.projectId || p.project_id,
    project_id:     p.id || p.projectId || p.project_id,
    name:           p.name || '',
    project_number: p.projectNumber || p.project_number || p.number || '',
    status:         resolveListValue(p.status)      || resolveListValue(p.projectStatus)      || resolveListValue(p.project_status)      || '',
    type:           resolveListValue(p.type)        || resolveListValue(p.projectType)        || resolveListValue(p.project_type)        || '',
    done:           (p.done || p.is_done || p.completed) ? 1 : 0,
    endDate:        p.endDate    || p.end_date    || p.end    || null,
    registered:     p.registered || p.created_at  || p.created || null,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

async function getContacts(profile, { limit = 50, offset = 0 } = {}) {
  const page = await apiGet(profile, '/contacts', { limit, offset });
  const items = Array.isArray(page) ? page : (page?.items ?? page?.value ?? page?.data ?? []);
  return items.map(mapContactListItem)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

async function getContact(profile, id) {
  const [c, persons] = await Promise.all([
    apiGet(profile, `/contacts/${id}`),
    apiGet(profile, `/contacts/${id}/persons`).catch(() => []),
  ]);
  const pArr = Array.isArray(persons) ? persons : (persons?.items ?? []);
  return mapContactDetail(c, pArr);
}

async function getPersons(profile, { limit = 50, offset = 0 } = {}) {
  try {
    const page = await apiGet(profile, '/persons', { limit, offset });
    const items = Array.isArray(page) ? page : (page?.items ?? page?.value ?? page?.data ?? []);
    return items.map(p => mapPersonListItem(p, null))
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'de'));
  } catch (e) {
    if (String(e.message).includes('404')) return [];
    throw e;
  }
}

async function getProjects(profile, { limit = 50, offset = 0 } = {}) {
  const page = await apiGet(profile, '/projects', { limit, offset });
  const items = Array.isArray(page) ? page : (page?.items ?? page?.value ?? page?.data ?? []);
  return items.map(mapProject)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

async function getFavorites(profile) {
  try {
    const items = await apiGetAll(profile, '/contacts', { favorite: true, onlyMine: true });
    if (items.length <= 100) {
      return items.map(c => ({
        entity_id:  c.id || c.contactId || c.contact_id,
        entityname: 'contact',
      }));
    }
  } catch { /* weiter zu Fallback */ }

  try {
    const self   = await apiGet(profile, '/users/self');
    const selfId = self?.id;
    if (!selfId) return [];
    const items = await apiGetAll(profile, `/users/${selfId}/contacts`);
    return items.map(c => ({
      entity_id:  c.id || c.contactId || c.contact_id,
      entityname: 'contact',
    }));
  } catch { return []; }
}

async function getAssociates(profile) {
  try {
    const items = await apiGetAll(profile, '/users');
    return items.map(u => ({
      associate_id: u.id || u.associateId || u.associate_id,
      firstname:    u.first_name || u.firstName || u.firstname || '',
      lastname:     u.last_name  || u.lastName  || u.lastname  || '',
      retired:      (u.is_active === 0 || u.retired === 1 || u.retired === true) ? 1 : 0,
    }));
  } catch { return []; }
}

/**
 * Personen-Foto als Buffer.
 * @returns {Promise<{data: Buffer, contentType: string}|null>}
 */
async function getPersonPhoto(profile, id) {
  const token = await getToken(profile);
  let r = await rawBinaryRequest(profile.baseUrl, `/persons/${id}/picture`, token);
  if (r?.status === 401) {
    invalidateToken(profile.id);
    const fresh = await getToken(profile);
    r = await rawBinaryRequest(profile.baseUrl, `/persons/${id}/picture`, fresh);
  }
  if (!r || r.status === 401 || !r.data?.length) return null;
  return { data: r.data, contentType: r.contentType };
}

/**
 * Testet die Verbindung durch einen Login-Versuch.
 * Cached den Token bei Erfolg.
 * @returns {Promise<string>} baseUrl bei Erfolg
 */
async function testConnection(profile) {
  const { token, expiresIn } = await login(profile);
  _tokenCache[profile.id || '_test'] = { token, expiry: Date.now() + (expiresIn - 60) * 1000 };
  return profile.baseUrl;
}

/**
 * Führt einen rohen authentifizierten GET-Request aus.
 * Nützlich für custom Endpunkte, die nicht durch den Standard-Mapper abgedeckt sind.
 * @returns {Promise<any>} Rohe API-Antwort
 */
async function get(profile, path, params) {
  return apiGet(profile, path, params);
}

/**
 * Führt einen rohen authentifizierten paginierten GET-Request aus.
 * @returns {Promise<any[]>} Alle Seiten zusammengeführt
 */
async function getAll(profile, path, params) {
  return apiGetAll(profile, path, params);
}

module.exports = {
  // Hohe Ebene – sellify-Entitäten
  getContacts, getContact,
  getPersons,
  getProjects,
  getFavorites,
  getAssociates,
  getPersonPhoto,
  // Verbindung
  testConnection,
  invalidateToken,
  // Niedrige Ebene – für custom Endpunkte
  get,
  getAll,
};

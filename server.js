const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendSms, SIMULATION_MODE } = require('./sms');

const app = express();
const PORT = process.env.PORT || 3000;
// Set DATA_DIR to a Railway Volume mount (e.g. /app/data) so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'db.json');
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L look-alikes
const FOLLOWUP_DELAY_HOURS = 48;
const REVIEW_REQUEST_DELAY_HOURS = 2; // sent after redemption, timed for "on their way out"
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const STAGES = [
  'New Lead',
  'Discovery Call',
  'Offer Designed',
  'Onboarding',
  'Live Client',
];

// ---- tiny JSON file "database" ----
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ leads: [], customers: [], messages: [], automations: [] }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.customers) db.customers = []; // upgrade older db.json files in place
  if (!db.messages) db.messages = [];
  if (!db.automations) db.automations = [];
  if (!db.redemptions) db.redemptions = [];
  if (!db.visits) db.visits = [];
  return db;
}

// ---- helpers: phones, emails, reward IDs, staff PINs ----
function normalizePhone(raw) {
  const str = String(raw || '').trim();
  const digits = str.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (str.startsWith('+') && digits.length >= 10) return '+' + digits;
  return '';
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function localDay(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
}

function randomChars(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
  return out;
}

function newStaffPin() {
  return String(crypto.randomInt(1000, 10000));
}

// Short restaurant code used as the Reward ID prefix, e.g. "Mama's Kitchen" -> "MAMA"
function makeRewardCode(name, leads, selfId) {
  let base = String(name || 'REST').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'REST';
  while (base.length < 3) base += 'X';
  let code = base;
  let n = 2;
  while (leads.some((l) => l.id !== selfId && l.rewardCode === code)) code = base + n++;
  return code;
}

// Backfill reward fields on restaurants created before this feature existed.
function ensureRewardFields(lead, db) {
  let changed = false;
  if (!lead.rewardCode) { lead.rewardCode = makeRewardCode(lead.restaurantName, db.leads, lead.id); changed = true; }
  if (typeof lead.rewardCounter !== 'number') { lead.rewardCounter = 0; changed = true; }
  if (!lead.staffPin) { lead.staffPin = newStaffPin(); changed = true; }
  return changed;
}

// Generates the next unique Reward ID for a restaurant, e.g. MAMA-0007-K3
function nextRewardId(lead, db) {
  ensureRewardFields(lead, db);
  let id;
  do {
    lead.rewardCounter += 1;
    id = `${lead.rewardCode}-${String(lead.rewardCounter).padStart(4, '0')}-${randomChars(2)}`;
  } while (db.customers.some((c) => c.rewardId === id));
  return id;
}

function publicCustomer(c) {
  return { name: c.name, rewardId: c.rewardId, redemptionCount: c.redemptionCount || 0 };
}

// Why the guest is here today (dropdown on the check-in page)
const VISIT_TYPES = {
  first_time: 'First time here',
  regular: "I'm a regular",
  friend: 'A friend sent me',
  takeout: 'Picking up takeout',
  celebrating: 'Celebrating something',
  social: 'Saw you on social media',
  event: 'Here for an event / game night',
};
function cleanVisitType(v) { return VISIT_TYPES[v] ? v : ''; }

// Secret token saved on the guest's phone so they never re-enter their info.
function newDeviceToken() { return crypto.randomBytes(24).toString('base64url'); }
function ensureDeviceToken(c) { if (!c.deviceToken) c.deviceToken = newDeviceToken(); return c.deviceToken; }

// One logged check-in per guest per day (the latest answer wins).
function logVisit(db, customer, visitType, via) {
  const today = localDay(new Date());
  let visit = db.visits.find((v) => v.customerId === customer.id && v.day === today);
  if (visit) {
    if (visitType) visit.visitType = visitType;
  } else {
    visit = { id: crypto.randomUUID(), restaurantId: customer.restaurantId, customerId: customer.id,
              day: today, visitType: visitType || '', via, at: new Date().toISOString() };
    db.visits.unshift(visit);
    customer.checkinCount = (customer.checkinCount || 0) + 1;
    customer.lastCheckinAt = visit.at;
  }
  if (visitType) customer.lastVisitType = visitType;
  return visit;
}

// Status the guest sees on their pass
function passStatus(customer) {
  const today = localDay(new Date());
  if (customer.lastRedemptionAt && localDay(customer.lastRedemptionAt) === today) return 'redeemed_today';
  if (localDay(customer.optedInAt) === today) return 'joined_today';
  return 'ready';
}

function maskPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? '•••-•••-' + d.slice(-4) : ''; }

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

app.use(express.json());

// ---- Optional admin password for the CRM itself ----
// Set ADMIN_PASSWORD in Railway Variables. Guest (check-in) and staff (redeem) pages stay open.
const PUBLIC_PREFIXES = ['/welcome', '/media/', '/js/welcome.js', '/checkin/', '/redeem/', '/api/public/', '/api/sms/inbound', '/js/checkin.js', '/js/redeem.js', '/favicon'];
app.use((req, res, next) => {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass || PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  const header = req.headers.authorization || '';
  const [, encoded] = header.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString() : '';
  const given = decoded.slice(decoded.indexOf(':') + 1);
  if (given && given.length === pass.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pass))) return next();
  res.set('WWW-Authenticate', 'Basic realm="InTheLoop CRM"');
  res.status(401).send('Login required');
});

app.use(express.static(path.join(__dirname, 'public')));

// The public check-in page a QR code / NFC tag points to: /checkin/<restaurantId>
app.get('/checkin/:restaurantId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});

// Public landing page with the VSL + booking form: /welcome
app.get('/welcome', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

// Staff-only redeem page (protected by the restaurant's 4-digit staff PIN): /redeem/<restaurantId>
app.get('/redeem/:restaurantId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'redeem.html'));
});

// ---- API: stages ----
app.get('/api/stages', (req, res) => {
  res.json(STAGES);
});

// ---- API: leads / restaurants ----
app.get('/api/leads', (req, res) => {
  const db = readDB();
  let changed = false;
  db.leads.forEach((l) => { if (ensureRewardFields(l, db)) changed = true; });
  if (changed) writeDB(db);
  res.json(db.leads);
});

app.get('/api/leads/:id', (req, res) => {
  const db = readDB();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(lead);
});

app.post('/api/leads', (req, res) => {
  const db = readDB();
  const now = new Date().toISOString();
  const stage = STAGES.includes(req.body.stage) ? req.body.stage : STAGES[0];
  const lead = {
    id: crypto.randomUUID(),
    restaurantName: req.body.restaurantName || 'Untitled Restaurant',
    contactName: req.body.contactName || '',
    phone: req.body.phone || '',
    email: req.body.email || '',
    slowestNight: req.body.slowestNight || '',
    currentOffer: req.body.currentOffer || '',
    googleReviewLink: req.body.googleReviewLink || '',
    stage,
    liveSince: stage === 'Live Client' ? now : null,
    notes: req.body.notes || '',
    rewardCode: makeRewardCode(req.body.restaurantName, db.leads, null),
    rewardCounter: 0,
    staffPin: newStaffPin(),
    createdAt: now,
    updatedAt: now,
  };
  db.leads.unshift(lead);
  writeDB(db);
  res.status(201).json(lead);
});

app.put('/api/leads/:id', (req, res) => {
  const db = readDB();
  const idx = db.leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const existing = db.leads[idx];
  const newStage = STAGES.includes(req.body.stage) ? req.body.stage : existing.stage;
  const becomingLive = newStage === 'Live Client' && existing.stage !== 'Live Client';
  const body = { ...req.body };
  delete body.rewardCode; // reward IDs already issued depend on these – never overwritten from the form
  delete body.rewardCounter;
  if (body.staffPin !== undefined && !/^\d{4}$/.test(String(body.staffPin))) delete body.staffPin;
  const updated = {
    ...existing,
    ...body,
    id: existing.id,
    stage: newStage,
    liveSince: becomingLive ? new Date().toISOString() : existing.liveSince || null,
    updatedAt: new Date().toISOString(),
  };
  db.leads[idx] = updated;
  writeDB(db);
  res.json(updated);
});

app.delete('/api/leads/:id', (req, res) => {
  const db = readDB();
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  db.customers = db.customers.filter((c) => c.restaurantId !== req.params.id);
  writeDB(db);
  res.status(204).end();
});

// ---- API: customers, scoped to one restaurant (owner-side view) ----
app.get('/api/leads/:id/customers', (req, res) => {
  const db = readDB();
  const customers = db.customers
    .filter((c) => c.restaurantId === req.params.id)
    .sort((a, b) => new Date(b.optedInAt) - new Date(a.optedInAt))
    .map(({ deviceToken, ...c }) => ({
      ...c,
      firstVisitLabel: VISIT_TYPES[c.firstVisitType] || '',
      lastVisitLabel: VISIT_TYPES[c.lastVisitType] || '',
    }));
  res.json(customers);
});

// Why guests came in, per restaurant (from the check-in dropdown)
app.get('/api/leads/:id/visit-stats', (req, res) => {
  const db = readDB();
  const counts = {};
  Object.keys(VISIT_TYPES).forEach((k) => (counts[k] = 0));
  db.visits.filter((v) => v.restaurantId === req.params.id && v.visitType).forEach((v) => counts[v.visitType]++);
  res.json(Object.entries(counts).map(([key, count]) => ({ key, label: VISIT_TYPES[key], count })));
});

// Owner manually adding a customer from inside the CRM
app.post('/api/leads/:id/customers', (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Valid phone number required' });
  if (db.customers.some((c) => c.restaurantId === req.params.id && c.phone === phone)) {
    return res.status(409).json({ error: 'That phone number is already a customer here' });
  }
  const now = new Date().toISOString();
  const customer = {
    id: crypto.randomUUID(),
    restaurantId: req.params.id,
    rewardId: nextRewardId(restaurant, db),
    name: req.body.name || '',
    phone,
    email: normalizeEmail(req.body.email),
    smsConsent: false, // added by staff: no texts until the guest opts in themselves
    optedInAt: now,
    optedOut: false,
    redemptionCount: 0,
    lastRedemptionAt: null,
    followUpSentAt: null,
    reviewRequestSentAt: null,
  };
  db.customers.unshift(customer);
  writeDB(db);
  res.status(201).json(customer);
});

// ---- PUBLIC API: called by the /checkin/:restaurantId page (QR / NFC) ----
// No auth — this is the guest-facing capture endpoint.
app.get('/api/public/restaurant/:id', (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  res.json({
    id: restaurant.id,
    restaurantName: restaurant.restaurantName,
    currentOffer: restaurant.currentOffer,
    slowestNight: restaurant.slowestNight,
  });
});

app.post('/api/public/checkin', async (req, res) => {
  const db = readDB();
  const { restaurantId } = req.body;
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const visitType = cleanVisitType(req.body.visitType);

  // A guest who already gave their info at ANOTHER restaurant can join with one tap:
  // their phone saved token stands in for the form.
  let name = req.body.name;
  let phone = normalizePhone(req.body.phone);
  let email = normalizeEmail(req.body.email);
  if (req.body.token) {
    const known = db.customers.find((c) => c.deviceToken && c.deviceToken === String(req.body.token));
    if (known) { name = name || known.name; phone = phone || known.phone; email = email || known.email; }
  }
  if (!phone) return res.status(400).json({ error: 'Please enter a valid mobile number' });
  if (req.body.email && !normalizeEmail(req.body.email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (req.body.smsConsent !== true) return res.status(400).json({ error: 'Please tick the box to agree to texts' });

  // Same phone OR same email at this restaurant = same guest: no new ID, no double reward.
  let customer = db.customers.find(
    (c) => c.restaurantId === restaurantId && (c.phone === phone || (email && c.email === email))
  );
  const now = new Date().toISOString();
  const isNewCustomer = !customer;
  if (customer) {
    customer.name = name || customer.name;
    if (email && !customer.email) customer.email = email;
    if (customer.optedOut) { customer.optedOut = false; customer.smsConsent = true; customer.consentAt = now; }
  } else {
    customer = {
      id: crypto.randomUUID(),
      restaurantId,
      rewardId: nextRewardId(restaurant, db),
      name: name || '',
      phone,
      email,
      smsConsent: true,
      consentAt: now,
      optedInAt: now,
      optedOut: false,
      firstVisitType: visitType,
      redemptionCount: 0,
      lastRedemptionAt: null,
      followUpSentAt: null,
      reviewRequestSentAt: null,
    };
    db.customers.unshift(customer);
  }
  ensureDeviceToken(customer);
  logVisit(db, customer, visitType, 'form');
  writeDB(db);

  // Welcome text with their Reward ID the moment a brand-new guest opts in.
  if (isNewCustomer) {
    const offer = restaurant.currentOffer ? `Your reward: ${restaurant.currentOffer}. ` : '';
    const body = `Welcome to the ${restaurant.restaurantName} loop! ${offer}Your Reward ID is ${customer.rewardId} - show it to staff on your next visit. Reply STOP to opt out.`;
    const result = await sendSms(phone, body);
    db.messages.unshift({
      id: crypto.randomUUID(),
      restaurantId,
      customerId: customer.id,
      type: 'welcome',
      body,
      sentAt: new Date().toISOString(),
      status: result.status,
    });
    writeDB(db);
  }

  res.status(201).json({
    customer: publicCustomer(customer),
    token: customer.deviceToken,
    status: passStatus(customer),
    isNewCustomer,
    offer: restaurant.currentOffer,
    restaurantName: restaurant.restaurantName,
  });
});

// Returning guest: the check-in page sends the token saved on their phone, no form needed.
app.post('/api/public/returning', (req, res) => {
  const db = readDB();
  const { restaurantId } = req.body;
  const token = String(req.body.token || '');
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  if (!token) return res.status(404).json({ error: 'unknown' });

  // The token identifies the person; they may already be a member here under a different record.
  const known = db.customers.find((c) => c.deviceToken === token);
  if (!known) return res.status(404).json({ error: 'unknown' });
  const here = known.restaurantId === restaurantId ? known
    : db.customers.find((c) => c.restaurantId === restaurantId && c.phone === known.phone);
  if (here) {
    // Coming back on a new day = a regular, unless they pick something else in the dropdown.
    const today = localDay(new Date());
    const alreadyToday = db.visits.some((v) => v.customerId === here.id && v.day === today);
    const visitType = cleanVisitType(req.body.visitType) || (alreadyToday ? '' : 'regular');
    logVisit(db, here, visitType, 'saved_phone');
    writeDB(db);
    return res.json({
      member: true,
      customer: publicCustomer(here),
      status: passStatus(here),
      visitType: here.lastVisitType || '',
      offer: restaurant.currentOffer,
      restaurantName: restaurant.restaurantName,
    });
  }

  // Known guest from another restaurant: offer one-tap join (they still tick consent for THIS place).
  res.json({ member: false, knownGuest: true, name: known.name, phoneHint: maskPhone(known.phone) });
});

// Landing-page booking form -> becomes a New Lead in the CRM pipeline
app.post('/api/public/book', (req, res) => {
  const db = readDB();
  const restaurantName = String(req.body.restaurantName || '').trim().slice(0, 120);
  const phone = String(req.body.phone || '').trim().slice(0, 40);
  const email = normalizeEmail(req.body.email);
  const preferredTime = String(req.body.preferredTime || '').trim().slice(0, 40);
  if (!restaurantName) return res.status(400).json({ error: 'Please add your restaurant name.' });
  if (!phone && !email) return res.status(400).json({ error: 'Please add a phone number or email so we can confirm.' });
  if (req.body.email && !email) return res.status(400).json({ error: 'Please enter a valid email.' });
  let when = preferredTime;
  const d = new Date(preferredTime);
  if (preferredTime && !isNaN(d)) when = d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const now = new Date().toISOString();
  const lead = {
    id: crypto.randomUUID(),
    restaurantName,
    contactName: '',
    phone,
    email,
    slowestNight: '',
    currentOffer: '',
    googleReviewLink: '',
    stage: STAGES[0],
    liveSince: null,
    notes: `Booked a meeting from the landing page. Preferred time: ${when || 'not given'}.`,
    rewardCode: makeRewardCode(restaurantName, db.leads, null),
    rewardCounter: 0,
    staffPin: newStaffPin(),
    source: 'landing-page',
    preferredMeetingTime: preferredTime,
    createdAt: now,
    updatedAt: now,
  };
  db.leads.unshift(lead);
  writeDB(db);
  res.status(201).json({ ok: true });
});

// Staff redeem: requires the restaurant's staff PIN + the guest's Reward ID.
// A redemption counts as a RETURN visit, so it isn't allowed on the day they signed up,
// and only once per guest per day.
app.post('/api/public/redeem', (req, res) => {
  const db = readDB();
  const { restaurantId } = req.body;
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  ensureRewardFields(restaurant, db);
  if (String(req.body.pin || '') !== restaurant.staffPin) {
    return res.status(401).json({ error: 'Wrong staff PIN' });
  }
  const entered = String(req.body.rewardId || '').trim().toUpperCase().replace(/\s+/g, '');
  const log = (result, customer) => {
    db.redemptions.unshift({
      id: crypto.randomUUID(), restaurantId, rewardIdEntered: entered, result,
      customerId: customer ? customer.id : null, at: new Date().toISOString(),
    });
    writeDB(db);
  };

  const customer = db.customers.find((c) => c.restaurantId === restaurantId && c.rewardId === entered);
  if (!customer) { log('invalid'); return res.status(404).json({ error: `No guest with Reward ID ${entered} at this restaurant` }); }

  const today = localDay(new Date());
  if (localDay(customer.optedInAt) === today) {
    log('same_day');
    return res.status(409).json({ error: 'Signed up today - the reward is for their NEXT visit.', customer: publicCustomer(customer) });
  }
  if (customer.lastRedemptionAt && localDay(customer.lastRedemptionAt) === today) {
    log('already_today');
    return res.status(409).json({ error: 'Already redeemed today.', customer: publicCustomer(customer) });
  }

  customer.redemptionCount = (customer.redemptionCount || 0) + 1;
  customer.lastRedemptionAt = new Date().toISOString();
  log('valid', customer);
  res.json({ ok: true, customer: publicCustomer(customer), offer: restaurant.currentOffer, visitNumber: customer.redemptionCount });
});

// Owner-side redemption log (CRM)
app.get('/api/leads/:id/redemptions', (req, res) => {
  const db = readDB();
  res.json(db.redemptions.filter((r) => r.restaurantId === req.params.id).slice(0, 100));
});

// ---- API: send a promotion to this restaurant's customers ----
app.post('/api/leads/:id/promotions', async (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { message, audience } = req.body; // audience: 'all' | 'new' | 'returning'
  if (!message) return res.status(400).json({ error: 'Message is required' });

  let recipients = db.customers.filter((c) => c.restaurantId === req.params.id && !c.optedOut && c.smsConsent !== false);
  if (audience === 'new') recipients = recipients.filter((c) => (c.redemptionCount || 0) === 0);
  if (audience === 'returning') recipients = recipients.filter((c) => (c.redemptionCount || 0) > 0);

  const results = [];
  for (const customer of recipients) {
    const result = await sendSms(customer.phone, `${message} Reply STOP to opt out.`);
    results.push({ customerId: customer.id, phone: customer.phone, status: result.status });
  }

  const promotion = {
    id: crypto.randomUUID(),
    restaurantId: req.params.id,
    message,
    audience: audience || 'all',
    recipientCount: recipients.length,
    sentAt: new Date().toISOString(),
  };
  db.messages.unshift({ ...promotion, type: 'promotion' });
  writeDB(db);

  res.status(201).json({ promotion, results, simulated: SIMULATION_MODE });
});

app.get('/api/leads/:id/promotions', (req, res) => {
  const db = readDB();
  const promotions = db.messages
    .filter((m) => m.restaurantId === req.params.id && m.type === 'promotion')
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
  res.json(promotions);
});

// ---- Twilio inbound webhook — handles STOP replies ----
// Point your Twilio phone number's "A message comes in" webhook at:
// https://<your-domain>/api/sms/inbound
app.post('/api/sms/inbound', express.urlencoded({ extended: false }), (req, res) => {
  const from = normalizePhone(req.body.From);
  const body = (req.body.Body || '').trim().toUpperCase();
  if (from && ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(body)) {
    const db = readDB();
    db.customers
      .filter((c) => c.phone === from)
      .forEach((c) => { c.optedOut = true; c.smsConsent = false; });
    writeDB(db);
  }
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});


app.get('/api/analytics', (req, res) => {
  const db = readDB();
  const leads = db.leads;
  const total = leads.length;

  const byStage = {};
  STAGES.forEach((s) => (byStage[s] = 0));
  leads.forEach((l) => {
    if (byStage[l.stage] === undefined) byStage[l.stage] = 0;
    byStage[l.stage]++;
  });

  const liveClients = byStage['Live Client'] || 0;
  const conversionRate = total > 0 ? Math.round((liveClients / total) * 1000) / 10 : 0;

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const newThisMonth = leads.filter((l) => new Date(l.createdAt).getTime() >= thirtyDaysAgo).length;
  const dealsClosedThisMonth = leads.filter(
    (l) => l.stage === 'Live Client' && new Date(l.updatedAt).getTime() >= thirtyDaysAgo
  ).length;

  const recent = [...leads]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 5)
    .map((l) => ({ id: l.id, restaurantName: l.restaurantName, stage: l.stage, updatedAt: l.updatedAt }));

  const totalCustomers = db.customers.length;
  const totalRedemptions = db.customers.reduce((sum, c) => sum + (c.redemptionCount || 0), 0);

  res.json({
    total,
    byStage,
    liveClients,
    conversionRate,
    newThisMonth,
    dealsClosedThisMonth,
    recent,
    totalCustomers,
    totalRedemptions,
  });
});

// ---- Automated 48-hour follow-up ----
// Every 15 minutes, check for customers who opted in ~48h ago and haven't
// gotten their follow-up yet, then send it automatically.
async function runFollowUpCheck() {
  const db = readDB();
  const cutoff = Date.now() - FOLLOWUP_DELAY_HOURS * 60 * 60 * 1000;
  const due = db.customers.filter(
    (c) => !c.optedOut && c.smsConsent !== false && !c.followUpSentAt && !(c.redemptionCount > 0) &&
      new Date(c.optedInAt).getTime() <= cutoff
  );

  for (const customer of due) {
    const restaurant = db.leads.find((l) => l.id === customer.restaurantId);
    if (!restaurant || !restaurant.currentOffer) continue;

    const body = `Still thinking about ${restaurant.restaurantName}? Your offer is waiting: ${restaurant.currentOffer}. Show Reward ID ${customer.rewardId || ''} to staff. Reply STOP to opt out.`;
    const result = await sendSms(customer.phone, body);
    customer.followUpSentAt = new Date().toISOString();
    db.messages.unshift({
      id: crypto.randomUUID(),
      restaurantId: customer.restaurantId,
      customerId: customer.id,
      type: 'followup',
      body,
      sentAt: new Date().toISOString(),
      status: result.status,
    });
  }

  if (due.length > 0) writeDB(db);
}

// ---- Automated Google review request ----
// Every 15 minutes, check for customers who redeemed ~2h ago (long enough to
// have finished their meal and left) and haven't been asked for a review yet
// for that visit, then text them the restaurant's Google review link.
async function runReviewRequestCheck() {
  const db = readDB();
  const cutoff = Date.now() - REVIEW_REQUEST_DELAY_HOURS * 60 * 60 * 1000;
  const due = db.customers.filter(
    (c) =>
      !c.optedOut &&
      c.smsConsent !== false &&
      c.lastRedemptionAt &&
      new Date(c.lastRedemptionAt).getTime() <= cutoff &&
      (!c.reviewRequestSentAt || new Date(c.reviewRequestSentAt) < new Date(c.lastRedemptionAt))
  );

  for (const customer of due) {
    const restaurant = db.leads.find((l) => l.id === customer.restaurantId);
    if (!restaurant || !restaurant.googleReviewLink) continue;

    const body = `Thanks for stopping by ${restaurant.restaurantName}! Mind leaving us a quick Google review? ${restaurant.googleReviewLink} Reply STOP to opt out.`;
    const result = await sendSms(customer.phone, body);
    customer.reviewRequestSentAt = new Date().toISOString();
    db.messages.unshift({
      id: crypto.randomUUID(),
      restaurantId: customer.restaurantId,
      customerId: customer.id,
      type: 'review_request',
      body,
      sentAt: new Date().toISOString(),
      status: result.status,
    });
  }

  if (due.length > 0) writeDB(db);
}

// ---- Automated / scheduled promotions ----
// Restaurant-level recurring promotions, e.g. "every Wednesday, text all
// customers this message." Checked once a day per automation.
app.get('/api/leads/:id/automations', (req, res) => {
  const db = readDB();
  res.json(db.automations.filter((a) => a.restaurantId === req.params.id));
});

app.post('/api/leads/:id/automations', (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const { message, audience, dayOfWeek } = req.body;
  if (!message || !DAY_NAMES.includes(dayOfWeek)) {
    return res.status(400).json({ error: 'Message and a valid dayOfWeek are required' });
  }
  const automation = {
    id: crypto.randomUUID(),
    restaurantId: req.params.id,
    message,
    audience: audience || 'all',
    dayOfWeek,
    active: true,
    lastSentAt: null,
    createdAt: new Date().toISOString(),
  };
  db.automations.unshift(automation);
  writeDB(db);
  res.status(201).json(automation);
});

app.delete('/api/leads/:id/automations/:automationId', (req, res) => {
  const db = readDB();
  db.automations = db.automations.filter((a) => a.id !== req.params.automationId);
  writeDB(db);
  res.status(204).end();
});

async function runAutomationCheck() {
  const db = readDB();
  const today = DAY_NAMES[new Date().getDay()];
  const todayKey = new Date().toISOString().slice(0, 10);

  const due = db.automations.filter(
    (a) => a.active && a.dayOfWeek === today && (!a.lastSentAt || !a.lastSentAt.startsWith(todayKey))
  );

  for (const automation of due) {
    let recipients = db.customers.filter((c) => c.restaurantId === automation.restaurantId && !c.optedOut && c.smsConsent !== false);
    if (automation.audience === 'new') recipients = recipients.filter((c) => (c.redemptionCount || 0) === 0);
    if (automation.audience === 'returning') recipients = recipients.filter((c) => (c.redemptionCount || 0) > 0);

    for (const customer of recipients) {
      const result = await sendSms(customer.phone, `${automation.message} Reply STOP to opt out.`);
      db.messages.unshift({
        id: crypto.randomUUID(),
        restaurantId: automation.restaurantId,
        customerId: customer.id,
        type: 'promotion',
        message: automation.message,
        audience: automation.audience,
        recipientCount: 1,
        body: automation.message,
        sentAt: new Date().toISOString(),
        status: result.status,
        automationId: automation.id,
      });
    }
    automation.lastSentAt = new Date().toISOString();
  }

  if (due.length > 0) writeDB(db);
}

setInterval(runFollowUpCheck, 15 * 60 * 1000);
setInterval(runReviewRequestCheck, 15 * 60 * 1000);
setInterval(runAutomationCheck, 15 * 60 * 1000);
runFollowUpCheck();
runReviewRequestCheck();
runAutomationCheck();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`InTheLoop CRM running on port ${PORT}${SIMULATION_MODE ? ' (SMS simulation mode — no Twilio credentials set)' : ''}`);
});

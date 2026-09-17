const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendSms, SIMULATION_MODE } = require('./sms');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
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
  return db;
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// The public check-in page a QR code / NFC tag points to: /checkin/<restaurantId>
app.get('/checkin/:restaurantId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});

// ---- API: stages ----
app.get('/api/stages', (req, res) => {
  res.json(STAGES);
});

// ---- API: leads / restaurants ----
app.get('/api/leads', (req, res) => {
  const db = readDB();
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
  const updated = {
    ...existing,
    ...req.body,
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
    .sort((a, b) => new Date(b.optedInAt) - new Date(a.optedInAt));
  res.json(customers);
});

// Owner manually adding a customer from inside the CRM
app.post('/api/leads/:id/customers', (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  const now = new Date().toISOString();
  const customer = {
    id: crypto.randomUUID(),
    restaurantId: req.params.id,
    name: req.body.name || '',
    phone: req.body.phone || '',
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
  const { restaurantId, name, phone } = req.body;
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  let customer = db.customers.find((c) => c.restaurantId === restaurantId && c.phone === phone);
  const now = new Date().toISOString();
  const isNewCustomer = !customer;
  if (customer) {
    customer.name = name || customer.name;
  } else {
    customer = {
      id: crypto.randomUUID(),
      restaurantId,
      name: name || '',
      phone,
      optedInAt: now,
      optedOut: false,
      redemptionCount: 0,
      lastRedemptionAt: null,
      followUpSentAt: null,
      reviewRequestSentAt: null,
    };
    db.customers.unshift(customer);
  }
  writeDB(db);

  // Send the welcome text the moment a brand-new guest opts in.
  if (isNewCustomer && restaurant.currentOffer) {
    const body = `Welcome to the ${restaurant.restaurantName} loop! Your offer: ${restaurant.currentOffer}. Show this text or your pass at the table to redeem. Reply STOP to opt out.`;
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
    customer,
    offer: restaurant.currentOffer,
    restaurantName: restaurant.restaurantName,
  });
});

app.post('/api/public/redeem', (req, res) => {
  const db = readDB();
  const { restaurantId, phone } = req.body;
  const customer = db.customers.find((c) => c.restaurantId === restaurantId && c.phone === phone);
  if (!customer) return res.status(404).json({ error: 'Customer not found — check in first' });
  customer.redemptionCount = (customer.redemptionCount || 0) + 1;
  customer.lastRedemptionAt = new Date().toISOString();
  writeDB(db);
  res.json({ customer });
});

// ---- API: send a promotion to this restaurant's customers ----
app.post('/api/leads/:id/promotions', async (req, res) => {
  const db = readDB();
  const restaurant = db.leads.find((l) => l.id === req.params.id);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

  const { message, audience } = req.body; // audience: 'all' | 'new' | 'returning'
  if (!message) return res.status(400).json({ error: 'Message is required' });

  let recipients = db.customers.filter((c) => c.restaurantId === req.params.id && !c.optedOut);
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
  const from = req.body.From;
  const body = (req.body.Body || '').trim().toUpperCase();
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(body)) {
    const db = readDB();
    db.customers
      .filter((c) => c.phone === from)
      .forEach((c) => (c.optedOut = true));
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
    (c) => !c.optedOut && !c.followUpSentAt && new Date(c.optedInAt).getTime() <= cutoff
  );

  for (const customer of due) {
    const restaurant = db.leads.find((l) => l.id === customer.restaurantId);
    if (!restaurant || !restaurant.currentOffer) continue;

    const body = `Still thinking about ${restaurant.restaurantName}? Your offer is waiting: ${restaurant.currentOffer}. Reply STOP to opt out.`;
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
    let recipients = db.customers.filter((c) => c.restaurantId === automation.restaurantId && !c.optedOut);
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

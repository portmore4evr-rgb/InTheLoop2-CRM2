const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

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
    fs.writeFileSync(DB_PATH, JSON.stringify({ leads: [], customers: [] }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.customers) db.customers = []; // upgrade older db.json files in place
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
  const lead = {
    id: crypto.randomUUID(),
    restaurantName: req.body.restaurantName || 'Untitled Restaurant',
    contactName: req.body.contactName || '',
    phone: req.body.phone || '',
    email: req.body.email || '',
    slowestNight: req.body.slowestNight || '',
    currentOffer: req.body.currentOffer || '',
    stage: STAGES.includes(req.body.stage) ? req.body.stage : STAGES[0],
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
  const updated = {
    ...existing,
    ...req.body,
    id: existing.id,
    stage: STAGES.includes(req.body.stage) ? req.body.stage : existing.stage,
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
    redemptionCount: 0,
    lastRedemptionAt: null,
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

app.post('/api/public/checkin', (req, res) => {
  const db = readDB();
  const { restaurantId, name, phone } = req.body;
  const restaurant = db.leads.find((l) => l.id === restaurantId);
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  let customer = db.customers.find((c) => c.restaurantId === restaurantId && c.phone === phone);
  const now = new Date().toISOString();
  if (customer) {
    customer.name = name || customer.name;
  } else {
    customer = {
      id: crypto.randomUUID(),
      restaurantId,
      name: name || '',
      phone,
      optedInAt: now,
      redemptionCount: 0,
      lastRedemptionAt: null,
    };
    db.customers.unshift(customer);
  }
  writeDB(db);
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

// ---- API: analytics ----
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`InTheLoop CRM running on port ${PORT}`);
});

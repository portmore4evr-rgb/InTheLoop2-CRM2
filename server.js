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
    fs.writeFileSync(DB_PATH, JSON.stringify({ leads: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  writeDB(db);
  res.status(204).end();
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

  res.json({
    total,
    byStage,
    liveClients,
    conversionRate,
    newThisMonth,
    dealsClosedThisMonth,
    recent,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`InTheLoop CRM running on port ${PORT}`);
});

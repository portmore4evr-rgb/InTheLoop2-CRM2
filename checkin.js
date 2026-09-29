const restaurantId = window.location.pathname.split('/checkin/')[1];
const TOKEN_KEY = 'itl_guest_token';
let currentOffer = '';
let restaurantName = '';

// ---- saved-on-this-phone token (so guests only fill the form once) ----
function getToken() {
  try { const t = localStorage.getItem(TOKEN_KEY); if (t) return t; } catch (e) {}
  const m = document.cookie.match(/(?:^|; )itl_guest=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function saveToken(t) {
  if (!t) return;
  try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
  document.cookie = `itl_guest=${encodeURIComponent(t)}; max-age=${60 * 60 * 24 * 400}; path=/; SameSite=Lax; Secure`;
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  document.cookie = 'itl_guest=; max-age=0; path=/';
}

function showStep(n) {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
}

function consentText() {
  return `Yes, text me my Reward ID and occasional offers from ${restaurantName}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out anytime.`;
}

function showPass(data, heading) {
  currentOffer = data.offer || currentOffer;
  document.getElementById('reward-id').textContent = data.customer.rewardId;
  document.getElementById('pass-heading').textContent = heading;
  const box = document.getElementById('status-box');
  const offerEl = document.getElementById('pass-offer-text');
  const note = document.getElementById('pass-note');
  offerEl.textContent = currentOffer || 'Your reward';
  if (data.status === 'redeemed_today') {
    box.className = 'rounded-2xl px-4 py-3 mb-4 text-sm bg-paper border border-line text-inksoft';
    box.textContent = '✓ Reward already used today. Rewards are once per day, so come back tomorrow for your next one:';
  } else if (data.status === 'joined_today') {
    box.className = 'rounded-2xl px-4 py-3 mb-4 text-sm bg-paper border border-line text-inksoft';
    box.textContent = 'You\'re in! On your NEXT visit, show this ID to staff to get:';
  } else {
    box.className = 'rounded-2xl px-4 py-3 mb-4 text-sm bg-okgreen text-paper2 font-semibold';
    box.textContent = 'Ready to redeem: show this ID to staff to get:';
  }
  note.textContent = data.isNewCustomer === false || data.member
    ? 'This phone is remembered: next time just scan, no form.'
    : 'We also texted it to you. This phone is remembered: next time just scan, no form.';
  if (data.visitType) document.getElementById('today-visit').value = data.visitType;
  showStep(2);
}

async function loadRestaurant() {
  try {
    const res = await fetch(`/api/public/restaurant/${restaurantId}`);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    restaurantName = data.restaurantName;
    document.getElementById('restaurant-name').textContent = data.restaurantName;
    document.getElementById('consent-text').textContent = consentText();
    document.getElementById('join-consent-text').textContent = consentText();
    document.getElementById('offer-text').textContent = data.currentOffer || 'Ask your server about today\'s deal!';
    currentOffer = data.currentOffer || '';
  } catch (e) {
    document.getElementById('restaurant-name').textContent = 'Restaurant not found';
    document.getElementById('offer-text').textContent = 'This check-in link looks invalid.';
    return false;
  }
  return true;
}

// Scanned before? Skip the form.
async function tryReturning() {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch('/api/public/returning', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token }),
    });
    if (!res.ok) { if (res.status === 404) clearToken(); return; }
    const data = await res.json();
    if (data.member) {
      const name = data.customer.name ? `, ${data.customer.name}` : '';
      showPass(data, `Welcome back${name}!`);
    } else if (data.knownGuest) {
      document.getElementById('join-heading').textContent = data.name ? `Hi ${data.name}!` : 'Hi there!';
      document.getElementById('join-sub').textContent =
        `Join ${restaurantName}'s loop with your saved info${data.phoneHint ? ` (${data.phoneHint})` : ''}. No typing needed.`;
      showStep(3);
    }
  } catch (e) { /* stay on the form */ }
}

async function checkIn() {
  const visitType = document.getElementById('visit-input').value;
  const name = document.getElementById('name-input').value.trim();
  const phone = document.getElementById('phone-input').value.trim();
  const email = document.getElementById('email-input').value.trim();
  const smsConsent = document.getElementById('consent-input').checked;
  const errorEl = document.getElementById('checkin-error');
  errorEl.classList.add('hidden');

  const fail = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };
  if (!visitType) return fail('Please pick whether this is your first time here.');
  if (!phone) return fail('Please enter your phone number.');
  if (!smsConsent) return fail('Please tick the box so we can text you your Reward ID.');

  try {
    const res = await fetch('/api/public/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, name, phone, email, smsConsent, visitType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || 'Something went wrong — please try again.');
    saveToken(data.token);
    data.visitType = visitType;
    showPass(data, data.isNewCustomer ? "You're In The Loop" : 'Welcome back — here is your Reward ID');
  } catch (e) {
    fail('Something went wrong — please try again.');
  }
}

async function joinWithSavedInfo() {
  const visitType = document.getElementById('join-visit').value;
  const smsConsent = document.getElementById('join-consent').checked;
  const errorEl = document.getElementById('join-error');
  errorEl.classList.add('hidden');
  const fail = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };
  if (!visitType) return fail('Please pick whether this is your first time here.');
  if (!smsConsent) return fail('Please tick the box so we can text you your Reward ID.');
  try {
    const res = await fetch('/api/public/checkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token: getToken(), smsConsent, visitType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || 'Something went wrong — please try again.');
    saveToken(data.token);
    data.visitType = visitType;
    showPass(data, "You're In The Loop");
  } catch (e) {
    fail('Something went wrong — please try again.');
  }
}

async function saveTodayVisit() {
  const visitType = document.getElementById('today-visit').value;
  if (!visitType) return;
  try {
    const res = await fetch('/api/public/returning', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, token: getToken(), visitType }),
    });
    if (res.ok) {
      const el = document.getElementById('today-saved');
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 2500);
    }
  } catch (e) {}
}

function notMe() {
  clearToken();
  document.getElementById('name-input').value = '';
  document.getElementById('phone-input').value = '';
  document.getElementById('email-input').value = '';
  showStep(1);
}

document.getElementById('today-visit').addEventListener('change', saveTodayVisit);
document.getElementById('join-btn').addEventListener('click', joinWithSavedInfo);
document.getElementById('not-me').addEventListener('click', notMe);
document.getElementById('join-not-me').addEventListener('click', notMe);

(async () => { if (await loadRestaurant()) await tryReturning(); })();

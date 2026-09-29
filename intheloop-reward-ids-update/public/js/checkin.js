const restaurantId = window.location.pathname.split('/checkin/')[1];
let currentOffer = '';

function showStep(n) {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
}

async function loadRestaurant() {
  try {
    const res = await fetch(`/api/public/restaurant/${restaurantId}`);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    document.getElementById('restaurant-name').textContent = data.restaurantName;
    document.getElementById('consent-text').textContent =
      `Yes, text me my Reward ID and occasional offers from ${data.restaurantName}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out anytime.`;
    document.getElementById('offer-text').textContent = data.currentOffer || 'Ask your server about today\'s deal!';
    currentOffer = data.currentOffer || '';
  } catch (e) {
    document.getElementById('restaurant-name').textContent = 'Restaurant not found';
    document.getElementById('offer-text').textContent = 'This check-in link looks invalid.';
  }
}

async function checkIn() {
  const name = document.getElementById('name-input').value.trim();
  const phone = document.getElementById('phone-input').value.trim();
  const email = document.getElementById('email-input').value.trim();
  const smsConsent = document.getElementById('consent-input').checked;
  const errorEl = document.getElementById('checkin-error');
  errorEl.classList.add('hidden');

  const fail = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };
  if (!phone) return fail('Please enter your phone number.');
  if (!smsConsent) return fail('Please tick the box so we can text you your Reward ID.');

  try {
    const res = await fetch('/api/public/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, name, phone, email, smsConsent }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || 'Something went wrong — please try again.');
    currentOffer = data.offer || currentOffer;
    document.getElementById('reward-id').textContent = data.customer.rewardId;
    document.getElementById('pass-heading').textContent = data.isNewCustomer
      ? "You're In The Loop" : 'Welcome back — here is your Reward ID';
    document.getElementById('pass-offer-text').textContent = currentOffer || 'Your welcome reward';
    showStep(2);
  } catch (e) {
    fail('Something went wrong — please try again.');
  }
}

loadRestaurant();

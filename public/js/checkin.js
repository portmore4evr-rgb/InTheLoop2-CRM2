const restaurantId = window.location.pathname.split('/checkin/')[1];
let currentPhone = '';
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
  const errorEl = document.getElementById('checkin-error');
  errorEl.classList.add('hidden');

  if (!phone) {
    errorEl.textContent = 'Please enter your phone number.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch('/api/public/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, name, phone }),
    });
    if (!res.ok) throw new Error('checkin failed');
    const data = await res.json();
    currentPhone = phone;
    currentOffer = data.offer || currentOffer;
    document.getElementById('pass-offer-text').textContent = currentOffer || 'Welcome bundle unlocked!';
    showStep(2);
  } catch (e) {
    errorEl.textContent = 'Something went wrong — please try again.';
    errorEl.classList.remove('hidden');
  }
}

async function redeem() {
  try {
    const res = await fetch('/api/public/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, phone: currentPhone }),
    });
    if (!res.ok) throw new Error('redeem failed');
    document.getElementById('redeemed-offer-text').textContent = currentOffer || 'Offer redeemed';
    showStep(3);
  } catch (e) {
    alert('Could not redeem right now — show this screen to your server and they can help.');
  }
}

loadRestaurant();

const restaurantId = window.location.pathname.split('/redeem/')[1];
const PIN_KEY = 'itl_pin_' + restaurantId;

function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function showResult(ok, title, detail) {
  const el = document.getElementById('result');
  el.className = 'rounded-[32px] p-6 text-center ' + (ok ? 'bg-okgreen text-paper2' : 'bg-brick text-paper2');
  el.innerHTML = `<p class="font-mono uppercase tracking-wider text-sm mb-2">${ok ? '✓ VALID — GIVE THE REWARD' : '✕ DO NOT REDEEM'}</p>
    <p class="font-display text-3xl mb-1">${esc(title)}</p><p class="text-sm opacity-90">${esc(detail)}</p>`;
  el.classList.remove('hidden');
}

async function loadRestaurant() {
  try {
    const res = await fetch(`/api/public/restaurant/${restaurantId}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    document.getElementById('restaurant-name').textContent = data.restaurantName;
  } catch (e) {
    document.getElementById('restaurant-name').textContent = 'Restaurant not found';
  }
  try { const saved = localStorage.getItem(PIN_KEY); if (saved) document.getElementById('pin-input').value = saved; } catch (e) {}
}

async function redeem() {
  const rewardId = document.getElementById('reward-input').value.trim().toUpperCase();
  const pin = document.getElementById('pin-input').value.trim();
  if (!rewardId || !pin) return showResult(false, 'Missing info', 'Enter the Reward ID and your staff PIN.');
  try {
    if (document.getElementById('remember-pin').checked) localStorage.setItem(PIN_KEY, pin);
    else localStorage.removeItem(PIN_KEY);
  } catch (e) {}
  try {
    const res = await fetch('/api/public/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, rewardId, pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const name = data.customer && data.customer.name ? data.customer.name : 'Guest';
      showResult(true, `${name} · return visit #${data.visitNumber}`, data.offer ? `Reward: ${data.offer}` : 'Give the welcome reward.');
      document.getElementById('reward-input').value = '';
    } else {
      showResult(false, data.error || 'Could not redeem', rewardId);
    }
  } catch (e) {
    showResult(false, 'No connection', 'Try again in a moment.');
  }
}

document.getElementById('btn-redeem').addEventListener('click', redeem);
document.getElementById('reward-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') redeem(); });
loadRestaurant();

const SIMULATION_MODE = !(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_PHONE_NUMBER
);

let client = null;
if (!SIMULATION_MODE) {
  const twilio = require('twilio');
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/**
 * Sends one SMS. In simulation mode (no Twilio env vars set), it just logs
 * to the console and returns success — so the app works end to end before
 * you've connected a real Twilio account.
 */
async function sendSms(to, body) {
  if (SIMULATION_MODE) {
    console.log(`[SIMULATED SMS] to ${to}: ${body}`);
    return { status: 'simulated', sid: null };
  }
  try {
    const message = await client.messages.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      body,
    });
    return { status: message.status, sid: message.sid };
  } catch (err) {
    console.error(`SMS send failed to ${to}:`, err.message);
    return { status: 'failed', sid: null, error: err.message };
  }
}

module.exports = { sendSms, SIMULATION_MODE };

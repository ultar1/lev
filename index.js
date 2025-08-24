const { spawnSync, spawn } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const path = require('path');
const axios = require('axios');

// === CONFIGURATION ===
const APP_NAME             = process.env.APP_NAME             || 'Levanter App';
const SESSION_ID           = process.env.SESSION_ID           || 'unknown-session';
const STATUS_VIEW_EMOJI    = process.env.STATUS_VIEW_EMOJI;
// FIXED: Changed default RESTART_DELAY_MINUTES from 12 hours (720) to 6 hours (360)
const RESTART_DELAY_MINUTES= parseInt(process.env.RESTART_DELAY_MINUTES || '360', 10);
const HEROKU_API_KEY       = process.env.HEROKU_API_KEY;

// === TELEGRAM SETUP ===
// FIX: Hardcoded Telegram Bot Token as requested
const TELEGRAM_BOT_TOKEN   = '7350697926:AAE3TO87lDFGKhZAiOzcWnyf4XIsIeSZhLo';
const TELEGRAM_USER_ID     = '7302005705';
// HARDCODED TELEGRAM CHANNEL ID - Replace with your actual channel ID
const TELEGRAM_CHANNEL_ID  = '-1002892034574'; // <--- Your channel ID goes here

let lastLogoutMessageId = null;
let lastLogoutAlertTime = null;

// === Load LAST_LOGOUT_ALERT from Heroku config vars ===
async function loadLastLogoutAlertTime() {
  // Ensure HEROKU_API_KEY is available before making API calls
  if (!HEROKU_API_KEY) {
      console.warn('HEROKU_API_KEY is not set. Cannot load LAST_LOGOUT_ALERT from Heroku config vars.');
      return;
  }
  const url = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
  const headers = {
    Authorization: `Bearer ${HEROKU_API_KEY}`,
    Accept: 'application/vnd.heroku+json; version=3'
  };

  try {
    const res = await axios.get(url, { headers });
    const saved = res.data.LAST_LOGOUT_ALERT;
    if (saved) {
      const parsed = new Date(saved);
      if (!isNaN(parsed)) {
        lastLogoutAlertTime = parsed;
        console.log(`Loaded LAST_LOGOUT_ALERT: ${parsed.toISOString()}`);
      }
    }
  } catch (err) {
    console.error('Failed to load LAST_LOGOUT_ALERT from Heroku:', err.message);
  }
}

// === Telegram helper ===
async function sendTelegramAlert(text, chatId = TELEGRAM_USER_ID) { // Make chatId an optional parameter
  // Ensure TELEGRAM_BOT_TOKEN is available before sending alerts
  if (!TELEGRAM_BOT_TOKEN) {
      console.error('TELEGRAM_BOT_TOKEN is not set. Cannot send Telegram alerts.');
      return null;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text };

  try {
    const res = await axios.post(url, payload);
    return res.data.result.message_id;
  } catch (err) {
    console.error(`Telegram alert failed for chat ID ${chatId}:`, err.message);
    if (err.response) {
        console.error(`   Telegram API Response: Status ${err.response.status}, Data: ${JSON.stringify(err.response.data)}`);
    }
    return null;
  }
}

// === “Logged out” alert with 24-hr cooldown & auto-delete ===
async function sendInvalidSessionAlert() {
  const now = new Date();
  if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < 24 * 3600e3) {
    console.log('Skipping logout alert — cooldown not expired.');
    return;
  }

  const nowStr   = now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  const hour     = now.getHours();
  const greeting = hour < 12 ? 'good morning'
                 : hour < 17 ? 'good afternoon'
                 : 'good evening';

  // FIX: Format restart time display for clarity (hours if >= 60 minutes)
  const restartTimeDisplay = RESTART_DELAY_MINUTES >= 60 && (RESTART_DELAY_MINUTES % 60 === 0)
    ? `${RESTART_DELAY_MINUTES / 60} hour(s)` 
    : `${RESTART_DELAY_MINUTES} minute(s)`;

  const message =
    `Hey 𝖀𝖑𝖙-𝕬𝕽, ${greeting}!\n\n` +
    `User [${APP_NAME}] has logged out.\n` +
    `[${SESSION_ID}] invalid\n` +
    `Time: ${nowStr}\n` +
    `Restarting in ${restartTimeDisplay}.`; // FIX: Use the new display variable

  try {
    // delete last one (only for the user, not channel if it's a broadcast)
    if (lastLogoutMessageId) {
      try { // Added try-catch for delete message to prevent it from failing the whole alert
        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`,
          { chat_id: TELEGRAM_USER_ID, message_id: lastLogoutMessageId }
        );
        console.log(`Deleted logout alert id ${lastLogoutMessageId}`);
      } catch (delErr) {
        console.warn(`Failed to delete previous message ${lastLogoutMessageId}: ${delErr.message}`);
      }
    }

    // send new one to user
    const msgId = await sendTelegramAlert(message, TELEGRAM_USER_ID);
    if (!msgId) return;

    lastLogoutMessageId = msgId;
    lastLogoutAlertTime = now;

    // Send to channel 
    await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
    console.log(`Sent new logout alert to channel ${TELEGRAM_CHANNEL_ID}`);


    // persist timestamp
    // Ensure HEROKU_API_KEY is available before making API calls
    if (!HEROKU_API_KEY) {
        console.warn('HEROKU_API_KEY is not set. Cannot persist LAST_LOGOUT_ALERT timestamp.');
        return;
    }
    const cfgUrl = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
    const headers = {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    };
    await axios.patch(cfgUrl, { LAST_LOGOUT_ALERT: now.toISOString() }, { headers });
    console.log(`Persisted LAST_LOGOUT_ALERT timestamp.`); // FIX: Clarified log message
  } catch (err) {
    console.error('Failed during sendInvalidSessionAlert():', err.message);
  }
}

// ---
// === Restart count tracker ===
async function trackRestartCount() {
  // Ensure HEROKU_API_KEY is available before making API calls
  if (!HEROKU_API_KEY) {
      console.warn('HEROKU_API_KEY is not set. Cannot track restart count on Heroku config vars.');
      return;
  }
  const url = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
  const headers = {
    Authorization: `Bearer ${HEROKU_API_KEY}`,
    Accept: 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json'
  };

  try {
    const res     = await axios.get(url, { headers });
    const current = parseInt(res.data.RESTART_COUNT || '0', 10);
    const updated = (current + 1).toString();

    await axios.patch(url, { RESTART_COUNT: updated }, { headers });

    const now    = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const text   = `[${APP_NAME}] Restart count: ${updated}\n🕒 Time: ${now}`;

    // Send to user
    await sendTelegramAlert(text, TELEGRAM_USER_ID);
    // Send to channel
    await sendTelegramAlert(text, TELEGRAM_CHANNEL_ID);
    console.log(`Sent restart count update to channel ${TELEGRAM_CHANNEL_ID}`);
  } catch (err) {
    console.error('Failed to update RESTART_COUNT:', err.message);
  }
}

// ---
// === PM2 process monitor ===
function startPm2() {
  const pm2 = spawn(
    'yarn', ['pm2','start','index.js','--name','levanter','--attach'],
    { cwd: 'levanter', stdio: ['pipe','pipe','pipe'] }
  );

  let restartScheduled = false;
  function scheduleRestart() {
    if (restartScheduled) return;
    restartScheduled = true;
    console.warn(`INVALID SESSION ID DETECTED → scheduling restart in ${RESTART_DELAY_MINUTES} minute(s).`); // FIX: Clarified log
    sendInvalidSessionAlert();
    setTimeout(() => process.exit(1), RESTART_DELAY_MINUTES * 60*1000);
  }

  pm2.stderr.on('data', data => {
    if (data.toString().includes('INVALID SESSION ID')) scheduleRestart();
  });

  pm2.stdout.on('data', async data => {
    const out = data.toString();
    console.log(out.trim());
    if (out.includes('INVALID SESSION ID')) scheduleRestart();
    if (out.includes('External Plugins Installed')) {
      const now = new Date().toLocaleString('en-GB',{ timeZone:'Africa/Lagos'});
      const message = `[${APP_NAME}] connected.\n🔐 ${SESSION_ID}\n🕒 ${now}`;
      // Send to user
      await sendTelegramAlert(message, TELEGRAM_USER_ID);
      // Send to channel
      await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
      console.log(` Sent "connected" message to channel ${TELEGRAM_CHANNEL_ID}`);
    }
  });
 // This is the CRITICAL part. It listens for errors.
    pm2.stderr.on('data', async data => {
    const error = data.toString().trim();
    if (error.length > 0) {
      console.error(error);
      
      // Check for the R14 memory error message
      if (error.includes('R14 (Memory quota exceeded)')) {
          // Send the specific message you want to the channel, correctly formatted as a string
          const errorMessage = `R14 memory error detected for [${APP_NAME}]`;
          await sendTelegramAlert(errorMessage, TELEGRAM_CHANNEL_ID);
      } else {
          // If it's another error, send the raw error message
          await sendTelegramAlert(`[LEVANTER_ERROR] ${error}`, TELEGRAM_CHANNEL_ID);
      }
    }
  });

  pm2.on('close', async (code) => {
    // This is a correct template literal
    const exitMessage = `[LEVANTER_ERROR] Bot process exited with code ${code}. Restarting...`;
    console.log(exitMessage);
    await sendTelegramAlert(exitMessage, TELEGRAM_CHANNEL_ID);
    // Restart the parent process to restart PM2
    process.exit(1); 
  });


// ---
// === Dependency & repo setup ===
function installDependencies() {
  const r = spawnSync('yarn',
    ['install','--force','--non-interactive','--network-concurrency','3'],
    { cwd:'levanter', stdio:'inherit', env:{...process.env,CI:'true'} }
  );
  if (r.error||r.status!==0) {
    console.error('❌ Dependency install failed:', r.error||r.status);
    process.exit(1);
  }
}

function checkDependencies() {
  if (!existsSync(path.resolve('levanter/package.json'))) {
    console.error('❌ package.json missing');
    process.exit(1);
  }
  const r = spawnSync('yarn',['check','--verify-tree'],{cwd:'levanter',stdio:'inherit'});
  if (r.status!==0) installDependencies();
}

function cloneRepository() {
  const r = spawnSync('git',
    ['clone','https://github.com/lyfe00011/levanter.git','levanter'],
    { stdio:'inherit' }
  );
  if (r.error) throw new Error(`git clone failed: ${r.error.message}`);

  const cfg = `VPS=true\nSESSION_ID=${SESSION_ID}` +
    (STATUS_VIEW_EMOJI ? `\nSTATUS_VIEW_EMOJI=${STATUS_VIEW_EMOJI}` : '');
  writeFileSync('levanter/config.env', cfg);
  installDependencies();
}

// === INIT ===
(async () => {
  await loadLastLogoutAlertTime();
  await trackRestartCount();

  if (!existsSync('levanter')) {
    cloneRepository();
    checkDependencies();
  } else {
    checkDependencies();
  }

  startPm2();
})();

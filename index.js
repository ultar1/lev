const { spawnSync, spawn } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const path = require('path');
const axios = require('axios');

// === CONFIGURATION ===
const APP_NAME             = process.env.APP_NAME             || 'Levanter App';
const SESSION_ID           = process.env.SESSION_ID           || 'unknown-session';
const STATUS_VIEW_EMOJI    = process.env.STATUS_VIEW_EMOJI;
const RESTART_DELAY_MINUTES= parseInt(process.env.RESTART_DELAY_MINUTES || '360', 10);
const HEROKU_API_KEY       = process.env.HEROKU_API_KEY;

// === TELEGRAM SETUP ===
const TELEGRAM_BOT_TOKEN   = '7350697926:AAE3TO87lDFGKhZAiOzcWnyf4XIsIeSZhLo';
const TELEGRAM_USER_ID     = '7302005705';
const TELEGRAM_CHANNEL_ID  = '-1002892034574';

let lastLogoutMessageId = null;
let lastLogoutAlertTime = null;

// === Load LAST_LOGOUT_ALERT from Heroku config vars ===
async function loadLastLogoutAlertTime() {
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
async function sendTelegramAlert(text, chatId = TELEGRAM_USER_ID) {
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
    return null;
  }
}

// === Logged out alert with 24-hr cooldown & auto-delete ===
async function sendInvalidSessionAlert() {
  const now = new Date();
  if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < 24 * 3600e3) {
    console.log('Skipping logout alert cooldown not expired.');
    return;
  }

  const nowStr   = now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  const hour     = now.getHours();
  const greeting = hour < 12 ? 'good morning'
                 : hour < 17 ? 'good afternoon'
                 : 'good evening';

  const restartTimeDisplay = RESTART_DELAY_MINUTES >= 60 && (RESTART_DELAY_MINUTES % 60 === 0)
    ? `${RESTART_DELAY_MINUTES / 60} hour(s)` 
    : `${RESTART_DELAY_MINUTES} minute(s)`;

  const message =
    `Hey Ult-AR, ${greeting}!\n\n` +
    `User [${APP_NAME}] has logged out.\n` +
    `[${SESSION_ID}] invalid\n` +
    `Time: ${nowStr}\n` +
    `Restarting in ${restartTimeDisplay}.`;

  try {
    if (lastLogoutMessageId) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`,
          { chat_id: TELEGRAM_USER_ID, message_id: lastLogoutMessageId }
        );
      } catch (delErr) {
        console.warn(`Failed to delete previous message ${lastLogoutMessageId}: ${delErr.message}`);
      }
    }

    const msgId = await sendTelegramAlert(message, TELEGRAM_USER_ID);
    if (!msgId) return;

    lastLogoutMessageId = msgId;
    lastLogoutAlertTime = now;
 
    await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);

    if (!HEROKU_API_KEY) return;
    const cfgUrl = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
    const headers = {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    };
    await axios.patch(cfgUrl, { LAST_LOGOUT_ALERT: now.toISOString() }, { headers });
  } catch (err) {
    console.error('Failed during sendInvalidSessionAlert():', err.message);
  }
}

// ASYNC FUNCTION FOR R14 ERRORS
async function sendR14ErrorAlert() {
  const message = `R14 memory error detected for [${APP_NAME}]`;
  await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
}

// Monitor Heroku logs every 3 minutes
async function monitorHerokuLogs() {
  if (!HEROKU_API_KEY) return;

  const url = `https://api.heroku.com/apps/${APP_NAME}/log-sessions`;
  const headers = {
    Authorization: `Bearer ${HEROKU_API_KEY}`,
    Accept: 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json'
  };

  try {
    const res = await axios.post(url, { lines: 150, source: 'app' }, { headers });
    const logplexUrl = res.data.logplex_url;
    const logsRes = await axios.get(logplexUrl);
    const logs = logsRes.data;

    if (logs.includes('Error R14 (Memory quota exceeded)')) {
      await sendR14ErrorAlert();
    }

    if (logs.includes('Process exited with status 137') || logs.includes('State changed from starting to crashed')) {
        process.exit(1);
    }
  } catch (err) {
    console.error('Failed to monitor Heroku logs:', err.message);
  }
}

// === PM2 process monitor ===
function startPm2() {
  const pm2 = spawn(
    'npx', ['pm2-runtime', 'start', 'index.js', '--name', 'levanter'],
    { cwd: 'levanter', stdio: ['pipe','pipe','pipe'] }
  );

  let restartScheduled = false;
  function scheduleRestart() {
    if (restartScheduled) return;
    restartScheduled = true;
    sendInvalidSessionAlert();
    setTimeout(() => process.exit(1), RESTART_DELAY_MINUTES * 60*1000);
  }
  
  pm2.stderr.on('data', async data => {
    const error = data.toString();
    console.error(error.trim());
    if (error.includes('INVALID SESSION ID')) scheduleRestart();
  });

  pm2.stdout.on('data', async data => {
    const out = data.toString();
    console.log(out.trim()); 

    if (out.includes('INVALID SESSION ID')) scheduleRestart();
    
    if (out.includes('External Plugins Installed')) {
      const now = new Date().toLocaleString('en-GB',{ timeZone:'Africa/Lagos'});
      const message = `[${APP_NAME}] connected.\nSession: ${SESSION_ID}\nTime: ${now}`;
      await sendTelegramAlert(message, TELEGRAM_USER_ID);
      await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
    }
  });

  pm2.on('close', async (code) => {
    process.exit(1); 
  });
}

// === INIT ===
(async () => {
  await loadLastLogoutAlertTime();

  // Create config.env from existing folder built during postbuild phase
  const cfg = `VPS=true\nSESSION_ID=${SESSION_ID}` +
    (STATUS_VIEW_EMOJI ? `\nSTATUS_VIEW_EMOJI=${STATUS_VIEW_EMOJI}` : '');

  if (existsSync('levanter')) {
    writeFileSync('levanter/config.env', cfg);
    console.log('Config.env updated.');
  } else {
    console.error('Levanter folder missing. Build failed.');
    process.exit(1);
  }

  setInterval(monitorHerokuLogs, 3 * 60 * 1000);
  startPm2();
})();

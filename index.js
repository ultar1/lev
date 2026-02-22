process.env.NPM_CONFIG_LEGACY_PEER_DEPS = 'true';

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
const TELEGRAM_CHANNEL_ID  = '-1003620973489';

// === GLOBALS (FIXED: DEFINED AT TOP TO AVOID REFERENCEERROR) ===
let nodeRestartCount = 0;
const maxNodeRestarts = 5;
const restartWindow = 30000; 
let lastRestartTime = Date.now();
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

  const restartTimeDisplay = RESTART_DELAY_MINUTES >= 60 && (RESTART_DELAY_MINUTES % 60 === 0)
    ? `${RESTART_DELAY_MINUTES / 60} hour(s)` 
    : `${RESTART_DELAY_MINUTES} minute(s)`;

  const message =
    `Hey 𝖀𝖑𝖙-𝕬𝕽, ${greeting}!\n\n` +
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
        console.log(`Deleted logout alert id ${lastLogoutMessageId}`);
      } catch (delErr) {
        console.warn(`Failed to delete previous message ${lastLogoutMessageId}: ${delErr.message}`);
      }
    }

    const msgId = await sendTelegramAlert(message, TELEGRAM_USER_ID);
    if (!msgId) return;

    lastLogoutMessageId = msgId;
    lastLogoutAlertTime = now;
 
    await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
    console.log(`Sent new logout alert to channel ${TELEGRAM_CHANNEL_ID}`);

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
    console.log(`Persisted LAST_LOGOUT_ALERT timestamp.`);
  } catch (err) {
    console.error('Failed during sendInvalidSessionAlert():', err.message);
  }
}

// --- NEW ASYNC FUNCTION FOR R14 ERRORS ---
async function sendR14ErrorAlert() {
  const message = `R14 memory error detected for [${APP_NAME}]`;
  console.log(`[MONITOR] Detected R14 Error. Formatting alert.`);
  await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
}
// --- END OF NEW FUNCTION ---

// --- NEW: Monitor Heroku logs every 3 minutes ---
async function monitorHerokuLogs() {
  if (!HEROKU_API_KEY) {
    console.warn('HEROKU_API_KEY is not set. Cannot monitor Heroku logs.');
    return;
  }

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

    // Check for R14 errors
    if (logs.includes('Error R14 (Memory quota exceeded)')) {
      console.log('[MONITOR] R14 detected in Heroku logs.');
      await sendR14ErrorAlert();
    } else {
      console.log('[MONITOR] No R14 errors found in latest logs.');
    }

    // === UPDATE: Check for SIGKILL / Crash / Status 137 ===
    if (logs.includes('Process exited with status 137') || logs.includes('State changed from starting to crashed')) {
        console.log('[MONITOR] CRASH DETECTED (SIGKILL/Status 137). Restarting app immediately...');
        process.exit(1);
    }
    // === END UPDATE ===

  } catch (err) {
    console.error('Failed to monitor Heroku logs:', err.message);
  }
}
// --- END OF NEW FUNCTION ---


function startNode() {
  const child = spawn('node', ['index.js'], { 
    cwd: 'levanter', 
    stdio: ['pipe', 'pipe', 'pipe'] 
  });

  let restartScheduled = false;
  function scheduleRestart() {
    if (restartScheduled) return;
    restartScheduled = true;
    console.warn(`INVALID SESSION ID DETECTED → scheduling restart in ${RESTART_DELAY_MINUTES} minute(s).`);
    sendInvalidSessionAlert();
    setTimeout(() => process.exit(1), RESTART_DELAY_MINUTES * 60 * 1000);
  }

  child.stderr.on('data', async data => {
    const error = data.toString();
    console.error(error.trim());
    
    if (error.includes('Error R14 (Memory quota exceeded)')) {
        await sendR14ErrorAlert();
    }

    if (error.includes('exceeded the data transfer quota')) {
        const quotaMessage = `🚨 **NEON QUOTA EXCEEDED** 🚨\n\nApp: \`${APP_NAME}\`\nError: Data transfer quota exceeded. Database is likely offline.`;
        console.warn(quotaMessage);
        await sendTelegramAlert(quotaMessage, TELEGRAM_CHANNEL_ID);
    }
    
    if (error.includes('INVALID SESSION ID')) {
        scheduleRestart();
    }
  });

  child.stdout.on('data', async data => {
    const out = data.toString();
    console.log(out.trim()); 
    
    if (out.includes('Error R14 (Memory quota exceeded)')) {
        await sendR14ErrorAlert();
    }

    if (out.includes('exceeded the data transfer quota')) {
        const quotaMessage = `🚨 **NEON QUOTA EXCEEDED** 🚨\n\nApp: \`${APP_NAME}\`\nError: Data transfer quota exceeded. Database is likely offline.`;
        console.warn(quotaMessage);
        await sendTelegramAlert(quotaMessage, TELEGRAM_CHANNEL_ID);
    }

    if (out.includes('INVALID SESSION ID')) {
      scheduleRestart();
    }
    
    if (out.includes('External Plugins Installed')) {
      const now = new Date().toLocaleString('en-GB',{ timeZone:'Africa/Lagos'});
      const message = `[${APP_NAME}] connected.\n🔐 ${SESSION_ID}\n🕒 ${now}`;
      await sendTelegramAlert(message, TELEGRAM_USER_ID);
      await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
      console.log(` Sent "connected" message to channel ${TELEGRAM_CHANNEL_ID}`);
    }
  });

  child.on('close', async (code) => {
    if (restartScheduled) return; // Don't alert if we planned the exit
    const exitMessage = `[LEVANTER_ERROR] Bot process exited with code ${code}. Restarting...`;
    console.log(exitMessage);
    await sendTelegramAlert(exitMessage, TELEGRAM_CHANNEL_ID);
    
    // Auto-restart logic for startNode
    const currentTime = Date.now();
    if (currentTime - lastRestartTime > restartWindow) {
      nodeRestartCount = 0;
    }
    lastRestartTime = currentTime;
    nodeRestartCount++;

    if (nodeRestartCount > maxNodeRestarts) {
      console.error('Continuous crash detected. Stopping retries.');
      return;
    }
    setTimeout(startNode, 5000);
  });
}

// === PM2 process monitor ===

const { spawn } = require('child_process');

function startPm2() {
  const pm2 = spawn(
    'npx',
    ['pm2', 'start', 'index.js', '--name', 'levanter', '--attach'],
    { cwd: 'levanter', stdio: 'inherit' }
  );

  pm2.on('close', (code) => {
    console.log(`PM2 exited with code ${code}`);
    process.exit(code);
  });
}

  let restartScheduled = false;
  function scheduleRestart() {
    if (restartScheduled) return;
    restartScheduled = true;
    console.warn(`INVALID SESSION ID DETECTED → scheduling restart in ${RESTART_DELAY_MINUTES} minute(s).`);
    sendInvalidSessionAlert();
    setTimeout(() => process.exit(1), RESTART_DELAY_MINUTES * 60*1000);
  }
  
  pm2.stderr.on('data', async data => {
    const error = data.toString();
    console.error(error.trim());
    
    if (error.includes('Error R14 (Memory quota exceeded)')) {
        await sendR14ErrorAlert();
    }

    // --- NEW CHECK FOR DATA QUOTA ---
    if (error.includes('exceeded the data transfer quota')) {
        const quotaMessage = `🚨 **NEON QUOTA EXCEEDED** 🚨\n\nApp: \`${APP_NAME}\`\nError: Data transfer quota exceeded. Database is likely offline.`;
        console.warn(quotaMessage);
        await sendTelegramAlert(quotaMessage, TELEGRAM_CHANNEL_ID); // <-- CHANGED TO CHANNEL ID
    }
    // --- END OF NEW CHECK ---
    
    if (error.includes('INVALID SESSION ID')) {
        scheduleRestart();
    }
  });

  pm2.stdout.on('data', async data => {
    const out = data.toString();
    console.log(out.trim()); 
    
    if (out.includes('Error R14 (Memory quota exceeded)')) {
        await sendR14ErrorAlert();
    }

    // --- NEW CHECK FOR DATA QUOTA ---
    if (out.includes('exceeded the data transfer quota')) {
        const quotaMessage = `🚨 **NEON QUOTA EXCEEDED** 🚨\n\nApp: \`${APP_NAME}\`\nError: Data transfer quota exceeded. Database is likely offline.`;
        console.warn(quotaMessage);
        await sendTelegramAlert(quotaMessage, TELEGRAM_CHANNEL_ID); // <-- CHANGED TO CHANNEL ID
    }
    // --- END OF NEW CHECK ---

    if (out.includes('INVALID SESSION ID')) {
      scheduleRestart();
    }
    
    if (out.includes('External Plugins Installed')) {
      const now = new Date().toLocaleString('en-GB',{ timeZone:'Africa/Lagos'});
      const message = `[${APP_NAME}] connected.\n🔐 ${SESSION_ID}\n🕒 ${now}`;
      await sendTelegramAlert(message, TELEGRAM_USER_ID);
      await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
      console.log(` Sent "connected" message to channel ${TELEGRAM_CHANNEL_ID}`);
    }
  });

  pm2.on('close', async (code) => {
    const exitMessage = `[LEVANTER_ERROR] Bot process exited with code ${code}. Restarting...`;
    console.log(exitMessage);
    await sendTelegramAlert(exitMessage, TELEGRAM_CHANNEL_ID);
    process.exit(1); 
  });
}

// === INIT ===
(async () => {
  await loadLastLogoutAlertTime();

  if (!existsSync('levanter/package.json')) {
    console.error('❌ Levanter folder not found!');
    process.exit(1);
  }

  const cfg = `VPS=true\nSESSION_ID=${SESSION_ID}` + (STATUS_VIEW_EMOJI ? `\nSTATUS_VIEW_EMOJI=${STATUS_VIEW_EMOJI}` : '');
  writeFileSync('levanter/config.env', cfg);

  setInterval(monitorHerokuLogs, 180000); // 3 mins

  // FIXED: 3-second delay to prevent the Baileys "module status 0" race condition
  console.log("🕒 Waiting for system to stabilize...");
  setTimeout(startPm2, 3000);
})();

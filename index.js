const { spawnSync, spawn } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

// === CONFIGURATION ===
const APP_NAME = process.env.APP_NAME || 'Levanter App';
const SESSION_ID = process.env.SESSION_ID || 'unknown-session';
const STATUS_VIEW_EMOJI = process.env.STATUS_VIEW_EMOJI;
const RESTART_DELAY_MINUTES = parseInt(process.env.RESTART_DELAY_MINUTES || '15', 10);
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;

// === TELEGRAM SETUP ===
const TELEGRAM_BOT_TOKEN = '7350697926:AAFNtsuGfJy4wOkA0Xuv_uY-ncx1fXPuTGI';
const TELEGRAM_USER_ID = '7302005705';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// === TELEGRAM ALERT ===
function sendTelegramAlert(message) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: TELEGRAM_USER_ID,
    text: message,
  });
}

function sendInvalidSessionAlert() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'good morning' : hour < 17 ? 'good afternoon' : 'good evening';

  const message = `👋 Hey 𝖀𝖑𝖙-𝕬𝕽, ${greeting}!\n\nUser [${APP_NAME}] has logged out.\n[${SESSION_ID}] invalid\n🕒 Time: ${now}\n🔁 Restarting in ${RESTART_DELAY_MINUTES} minute(s).`;
  sendTelegramAlert(message);
}

async function trackAppStart() {
  const url = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
  const headers = {
    Authorization: `Bearer ${HEROKU_API_KEY}`,
    Accept: 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json',
  };

  try {
    const res = await axios.get(url, { headers });
    const now = new Date();
    const createdAt = res.data.CREATED_AT || now.toISOString();

    if (!res.data.CREATED_AT) {
      await axios.patch(url, { CREATED_AT: createdAt }, { headers });
    }

    await axios.patch(url, {
      LAST_RESTART: now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })
    }, { headers });

    const message = `🚀 [${APP_NAME}] App started.\n🕒 Time: ${now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}`;
    sendTelegramAlert(message);
  } catch (err) {
    console.error('❌ Failed to update app start info:', err.message);
  }
}

async function getAppStatus(appName) {
  const url = `https://api.heroku.com/apps/${appName}/config-vars`;
  const headers = {
    Authorization: `Bearer ${HEROKU_API_KEY}`,
    Accept: 'application/vnd.heroku+json; version=3',
  };

  try {
    const res = await axios.get(url, { headers });
    const session = res.data.SESSION_ID || 'unknown';
    const lastRestart = res.data.LAST_RESTART || 'not recorded';
    const createdAt = res.data.CREATED_AT;

    let countdown = '';
    if (createdAt) {
      const created = new Date(createdAt);
      const now = new Date();
      const daysPassed = Math.floor((now - created) / (1000 * 60 * 60 * 24));
      const daysLeft = Math.max(0, 30 - daysPassed);
      countdown = `📆 Days Remaining: ${daysLeft} of 30`;
    }

    return `📊 [${appName}] Status:\n🔐 Session ID: ${session}\n🕒 Last Restart: ${lastRestart}\n${countdown}`;
  } catch (err) {
    return `❌ Failed to fetch status for ${appName}: ${err.message}`;
  }
}

// === NODE PROCESS MONITORING ===
function startPm2() {
  const pm2 = spawn('yarn', ['pm2', 'start', 'index.js', '--name', 'levanter', '--attach'], {
    cwd: 'levanter',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let restartScheduled = false;

  function scheduleRestart() {
    if (restartScheduled) return;
    restartScheduled = true;

    console.warn(`Invalid session detected. Restarting in ${RESTART_DELAY_MINUTES} minute(s)...`);
    sendInvalidSessionAlert();

    setTimeout(() => {
      console.log('Restarting app now...');
      process.exit(1);
    }, RESTART_DELAY_MINUTES * 60 * 1000);
  }

  if (pm2.stderr) {
    pm2.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('INVALID SESSION ID')) {
        scheduleRestart();
      }
    });
  }

  if (pm2.stdout) {
    pm2.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(output);

      if (output.includes('INVALID SESSION ID')) {
        scheduleRestart();
      }

      if (output.includes('External Plugins Installed')) {
        const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
        const message = `✅ [${APP_NAME}] connected successfully.\n🔐 Session ID: ${SESSION_ID}\n🕒 Time: ${now}`;
        sendTelegramAlert(message);
      }
    });
  }
}

// === DEPENDENCY SETUP ===
function installDependencies() {
  const installResult = spawnSync(
    'yarn',
    ['install', '--force', '--non-interactive', '--network-concurrency', '3'],
    {
      cwd: 'levanter',
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
    }
  );

  if (installResult.error || installResult.status !== 0) {
    console.error(
      `Failed to install dependencies: ${
        installResult.error ? installResult.error.message : 'Unknown error'
      }`
    );
    process.exit(1);
  }
}

function checkDependencies() {
  if (!existsSync(path.resolve('levanter/package.json'))) {
    console.error('package.json not found!');
    process.exit(1);
  }

  const result = spawnSync('yarn', ['check', '--verify-tree'], {
    cwd: 'levanter',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.log('Some dependencies are missing or incorrectly installed.');
    installDependencies();
  }
}

function cloneRepository() {
  const cloneResult = spawnSync(
    'git',
    ['clone', 'https://github.com/lyfe00011/levanter.git', 'levanter'],
    {
      stdio: 'inherit',
    }
  );

  if (cloneResult.error) {
    throw new Error(`Failed to clone the repository: ${cloneResult.error.message}`);
  }

  const configPath = 'levanter/config.env';
  try {
    let configContent = `VPS=true\nSESSION_ID=${SESSION_ID}`;
    
    if (STATUS_VIEW_EMOJI) {
      configContent += `\nSTATUS_VIEW_EMOJI=${STATUS_VIEW_EMOJI}`;
    }

    writeFileSync(configPath, configContent);
  } catch (err) {
    throw new Error(`Failed to write to config.env: ${err.message}`);
  }

  installDependencies();
}

// === TELEGRAM WEBHOOK HANDLER ===
const app = express();
app.use(bodyParser.json());

app.post(`/webhook/${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  const msg = req.body.message;
  if (!msg || msg.chat.id.toString() !== TELEGRAM_USER_ID) return res.sendStatus(403);

  const text = msg.text.trim();

  if (text.startsWith('/status ')) {
    const [, appName] = text.split(' ');
    const status = await getAppStatus(appName);
    await sendTelegramAlert(status);
  } else {
    await sendTelegramAlert(`🤖 Available commands:\n/status <app>`);
  }

  res.sendStatus(200);
});

// === INIT ===
trackAppStart();

if (!existsSync('levanter')) {
  cloneRepository();
  checkDependencies();
} else {
  checkDependencies();
}

startPm2();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot + Monitor running on port ${PORT}`));

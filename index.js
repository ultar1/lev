const { spawnSync, spawn } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const path = require('path');
const axios = require('axios');

// === CONFIGURATION ===
const APP_NAME = process.env.APP_NAME || 'Levanter App';
const SESSION_ID = process.env.SESSION_ID || 'unknown-session';
const STATUS_VIEW_EMOJI = process.env.STATUS_VIEW_EMOJI;
const RESTART_DELAY_MINUTES = parseInt(process.env.RESTART_DELAY_MINUTES || '15', 10);
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;

// === TELEGRAM ALERT SETUP ===
const TELEGRAM_BOT_TOKEN = '7350697926:AAFNtsuGfJy4wOkA0Xuv_uY-ncx1fXPuTGI';
const TELEGRAM_USER_ID = '7302005705';

function sendTelegramAlert(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_USER_ID,
    text: message,
  };

  axios.post(url, payload)
    .then(() => console.log('✅ Telegram alert sent'))
    .catch((err) => console.error('❌ Telegram alert failed:', err.message));
}

function sendInvalidSessionAlert() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'good morning' : hour < 17 ? 'good afternoon' : 'good evening';

  const message = `👋 Hey 𝖀𝖑𝖙-𝕬𝕽, ${greeting}!\n\nUser [${APP_NAME}] has logged out.\n[${SESSION_ID}] invalid\n🕒 Time: ${now}\n🔁 Restarting in ${RESTART_DELAY_MINUTES} minute(s).`;

  sendTelegramAlert(message);
}

async function trackRestartCount() {
  const url = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
  const headers = {
    Authorization: `Bearer ${HEROKU_API_KEY}`,
    Accept: 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json',
  };

  try {
    const res = await axios.get(url, { headers });
    const current = parseInt(res.data.RESTART_COUNT || '0', 10);
    const updated = current + 1;

    await axios.patch(url, { RESTART_COUNT: updated.toString() }, { headers });

    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const message = `🔁 [${APP_NAME}] Restart count: ${updated}\n🕒 Time: ${now}`;
    sendTelegramAlert(message);
  } catch (err) {
    console.error('❌ Failed to update RESTART_COUNT:', err.message);
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

// === INIT ===
trackRestartCount();

if (!existsSync('levanter')) {
  cloneRepository();
  checkDependencies();
} else {
  checkDependencies();
}

startPm2();

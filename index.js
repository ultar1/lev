const { spawnSync, spawn } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const path = require('path');
const axios = require('axios');

// === CONFIGURATION ===
const SESSION_ID = process.env.SESSION_ID;
const STATUS_VIEW_EMOJI = process.env.STATUS_VIEW_EMOJI;
const RESTART_DELAY_MINUTES = parseInt(process.env.RESTART_DELAY_MINUTES || '15', 10);
const APP_NAME = SESSION_ID || 'Levanter App'; // Use SESSION_ID as app name

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
  const hour = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false });
  let greeting;

  if (hour < 12) greeting = 'good morning';
  else if (hour < 17) greeting = 'good afternoon';
  else greeting = 'good evening';

  const message = `👋 Hey 𝖀𝖑𝖙-𝕬𝕽, ${greeting}!\n\n🚨 [${APP_NAME}] Invalid Session ID detected.\n🕒 Time: ${now}\n🔁 Restarting in ${RESTART_DELAY_MINUTES} minute(s).`;

  sendTelegramAlert(message);
}

// === LOGGING ===
console.log(`STATUS_VIEW_EMOJI: ${STATUS_VIEW_EMOJI ? STATUS_VIEW_EMOJI : 'Skipping...'}`);
console.log(`RESTART_DELAY_MINUTES: ${RESTART_DELAY_MINUTES} minute(s)`);

// === NODE PROCESS MONITORING ===
let nodeRestartCount = 0;
const maxNodeRestarts = 5;
const restartWindow = 30000;
let lastRestartTime = Date.now();

function startNode() {
  const child = spawn('node', ['index.js'], { cwd: 'levanter', stdio: 'inherit' });

  child.on('exit', (code) => {
    if (code !== 0) {
      const currentTime = Date.now();
      if (currentTime - lastRestartTime > restartWindow) {
        nodeRestartCount = 0;
      }
      lastRestartTime = currentTime;
      nodeRestartCount++;

      if (nodeRestartCount > maxNodeRestarts) {
        console.error('Node.js process is restarting continuously. Stopping retries...');
        return;
      }
      console.log(
        `Node.js process exited with code ${code}. Restarting... (Attempt ${nodeRestartCount})`
      );
      startNode();
    }
  });
}

function startPm2() {
  const pm2 = spawn('yarn', ['pm2', 'start', 'index.js', '--name', 'levanter', '--attach'], {
    cwd: 'levanter',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let restartCount = 0;
  const maxRestarts = 5;
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

  pm2.on('exit', (code) => {
    if (code !== 0) {
      startNode();
    }
  });

  pm2.on('error', (error) => {
    console.error(`yarn pm2 error: ${error.message}`);
    startNode();
  });

  if (pm2.stderr) {
    pm2.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('restart')) {
        restartCount++;
        if (restartCount > maxRestarts) {
          spawnSync('yarn', ['pm2', 'delete', 'levanter'], { cwd: 'levanter', stdio: 'inherit' });
          startNode();
        }
      }
      if (output.includes('INVALID SESSION ID')) {
        scheduleRestart();
      }
    });
  }

  if (pm2.stdout) {
    pm2.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(output);
      if (output.includes('Connecting')) {
        restartCount = 0;
      }
      if (output.includes('INVALID SESSION ID')) {
        scheduleRestart();
      }
    });
  }
}

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

if (!existsSync('levanter')) {
  cloneRepository();
  checkDependencies();
} else {
  checkDependencies();
}

startPm2();

// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// 2) Load fallback env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch (e) {
  console.warn('Could not load fallback env vars from app.json:', e.message);
}

// 3) Environment config
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// Add the channel ID the bot will listen to for specific messages
const TELEGRAM_LISTEN_CHANNEL_ID = '-1002892034574'; // <--- Your channel ID here

// 4) Postgres setup & ensure tables exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id    TEXT NOT NULL,
      bot_name   TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deploy_keys (
      key        TEXT PRIMARY KEY,
      uses_left  INTEGER NOT NULL,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Table for "Free Trial" cooldowns
  await pool.query(`
    CREATE TABLE IF NOT EXISTS temp_deploys (
      user_id       TEXT PRIMARY KEY,
      last_deploy_at TIMESTAMP NOT NULL
    );
  `);
})().catch(console.error);

// 5) DB helper functions
async function addUserBot(u, b, s) {
  await pool.query(
    'INSERT INTO user_bots(user_id,bot_name,session_id) VALUES($1,$2,$3)',
    [u, b, s]
  );
}
async function getUserBots(u) {
  const r = await pool.query(
    'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
    [u]
  );
  return r.rows.map(x => x.bot_name);
}
// NEW: Function to get user_id by bot_name
async function getUserIdByBotName(botName) {
    const r = await pool.query(
        'SELECT user_id FROM user_bots WHERE bot_name=$1',
        [botName]
    );
    return r.rows.length > 0 ? r.rows[0].user_id : null;
}
// NEW: Function to get all bots from the database
async function getAllUserBots() {
    const r = await pool.query('SELECT user_id, bot_name FROM user_bots');
    return r.rows;
}

async function deleteUserBot(u, b) {
  await pool.query(
    'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
    [u, b]
  );
}
async function updateUserSession(u, b, s) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [s, u, b]
  );
}
async function addDeployKey(key, uses, createdBy) {
  await pool.query(
    'INSERT INTO deploy_keys(key,uses_left,created_by) VALUES($1,$2,$3)',
    [key, uses, createdBy]
  );
}
async function useDeployKey(key) {
  const res = await pool.query(
    `UPDATE deploy_keys
     SET uses_left = uses_left - 1
     WHERE key = $1 AND uses_left > 0
     RETURNING uses_left`,
    [key]
  );
  if (res.rowCount === 0) return null;
  const left = res.rows[0].uses_left;
  if (left === 0) {
    await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]);
  }
  return left;
}

async function canDeployFreeTrial(userId) {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days
    const res = await pool.query(
        'SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1',
        [userId]
    );
    if (res.rows.length === 0) return { can: true };
    const lastDeploy = new Date(res.rows[0].last_deploy_at);
    if (lastDeploy < fourteenDaysAgo) return { can: true };

    const nextAvailable = new Date(lastDeploy.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days
    return { can: false, cooldown: nextAvailable };
}
async function recordFreeTrialDeploy(userId) {
    await pool.query(
        `INSERT INTO temp_deploys (user_id, last_deploy_at) VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_deploy_at = NOW()`,
        [userId]
    );
}


// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {}; // chatId -> { step, data, message_id }
const authorizedUsers = new Set(); // chatIds who've passed a key

// 7) Utilities
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

function buildKeyboard(isAdmin) {
  const baseMenu = [
      ['Get Session', 'Deploy'],
      ['Free Trial', 'My Bots'], // "Free Trial" button
      ['Support']
  ];
  if (isAdmin) {
      return [
          ['Deploy', 'Apps'],
          ['Generate Key', 'Get Session'],
          ['Support']
      ];
  }
  return baseMenu;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function sendAnimatedMessage(chatId, baseText) {
    const msg = await bot.sendMessage(chatId, `⚙️ ${baseText}...`);
    await new Promise(r => setTimeout(r, 1200)); // Wait for animation
    return msg;
}

async function startRestartCountdown(chatId, appName, messageId) {
    const totalSeconds = 60; // 45 seconds for demonstration. Change to 45 * 60 for 45 minutes.
    const intervalTime = 5; // Update every 5 seconds
    const totalSteps = totalSeconds / intervalTime;

    // Initial message
    await bot.editMessageText(`Bot "${appName}" restarting...`, {
        chat_id: chatId,
        message_id: messageId
    }).catch(() => {});

    for (let i = 0; i <= totalSteps; i++) {
        const secondsLeft = totalSeconds - (i * intervalTime);
        const minutesLeft = Math.floor(secondsLeft / 60);
        const remainingSeconds = secondsLeft % 60;

        const filledBlocks = '█'.repeat(i);
        const emptyBlocks = '░'.repeat(totalSteps - i);

        let countdownMessage = `Bot "${appName}" restarting...\n\n`;
        if (secondsLeft > 0) {
            countdownMessage += `[${filledBlocks}${emptyBlocks}] ${minutesLeft}m ${remainingSeconds}s left`;
        } else {
            countdownMessage += `[${filledBlocks}] Restart complete!`;
        }
        
        await bot.editMessageText(countdownMessage, {
            chat_id: chatId,
            message_id: messageId
        }).catch(() => {}); // Ignore errors if message is deleted

        if (secondsLeft <= 0) break; // Exit loop when countdown is done
        await new Promise(r => setTimeout(r, intervalTime * 1000));
    }
    await bot.editMessageText(`Bot "${appName}" has restarted successfully and is back online!`, {
        chat_id: chatId,
        message_id: messageId
    });
}


// 8) Send Heroku apps list
async function sendAppList(chatId, messageId = null) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) {
      if (messageId) return bot.editMessageText(chatId, 'No apps found.', { chat_id: chatId, message_id: messageId });
      return bot.sendMessage(chatId, 'No apps found.');
    }
    const rows = chunkArray(apps, 3).map(r =>
      r.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    const message = `Total apps: ${apps.length}\nSelect an app:`;
    if (messageId) {
        await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
    } else {
        await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: rows } });
    }
  } catch (e) {
    const errorMsg = `Error fetching apps: ${e.response?.data?.message || e.message}`;
    if (messageId) {
        bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId });
    } else {
        bot.sendMessage(chatId, errorMsg);
    }
  }
}

// 9) Build & deploy helper with animated countdown
async function buildWithProgress(chatId, vars, isFreeTrial = false) {
  const name = vars.APP_NAME;

  try {
    // Stage 1: Create App
    const createMsg = await bot.sendMessage(chatId, '🚀 Creating application...');
    await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    // Stage 2: Add-ons and Buildpacks
    await bot.editMessageText('⚙️ Configuring resources...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.post(
      `https://api.heroku.com/apps/${name}/addons`,
      { plan: 'heroku-postgresql' },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    await axios.put(
      `https://api.heroku.com/apps/${name}/buildpack-installations`,
      {
        updates: [
          { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
          { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
          { buildpack: 'heroku/nodejs' }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    // Stage 3: Config Vars
    await bot.editMessageText('🔧 Setting environment variables...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.patch(
      `https://api.heroku.com/apps/${name}/config-vars`,
      {
        ...defaultEnvVars,
        ...vars
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    // Stage 4: Build
    await bot.editMessageText('🛠️ Starting build process...', { chat_id: chatId, message_id: createMsg.message_id });
    const bres = await axios.post(
      `https://api.heroku.com/apps/${name}/builds`,
      { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
    let status = 'pending';
    const progMsg = await bot.editMessageText('Building... 0%', { chat_id: chatId, message_id: createMsg.message_id });

    for (let i = 1; i <= 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const poll = await axios.get(statusUrl, {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
          }
        });
        status = poll.data.status;
      } catch {
        status = 'error';
        break;
      }
      const pct = Math.min(100, i * 5);
      await bot.editMessageText(`Building... ${pct}%`, {
        chat_id: chatId,
        message_id: progMsg.message_id
      }).catch(() => {});

      if (status !== 'pending') break;
    }

    if (status === 'succeeded') {
      // Animated Countdown Logic
      await bot.editMessageText('Build complete!', {
        chat_id: chatId,
        message_id: progMsg.message_id
      });

      const totalSteps = 12; // 12 steps for a 60-second countdown (5 seconds per step)
      for (let i = 1; i <= totalSteps; i++) {
          await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds
          const secondsLeft = 60 - (i * 5);
          const filled = '■'.repeat(i);
          const empty = '□'.repeat(totalSteps - i);
          const countdownMessage = `[${filled}${empty}] Wait for your bot to start ... (${secondsLeft}s left)`;
          await bot.editMessageText(countdownMessage, {
              chat_id: chatId,
              message_id: progMsg.message_id
          }).catch(() => {}); // Ignore errors if user deletes message
      }

      await bot.editMessageText(
        `Your bot is now live at:\nhttps://${name}.herokuapp.com`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );

      if (isFreeTrial) {
        // Schedule deletion after 30 minutes
        setTimeout(async () => {
            try {
                await bot.sendMessage(chatId, `⏳ Your Free Trial app "${name}" is being deleted now as its 30-minute runtime has ended.`);
                await axios.delete(`https://api.heroku.com/apps/${name}`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                await deleteUserBot(chatId, name);
                await bot.sendMessage(chatId, `Free Trial app "${name}" successfully deleted.`);
            } catch (e) {
                console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                await bot.sendMessage(chatId, `⚠️ Could not auto-delete the app "${name}". Please delete it manually from your Heroku dashboard.`);
            }
        }, 30 * 60 * 1000); // 30 minutes in milliseconds
      }
      return true; // Indicate success
    } else {
      await bot.editMessageText(
        `Build status: ${status}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );
      return false; // Indicate failure
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    return false; // Indicate failure
  }
}

// 10) Polling error handler
bot.on('polling_error', console.error);

// 11) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}]`);
  await bot.sendMessage(cid,
    isAdmin ? 'Welcome, Admin! Here is your menu:' : 'Welcome! Please select an option:', {
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    }
  );
});

bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    sendAppList(cid);
  }
});

// 12) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // --- Button Handlers ---
  if (text === 'Deploy') {
    if (isAdmin) {
      userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Please enter your session ID');
    } else {
      userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Enter your Deploy key');
    }
  }

  if (text === 'Free Trial') {
    const check = await canDeployFreeTrial(cid);
    if (!check.can) {
        return bot.sendMessage(cid, `⏳ You have already used your Free Trial. You can use it again after:\n\n${check.cooldown.toLocaleString()}`);
    }
    userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: true } };
    return bot.sendMessage(cid, 'Free Trial (30 mins runtime, 14-day cooldown) initiated.\n\nPlease enter your session ID:');
  }

  if (text === 'Apps' && isAdmin) {
    return sendAppList(cid);
  }

  if (text === 'Generate Key' && isAdmin) {
    const buttons = [
      [1, 2, 3, 4, 5].map(n => ({
        text: String(n),
        callback_data: `genkeyuses:${n}`
      }))
    ];
    return bot.sendMessage(cid, 'How many uses for this key?', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (text === 'Get Session') {
    const guideCaption =
        "To get your session ID, please follow these steps carefully:\n\n" +
        "1️⃣ *Open the Link*\n" +
        "Visit: https://levanter-delta.vercel.app/\n\n" +
        "2️⃣ *Important for iPhone Users*\n" +
        "If you are on an iPhone, please open the link using the **Google Chrome** browser for best results.\n\n" +
        "3️⃣ *Skip Advertisements*\n" +
        "The website may show ads. Please close or skip any popups or advertisements to proceed.\n\n" +
        "4️⃣ *Use a CUSTOM ID*\n" +
        "You **must** enter your own unique ID in the 'Custom Session' field. Do not use the default one. A good ID could be your name or username (e.g., `johnsmith`).\n\n" +
        "Once you have copied your session ID, tap the 'Deploy' button here to continue.";

    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: guideCaption,
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, guideCaption, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (text === 'My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, "You haven't deployed any bots yet.");
    const rows = chunkArray(bots, 3).map(r => r.map(n => ({
      text: n,
      callback_data: `selectbot:${n}`
    })));
    return bot.sendMessage(cid, 'Your deployed bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  if (text === 'Support') {
    return bot.sendMessage(cid, `For help, contact the admin: ${SUPPORT_USERNAME}`);
  }

  // --- Stateful flows ---
  const st = userStates[cid];
  if (!st) return;

  if (st.step === 'AWAITING_KEY') {
    const keyAttempt = text.toUpperCase();
    const usesLeft = await useDeployKey(keyAttempt);
    if (usesLeft === null) {
      return bot.sendMessage(cid, `❌ Invalid or expired key.\n\nPlease contact the admin for a valid key: ${SUPPORT_USERNAME}`);
    }
    authorizedUsers.add(cid);
    st.step = 'SESSION_ID'; // Keep data, just change step

    const { first_name, last_name, username } = msg.from;
    const userDetails = [
      `*Name:* ${first_name || ''} ${last_name || ''}`,
      `*Username:* @${username || 'N/A'}`,
      `*Chat ID:* \`${cid}\``
    ].join('\n');

    await bot.sendMessage(ADMIN_ID,
      `🔑 *Key Used By:*\n${userDetails}\n\n*Uses Left:* ${usesLeft}`,
      { parse_mode: 'Markdown' }
    );
    return bot.sendMessage(cid, 'Verified, please enter your session ID:');
  }

  if (st.step === 'SESSION_ID') {
    if (text.length < 10) {
      return bot.sendMessage(cid, 'Session ID must be at least 10 characters long.');
    }
    st.data.SESSION_ID = text.trim();
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, 'Great. Now enter a name for your bot (e.g., my-awesome-bot or utarbot12):');
  }

  if (st.step === 'APP_NAME') {
    const nm = text.toLowerCase().replace(/\s+/g, '-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid, 'Invalid name. Use at least 5 lowercase letters, numbers, or hyphens.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `The name "${nm}" is already taken. Please choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = nm;
        
        // --- INTERACTIVE WIZARD START ---
        // Instead of asking for the next step via text, we now send an interactive message.
        st.step = 'AWAITING_WIZARD_CHOICE'; // A neutral state to wait for button click
        
        const wizardText = `App name "*${nm}*" is available.\n\n*Next Step:*\nEnable automatic status view? This marks statuses as seen automatically.`;
        const wizardKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Yes (Recommended)', callback_data: `setup:autostatus:true` },
                        { text: 'No', callback_data: `setup:autostatus:false` }
                    ]
                ]
            }
        };
        const wizardMsg = await bot.sendMessage(cid, wizardText, { ...wizardKeyboard, parse_mode: 'Markdown' });
        st.message_id = wizardMsg.message_id; // Store message_id to edit it later
        // --- INTERACTIVE WIZARD END ---

      } else {
        console.error(`Error checking app name "${nm}":`, e.response?.data?.message || e.message);
        return bot.sendMessage(cid, `Could not verify app name. The Heroku API might be down. Please try again later.`);
      }
    }
  }

  // --- INTERACTIVE WIZARD NOTE ---
  // The 'AUTO_STATUS_VIEW' step is now handled entirely by the callback_query handler.
  // We can remove it from here.

  if (st.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME, fromChannelBotName, fromChannelUserId } = st.data; // Capture original source
    const newVal = text.trim();
    try {
      const updateMsg = await bot.sendMessage(cid, `Updating ${VAR_NAME} for "${APP_NAME}"...`); // Send immediate feedback
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: newVal },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
          }
        }
      );
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(cid, APP_NAME, newVal);
      }
      // If this flow originated from a channel notification for this user's bot
      if (fromChannelBotName && fromChannelUserId === cid && VAR_NAME === 'SESSION_ID') {
          await bot.sendMessage(cid, `✅ Session ID for "${fromChannelBotName}" updated successfully! Restarting bot...`);
          // Optionally, trigger a restart directly here if you want to ensure it restarts immediately
          // and you are certain the Heroku API call below will handle the restart logic correctly.
          // For now, relying on the 'startRestartCountdown' to imply a restart.
      }
      delete userStates[cid];
      // Start the restart countdown after the variable is successfully set
      await startRestartCountdown(cid, APP_NAME, updateMsg.message_id);
    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
  }
});

// 13) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id).catch(() => {});

  // --- INTERACTIVE WIZARD HANDLER ---
  if (action === 'setup') {
      const st = userStates[cid];
      // Ensure the user session is still active
      if (!st || !st.message_id || q.message.message_id !== st.message_id) {
          return bot.editMessageText('This menu has expired. Please start over by tapping /menu.', {
              chat_id: cid,
              message_id: q.message.message_id
          });
      }

      const [step, value] = [payload, extra];

      if (step === 'autostatus') {
          // Store the user's choice
          st.data.AUTO_STATUS_VIEW = value === 'true' ? 'no-dl' : 'false';

          // Edit the message to show a confirmation and the final "Deploy" button
          const confirmationText = ` *Deployment Configuration*\n\n` +
                                   `*App Name:* \`${st.data.APP_NAME}\`\n` +
                                   `*Session ID:* \`${st.data.SESSION_ID.slice(0, 15)}...\`\n` +
                                   `*Auto Status:* \`${st.data.AUTO_STATUS_VIEW}\`\n\n` +
                                   `Ready to proceed?`;
          
          const confirmationKeyboard = {
              reply_markup: {
                  inline_keyboard: [
                      [{ text: 'Yes, Deploy Now', callback_data: 'setup:startbuild' }],
                      [{ text: 'Cancel', callback_data: 'setup:cancel' }]
                  ]
              }
          };

          await bot.editMessageText(confirmationText, {
              chat_id: cid,
              message_id: st.message_id,
              parse_mode: 'Markdown',
              ...confirmationKeyboard
          });
      }

      if (step === 'startbuild') {
          // User confirmed deployment, start the build process
          await bot.editMessageText('Configuration confirmed. Initiating deployment...', {
              chat_id: cid,
              message_id: st.message_id
          });

          const buildSuccessful = await buildWithProgress(cid, st.data, st.data.isFreeTrial);

          if (buildSuccessful) {
              await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);

              if (st.data.isFreeTrial) {
                  await recordFreeTrialDeploy(cid);
                  bot.sendMessage(cid, `Reminder: This Free Trial app will be automatically deleted in 30 minutes.`);
              }

              const { first_name, last_name, username } = q.from;
              const appUrl = `https://${st.data.APP_NAME}.herokuapp.com`;
              const userDetails = [
                `*Name:* ${first_name || ''} ${last_name || ''}`,
                `*Username:* @${username || 'N/A'}`,
                `*Chat ID:* \`${cid}\``
              ].join('\n');
      
              const appDetails = `*App Name:* \`${st.data.APP_NAME}\`\n*URL:* ${appUrl}\n*Session ID:* \`${st.data.SESSION_ID}\`\n*Type:* ${st.data.isFreeTrial ? 'Free Trial' : 'Permanent'}`;
      
              await bot.sendMessage(ADMIN_ID,
                  `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
                  { parse_mode: 'Markdown', disable_web_page_preview: true }
              );
          }
          // Clean up the user state after completion or failure
          delete userStates[cid];
      }

      if (step === 'cancel') {
          await bot.editMessageText('❌ Deployment cancelled.', {
              chat_id: cid,
              message_id: st.message_id
          });
          delete userStates[cid];
      }
      return; // Stop further processing
  }
  // --- END WIZARD HANDLER ---


  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    return bot.sendMessage(cid, `Generated key: \`${key}\`\nUses: ${uses}`, { parse_mode: 'Markdown' });
  }

  if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    // Store the message_id for later editing
    const messageId = q.message.message_id; 
    userStates[cid] = { step: 'APP_MANAGEMENT', data: { appName: payload, messageId: messageId, isUserBot: isUserBot } };
    
    return bot.editMessageText(`Manage app "${payload}":`, { // Use editMessageText
      chat_id: cid,
      message_id: messageId, // Use the stored messageId
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Info', callback_data: `info:${payload}` },
            { text: 'Restart', callback_data: `restart:${payload}` },
            { text: 'Logs', callback_data: `logs:${payload}` }
          ],
          [
            { text: 'Delete', callback_data: `${isUserBot ? 'userdelete' : 'delete'}:${payload}` },
            { text: 'Set Variable', callback_data: `setvar:${payload}` }
          ],
          [{ text: '◀️ Back', callback_data: 'back_to_app_list' }] // Add back button
        ]
      }
    });
  }

  if (action === 'info') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) { // Ensure state is valid for this app
        // Fallback if state is lost or user clicks old button
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = st.data.messageId; // Get the stored message ID

    await bot.editMessageText('⚙️ Fetching app info...', { chat_id: cid, message_id: messageId });
    try {
      const apiHeaders = {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      };

      const [appRes, configRes, dynoRes] = await Promise.all([
        axios.get(`https://api.heroku.com/apps/${payload}`, { headers: apiHeaders }),
        axios.get(`https://api.heroku.com/apps/${payload}/config-vars`, { headers: apiHeaders }),
        axios.get(`https://api.heroku.com/apps/${payload}/dynos`, { headers: apiHeaders })
      ]);

      const appData = appRes.data;
      const configData = configRes.data;
      const dynoData = dynoRes.data;

      const createdAt = new Date(appData.created_at);
      const now = new Date();
      const diffTime = Math.abs(now - createdAt);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      let dynoStatus = 'No dynos found.';
      let statusEmoji = '❓';
      if (dynoData.length > 0) {
          const webDyno = dynoData.find(d => d.type === 'web');
          if (webDyno) {
              const state = webDyno.state;
              if (state === 'up') statusEmoji = '🟢';
              else if (state === 'crashed') statusEmoji = '🔴';
              else if (state === 'idle') statusEmoji = '🟡';
              else if (state === 'starting' || state === 'restarting') statusEmoji = '⏳';
              else statusEmoji = '❓';
              dynoStatus = `${statusEmoji} ${state.charAt(0).toUpperCase() + state.slice(1)}`;
          }
      }

      const info = `*App Info: ${appData.name}*\n\n` +
                   `*Dyno Status:* ${dynoStatus}\n` +
                   `*URL:* [${appData.web_url}](${appData.web_url})\n` +
                   `*Created:* ${createdAt.toLocaleDateString()} (${diffDays} days ago)\n` +
                   `*Last Release:* ${new Date(appData.released_at).toLocaleString()}\n` +
                   `*Stack:* ${appData.stack.name}\n\n` +
                   `*🔧 Key Config Vars:*\n` +
                   `  \`SESSION_ID\`: ${configData.SESSION_ID ? '✅ Set' : '❌ Not Set'}\n` +
                   `  \`AUTO_STATUS_VIEW\`: \`${configData.AUTO_STATUS_VIEW || 'false'}\`\n`;

      // Edit the message with the info and add a back button
      return bot.editMessageText(info, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]] // Back to app management
        }
      });
    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching info: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'restart') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = st.data.messageId;

    await bot.editMessageText('🔄 Restarting app...', { chat_id: cid, message_id: messageId });
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });
      return bot.editMessageText(`"${payload}" restarted successfully.`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error restarting: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'logs') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = st.data.messageId;

    await bot.editMessageText('📄 Fetching logs...', { chat_id: cid, message_id: messageId });
    try {
      const sess = await axios.post(`https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: false, lines: 100 },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      const logRes = await axios.get(sess.data.logplex_url);
      const logs = logRes.data.trim().slice(-4000);
      
      // Edit the message to show logs
      return bot.editMessageText(`Logs for "${payload}":\n\`\`\`\n${logs || 'No recent logs.'}\n\`\`\``, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching logs: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'delete' || action === 'userdelete') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = st.data.messageId;

      return bot.editMessageText(`Are you sure you want to delete the app "${payload}"? This action cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: "Yes, I'm sure", callback_data: `confirmdelete:${payload}:${action}` },
            { text: "No, cancel", callback_data: `selectapp:${payload}` } // Back to app management on cancel
          ]]
        }
      });
  }

  if (action === 'confirmdelete') {
      const appToDelete = payload;
      const originalAction = extra;
      const st = userStates[cid];
      if (!st || st.data.appName !== appToDelete) {
          return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
      }
      const messageId = st.data.messageId;

      await bot.editMessageText(`🗑️ Deleting ${appToDelete}...`, { chat_id: cid, message_id: messageId });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          if (originalAction === 'userdelete') {
              await deleteUserBot(cid, appToDelete);
          }
          await bot.editMessageText(`✅ App "${appToDelete}" has been permanently deleted.`, { chat_id: cid, message_id: messageId });
          // After deletion, take them back to their list of bots or main menu
          if (originalAction === 'userdelete') {
              const bots = await getUserBots(cid);
              if (bots.length > 0) {
                  const rows = chunkArray(bots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
                  return bot.sendMessage(cid, 'Your remaining deployed bots:', { reply_markup: { inline_keyboard: rows } });
              } else {
                  return bot.sendMessage(cid, "You no longer have any deployed bots.");
              }
          } else { // Admin delete
            return sendAppList(cid); // Admin sees all apps
          }
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          return bot.editMessageText(`Error deleting app: ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${appToDelete}` }]]
            }
          });
      }
  }

  if (action === 'canceldelete') {
      // This handler might not be strictly needed if `selectapp` is used for "No, cancel"
      // But keeping it just in case for older messages or alternative flows.
      return bot.editMessageText('Deletion cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
  }

  if (action === 'setvar') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = st.data.messageId;
    
    // Edit the current message to show variable selection
    return bot.editMessageText(`Select a variable to set for "${payload}":`, {
      chat_id: cid,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${payload}` }],
          [{ text: 'AUTO_STATUS_VIEW', callback_data: `varselect:AUTO_STATUS_VIEW:${payload}` }],
          [{ text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${payload}` }],
          [{ text: 'PREFIX', callback_data: `varselect:PREFIX:${payload}` }],
          [{ text: 'ANTI_DELETE', callback_data: `varselect:ANTI_DELETE:${payload}` }],
          [{ text: '◀️ Back', callback_data: `selectapp:${payload}` }] // Back to app management
        ]
      }
    });
  }

  if (action === 'varselect') {
    const [varKey, appName] = [payload, extra];
    const st = userStates[cid];
    if (!st || st.data.appName !== appName) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = st.data.messageId;

    if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE'].includes(varKey)) {
      return bot.editMessageText(`Set ${varKey} to:`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ],
          [{ text: '◀️ Back', callback_data: `setvar:${appName}` }]] // Back to variable selection
        }
      });
    } else {
      userStates[cid].step = 'SETVAR_ENTER_VALUE'; // Update step for message handler
      userStates[cid].data.VAR_NAME = varKey; // Store VAR_NAME
      userStates[cid].data.APP_NAME = appName; // Ensure APP_NAME is stored for this step
      // When asking for value, send a new message as direct input is expected
      return bot.sendMessage(cid, `Please enter the new value for ${varKey}:`);
    }
  }

  if (action === 'setvarbool') {
    const [varKey, appName, valStr] = [payload, extra, flag];
    const flagVal = valStr === 'true';
    let newVal;
    if (varKey === 'AUTO_STATUS_VIEW') newVal = flagVal ? 'no-dl' : 'false';
    else if (varKey === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
    else newVal = flagVal ? 'true' : 'false';

    try {
      const updateMsg = await bot.sendMessage(cid, `Updating ${varKey} for "${appName}"...`); // Send immediate feedback
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      await startRestartCountdown(cid, appName, updateMsg.message_id); // Start countdown
    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
  }

  // NEW: Handler for initiating session change from channel notification
  if (action === 'change_session') {
      const appName = payload;
      const targetUserId = extra; // The user ID that owns this bot

      // Ensure the user initiating this action is the actual owner (optional but good for security)
      if (cid !== targetUserId) {
          await bot.sendMessage(cid, `You can only change the session ID for your own bots.`);
          return;
      }
      
      userStates[cid] = {
          step: 'SETVAR_ENTER_VALUE',
          data: {
              APP_NAME: appName,
              VAR_NAME: 'SESSION_ID',
              fromChannelBotName: appName, // Store context that this came from a channel alert
              fromChannelUserId: targetUserId // Store context
          }
      };
      await bot.sendMessage(cid, `Please enter the *new* session ID for your bot "${appName}":`, { parse_mode: 'Markdown' });
      return;
  }


  if (action === 'back_to_app_list') {
    const isAdmin = cid === ADMIN_ID;
    const currentMessageId = q.message.message_id; // Get the ID of the message to edit

    if (isAdmin) {
      // If admin, show all apps
      return sendAppList(cid, currentMessageId); // Use existing sendAppList for admin
    } else {
      // If regular user, show only their bots
      const bots = await getUserBots(cid);
      if (bots.length > 0) {
          const rows = chunkArray(bots, 3).map(r => r.map(n => ({
            text: n,
            callback_data: `selectbot:${n}`
          })));
          return bot.editMessageText('Your remaining deployed bots:', {
            chat_id: cid,
            message_id: currentMessageId,
            reply_markup: { inline_keyboard: rows }
          });
      } else {
          return bot.editMessageText("You haven't deployed any bots yet.", { chat_id: cid, message_id: currentMessageId });
      }
    }
  }
});

---
### **14) Channel Post Handler**
This is the core new feature to detect and react to messages from your Levanter app.
---
bot.on('channel_post', async msg => {
    const channelId = msg.chat.id.toString();
    const text = msg.text?.trim();

    // Check if the message is from the designated listening channel
    if (channelId !== TELEGRAM_LISTEN_CHANNEL_ID) {
        return; // Ignore messages from other channels
    }

    if (!text) {
        return; // Ignore empty messages
    }

    // Regex for "logged out" message: User [bot_name] has logged out.
    const logoutMatch = text.match(/User \[([^\]]+)\] has logged out\./);
    if (logoutMatch) {
        const botName = logoutMatch[1];
        console.log(`Detected logout for bot: ${botName}`);

        const userId = await getUserIdByBotName(botName); // Get the owner's ID
        if (userId) {
            const warningMessage =
                `⚠️ Your bot "*${botName}*" has logged out due to an invalid session.\n` +
                `Please update your session ID to get it back online.`;
            
            await bot.sendMessage(userId, warningMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Change Session ID', callback_data: `change_session:${botName}:${userId}` }]
                    ]
                }
            });
            console.log(`Sent logout notification to user ${userId} for bot ${botName}`);
        } else {
            console.warn(`Could not find user for bot "${botName}" during logout alert.`);
        }
        return;
    }

    // Regex for "connected" message: ✅ [bot_name] connected.
    const connectedMatch = text.match(/✅ \[([^\]]+)\] connected\./);
    if (connectedMatch) {
        const botName = connectedMatch[1];
        console.log(`Detected connected status for bot: ${botName}`);

        const userId = await getUserIdByBotName(botName); // Get the owner's ID
        if (userId) {
            const appUrl = `https://${botName}.herokuapp.com`; // Construct the URL
            const liveMessage = `🎉 Your bot "*${botName}*" is now live at:\n${appUrl}`;
            
            await bot.sendMessage(userId, liveMessage, {
                parse_mode: 'Markdown',
                disable_web_page_preview: false // Allow link preview
            });
            console.log(`Sent live notification to user ${userId} for bot ${botName}`);
        } else {
            console.warn(`Could not find user for bot "${botName}" during connected alert.`);
        }
        return;
    }
});

---
### **15) Scheduled Task for Logout Reminders**
This section will periodically check for bots that have been logged out for more than 24 hours.
---
async function checkAndRemindLoggedOutBots() {
    console.log('Running scheduled check for logged out bots...');
    const allBots = await getAllUserBots(); // Get all bots from your DB

    for (const botEntry of allBots) {
        const { user_id, bot_name } = botEntry;
        const herokuApp = bot_name; // Assuming bot_name is also the Heroku app name

        try {
            const apiHeaders = {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            };

            // 1. Get app config vars to check LAST_LOGOUT_ALERT
            const configRes = await axios.get(`https://api.heroku.com/apps/${herokuApp}/config-vars`, { headers: apiHeaders });
            const lastLogoutAlertStr = configRes.data.LAST_LOGOUT_ALERT;

            // 2. Get dyno status to check if the bot is currently "up"
            const dynoRes = await axios.get(`https://api.heroku.com/apps/${herokuApp}/dynos`, { headers: apiHeaders });
            const webDyno = dynoRes.data.find(d => d.type === 'worker'); // Assuming your Levanter bot runs as a 'worker' dyno

            const isBotRunning = webDyno && webDyno.state === 'up';

            if (lastLogoutAlertStr && !isBotRunning) {
                const lastLogoutAlertTime = new Date(lastLogoutAlertStr);
                const now = new Date();
                const timeSinceLogout = now.getTime() - lastLogoutAlertTime.getTime();
                const twentyFourHours = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

                // Check if it's been more than 24 hours since the last logout alert AND the bot is NOT running
                if (timeSinceLogout > twentyFourHours) {
                    const reminderMessage =
                        `🔔 *Reminder:* Your bot "*${bot_name}*" has been logged out for more than 24 hours!\n` +
                        `It appears to still be offline. Please update your session ID to bring it back online.`;
                    
                    await bot.sendMessage(user_id, reminderMessage, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Change Session ID', callback_data: `change_session:${bot_name}:${user_id}` }]
                            ]
                        }
                    });
                    console.log(`Sent 24-hour logout reminder to user ${user_id} for bot ${bot_name}`);
                }
            }

        } catch (error) {
            // Ignore 404 errors (app not found/deleted), log others
            if (error.response && error.response.status === 404) {
                console.log(`App ${herokuApp} not found for reminder check, likely deleted.`);
                // Optionally: Delete this bot from your user_bots table if it's not found on Heroku
                // await deleteUserBot(user_id, herokuApp);
            } else {
                console.error(`Error checking status for bot ${herokuApp} (user ${user_id}):`, error.response?.data?.message || error.message);
            }
        }
    }
}

// Schedule the check to run every hour (3600000 milliseconds)
// For testing, you can make this interval shorter, e.g., 60000 (1 minute)
setInterval(checkAndRemindLoggedOutBots, 60 * 60 * 1000); // Every hour


console.log('Bot is running...');

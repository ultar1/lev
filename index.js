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
  DATABASE_URL,
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
  try {
    // --- IMPORTANT FOR DEVELOPMENT/DEBUGGING ---
    // Uncomment the line below ONCE if you need to completely reset your user_bots table
    // (e.g., if you suspect corrupt data or a malformed schema).
    // After running once, comment it out again to prevent data loss on future deploys.
    // await pool.query('DROP TABLE IF EXISTS user_bots;');
    // console.warn("[DB] DEVELOPMENT: user_bots table dropped (if existed).");
    // ---------------------------------------------

    // Attempt to create the user_bots table with the PRIMARY KEY constraint
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
        session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, bot_name)
      );
    `);
    console.log("[DB] 'user_bots' table checked/created with PRIMARY KEY.");

    // Add deploy_keys table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deploy_keys (
        key        TEXT PRIMARY KEY,
        uses_left  INTEGER NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[DB] 'deploy_keys' table checked/created.");

    // Add temp_deploys table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS temp_deploys (
        user_id       TEXT PRIMARY KEY,
        last_deploy_at TIMESTAMP NOT NULL
      );
    `);
    console.log("[DB] 'temp_deploys' table checked/created.");

    console.log("[DB] All necessary tables checked/created successfully.");

  } catch (dbError) {
    // This catch block handles errors during the *initial* CREATE TABLE IF NOT EXISTS.
    // The most common is if a table already exists but the constraint part (like PK) failed to add.
    
    // Check for specific error code for "duplicate_table" which implies the table itself exists
    if (dbError.code === '42P07' || (dbError.message && dbError.message.includes('already exists'))) {
        console.warn(`[DB] 'user_bots' table already exists, or there was an issue creating it initially. Attempting to ensure PRIMARY KEY constraint.`);
        try {
            // Attempt to add the primary key if it's missing.
            // Using IF NOT EXISTS on the constraint name prevents error if constraint is already there.
            await pool.query(`
                ALTER TABLE user_bots
                ADD CONSTRAINT user_bots_pkey PRIMARY KEY (user_id, bot_name);
            `);
            console.log("[DB] PRIMARY KEY constraint successfully added to 'user_bots'.");
        } catch (alterError) {
            // If ALTER TABLE fails because the constraint already exists, that's fine.
            // PostgreSQL's error messages for "constraint already exists" can vary.
            if ((alterError.message && alterError.message.includes('already exists in relation "user_bots"')) || (alterError.message && alterError.message.includes('already exists'))) {
                 console.warn("[DB] PRIMARY KEY constraint 'user_bots_pkey' already exists on 'user_bots'. Skipping ALTER TABLE.");
            } else {
                 // Any other error during ALTER TABLE is critical.
                 console.error("[DB] CRITICAL ERROR adding PRIMARY KEY constraint to 'user_bots':", alterError.message, alterError.stack);
                 process.exit(1); 
            }
        }
    } else {
        // Any other error during initial table creation is considered critical.
        console.error("[DB] CRITICAL ERROR during initial database table creation/check:", dbError.message, dbError.stack);
        process.exit(1); 
    }
  }
})();

// 5) DB helper functions
async function addUserBot(u, b, s) {
  try {
    // Use ON CONFLICT to update if it already exists, or insert if new
    // With PRIMARY KEY (user_id, bot_name), this will update if the specific user-bot pair exists.
    // For transferring ownership, we will handle deletion of old entry in the calling function.
    const result = await pool.query(
      `INSERT INTO user_bots(user_id, bot_name, session_id)
       VALUES($1, $2, $3)
       ON CONFLICT (user_id, bot_name) DO UPDATE SET session_id = EXCLUDED.session_id, created_at = CURRENT_TIMESTAMP
       RETURNING *;`, // Return the row to confirm insertion/update
      [u, b, s]
    );
    if (result.rows.length > 0) {
      console.log(`[DB] addUserBot: Successfully added/updated bot "${b}" for user "${u}". Row:`, result.rows[0]);
    } else {
      console.warn(`[DB] addUserBot: Insert/update operation for bot "${b}" for user "${u}" did not return a row. This might indicate an issue.`);
    }
  } catch (error) {
    console.error(`[DB] addUserBot: CRITICAL ERROR Failed to add/update bot "${b}" for user "${u}":`, error.message, error.stack);
    // You might want to notify admin here if this is a persistent issue
    bot.sendMessage(ADMIN_ID, `⚠️ CRITICAL DB ERROR: Failed to add/update bot "${b}" for user "${u}". Check logs.`);
  }
}
async function getUserBots(u) {
  try {
    const r = await pool.query(
      'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
      [u]
    );
    console.log(`[DB] getUserBots: Fetching for user_id "${u}" - Found:`, r.rows.map(x => x.bot_name)); // Debugging log
    return r.rows.map(x => x.bot_name);
  }
  catch (error) {
    console.error(`[DB] getUserBots: Failed to get bots for user "${u}":`, error.message);
    return [];
  }
}
// Function to get user_id by bot_name
async function getUserIdByBotName(botName) {
    try {
        // FIX: Added ORDER BY created_at DESC LIMIT 1 to ensure the LATEST owner is retrieved
        // if multiple entries for the same bot_name (but different user_ids) exist due to past issues.
        // Once the /add fix is in place, only one entry per bot_name should exist.
        const r = await pool.query(
            'SELECT user_id FROM user_bots WHERE bot_name=$1 ORDER BY created_at DESC LIMIT 1',
            [botName]
        );
        const userId = r.rows.length > 0 ? r.rows[0].user_id : null;
        console.log(`[DB] getUserIdByBotName: For bot "${botName}", found user_id: "${userId}".`);
        return userId;
    }
    catch (error) {
        console.error(`[DB] getUserIdByBotName: Failed to get user ID by bot name "${botName}":`, error.message);
        return null;
    }
}
// Function to get all bots from the database
async function getAllUserBots() {
    try {
        const r = await pool.query('SELECT user_id, bot_name FROM user_bots');
        console.log(`[DB] getAllUserBots: Fetched all bots:`, r.rows.map(x => `"${x.user_id}" - "${x.bot_name}"`));
        return r.rows;
    }
    catch (error) {
        console.error('[DB] getAllUserBots: Failed to get all user bots:', error.message);
        return [];
    }
}

async function deleteUserBot(u, b) {
  try {
    await pool.query(
      'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
      [u, b]
    );
    console.log(`[DB] deleteUserBot: Successfully deleted bot "${b}" for user "${u}".`);
  } catch (error) {
    console.error(`[DB] deleteUserBot: Failed to delete bot "${b}" for user "${u}":`, error.message);
  }
}
async function updateUserSession(u, b, s) {
  // This function is effectively replaced by the ON CONFLICT in addUserBot,
  // but keeping it for explicit update calls if desired elsewhere.
  // For now, it will simply perform an UPDATE.
  try {
    await pool.query(
      'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
      [s, u, b]
    );
    console.log(`[DB] updateUserSession: Successfully updated session for bot "${b}" (user "${u}").`);
  } catch (error) {
    console.error(`[DB] updateUserSession: Failed to update session for bot "${b}" (user "${u}"):`, error.message);
  }
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

// NEW HELPER FUNCTION: Handles 404 Not Found from Heroku API
async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    console.log(`[AppNotFoundHandler] Handling 404 for app "${appName}". Initiated by ${callingChatId}.`);
    
    // Find the user_id currently associated with this app in our DB.
    // This is crucial because an admin might be managing another user's bot.
    let ownerUserId = await getUserIdByBotName(appName);
    
    if (!ownerUserId) {
        // If owner not found in DB, it might be an admin trying to manage an untracked app, or a very stale entry.
        ownerUserId = callingChatId; // Fallback to the current chat ID for notification.
        console.warn(`[AppNotFoundHandler] Owner not found in DB for "${appName}". Falling back to callingChatId: ${callingChatId} for notification.`);
    } else {
        console.log(`[AppNotFoundHandler] Found owner ${ownerUserId} in DB for app "${appName}".`);
    }

    // Delete the app from our internal user_bots database
    // Note: We are deleting a specific (user_id, bot_name) pair.
    // If a bot was moved with /add, it should have been deleted from old user's list.
    // If it's a 404, it's missing on Heroku, so we remove from DB.
    await deleteUserBot(ownerUserId, appName); // This deletes the (ownerUserId, appName) pair
    console.log(`[AppNotFoundHandler] Removed "${appName}" from user_bots DB for user "${ownerUserId}".`);

    const message = `🗑️ App "*${appName}*" was not found on Heroku. It has been automatically removed from your "My Bots" list.`;
    
    // Determine where to send the primary notification
    // Check if q (callback_query object) exists and if q.message.chat.id is available
    // FIX: This section assumes `q` is in scope, which it isn't here in a global helper.
    // We should rely purely on passed arguments.
    // The previous original `q.message.chat.id` check was incorrect here.
    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId; // Send to calling user if message ID provided, else to the owner.
    const messageToEditId = originalMessageId;

    if (messageToEditId) { 
        await bot.editMessageText(message, {
            chat_id: messageTargetChatId,
            message_id: messageToEditId,
            parse_mode: 'Markdown'
        }).catch(err => console.error(`Failed to edit message in handleAppNotFoundAndCleanDb: ${err.message}`));
    } else {
        // If original message is not editable or not provided, send a new message
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' })
            .catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb (new msg): ${err.message}`));
    }

    // If the original action was user-facing (e.g., a regular user tried to restart THEIR bot)
    // AND the detected owner is different from the person currently interacting (meaning an admin
    // managed another user's bot), notify the original owner.
    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `ℹ️ Your bot "*${appName}*" was not found on Heroku and has been removed from your "My Bots" list by the admin.`, { parse_mode: 'Markdown' })
             .catch(err => console.error(`Failed to send notification to original owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
}


// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {}; // chatId -> { step, data, message_id }
const authorizedUsers = new Set(); // chatIds who've passed a key

// Map to store Promises for app deployment status based on channel notifications
const appDeploymentPromises = new Map(); // appName -> { resolve, reject, animateIntervalId }

// 7) Utilities

// Animated emoji for loading states (five square boxes)
let emojiIndex = 0;
const animatedEmojis = ['⬜⬜⬜⬜⬜', '⬛⬜⬜⬜⬜', '⬜⬛⬜⬜⬜', '⬜⬜⬛⬜⬜', '⬜⬜⬜⬛⬜', '⬜⬜⬜⬜⬛', '⬜⬜⬜⬜⬜']; // Cycles through black square moving across white squares

function getAnimatedEmoji() {
    const emoji = animatedEmojis[emojiIndex];
    emojiIndex = (emojiIndex + 1) % animatedEmojis.length;
    return emoji;
}

// Function to animate a message
async function animateMessage(chatId, messageId, baseText) {
    const intervalId = setInterval(async () => {
        try {
            await bot.editMessageText(`${getAnimatedEmoji()} ${baseText}`, {
                chat_id: chatId,
                message_id: messageId
            }).catch(() => {}); // Catch potential errors if message is deleted
        } catch (e) {
            console.error(`Error animating message ${messageId}:`, e.message);
            clearInterval(intervalId); // Stop animation on error
        }
    }, 800); // Update every 800ms for smooth animation
    return intervalId;
}


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
async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserId = null, isRemoval = false) {
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

    // Adapt callback data based on whether it's for general selection, /add, or /remove
    const rows = chunkArray(apps, 3).map(r =>
      r.map(name => ({ 
        text: name, 
        callback_data: isRemoval
            ? `${callbackPrefix}:${name}:${targetUserId}` // remove_app_from_user:appName:targetUserId
            : targetUserId 
                ? `${callbackPrefix}:${name}:${targetUserId}` // add_assign_app:appName:targetUserId
                : `${callbackPrefix}:${name}` // selectapp:appName (general info/management)
      }))
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

  let buildResult = false; // Flag to track overall success
  const createMsg = await bot.sendMessage(chatId, '🚀 Creating application...');

  try {
    // Stage 1: Create App
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
    let buildStatus = 'pending';
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
        buildStatus = poll.data.status;
      } catch {
        buildStatus = 'error';
        break;
      }
      const pct = Math.min(100, i * 5);
      await bot.editMessageText(`Building... ${pct}%`, {
        chat_id: chatId,
        message_id: progMsg.message_id
      }).catch(() => {});

      if (buildStatus !== 'pending') break;
    }

    if (buildStatus === 'succeeded') {
      // --- CRITICAL MODIFICATION: Add bot to DB immediately after successful build ---
      console.log(`[Flow] buildWithProgress: Heroku build for "${name}" SUCCEEDED. Attempting to add bot to user_bots DB.`);
      await addUserBot(chatId, name, vars.SESSION_ID); // Add bot to DB immediately here!

      // Admin notification for successful build (even if bot isn't 'connected' yet)
      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [
        `*Name:* ${first_name || ''} ${last_name || ''}`,
        `*Username:* ${username ? `@${username}` : (first_name || last_name ? `${[first_name, last_name].filter(Boolean).join(' ')} (No @username)` : 'N/A')}`, // FIX: Improved username display
        `*Chat ID:* \`${chatId}\``
      ].join('\n');
      const appDetails = `*App Name:* \`${name}\`\n*Session ID:* \`${vars.SESSION_ID}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;

      await bot.sendMessage(ADMIN_ID,
          `*New App Deployed (Heroku Build Succeeded)*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
      // --- END OF CRITICAL MODIFICATION ---

      const baseWaitingText = `Build complete! Waiting for bot to connect...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { // Initial message with emoji
        chat_id: chatId,
        message_id: progMsg.message_id
      });

      // Start animation for waiting state
      const animateIntervalId = await animateMessage(chatId, progMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId }); // Store intervalId
      });

      const STATUS_CHECK_TIMEOUT = 120 * 1000; // 120 seconds (2 minutes) to wait for connection
      let timeoutId;

      try {
          // Set a timeout to reject the promise if no status update is received
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(name);
              if (appPromise) { // Only reject if still pending
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after deployment.`));
                  appDeploymentPromises.delete(name); // Clean up
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise; // Wait for the channel_post handler to resolve/reject this
          clearTimeout(timeoutId); // Clear the timeout if resolved/rejected
          clearInterval(animateIntervalId); // Stop animation on success/failure

          // If resolved, it means "connected" was received
          await bot.editMessageText(
            `🎉 Your bot is now live!`, // Removed URL here
            { chat_id: chatId, message_id: progMsg.message_id }
          );
          buildResult = true; // Overall success (including session connection)

          if (isFreeTrial) {
            // FIX: Schedule 5-minute warning notification for admin
            setTimeout(async () => {
                const adminWarningMessage = `🔔 Free Trial App "${name}" has 5 minutes left until deletion!`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: `Delete "${name}" Now`, callback_data: `admin_delete_trial_app:${name}` }]
                    ]
                };
                await bot.sendMessage(ADMIN_ID, adminWarningMessage, { reply_markup: keyboard, parse_mode: 'Markdown' });
                console.log(`[FreeTrial] Sent 5-min warning to admin for ${name}.`);
            }, 55 * 60 * 1000); // 55 minutes

            // FIX: Schedule deletion after 1 hour (formerly 30 minutes)
            setTimeout(async () => {
                try {
                    await bot.sendMessage(chatId, `⏳ Your Free Trial app "${name}" is being deleted now as its 1-hour runtime has ended.`);
                    await axios.delete(`https://api.heroku.com/apps/${name}`, {
                        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                    });
                    await deleteUserBot(chatId, name);
                    await bot.sendMessage(chatId, `Free Trial app "${name}" successfully deleted.`);
                    console.log(`[FreeTrial] Auto-deleted app ${name} after 1 hour.`);
                } catch (e) {
                    console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                    await bot.sendMessage(chatId, `⚠️ Could not auto-delete the app "${name}". Please delete it manually from your Heroku dashboard.`);
                    // Also notify admin if auto-delete fails
                    bot.sendMessage(ADMIN_ID, `⚠️ Failed to auto-delete free trial app "${name}" for user ${chatId}: ${e.message}`);
                }
            }, 60 * 60 * 1000); // 1 hour
          }

      } catch (err) {
          clearTimeout(timeoutId); // Ensure timeout is cleared on early exit
          clearInterval(animateIntervalId); // Stop animation
          console.error(`App status check failed for ${name}:`, err.message);
          // This catch block handles both direct rejections from channel_post and the timeout
          await bot.editMessageText(
            `⚠️ Bot "${name}" failed to start or session is invalid after deployment: ${err.message}\n\n` +
            `It has been added to your "My Bots" list, but you may need to learn how to update the session ID.`, // Updated message for clarity
            {
                chat_id: chatId,
                message_id: progMsg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Change Session ID', callback_data: `change_session:${name}:${chatId}` }]
                    ]
                }
            }
          );
          buildResult = false; // Overall failure to connect
      } finally {
          appDeploymentPromises.delete(name); // Always clean up the promise from the map
      }

    } else { // Heroku build failed
      await bot.editMessageText(
        `Build status: ${buildStatus}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );
      buildResult = false; // Overall failure
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    buildResult = false; // Overall failure
  }
  return buildResult; // Indicate overall deployment success (including app startup)
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
  
  if (isAdmin) {
    await bot.sendMessage(cid, 'Welcome, Admin! Here is your menu:', {
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    });
  } else {
    // FIX: Send image with professional caption and keyboard for regular users
    const welcomeImageUrl = 'https://files.catbox.moe/syx8uk.jpeg';
    // FIX: Updated welcomeCaption with exact words provided by user
    const welcomeCaption = `
👋 Welcome to our Bot Deployment Service!

To get started, please follow these simple steps:

1️⃣  Connect Your WhatsApp:
    Tap the 'Get Session' button to retrieve the necessary session details to link your WhatsApp account.

2️⃣  Deploy Your Bot:
    Once you have your session, use the 'Deploy' button to effortlessly launch your personalized bot.

We're here to assist you every step of the way!
`;
    await bot.sendPhoto(cid, welcomeImageUrl, {
      caption: welcomeCaption,
      parse_mode: 'Markdown',
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true } // buildKeyboard(isAdmin) correctly returns user keyboard
    });
  }
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

// New /id command
bot.onText(/^\/id$/, async msg => {
    const cid = msg.chat.id.toString();
    await bot.sendMessage(cid, `Your Telegram Chat ID is: \`${cid}\``, { parse_mode: 'Markdown' });
});

// New /add <user_id> command for admin (formerly /update)
bot.onText(/^\/add (\d+)$/, async (msg, match) => { // Renamed from /update to /add
    const cid = msg.chat.id.toString();
    const targetUserId = match[1]; // The user ID provided after /add

    console.log(`[Admin] /add command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /add attempt by ${cid}.`);
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    // Clear any existing state for this admin before starting new flow
    delete userStates[cid];
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);


    console.log(`[Admin] Admin ${cid} initiated /add for user ${targetUserId}. Prompting for app selection.`);
    
    try {
        const sentMsg = await bot.sendMessage(cid, `Please select the app to assign to user \`${targetUserId}\`:`, { parse_mode: 'Markdown' }); // Added parse_mode
        userStates[cid] = {
            step: 'AWAITING_APP_FOR_ADD', // New state for 'add' flow (formerly AWAITING_APP_FOR_UPDATE)
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid}:`, userStates[cid]);
        // Now send the app list, editing the message created above
        // Use the sendAppList which takes chatId, messageId to edit, callbackPrefix, and targetUserId
        sendAppList(cid, sentMsg.message_id, 'add_assign_app', targetUserId); // Renamed callback prefix
    } catch (error) {
        console.error("Error sending initial /add message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the add process. Please try again.");
    }
});

// New /remove <user_id> command for admin
bot.onText(/^\/remove (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const targetUserId = match[1]; // The user ID provided after /remove

    console.log(`[Admin] /remove command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /remove attempt by ${cid}.`);
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    // Clear any existing state for this admin before starting new flow
    delete userStates[cid];
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    // Fetch bots specifically for the targetUserId
    const userBots = await getUserBots(targetUserId);
    if (!userBots.length) {
        return bot.sendMessage(cid, `User \`${targetUserId}\` has no bots deployed via this system.`, { parse_mode: 'Markdown' });
    }

    console.log(`[Admin] Admin ${cid} initiated /remove for user ${targetUserId}. Prompting for app removal selection.`);
    
    try {
        const sentMsg = await bot.sendMessage(cid, `Select app to remove from user \`${targetUserId}\`'s dashboard:`, { parse_mode: 'Markdown' });
        
        userStates[cid] = {
            step: 'AWAITING_APP_FOR_REMOVAL', // New state for removal flow
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid} for removal:`, userStates[cid]);

        const rows = chunkArray(userBots, 3).map(r => r.map(name => ({
            text: name,
            callback_data: `remove_app_from_user:${name}:${targetUserId}` // Callback for removal
        })));
        
        await bot.editMessageReplyMarkup({ inline_keyboard: rows }, {
            chat_id: cid,
            message_id: sentMsg.message_id
        });

    } catch (error) {
        console.error("Error sending initial /remove message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the removal process. Please try again.");
    }
});


// 12) Message handler for buttons & state machine
// This handler is for plain text messages, not callback queries (button clicks).
// The logic for handling the /add command's app selection (button click) is in bot.on('callback_query').
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // --- Button Handlers (for keyboard buttons, not inline) ---
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
    // FIX: Updated guideCaption with exact words provided by user
    const guideCaption = `
👋 Welcome to our Bot Deployment Service!

To get started, please follow these simple steps:

1️⃣  Connect Your WhatsApp:
    Tap the 'Get Session' button to retrieve the necessary session details to link your WhatsApp account.

2️⃣  Deploy Your Bot:
    Once you have your session, use the 'Deploy' button to effortlessly launch your personalized bot.

We're here to assist you every step of the way!
`;

    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: guideCaption,
        parse_mode: 'Markdown'
      });
    } catch (e) { // Add catch block for sendPhoto
        console.error(`Error sending photo in Get Session: ${e.message}`);
        await bot.sendMessage(cid, guideCaption, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (text === 'My Bots') {
    // NEW: Log the user_id before fetching bots
    console.log(`[Flow] My Bots button clicked by user: ${cid}`);
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

  // --- Stateful flows (for text input) ---
  const st = userStates[cid];
  if (!st) return; // No active state, ignore message

  if (st.step === 'AWAITING_KEY') {
    const keyAttempt = text.toUpperCase();

    // Add animation for key verification
    const verificationMsg = await bot.sendMessage(cid, `${getAnimatedEmoji()} Verifying key...`);
    const animateIntervalId = await animateMessage(cid, verificationMsg.message_id, 'Verifying key...');

    // Wait for at least 5 seconds for the animation to play
    const startTime = Date.now();
    const usesLeft = await useDeployKey(keyAttempt); // This is where the actual work happens
    const elapsedTime = Date.now() - startTime;
    const remainingDelay = 5000 - elapsedTime; // Minimum 5 seconds delay
    if (remainingDelay > 0) {
        await new Promise(r => setTimeout(r, remainingDelay));
    }
    
    clearInterval(animateIntervalId); // Stop animation immediately after the delay

    if (usesLeft === null) {
      await bot.editMessageText(`❌ Invalid or expired key.\n\nPlease contact the admin for a valid key: ${SUPPORT_USERNAME}`, {
        chat_id: cid,
        message_id: verificationMsg.message_id
      });
      return; // Exit if key is invalid
    }
    
    await bot.editMessageText(`✅ Verified!`, {
        chat_id: cid,
        message_id: verificationMsg.message_id
    });
    await new Promise(r => setTimeout(r, 1000)); // Short pause to show "Verified!" before next prompt

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
    // Finally, prompt for session ID in a new message
    return bot.sendMessage(cid, 'Please enter your session ID:');
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
        // Instead of asking for the next step via text, we now send an an interactive message.
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

  if (st.step === 'SETVAR_ENTER_VALUE') {
    // This part of the message handler is for when a *text* input is expected.
    const { APP_NAME, VAR_NAME, targetUserId: targetUserIdFromState } = st.data; // targetUserIdFromState might be undefined here.
    const newVal = text.trim();
    
    // Determine the actual user ID to associate the bot with.
    const finalUserId = targetUserIdFromState || cid;
    
    // This check is primarily for the normal deployment flow where SESSION_ID is provided by user.
    if (VAR_NAME === 'SESSION_ID' && newVal.length < 10) { 
        return bot.sendMessage(cid, 'Session ID must be at least 10 characters long.');
    }

    try {
      const updateMsg = await bot.sendMessage(cid, `Updating ${VAR_NAME} for "${APP_NAME}"...`); 
      
      // Perform the actual Heroku config var update
      console.log(`[API_CALL] Patching Heroku config vars for ${APP_NAME}: { ${VAR_NAME}: '***' }`);
      const patchResponse = await axios.patch(
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
      console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${APP_NAME}. Status: ${patchResponse.status}`);
      
      // Update session in DB. This will correctly use the new session ID if VAR_NAME is SESSION_ID,
      // otherwise it just updates the row with current session_id from DB for other config var changes.
      console.log(`[Flow] SETVAR_ENTER_VALUE: Config var updated for "${APP_NAME}". Updating bot in user_bots DB for user "${finalUserId}".`);
      await addUserBot(finalUserId, APP_NAME, newVal); 

      const baseWaitingText = `Updated ${VAR_NAME} for "${APP_NAME}". Waiting for bot status confirmation...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { 
          chat_id: cid,
          message_id: updateMsg.message_id
      });
      // Start animation for waiting state after variable update
      const animateIntervalId = await animateMessage(cid, updateMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(APP_NAME, { resolve, reject, animateIntervalId }); 
      });

      const STATUS_CHECK_TIMEOUT = 180 * 1000; // 3 minutes for connection status check
      let timeoutId;

      try {
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(APP_NAME);
              if (appPromise) {
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.`));
                  appDeploymentPromises.delete(APP_NAME);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise; 
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId); 

          await bot.editMessageText(`✅ ${VAR_NAME} for "${APP_NAME}" updated successfully and bot is back online!`, {
              chat_id: cid,
              message_id: updateMsg.message_id
          });
          console.log(`Sent "updated and online" notification to user ${cid} for bot ${APP_NAME}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId); 
          console.error(`App status check failed for ${APP_NAME} after variable update:`, err.message);
          await bot.editMessageText(
              `⚠️ Bot "${APP_NAME}" failed to come online after variable "${VAR_NAME}" update: ${err.message}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Change Session ID', callback_data: `change_session:${APP_NAME}:${finalUserId}` }] // Use finalUserId here
                      ]
                  }
              }
          );
      } finally {
          appDeploymentPromises.delete(APP_NAME); 
      }

      delete userStates[cid];

    } catch (e) {
      const errorMsg = e.response?.data?.message || e.response?.data?.message || e.message; // More robust error message extraction
      console.error(`[API_CALL_ERROR] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data); 
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
  }
});

// 13) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  // Ensure q.data is not null or undefined before splitting
  const dataParts = q.data ? q.data.split(':') : [];
  const action = dataParts[0];
  const payload = dataParts[1];
  const extra = dataParts[2];
  const flag = dataParts[3];

  await bot.answerCallbackQuery(q.id).catch(() => {});

  console.log(`[CallbackQuery] Received: action=${action}, payload=${payload}, extra=${extra}, flag=${flag} from ${cid}`);
  console.log(`[CallbackQuery] Current state for ${cid}:`, userStates[cid]);

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

      const [step, value] = [payload, extra]; // payload is 'autostatus', extra is 'true'/'false'

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
                      [{ text: 'Yes, Deploy Now', callback_data: `setup:startbuild` }],
                      [{ text: 'Cancel', callback_data: `setup:cancel` }]
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

          // buildWithProgress now handles all post-build status updates to the user
          const buildSuccessful = await buildWithProgress(cid, st.data, st.data.isFreeTrial);

          // Clean up the user state after completion or failure (only if build was started)
          // The state deletion logic inside buildWithProgress is sufficient.
          // delete userStates[cid]; // This line might be redundant or cause issues if buildWithProgress handles it.
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
            { text: 'Redeploy', callback_data: `redeploy_app:${payload}` }, // FIX: Added Redeploy button
            { text: 'Delete', callback_data: `${isUserBot ? 'userdelete' : 'delete'}:${payload}` },
            { text: 'Set Variable', callback_data: `setvar:${payload}` }
          ],
          [{ text: '◀️️ Back', callback_data: 'back_to_app_list' }] // Add back button
        ]
      }
    });
  }

  // Handle app selection from the /add command
  if (action === 'add_assign_app') { // Renamed from update_assign_app
    const appName = payload;
    const targetUserId = extra; // The user ID passed from the /add command

    console.log(`[CallbackQuery - add_assign_app] Received selection for app: ${appName} to assign to user: ${targetUserId}`);
    console.log(`[CallbackQuery - add_assign_app] Current state for ${cid} is:`, userStates[cid]);

    // Ensure it's the admin interacting
    if (cid !== ADMIN_ID) {
        await bot.editMessageText("❌ You are not authorized to perform this action.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }

    // Verify the state is correct for this operation
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_ADD' || st.data.targetUserId !== targetUserId) { // State check changed
        console.error(`[CallbackQuery - add_assign_app] State mismatch for ${cid}. Expected AWAITING_APP_FOR_ADD for ${targetUserId}, got:`, st);
        await bot.editMessageText("This add session has expired or is invalid. Please start over with `/add <user_id>`.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid]; // Clear corrupted state
        return;
    }

    await bot.editMessageText(`Assigning app "${appName}" to user \`${targetUserId}\`...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown' 
    });

    try {
        // FIX: Start of ownership transfer logic
        // 1. Find existing owner (if any) for this bot_name
        const existingEntry = await pool.query('SELECT user_id FROM user_bots WHERE bot_name=$1', [appName]);
        if (existingEntry.rows.length > 0) {
            const oldUserId = existingEntry.rows[0].user_id;
            if (oldUserId !== targetUserId) { // Only delete if changing ownership
                console.log(`[Admin] Transferring ownership for bot "${appName}" from ${oldUserId} to ${targetUserId}. Deleting old entry.`);
                await pool.query('DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2', [oldUserId, appName]);
                // Optionally notify old user that their bot has been reassigned
                // await bot.sendMessage(oldUserId, `ℹ️ Your bot "*${appName}*" has been unassigned from your dashboard by the admin and assigned to another user.`, { parse_mode: 'Markdown' });
            } else {
                console.log(`[Admin] Bot "${appName}" is already owned by ${targetUserId}. Proceeding with update.`);
            }
        }
        // FIX: End of ownership transfer logic

        // Fetch the existing SESSION_ID from the Heroku app's config vars
        const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
            headers: {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            }
        });
        const currentSessionId = configRes.data.SESSION_ID;

        if (!currentSessionId) {
            await bot.editMessageText(`⚠️ Cannot assign "${appName}". It does not have a SESSION_ID config variable set on Heroku. Please set it manually first or deploy it via the bot.`, {
                chat_id: cid,
                message_id: q.message.message_id
            });
            delete userStates[cid]; 
            return;
        }

        // Directly call addUserBot with the fetched session ID (this will insert/update the new ownership)
        await addUserBot(targetUserId, appName, currentSessionId);
        console.log(`[Admin] Successfully called addUserBot for ${appName} to user ${targetUserId} with fetched session ID.`);

        await bot.editMessageText(`✅ App "*${appName}*" successfully assigned to user \`${targetUserId}\`! It will now appear in their "My Bots" menu.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        // Notify the target user
        await bot.sendMessage(targetUserId, `🎉 Your bot "*${appName}*" has been successfully assigned to your "My Bots" menu by the admin! You can now manage it.`, { parse_mode: 'Markdown' });
        console.log(`[Admin] Sent success notification to target user ${targetUserId}.`);

    } catch (e) {
        // FIX: Handle 404 Not Found explicitly for add_assign_app
        if (e.response && e.response.status === 404) {
            await handleAppNotFoundAndCleanDb(cid, appName, q.message.message_id, false); // Admin initiated, not user-facing
            return; 
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error assigning app "${appName}" to user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`❌ Failed to assign app "${appName}" to user \`${targetUserId}\`: ${errorMsg}`, {
            chat_id: cid,
            message_id: q.message.message_id
        });
    } finally {
        delete userStates[cid]; // Clear state regardless of success or failure
        console.log(`[Admin] State cleared for ${cid} after add_assign_app flow.`);
    }
    return;
  }

  // Handle app selection from the /remove command
  if (action === 'remove_app_from_user') {
    const appName = payload;
    const targetUserId = extra; // The user ID passed from the /remove command

    console.log(`[CallbackQuery - remove_app_from_user] Received selection for app: ${appName} to remove from user: ${targetUserId}`);
    console.log(`[CallbackQuery - remove_app_from_user] Current state for ${cid} is:`, userStates[cid]);

    if (cid !== ADMIN_ID) {
        await bot.editMessageText("❌ You are not authorized to perform this action.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_REMOVAL' || st.data.targetUserId !== targetUserId) {
        console.error(`[CallbackQuery - remove_app_from_user] State mismatch for ${cid}. Expected AWAITING_APP_FOR_REMOVAL for ${targetUserId}, got:`, st);
        await bot.editMessageText("This removal session has expired or is invalid. Please start over with `/remove <user_id>`.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid];
        return;
    }

    await bot.editMessageText(`Removing app "${appName}" from user \`${targetUserId}\`'s dashboard...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        await deleteUserBot(targetUserId, appName);
        console.log(`[Admin] Successfully called deleteUserBot for ${appName} from user ${targetUserId}.`);

        await bot.editMessageText(`✅ App "*${appName}*" successfully removed from user \`${targetUserId}\`'s dashboard.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        // Optionally notify the target user that an app was removed from their dashboard
        await bot.sendMessage(targetUserId, `ℹ️ The admin has removed bot "*${appName}*" from your "My Bots" menu.`, { parse_mode: 'Markdown' });
        console.log(`[Admin] Sent removal notification to target user ${targetUserId}.`);

    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error removing app "${appName}" from user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`❌ Failed to remove app "${appName}" from user \`${targetUserId}\`'s dashboard: ${errorMsg}`, {
            chat_id: cid,
            message_id: q.message.message_id
        });
    } finally {
        delete userStates[cid];
        console.log(`[Admin] State cleared for ${cid} after remove_app_from_user flow.`);
    }
    return;
  }


  if (action === 'info') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) { // Ensure state is valid for this app
        // Fallback if state is lost or user clicks old button
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id; // Use messageId from query

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

      let dynoStatus = '⚪️ Scaled to 0 / Off'; // Default to scaled to 0 or off
      let statusEmoji = '⚪️'; // Grey circle for off/scaled to 0

      if (dynoData.length > 0) {
          const workerDyno = dynoData.find(d => d.type === 'worker'); 
          if (workerDyno) {
              const state = workerDyno.state;
              if (state === 'up') {
                  statusEmoji = '🟢'; // Green for Up
                  dynoStatus = `${statusEmoji} Up`;
              } else if (state === 'crashed') {
                  statusEmoji = '🔴'; // Red for Crashed
                  dynoStatus = `${statusEmoji} Crashed`;
              } else if (state === 'idle') {
                  statusEmoji = '🟡'; // Yellow for Idle (though worker dynos usually aren't 'idle' in the web dyno sense)
                  dynoStatus = `${statusEmoji} Idle`;
              } else if (state === 'starting' || state === 'restarting') {
                  statusEmoji = '⏳'; // Hourglass for transitional states
                  dynoStatus = `${statusEmoji} ${state.charAt(0).toUpperCase() + state.slice(1)}`;
              } else {
                  statusEmoji = '❓'; // Unknown state
                  dynoStatus = `${statusEmoji} Unknown State: ${state}`;
              }
          } else {
              // Dynos exist, but no 'worker' dyno (e.g., only a 'web' dyno, or worker scaled to 0 after other dynos)
              dynoStatus = '⚪️ Worker dyno not active/scaled to 0'; // More specific if other dynos exist but not worker
          }
      }


      const info = `*App Info: ${appData.name}*\n\n` +
                   `*Dyno Status:* ${dynoStatus}\n` + // Updated status
                   `*Created:* ${new Date(appData.created_at).toLocaleDateString()} (${Math.ceil(Math.abs(new Date() - new Date(appData.created_at)) / (1000 * 60 * 60 * 24))} days ago)\n` + // Re-calculate days for robustness
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
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]] // Back to app management
        }
      });
    } catch (e) {
      // FIX: Handle 404 Not Found explicitly for info
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true); // User initiated info
          return; 
      }
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`Error fetching info for ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`Error fetching info: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'restart') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id; // Use messageId from query

    await bot.editMessageText(`🔄 Restarting bot "${payload}"...`, { // Initial message without animation
        chat_id: cid,
        message_id: messageId
    });

    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });

      // FIX: Changed success message and removed waiting animation for restart
      await bot.editMessageText(`✅ Bot "${payload}" restarted successfully!`, {
          chat_id: cid,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]] // Back to app management
          }
      });
      console.log(`Sent "restarted successfully" notification to user ${cid} for bot ${payload}`);

    } catch (e) {
      // FIX: Handle 404 Not Found explicitly for restart
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true); // User initiated restart
          return; 
      }
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`Error restarting ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`❌ Error restarting bot: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } finally {
        delete userStates[cid]; // Clear state after restart attempt
    }
  }

  if (action === 'logs') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id; // Use messageId from query

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
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      // FIX: Handle 404 Not Found explicitly for logs
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true); // User initiated logs
          return; 
      }
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching logs: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'delete' || action === 'userdelete') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id; // Use messageId from query

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
      const originalAction = extra; // 'delete' (admin) or 'userdelete' (regular user)
      const st = userStates[cid];
      if (!st || st.data.appName !== appToDelete) {
          return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
      }
      const messageId = q.message.message_id; // Use messageId from query

      await bot.editMessageText(`🗑️ Deleting ${appToDelete}...`, { chat_id: cid, message_id: messageId });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          // After successful Heroku delete, delete from our DB
          if (originalAction === 'userdelete') { // If it was a user deleting their own bot
              await deleteUserBot(cid, appToDelete);
          } else { // If it was an admin deleting
              const ownerId = await getUserIdByBotName(appToDelete); // Find actual owner
              if (ownerId) await deleteUserBot(ownerId, appToDelete);
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
          // FIX: Handle 404 Not Found explicitly for delete actions
          if (e.response && e.response.status === 404) {
              // If it's a 404 during delete, it means it was already deleted from Heroku.
              // Just clean up our DB and notify.
              await handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, originalAction === 'userdelete'); // Pass isUserFacing based on original action
              return; 
          }
          const errorMsg = e.response?.data?.message || e.message;
          return bot.editMessageText(`Error deleting app: ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appToDelete}` }]]
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
    const messageId = q.message.message_id; // Use messageId from query
    
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
          [{ text: '◀️️ Back', callback_data: `setvar:${payload}` }] // Back to app management
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
    const messageId = q.message.message_id; // Use messageId from query

    if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE'].includes(varKey)) {
      return bot.editMessageText(`Set ${varKey} to:`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ],
          [{ text: '◀️️ Back', callback_data: `setvar:${appName}` }]] // Back to variable selection
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
      console.log(`[API_CALL] Patching Heroku config vars (boolean) for ${appName}: { ${varKey}: '${newVal}' }`); // Log for boolean
      const patchResponse = await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      console.log(`[API_CALL_SUCCESS] Heroku config vars (boolean) patched successfully for ${appName}. Status: ${patchResponse.status}`);


      // Update session in DB immediately after config var update
      console.log(`[Flow] setvarbool: Config var updated for "${appName}". Updating bot in user_bots DB.`);
      // For boolean setvar, we update the existing session_id which is still tied to 'cid'
      const { session_id: currentSessionId } = await pool.query('SELECT session_id FROM user_bots WHERE user_id=$1 AND bot_name=$2', [cid, appName]).then(res => res.rows[0] || {});
      await addUserBot(cid, appName, currentSessionId); // Keep current session_id, just update the row

      const baseWaitingText = `Updating ${varKey} for "${appName}". Waiting for bot status confirmation...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { 
          chat_id: cid,
          message_id: updateMsg.message_id
      });
      // Start animation for waiting state after variable update
      const animateIntervalId = await animateMessage(cid, updateMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(appName, { resolve, reject, animateIntervalId }); 
      });

      const STATUS_CHECK_TIMEOUT = 180 * 1000; // 3 minutes for connection status check
      let timeoutId;

      try {
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(appName);
              if (appPromise) {
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.`));
                  appDeploymentPromises.delete(appName);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise; 
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId); 

          await bot.editMessageText(`✅ Variable "${varKey}" for "${appName}" updated successfully and bot is back online!`, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              reply_markup: {
                  inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]]
              }
          });
          console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${appName}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId); 
          console.error(`App status check failed for ${appName} after variable update:`, err.message);
          await bot.editMessageText(
              `⚠️ Bot "${appName}" failed to come online after variable "${varKey}" update: ${err.message}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Change Session ID', callback_data: `change_session:${appName}:${cid}` }],
                          [{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]
                      ]
                  }
              }
          );
      } finally {
          appDeploymentPromises.delete(appName); 
      }

    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`[API_CALL_ERROR] Error updating boolean variable ${varKey} for ${appName}:`, errorMsg, e.response?.data);
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
  }

  // Handler for initiating session change from channel notification
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
              targetUserId: targetUserId 
          }
      };
      await bot.sendMessage(cid, `Please enter the *new* session ID for your bot "${appName}":`, { parse_mode: 'Markdown' });
      return;
  }

  // FIX: New admin_delete_trial_app callback action
  if (action === 'admin_delete_trial_app') {
      const appToDelete = payload;
      const messageId = q.message.message_id;

      if (cid !== ADMIN_ID) {
          await bot.editMessageText("❌ You are not authorized to perform this action.", { chat_id: cid, message_id: messageId });
          return;
      }

      await bot.editMessageText(`🗑️ Admin deleting Free Trial app "${appToDelete}"...`, { chat_id: cid, message_id: messageId });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          const ownerId = await getUserIdByBotName(appToDelete); // Find actual owner
          if (ownerId) await deleteUserBot(ownerId, appToDelete); // Delete from DB for owner
          
          await bot.editMessageText(`✅ Free Trial app "${appToDelete}" permanently deleted by Admin.`, { chat_id: cid, message_id: messageId });
          // Optionally notify the user who owned this trial app
          if (ownerId && ownerId !== cid) {
              await bot.sendMessage(ownerId, `ℹ️ Your Free Trial bot "*${appToDelete}*" has been manually deleted by the admin.`, { parse_mode: 'Markdown' });
          }
      } catch (e) {
          // Handle 404 if it was already deleted
          if (e.response && e.response.status === 404) {
              await handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, false); // Admin initiated delete
              return;
          }
          const errorMsg = e.response?.data?.message || e.message;
          await bot.editMessageText(`❌ Failed to delete Free Trial app "${appToDelete}": ${errorMsg}`, {
              chat_id: cid,
              message_id: messageId
          });
      }
      return;
  }

  // FIX: New redeploy_app callback action
  if (action === 'redeploy_app') {
    const appName = payload;
    const messageId = q.message.message_id;

    // Optional: Check if user is admin or owner of the app
    const isOwner = (await getUserIdByBotName(appName)) === cid;
    if (cid !== ADMIN_ID && !isOwner) {
        await bot.editMessageText("❌ You are not authorized to redeploy this app.", { chat_id: cid, message_id: messageId });
        return;
    }

    await bot.editMessageText(`🔄 Redeploying "${appName}" from GitHub...`, {
        chat_id: cid,
        message_id: messageId
    });

    let animateIntervalId = null; // Declare outside try for finally block
    try {
        const bres = await axios.post(
            `https://api.heroku.com/apps/${appName}/builds`,
            { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } }, // Uses your existing GitHub repo
            {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3',
                    'Content-Type': 'application/json'
                }
            }
        );

        const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
        
        await bot.editMessageText(`🛠️ Build initiated for "${appName}". Waiting for completion...`, {
            chat_id: cid,
            message_id: messageId
        });
        animateIntervalId = await animateMessage(cid, messageId, `Building "${appName}" from GitHub...`);

        // Polling for build status (similar to buildWithProgress)
        const BUILD_POLL_TIMEOUT = 300 * 1000; // 5 minutes for rebuilds
        
        const buildPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                clearInterval(checkBuildStatusInterval);
                reject(new Error('Redeploy build process timed out.'));
            }, BUILD_POLL_TIMEOUT);

            const checkBuildStatusInterval = setInterval(async () => {
                try {
                    const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    if (poll.data.status === 'succeeded') {
                        clearInterval(checkBuildStatusInterval);
                        clearTimeout(timeoutId);
                        resolve('succeeded');
                    } else if (poll.data.status === 'failed') {
                        clearInterval(checkBuildStatusInterval);
                        clearTimeout(timeoutId);
                        reject(new Error(`Redeploy build failed: ${poll.data.slug?.id ? `https://dashboard.heroku.com/apps/${appName}/activity/build/${poll.data.id}` : 'Check Heroku logs.'}`));
                    }
                } catch (error) {
                    clearInterval(checkBuildStatusInterval);
                    clearTimeout(timeoutId);
                    reject(new Error(`Error polling build status: ${error.message}`));
                }
            }, 10000); // Poll every 10 seconds
        });
        
        await buildPromise; // Wait for build to complete
        
        await bot.editMessageText(`✅ App "${appName}" redeployed successfully!`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]]
            }
        });
        console.log(`App "${appName}" redeployed successfully for user ${cid}.`);

    } catch (e) {
        // FIX: Handle 404 Not Found explicitly for redeploy
        if (e.response && e.response.status === 404) {
            await handleAppNotFoundAndCleanDb(cid, appName, messageId, true); // User initiated redeploy
            return; 
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`Error redeploying ${appName}:`, errorMsg, e.stack);
        await bot.editMessageText(`❌ Failed to redeploy "${appName}": ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    } finally {
        if (animateIntervalId) clearInterval(animateIntervalId); // Ensure animation stops
        delete userStates[cid];
    }
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

// 14) Channel Post Handler
// This is the core new feature to detect and react to messages from your Levanter app.
bot.on('channel_post', async msg => {
    const channelId = msg.chat.id.toString();
    const text = msg.text?.trim();

    // Always log the raw incoming message for debugging
    console.log(`[Channel Post - Raw] Received message from channel ${channelId}:\n---BEGIN MESSAGE---\n${text}\n---END MESSAGE---`);

    // Check if the message is from the designated listening channel
    if (channelId !== TELEGRAM_LISTEN_CHANNEL_ID) {
        console.log(`[Channel Post] Ignoring message from non-listening channel: ${channelId}`);
        return; // Ignore messages from other channels
    }

    if (!text) {
        console.log(`[Channel Post] Ignoring empty message.`);
        return; // Ignore empty messages
    }

    // --- Logout Message Handling ---
    // Sample: "User [hhhhhhhhh-hr-db] has logged out." or "User [botname] has logged out.\n[Some other text] invalid"
    // The regex needs to handle the bot name in brackets, followed by "has logged out."
    // Using 's' (dotall) flag to make '.' match newlines, and 'i' for case-insensitivity
    // IMPORTANT: Make sure the exact string "has logged out." is present.
    const logoutMatch = text.match(/User \[([^\]]+)\] has logged out\./si); 
    if (logoutMatch) {
        const botName = logoutMatch[1];
        console.log(`[Channel Post] Detected LOGOUT for bot: ${botName}`);

        // If there's an ongoing deployment or var update for this app, resolve its promise as failure
        const pendingPromise = appDeploymentPromises.get(botName);
        if (pendingPromise) {
            clearInterval(pendingPromise.animateIntervalId); // Stop animation
            pendingPromise.reject(new Error('Bot session became invalid on startup.'));
            appDeploymentPromises.delete(botName); // Clean up
            console.log(`[Channel Post] Resolved pending promise for ${botName} with REJECTION (logout detected).`);
        } else {
            console.log(`[Channel Post] No active deployment promise for ${botName}, processing logout as an alert.`);
        }

        const userId = await getUserIdByBotName(botName); // Get the owner's ID from your DB
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
            console.log(`[Channel Post] Sent logout notification to user ${userId} for bot ${botName}`);
        } else {
            console.error(`[Channel Post] CRITICAL: Could not find user for bot "${botName}" during logout alert. Is this bot tracked in the database?`);
            // Optionally notify admin if a bot logs out that isn't in your system.
            bot.sendMessage(ADMIN_ID, `⚠️ Untracked bot "${botName}" logged out. User ID not found in DB.`);
        }
        return;
    }

    // --- Connected Message Handling ---
    // Sample: "✅ [hhhhhbbvvcvvvvvvvcccgvvvvvv] connected.\n🔐 levanter_7dd859633e5ac4e7ca50baced3d060542\n🕒 07/07/2025, 16:34:25"
    // The regex needs to match "connected." and allow for anything after it, including newlines.
    // Using 's' (dotall) flag for '.' to match newlines, and 'i' for case-insensitivity
    const connectedMatch = text.match(/✅ \[([^\]]+)\] connected\..*/si); 
    if (connectedMatch) {
        const botName = connectedMatch[1];
        console.log(`[Channel Post] Detected CONNECTED status for bot: ${botName}`);

        // If there's an ongoing deployment or var update for this app, resolve its promise as success
        const pendingPromise = appDeploymentPromises.get(botName);
        if (pendingPromise) {
            clearInterval(pendingPromise.animateIntervalId); // Stop animation
            pendingPromise.resolve('connected');
            appDeploymentPromises.delete(botName); // Clean up
            console.log(`[Channel Post] Resolved pending promise for ${botName} with SUCCESS.`);
        } else {
            console.log(`[Channel Post] No active deployment promise for ${botName}, not sending duplicate "live" message.`);
            // This case handles a bot connecting spontaneously (e.g., manual restart outside the bot's UI)
            // If you want a "Your bot is live!" message every time, you could enable this:
            // const userId = await getUserIdByBotName(botName);
            // if (userId) {
            //      await bot.sendMessage(userId, `🎉 Your bot "*${botName}*" is now live!`, { parse_mode: 'Markdown' });
            // }
        }
        return;
    }
});

// 15) Scheduled Task for Logout Reminders
// This section will periodically check for bots that have been logged out for more than 24 hours.
async function checkAndRemindLoggedOutBots() {
    console.log('Running scheduled check for logged out bots...');
    // Ensure HEROKU_API_KEY is available for this check
    if (!HEROKU_API_KEY) {
        console.warn('Skipping scheduled logout check: HEROKU_API_KEY not set.');
        return;
    }

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
            // Note: Your Levanter bot code would need to set LAST_LOGOUT_ALERT config var on Heroku
            // when it detects a logout and sends the message to the channel.
            const configRes = await axios.get(`https://api.heroku.com/apps/${herokuApp}/config-vars`, { headers: apiHeaders });
            const lastLogoutAlertStr = configRes.data.LAST_LOGOUT_ALERT; // Levanter bot needs to set this variable.

            // 2. Get dyno status to check if the bot is currently "up"
            const dynoRes = await axios.get(`https://api.heroku.com/apps/${herokuApp}/dynos`, { headers: apiHeaders });
            const workerDyno = dynoRes.data.find(d => d.type === 'worker'); // Assuming your Levanter bot runs as a 'worker' dyno

            const isBotRunning = workerDyno && workerDyno.state === 'up';

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
                    console.log(`[Scheduled Task] Sent 24-hour logout reminder to user ${user_id} for bot ${bot_name}`);
                    
                    // After sending a reminder, you might want to update the LAST_LOGOUT_ALERT
                    // so it doesn't send repeatedly within the next hour or day.
                    // This requires setting a config var on Heroku. Example:
                    // await axios.patch(
                    //     `https://api.heroku.com/apps/${herokuApp}/config-vars`,
                    //     { LAST_LOGOUT_ALERT: now.toISOString() },
                    //     { headers: apiHeaders }
                    // );
                }
            }

        } catch (error) {
            // FIX: Handle 404 Not Found explicitly in scheduled task
            if (error.response && error.response.status === 404) {
                console.log(`[Scheduled Task] App ${herokuApp} not found during reminder check. Auto-removing from DB.`);
                // We don't have the original message ID or calling chat ID here, so just clean DB.
                // Notifications are handled when user tries to interact.
                const currentOwnerId = await getUserIdByBotName(herokuApp);
                if (currentOwnerId) {
                    await deleteUserBot(currentOwnerId, herokuApp);
                    await bot.sendMessage(currentOwnerId, `ℹ️ Your bot "*${herokuApp}*" was not found on Heroku and has been automatically removed from your "My Bots" list.`, { parse_mode: 'Markdown' });
                }
                return; // Stop processing this app if it's not found on Heroku
            }
            console.error(`[Scheduled Task] Error checking status for bot ${herokuApp} (user ${user_id}):`, error.response?.data?.message || error.message);
        }
    }
}

// Schedule the check to run every hour (3600000 milliseconds)
// For testing, you can make this interval shorter, e.g., 60000 (1 minute)
setInterval(checkAndRemindLoggedOutBots, 60 * 60 * 1000); // Every hour


console.log('Bot is running...');

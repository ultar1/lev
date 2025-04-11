const { spawnSync, spawn } = require('child_process');
const { existsSync, writeFileSync, readFileSync } = require('fs');
const path = require('path');

const SESSION_ID = process.env.SESSION_ID; // Use Heroku environment variable

let nodeRestartCount = 0;
const maxNodeRestarts = 5;
const restartWindow = 30000; // 30 seconds
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
  const maxRestarts = 5; // Adjust this value as needed

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
    });
  }

  if (pm2.stdout) {
    pm2.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(output);
      if (output.includes('Connecting')) {
        restartCount = 0;
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
      env: { ...process.env, CI: 'true' }, // Ensure non-interactive environment
    }
  );

  if (installResult.error || installResult.status !== 0) {
    console.error(
      `Failed to install dependencies: ${
        installResult.error ? installResult.error.message : 'Unknown error'
      }`
    );
    process.exit(1); // Exit the process if installation fails
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
    writeFileSync(configPath, `VPS=true\nSESSION_ID=${SESSION_ID}`);
  } catch (err) {
    throw new Error(`Failed to write to config.env: ${err.message}`);
  }

  // Create credentials.json in the Levanter directory
  const credentialsPath = 'levanter/credentials.json';
  const credentials = {
    installed: {
      client_id: '72579695589-q22k1el7q8hq2dkubdt976hpsh0nslsu.apps.googleusercontent.com',
      project_id: 'levanter-456512',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_secret: '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',
      redirect_uris: ['http://localhost'],
    },
  };

  try {
    writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
    console.log('Successfully added credentials.json to the Levanter directory');
  } catch (err) {
    throw new Error(`Failed to write credentials.json: ${err.message}`);
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

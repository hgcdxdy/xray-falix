'use strict';
// Node.js wrapper for xray (VLESS + XHTTP packet-up / WS) on PaaS platforms
// that do not support Dockerfile builds (e.g. Belmo, FadeHost, Deploy.et).
// The platform edge terminates TLS; xray itself listens in cleartext on $PORT.
// Only Node built-in modules are used; no external dependencies.
//
// Env vars are read from process.env first, then from the file
// "katabump-node-credentials.env" in the same directory (KATABUMP_ prefixed
// keys), because some panels (KataBump/Pterodactyl) offer no custom-variable
// inputs. The credential file itself is uploaded separately, never pasted.
//
// Required (from env or file):
//   UUID       - VLESS client UUID (file key KATABUMP_NODE_UUID)
//   WS_PATH    - inbound path, e.g. /ws-xxxxxxxx (file key KATABUMP_NODE_WS_PATH)
//
// Optional:
//   PORT       - listen port (platform-injected), default 3000
//   TRANSPORT  - xhttp (default) or ws (file key KATABUMP_NODE_TRANSPORT)

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fileEnv = {};
try {
  const envPath = path.join(__dirname, 'katabump-node-credentials.env');
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) fileEnv[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  console.log('[wrapper] credential file loaded');
} catch (err) {
  console.log('[wrapper] no credential file, using process.env only');
}

const UUID = process.env.UUID || fileEnv.KATABUMP_NODE_UUID || fileEnv.UUID;
const WS_PATH = process.env.WS_PATH || fileEnv.KATABUMP_NODE_WS_PATH || fileEnv.WS_PATH;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || fileEnv.PORT || fileEnv.SERVER_PORT || '3000', 10);
const TRANSPORT = (process.env.TRANSPORT || fileEnv.KATABUMP_NODE_TRANSPORT || 'xhttp').toLowerCase();

if (!UUID) {
  console.error('[wrapper] FATAL: UUID env var is not set');
  process.exit(1);
}
if (!WS_PATH) {
  console.error('[wrapper] FATAL: WS_PATH env var is not set');
  process.exit(1);
}
if (TRANSPORT !== 'xhttp' && TRANSPORT !== 'ws') {
  console.error(`[wrapper] FATAL: TRANSPORT must be "xhttp" or "ws", got "${TRANSPORT}"`);
  process.exit(1);
}

const streamSettings = { network: TRANSPORT };
if (TRANSPORT === 'xhttp') {
  streamSettings.xhttpSettings = {
    path: WS_PATH,
    mode: 'packet-up',
  };
} else {
  streamSettings.wsSettings = {
    path: WS_PATH,
  };
}

const config = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      port: PORT,
      listen: '0.0.0.0',
      protocol: 'vless',
      settings: {
        clients: [{ id: UUID, flow: '' }],
        decryption: 'none',
      },
      streamSettings,
    },
  ],
  outbounds: [{ protocol: 'freedom', tag: 'direct' }],
};

const configPath = path.join(os.tmpdir(), 'xray-wrapper-config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`[wrapper] xray config written (transport=${TRANSPORT}, port=${PORT}, path=${WS_PATH})`);


// If the xray binary is missing (panel uploads cannot carry binaries),
// download the official release zip and extract it. Only Node built-ins
// plus curl/wget/unzip/python3 (whichever the image provides) are used.
const XRAY_URL = 'https://github.com/XTLS/Xray-core/releases/download/v26.10.31/Xray-linux-64.zip';
function ensureXray() {
  const { execSync } = require('child_process');
  const xrayPath = path.join(__dirname, 'xray');
  try {
    fs.accessSync(xrayPath, fs.constants.X_OK);
    console.log('[wrapper] xray binary present');
    return xrayPath;
  } catch (e) { /* missing: download it */ }
  console.log('[wrapper] xray binary missing, downloading release...');
  const zipPath = path.join(os.tmpdir(), 'xray-linux-64.zip');
  const downloads = [
    `curl -fsSL -o "${zipPath}" "${XRAY_URL}"`,
    `wget -q -O "${zipPath}" "${XRAY_URL}"`,
  ];
  let downloaded = false;
  for (const cmd of downloads) {
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 120000 });
      if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 1000000) { downloaded = true; break; }
    } catch (e) { console.log(`[wrapper] download attempt failed: ${cmd.split(' ')[0]}`); }
  }
  if (!downloaded) {
    console.error('[wrapper] FATAL: could not download xray release zip');
    process.exit(1);
  }
  const extracts = [
    `unzip -o "${zipPath}" xray -d "${__dirname}"`,
    `python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract('xray', sys.argv[2])" "${zipPath}" "${__dirname}"`,
  ];
  for (const cmd of extracts) {
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 60000 });
      if (fs.existsSync(xrayPath)) break;
    } catch (e) { console.log('[wrapper] extract attempt failed'); }
  }
  try { fs.accessSync(xrayPath, fs.constants.F_OK); }
  catch (e) {
    console.error('[wrapper] FATAL: xray binary still missing after download+extract');
    process.exit(1);
  }
  console.log('[wrapper] xray binary downloaded');
  return xrayPath;
}
const xrayBin = ensureXray();
try {
  fs.chmodSync(xrayBin, 0o755);
} catch (err) {
  console.log(`[wrapper] chmod xray failed (continuing): ${err.message}`);
}
const child = spawn(xrayBin, ['run', '-c', configPath], { stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`[wrapper] FATAL: failed to start xray: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.error(`[wrapper] xray exited (code=${code}, signal=${signal}); wrapper exiting`);
  process.exit(code === null ? 1 : code);
});

const shutdown = (signal) => {
  console.log(`[wrapper] received ${signal}, stopping xray`);
  if (!child.killed) child.kill(signal);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

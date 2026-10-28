
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, Browsers, delay, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
const PORT = process.env.PORT || 10000;
const SESSIONS = new Map();

app.get('/pair', async (req, res) => {
  let num = req.query.number;
  if (!num) return res.json({ error: "Use ?number=2557xxxxxxx" });
  num = num.replace(/[^0-9]/g, '');
  
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  const dir = `./temp/${id}`;
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  console.log(`[${id}] Starting for ${num}`);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
      },
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    // IMPORTANT: Wait for WS to open before requesting code
    await new Promise(resolve => {
      sock.ev.on('connection.update', (u) => {
        if (u.qr || u.connection) resolve();
      });
      setTimeout(resolve, 4000);
    });

    await delay(3000);

    if (sock.authState.creds.registered) {
      return res.json({ error: "This number already has session in temp. Delete temp folder and retry" });
    }

    console.log(`[${id}] Requesting pairing code...`);
    let code;
    try {
      code = await sock.requestPairingCode(num);
      code = code?.match(/.{1,4}/g)?.join("-") || code;
    } catch (e) {
      console.log(`[${id}] Pair error:`, e.message);
      try { await sock.ws.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      return res.status(500).json({ error: "Pair failed: " + e.message + " - Try QR method or wait 2 min" });
    }

    console.log(`[${id}] ✅ REAL CODE: ${code}`);
    SESSIONS.set(id, { sock, dir, code, status: 'waiting', creds: null });

    // Listen for login
    sock.ev.on('connection.update', async (u) => {
      if (u.connection === 'open') {
        console.log(`[${id}] CONNECTED!`);
        await delay(5000);
        try {
          const credsPath = path.join(dir, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const buff = fs.readFileSync(credsPath);
            const b64 = Buffer.from(buff).toString('base64');
            const sess = SESSIONS.get(id);
            if (sess) {
              sess.creds = b64;
              sess.status = 'completed';
            }
          }
        } catch {}
      }
    });

    res.json({ sessionId: id, code, status: "code_sent" });

  } catch (e) {
    console.log(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/session/:id', (req, res) => {
  const s = SESSIONS.get(req.params.id);
  if (!s) return res.json({ status: "not_found" });
  if (s.status === 'completed' && s.creds) {
    return res.json({ status: "completed", SESSION_ID: s.creds });
  }
  res.json({ status: s.status, code: s.code });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🌑 DARK-EYE Panel FIXED running on ${PORT}`));	

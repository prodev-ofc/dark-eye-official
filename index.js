const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 10000;
const SESSIONS = new Map();

// Auto clean temp
setInterval(() => {
  try {
    if (!fs.existsSync('./temp')) return;
    fs.readdirSync('./temp').forEach(f => {
      const fp = path.join('./temp', f);
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
        fs.rmSync(fp, { recursive: true, force: true });
      }
    });
  } catch {}
}, 60000);

async function createPairSession(number) {
  const sessionId = Math.random().toString(36).substring(2, 10).toUpperCase();
  const dir = `./temp/${sessionId}`;
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    logger: pino({ level: "silent" }),
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);
  SESSIONS.set(sessionId, { sock, dir, status: 'waiting', code: null, creds: null });

  return new Promise(async (resolve, reject) => {
    await delay(2500); // FIX: Wait for socket ready
    
    try {
      let cleanNum = number.replace(/[^0-9]/g, '');
      console.log(`[${sessionId}] Requesting REAL code for ${cleanNum}`);

      let code = null;
      // Retry 3 times for real code
      for (let i = 0; i < 3; i++) {
        try {
          if (!sock.authState.creds.registered) {
            code = await sock.requestPairingCode(cleanNum);
            if (code) break;
          }
        } catch (e) {
          console.log(`[${sessionId}] Retry ${i+1} failed: ${e.message}`);
          await delay(2000);
        }
      }

      if (!code) {
        SESSIONS.delete(sessionId);
        return reject(new Error("Failed to generate code. Try again in 10 sec"));
      }

      SESSIONS.get(sessionId).code = code;
      SESSIONS.get(sessionId).status = 'code_sent';
      console.log(`[${sessionId}] ✅ REAL CODE: ${code} for ${cleanNum}`);
      resolve({ sessionId, code });

    } catch (e) {
      console.log("Pair error:", e.message);
      SESSIONS.delete(sessionId);
      reject(e);
    }

    sock.ev.on('connection.update', async (u) => {
      const { connection } = u;
      if (connection === 'open') {
        const sess = SESSIONS.get(sessionId);
        if (!sess) return;
        sess.status = 'connected';
        await delay(4000);
        try {
          const credsPath = path.join(dir, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const data = fs.readFileSync(credsPath);
            const base64 = Buffer.from(data).toString('base64');
            sess.creds = base64;
            sess.status = 'completed';
            console.log(`[${sessionId}] ✅ Session completed`);
          }
        } catch (err) {
          console.log(err);
        }
        try { await sock.ws.close(); } catch {}
      }
      if (connection === 'close') {
        const sess = SESSIONS.get(sessionId);
        if (sess && sess.status !== 'completed') {
          // keep waiting for user to enter code
        }
      }
    });
  });
}

// API Routes
app.get('/pair', async (req, res) => {
  const num = req.query.number;
  if (!num) return res.json({ error: "Add ?number=2557xxxxxxx with country code" });
  if (SESSIONS.size > 25) return res.json({ error: "Server busy (25 users). Wait 2 min" });

  try {
    const { sessionId, code } = await createPairSession(num);
    res.json({ 
      sessionId, 
      code, 
      status: "code_sent", 
      message: "Enter this code in WhatsApp within 60 seconds" 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/session/:id', (req, res) => {
  const s = SESSIONS.get(req.params.id);
  if (!s) return res.json({ status: "not_found", message: "Session expired, generate new code" });
  if (s.status === 'completed' && s.creds) {
    res.json({ 
      status: "completed", 
      SESSION_ID: s.creds,
      DARK_EYE_SESSION: s.creds,
      id: req.params.id
    });
  } else {
    res.json({ status: s.status, code: s.code });
  }
});

app.get('/qr', async (req, res) => {
  const sessionId = Math.random().toString(36).substring(2, 8);
  const dir = `./temp/QR_${sessionId}`;
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const sock = makeWASocket({ 
    auth: state, 
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome")
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      const QR = require('qrcode');
      const img = await QR.toDataURL(u.qr);
      res.json({ qr: img, sessionId });
    }
  });
  setTimeout(() => {
    if (!res.headersSent) res.json({ error: "Timeout, try again" });
  }, 15000);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🌑 DARK-EYE-OFFICIAL Panel running on ${PORT} - Real Code Fix`));

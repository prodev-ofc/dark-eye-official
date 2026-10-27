const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers, delay, DisconnectReason } = require('@whiskeysockets/baileys');
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

// Clean temp every 10 min
setInterval(()=>{
  try{
    if(!fs.existsSync('./temp')) return;
    fs.readdirSync('./temp').forEach(f=>{
      const fp = path.join('./temp', f);
      const stat = fs.statSync(fp);
      if(Date.now() - stat.mtimeMs > 10*60*1000){
        fs.rmSync(fp, {recursive:true, force:true});
      }
    });
  }catch{}
}, 60000);

async function createPairSession(number){
  const sessionId = Math.random().toString(36).substring(2,10).toUpperCase();
  const dir = `./temp/${sessionId}`;
  fs.mkdirSync(dir, {recursive:true});
  
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS("Desktop"),
    logger: pino({level:"silent"})
  });

  sock.ev.on('creds.update', saveCreds);

  SESSIONS.set(sessionId, { sock, dir, status: 'waiting', code: null, creds: null });

  return new Promise(async (resolve, reject)=>{
    try{
      if(!sock.authState.creds.registered){
        await delay(1200);
        let cleanNum = number.replace(/[^0-9]/g,'');
        const code = await sock.requestPairingCode(cleanNum);
        SESSIONS.get(sessionId).code = code;
        SESSIONS.get(sessionId).status = 'code_sent';
        console.log(`[${sessionId}] Pair code ${code} for ${cleanNum}`);
        resolve({ sessionId, code });
      }
    }catch(e){ reject(e); }

    sock.ev.on('connection.update', async (u)=>{
      const { connection, lastDisconnect } = u;
      if(connection === 'open'){
        SESSIONS.get(sessionId).status = 'connected';
        await delay(3000);
        try{
          const credsPath = path.join(dir, 'creds.json');
          if(fs.existsSync(credsPath)){
            const credsData = fs.readFileSync(credsPath);
            const base64 = Buffer.from(credsData).toString('base64');
            const fullAuth = fs.readdirSync(dir);
            let allData = {};
            fullAuth.forEach(f=>{
              try{ allData[f] = fs.readFileSync(path.join(dir,f)).toString('base64'); }catch{}
            });
            SESSIONS.get(sessionId).creds = base64;
            SESSIONS.get(sessionId).all = allData;
            SESSIONS.get(sessionId).status = 'completed';
            console.log(`[${sessionId}] ✅ Connected & session ready`);
          }
        }catch(e){ console.log(e); }
      }
      if(connection === 'close'){
        if(lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut){
          // keep
        }
      }
    });
  });
}

// Routes
app.get('/pair', async (req,res)=>{
  const num = req.query.number;
  if(!num) return res.json({ error: "Number required ?number=255..." });
  if(SESSIONS.size > 20) return res.json({ error: "Server busy, try in 2 min" });
  try{
    const { sessionId, code } = await createPairSession(num);
    res.json({ sessionId, code, status: "code_sent", message: "Enter code in WhatsApp" });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get('/session/:id', (req,res)=>{
  const s = SESSIONS.get(req.params.id);
  if(!s) return res.json({ status: "not_found" });
  if(s.status === 'completed' && s.creds){
    res.json({ 
      status: "completed", 
      SESSION_ID: s.creds,
      DARK_EYE_SESSION: s.creds,
      download_all: s.all
    });
  }else{
    res.json({ status: s.status, code: s.code });
  }
});

app.get('/qr', async (req,res)=>{
  // QR mode for users who want QR
  const sessionId = Math.random().toString(36).substring(2,8);
  const dir = `./temp/QR_${sessionId}`;
  fs.mkdirSync(dir,{recursive:true});
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const sock = makeWASocket({ auth: state, logger: pino({level:"silent"}) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u)=>{
    if(u.qr){
      const QR = require('qrcode');
      const img = await QR.toDataURL(u.qr);
      res.json({ qr: img, sessionId });
    }
  });
});

app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, ()=> console.log(`🌑 DARK-EYE-OFFICIAL Panel running on ${PORT}`));

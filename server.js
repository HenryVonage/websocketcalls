const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const { handleWhatsAppInbound } = require('./lib/whatsappFlow');
const { handleAnswer, handleEvents } = require('./lib/voiceHandlers');
const { handleDlr } = require('./lib/dlrHandler');
const { attachVoiceBridge } = require('./lib/realtimeBridge');

const app = express();
app.use(express.json());

// --- WhatsApp text messaging (Flow 3) ---
app.post('/vonage-estate-whatsapp', handleWhatsAppInbound);

// --- Voice: Answer URL + Event URL (Flow 5 / Flow 4) ---
app.get('/answer', handleAnswer);
app.post('/answer', handleAnswer);
app.post('/events', handleEvents);

// --- Delivery receipts (DLR Status Handler) ---
app.post('/vonage-dlr-status', handleDlr);

app.get('/', (req, res) => {
  res.send('Vonage Estate server is running.');
});

const server = http.createServer(app);

// The realtime audio connection (Flow 6 replacement) needs raw
// binary/text websocket frames, not Express JSON routing, so it's handled
// as a manual upgrade on a dedicated path instead of an Express route.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/voice') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', attachVoiceBridge);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Vonage Estate server listening on port ${PORT}`);
});

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Keep a rolling in-memory history of signal points
const MAX_STORED_SIGNALS = 1000;

const signals = [
  {
    deviceId: 'esp32-001',
    triggered: false,
    value: 0,
    timestamp: new Date().toISOString(),
  },
];

app.get('/', (req, res) => {
  res.send('Backend is running 🚀');
});

// Get the latest signal only
app.get('/signal', (req, res) => {
  const latestSignal = signals[signals.length - 1] || null;
  res.json(latestSignal);
});

// Get recent signal history for charting
app.get('/signals', (req, res) => {
  const { deviceId, limit } = req.query;

  let filteredSignals = signals;

  if (deviceId) {
    filteredSignals = filteredSignals.filter(
      (signal) => signal.deviceId === deviceId
    );
  }

  let parsedLimit = parseInt(limit, 10);
  if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
    parsedLimit = 20;
  }

  if (parsedLimit > MAX_STORED_SIGNALS) {
    parsedLimit = MAX_STORED_SIGNALS;
  }

  const recentSignals = filteredSignals.slice(-parsedLimit);

  res.json(recentSignals);
});

// Receive new signal point from ESP32
app.post('/signal', (req, res) => {
  const { deviceId, triggered, value, timestamp } = req.body;

  const numericValue = Number(value);

  const newSignal = {
    deviceId:
      typeof deviceId === 'string' && deviceId.trim()
        ? deviceId.trim()
        : 'esp32-001',
    triggered: Boolean(triggered),
    value: Number.isFinite(numericValue) ? numericValue : 0,
    timestamp:
      typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))
        ? new Date(timestamp).toISOString()
        : new Date().toISOString(),
  };

  signals.push(newSignal);

  // Keep only the newest MAX_STORED_SIGNALS readings
  if (signals.length > MAX_STORED_SIGNALS) {
    signals.splice(0, signals.length - MAX_STORED_SIGNALS);
  }

  res.json({
    success: true,
    received: newSignal,
    storedCount: signals.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
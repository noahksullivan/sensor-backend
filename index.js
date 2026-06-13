const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

app.use(express.json());

// Keep a rolling in-memory history of signal points
const MAX_STORED_SIGNALS = 1000;
const DEFAULT_DEVICE_ID = 'esp32-001';

const signals = [
  {
    deviceId: DEFAULT_DEVICE_ID,
    triggered: false,
    value: 0,
    timestamp: new Date().toISOString(),
  },
];

function normalizeTimestamp(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    const ms = input < 1e12 ? input * 1000 : input;
    return new Date(ms).toISOString();
  }

  if (typeof input === 'string' && input.trim()) {
    const numeric = Number(input);

    if (Number.isFinite(numeric)) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      return new Date(ms).toISOString();
    }

    const parsed = Date.parse(input);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return new Date().toISOString();
}

function normalizeSignalPoint(point, fallbackDeviceId = DEFAULT_DEVICE_ID) {
  const numericValue = Number(point?.value);

  return {
    deviceId:
      typeof point?.deviceId === 'string' && point.deviceId.trim()
        ? point.deviceId.trim()
        : fallbackDeviceId,
    triggered: Boolean(point?.triggered),
    value: Number.isFinite(numericValue) ? numericValue : 0,
    timestamp: normalizeTimestamp(point?.timestamp),
  };
}

app.get('/', (req, res) => {
  res.send('Backend is running 🚀');
});

// Get the latest signal only
app.get('/signal', (req, res) => {
  const { deviceId } = req.query;

  const filteredSignals = deviceId
    ? signals.filter((signal) => signal.deviceId === deviceId)
    : signals;

  const latestSignal = filteredSignals[filteredSignals.length - 1] || null;
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

  const recentSignals = filteredSignals
    .slice()
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )
    .slice(-parsedLimit);

  res.json(recentSignals);
});

// Receive new signal point OR a batch of signal points from ESP32
app.post('/signal', (req, res) => {
  const body = req.body || {};

  const requestDeviceId =
    typeof body.deviceId === 'string' && body.deviceId.trim()
      ? body.deviceId.trim()
      : DEFAULT_DEVICE_ID;

  const rawPoints = Array.isArray(body.points) ? body.points : [body];

  if (rawPoints.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No signal points provided.',
    });
  }

  const newSignals = rawPoints.map((point) =>
    normalizeSignalPoint(
      {
        ...point,
        deviceId:
          typeof point?.deviceId === 'string' && point.deviceId.trim()
            ? point.deviceId.trim()
            : requestDeviceId,
      },
      requestDeviceId
    )
  );

  signals.push(...newSignals);

  // Keep only the newest MAX_STORED_SIGNALS readings
  if (signals.length > MAX_STORED_SIGNALS) {
    signals.splice(0, signals.length - MAX_STORED_SIGNALS);
  }

  res.json({
    success: true,
    receivedCount: newSignals.length,
    latest: newSignals[newSignals.length - 1],
    storedCount: signals.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
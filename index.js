const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

const DEFAULT_DEVICE_ID = 'esp32-001';
const DEFAULT_DASHBOARD_LIMIT = 600;
const MAX_DASHBOARD_LIMIT = 2000;
const DEFAULT_HISTORY_BUCKET_COUNT = 800;
const MAX_HISTORY_BUCKET_COUNT = 1000;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

const KNOWN_DEVICES = [
  {
    deviceId: 'esp32-001',
    label: 'Hilltop',
  },
  {
    deviceId: 'esp32-002',
    label: 'Site 3',
  },
];

const signalsByDevice = Object.fromEntries(
  KNOWN_DEVICES.map((device) => [device.deviceId, []])
);

function ensureSignalStore(deviceId) {
  if (!signalsByDevice[deviceId]) {
    signalsByDevice[deviceId] = [];
  }

  return signalsByDevice[deviceId];
}

function sanitizePositiveInt(value, fallback, max) {
  const parsed = parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function normalizeTimestamp(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    const ms = input < 1e12 ? input * 1000 : input;
    return {
      iso: new Date(ms).toISOString(),
      ms,
    };
  }

  if (typeof input === 'string' && input.trim()) {
    const numeric = Number(input);

    if (Number.isFinite(numeric)) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      return {
        iso: new Date(ms).toISOString(),
        ms,
      };
    }

    const parsed = Date.parse(input);

    if (!Number.isNaN(parsed)) {
      return {
        iso: new Date(parsed).toISOString(),
        ms: parsed,
      };
    }
  }

  const nowMs = Date.now();

  return {
    iso: new Date(nowMs).toISOString(),
    ms: nowMs,
  };
}

function normalizeSignalPoint(point, fallbackDeviceId = DEFAULT_DEVICE_ID) {
  const numericValue = Number(point?.value);
  const normalizedTime = normalizeTimestamp(point?.timestamp);

  return {
    deviceId:
      typeof point?.deviceId === 'string' && point.deviceId.trim()
        ? point.deviceId.trim()
        : fallbackDeviceId,
    triggered: Boolean(point?.triggered),
    value: Number.isFinite(numericValue) ? numericValue : 0,
    timestamp: normalizedTime.iso,
    timestampMs: normalizedTime.ms,
  };
}

function toPublicSignalPoint(point) {
  return {
    deviceId: point.deviceId,
    triggered: point.triggered,
    value: point.value,
    timestamp: point.timestamp,
  };
}

function findFirstIndexGreaterThan(points, timestampMs) {
  let low = 0;
  let high = points.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (points[mid].timestampMs <= timestampMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function findFirstIndexAtOrAfter(points, timestampMs) {
  let low = 0;
  let high = points.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (points[mid].timestampMs < timestampMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function getDeviceSignals(deviceId) {
  if (!deviceId) {
    return Object.values(signalsByDevice)
      .flat()
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  return ensureSignalStore(deviceId);
}

function bucketSignals(points, bucketCount) {
  if (points.length <= bucketCount) {
    return points.map(toPublicSignalPoint);
  }

  const bucketSize = Math.ceil(points.length / bucketCount);
  const bucketed = [];

  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, start + bucketSize);
    const lastPoint = bucket[bucket.length - 1];
    const averageValue =
      bucket.reduce((sum, point) => sum + point.value, 0) / bucket.length;

    bucketed.push({
      deviceId: lastPoint.deviceId,
      triggered: lastPoint.triggered,
      value: Number(averageValue.toFixed(3)),
      timestamp: lastPoint.timestamp,
    });
  }

  return bucketed;
}

app.get('/', (req, res) => {
  res.send('Backend is running 🚀');
});

app.get('/devices', (req, res) => {
  res.json(KNOWN_DEVICES);
});

app.get('/signal', (req, res) => {
  const { deviceId } = req.query;
  const deviceSignals = getDeviceSignals(deviceId);
  const latestSignal = deviceSignals[deviceSignals.length - 1] || null;

  res.json(latestSignal ? toPublicSignalPoint(latestSignal) : null);
});

app.get('/signals/summary', (req, res) => {
  const { deviceId } = req.query;
  const bucketCount = sanitizePositiveInt(
    req.query.bucketCount,
    DEFAULT_HISTORY_BUCKET_COUNT,
    MAX_HISTORY_BUCKET_COUNT
  );

  if (!deviceId) {
    return res.status(400).json({
      success: false,
      message: 'deviceId is required.',
    });
  }

  const deviceSignals = getDeviceSignals(deviceId);

  res.json({
    deviceId,
    totalPoints: deviceSignals.length,
    bucketCount,
    oldestTimestamp: deviceSignals[0]?.timestamp ?? null,
    latestTimestamp: deviceSignals[deviceSignals.length - 1]?.timestamp ?? null,
    points: bucketSignals(deviceSignals, bucketCount),
  });
});

app.get('/signals/page', (req, res) => {
  const { deviceId, before } = req.query;
  const pageSize = sanitizePositiveInt(
    req.query.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );

  if (!deviceId) {
    return res.status(400).json({
      success: false,
      message: 'deviceId is required.',
    });
  }

  const deviceSignals = getDeviceSignals(deviceId);

  let endExclusive = deviceSignals.length;

  if (before) {
    const beforeMs = Date.parse(before);

    if (!Number.isNaN(beforeMs)) {
      endExclusive = findFirstIndexAtOrAfter(deviceSignals, beforeMs);
    }
  }

  const startInclusive = Math.max(0, endExclusive - pageSize);
  const pageSignals = deviceSignals.slice(startInclusive, endExclusive);
  const newestFirst = pageSignals.slice().reverse().map(toPublicSignalPoint);

  const oldestPointInPage = pageSignals[0] || null;
  const hasMore = startInclusive > 0;

  res.json({
    deviceId,
    totalPoints: deviceSignals.length,
    hasMore,
    nextBefore: oldestPointInPage ? oldestPointInPage.timestamp : null,
    readings: newestFirst,
  });
});

app.get('/signals', (req, res) => {
  const { deviceId, since } = req.query;
  const deviceSignals = getDeviceSignals(deviceId);

  if (since) {
    const sinceMs = Date.parse(since);

    if (!Number.isNaN(sinceMs)) {
      const startIndex = findFirstIndexGreaterThan(deviceSignals, sinceMs);

      return res.json(deviceSignals.slice(startIndex).map(toPublicSignalPoint));
    }
  }

  const limit = sanitizePositiveInt(
    req.query.limit,
    DEFAULT_DASHBOARD_LIMIT,
    MAX_DASHBOARD_LIMIT
  );

  return res.json(deviceSignals.slice(-limit).map(toPublicSignalPoint));
});

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

  const newSignals = rawPoints
    .map((point) =>
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
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const deviceSignals = ensureSignalStore(requestDeviceId);
  const lastExistingPoint = deviceSignals[deviceSignals.length - 1];

  if (
    !lastExistingPoint ||
    lastExistingPoint.timestampMs <= newSignals[0].timestampMs
  ) {
    deviceSignals.push(...newSignals);
  } else {
    deviceSignals.push(...newSignals);
    deviceSignals.sort((a, b) => a.timestampMs - b.timestampMs);
  }

  res.json({
    success: true,
    receivedCount: newSignals.length,
    latest: toPublicSignalPoint(newSignals[newSignals.length - 1]),
    storedCount: deviceSignals.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
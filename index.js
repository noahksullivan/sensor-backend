const express = require('express');
const cors = require('cors');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

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
const DEFAULT_TRANSITION_LIMIT = 20;
const MAX_TRANSITION_LIMIT = 100;
const ON_THRESHOLD_AMPS = 0.5;

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

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const discordWebhookUrl = (
  process.env.DISCORD_ALERT_WEBHOOK_URL || ''
).trim();

const discordAlertTestToken = (
  process.env.DISCORD_ALERT_TEST_TOKEN || ''
).trim();

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

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

function toDbSignalPoint(point) {
  return {
    device_id: point.deviceId,
    triggered: point.triggered,
    value: point.value,
    timestamp: point.timestamp,
  };
}

function toPublicSignalPoint(row) {
  return {
    deviceId: row.device_id,
    triggered: row.triggered,
    value: Number(row.value),
    timestamp: row.timestamp,
  };
}

function getPointState(value) {
  return value >= ON_THRESHOLD_AMPS ? 'ON' : 'OFF';
}

function getDurationSeconds(startedAt, endedAt) {
  return Math.max(
    0,
    Math.round(
      (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000
    )
  );
}

function sortSignalsAscending(points) {
  return points
    .slice()
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
}

async function getDeviceStateRow(deviceId) {
  const { data, error } = await supabase
    .from('device_state')
    .select('*')
    .eq('device_id', deviceId)
    .limit(1);

  if (error) {
    throw error;
  }

  return data?.[0] ?? null;
}

async function saveDeviceStateRow(stateRow, existedAlready) {
  if (existedAlready) {
    const { error } = await supabase
      .from('device_state')
      .update(stateRow)
      .eq('device_id', stateRow.device_id);

    if (error) {
      throw error;
    }

    return;
  }

  const { error } = await supabase.from('device_state').insert(stateRow);

  if (error) {
    throw error;
  }
}

async function getLatestSignalRow(deviceId) {
  const { data, error } = await supabase
    .from('signal_points')
    .select('device_id, triggered, value, timestamp')
    .eq('device_id', deviceId)
    .order('timestamp', { ascending: false })
    .limit(1);

  if (error) {
    throw error;
  }

  return data?.[0] ?? null;
}

async function getRecentTransitionRows(deviceId, limit) {
  const { data, error } = await supabase
    .from('state_transitions')
    .select('state, started_at, ended_at, duration_seconds')
    .eq('device_id', deviceId)
    .order('ended_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data ?? [];
}

function getDeviceLabel(deviceId) {
  return (
    KNOWN_DEVICES.find((device) => device.deviceId === deviceId)?.label ??
    deviceId
  );
}

function formatDurationSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function postDiscordWebhook(payload) {
  if (!discordWebhookUrl) {
    return Promise.reject(
      new Error('DISCORD_ALERT_WEBHOOK_URL is not configured.')
    );
  }

  const webhookUrl = new URL(discordWebhookUrl);
  webhookUrl.searchParams.set('wait', 'true');

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: webhookUrl.protocol,
        hostname: webhookUrl.hostname,
        port: webhookUrl.port || 443,
        path: `${webhookUrl.pathname}${webhookUrl.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          responseBody += chunk;
        });

        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;

          if (statusCode >= 200 && statusCode < 300) {
            let parsedBody = null;

            if (responseBody) {
              try {
                parsedBody = JSON.parse(responseBody);
              } catch (error) {
                parsedBody = null;
              }
            }

            resolve({
              statusCode,
              body: parsedBody,
            });

            return;
          }

          reject(
            new Error(
              `Discord webhook failed with status ${statusCode}: ${responseBody.slice(
                0,
                500
              )}`
            )
          );
        });
      }
    );

    request.setTimeout(10000, () => {
      request.destroy(new Error('Discord webhook request timed out.'));
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function updateAlertNotificationStatus(
  alertRow,
  status,
  errorMessage = null
) {
  const updateRow = {
    notification_status: status,
    notification_attempts:
      Number(alertRow.notification_attempts ?? 0) + 1,
    notification_sent_at:
      status === 'SENT' ? new Date().toISOString() : null,
    last_notification_error:
      errorMessage === null
        ? null
        : String(errorMessage).slice(0, 1000),
  };

  const { error } = await supabase
    .from('device_alerts')
    .update(updateRow)
    .eq('id', alertRow.id);

  if (error) {
    throw error;
  }
}

async function sendLongOnDiscordAlert(alertRow) {
  const deviceLabel = getDeviceLabel(alertRow.device_id);

  return postDiscordWebhook({
    username: 'Pump Monitor',

    content: `🚨 ${deviceLabel} pump is running abnormally long.`,

    allowed_mentions: {
      parse: [],
    },

    embeds: [
      {
        title: 'Pump Running Abnormally Long',

        description:
          'The current ON cycle has exceeded the normal duration by more than three standard deviations.',

        color: 0xdc2626,

        fields: [
          {
            name: 'Location',
            value: deviceLabel,
            inline: true,
          },
          {
            name: 'Device',
            value: alertRow.device_id,
            inline: true,
          },
          {
            name: 'Current ON time',
            value: formatDurationSeconds(
              alertRow.current_duration_seconds
            ),
            inline: false,
          },
          {
            name: 'Last-10 average',
            value: formatDurationSeconds(
              alertRow.average_on_duration_seconds
            ),
            inline: true,
          },
          {
            name: 'Standard deviation',
            value: formatDurationSeconds(
              alertRow.standard_deviation_seconds
            ),
            inline: true,
          },
          {
            name: 'Alert threshold',
            value: formatDurationSeconds(
              alertRow.threshold_duration_seconds
            ),
            inline: true,
          },
        ],

        footer: {
          text: `Based on the last ${alertRow.sample_size} completed ON cycles`,
        },

        timestamp: alertRow.triggered_at,
      },
    ],
  });
}

async function evaluateAndSendLongOnAlert(deviceId) {
  const { data: evaluationRows, error: evaluationError } =
    await supabase.rpc('evaluate_long_on_alert', {
      p_device_id: deviceId,
    });

  if (evaluationError) {
    throw evaluationError;
  }

  const evaluation = evaluationRows?.[0] ?? null;

  if (!evaluation?.alert_created || !evaluation.alert_id) {
    return {
      evaluation,
      notificationAttempted: false,
      notificationSent: false,
    };
  }

  const { data: alertRows, error: alertError } = await supabase
    .from('device_alerts')
    .select(
      'id, device_id, cycle_started_at, triggered_at, current_duration_seconds, average_on_duration_seconds, standard_deviation_seconds, threshold_duration_seconds, sample_size, notification_attempts'
    )
    .eq('id', evaluation.alert_id)
    .limit(1);

  if (alertError) {
    throw alertError;
  }

  const alertRow = alertRows?.[0] ?? null;

  if (!alertRow) {
    throw new Error(
      `Long ON alert ${evaluation.alert_id} was created but could not be loaded.`
    );
  }

  try {
    const discordResult = await sendLongOnDiscordAlert(alertRow);

    try {
      await updateAlertNotificationStatus(alertRow, 'SENT');
    } catch (statusError) {
      console.error(
        'Discord sent, but SENT status could not be saved:',
        statusError
      );
    }

    return {
      evaluation,
      notificationAttempted: true,
      notificationSent: true,
      discordMessageId: discordResult.body?.id ?? null,
    };
  } catch (error) {
    console.error(`Discord alert failed for ${deviceId}:`, error);

    try {
      await updateAlertNotificationStatus(
        alertRow,
        'FAILED',
        error?.message ?? error
      );
    } catch (statusError) {
      console.error(
        'Could not record Discord notification failure:',
        statusError
      );
    }

    return {
      evaluation,
      notificationAttempted: true,
      notificationSent: false,
      error: String(error?.message ?? error),
    };
  }
}

app.get('/', (req, res) => {
  res.send('Backend is running 🚀');
});

app.get('/devices', (req, res) => {
  res.json(KNOWN_DEVICES);
});

app.post('/alerts/test', async (req, res) => {
  const providedToken = String(
    req.get('x-alert-test-token') || ''
  );

  if (
    !discordAlertTestToken ||
    providedToken !== discordAlertTestToken
  ) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized.',
    });
  }

  try {
    const discordResult = await postDiscordWebhook({
      username: 'Pump Monitor',

      content: '✅ Pump Monitor Discord test succeeded.',

      allowed_mentions: {
        parse: [],
      },

      embeds: [
        {
          title: 'Discord Alert Test',

          description:
            'The sensor backend can successfully send pump alerts to this channel.',

          color: 0x16a34a,

          timestamp: new Date().toISOString(),
        },
      ],
    });

    return res.json({
      success: true,
      message: 'Discord test alert sent.',
      discordMessageId: discordResult.body?.id ?? null,
    });
  } catch (error) {
    console.error('Discord test alert failed:', error);

    return res.status(502).json({
      success: false,
      message: 'Discord test alert failed.',
      error: String(error?.message ?? error),
    });
  }
});

app.get('/signal', async (req, res) => {
  try {
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: 'deviceId is required.',
      });
    }

    const latestRow = await getLatestSignalRow(deviceId);
    res.json(latestRow ? toPublicSignalPoint(latestRow) : null);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Could not load latest signal.',
    });
  }
});

app.get('/dashboard', async (req, res) => {
  try {
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: 'deviceId is required.',
      });
    }

    const transitionLimit = sanitizePositiveInt(
      req.query.transitionLimit,
      DEFAULT_TRANSITION_LIMIT,
      MAX_TRANSITION_LIMIT
    );

    const [stateRow, recentTransitions] = await Promise.all([
      getDeviceStateRow(deviceId),
      getRecentTransitionRows(deviceId, transitionLimit),
    ]);

    if (!stateRow) {
      return res.json({
        deviceId,
        thresholdAmps: ON_THRESHOLD_AMPS,
        latestSignal: null,
        currentState: null,
        currentStateStartedAt: null,
        currentStateDurationSeconds: 0,
        lastCompletedOnDurationSeconds: null,
        lastCompletedOffDurationSeconds: null,
        recentTransitions: [],
      });
    }

    const currentStateDurationSeconds =
      stateRow.current_state &&
      stateRow.current_state_started_at &&
      stateRow.latest_signal_at
        ? getDurationSeconds(
            stateRow.current_state_started_at,
            stateRow.latest_signal_at
          )
        : 0;

    res.json({
      deviceId,
      thresholdAmps: Number(stateRow.threshold_amps ?? ON_THRESHOLD_AMPS),
      latestSignal: stateRow.latest_signal_at
        ? {
            deviceId,
            triggered: Boolean(stateRow.latest_signal_triggered),
            value: Number(stateRow.latest_signal_value ?? 0),
            timestamp: stateRow.latest_signal_at,
          }
        : null,
      currentState: stateRow.current_state ?? null,
      currentStateStartedAt: stateRow.current_state_started_at ?? null,
      currentStateDurationSeconds,
      lastCompletedOnDurationSeconds:
        stateRow.last_completed_on_duration_seconds ?? null,
      lastCompletedOffDurationSeconds:
        stateRow.last_completed_off_duration_seconds ?? null,
      recentTransitions: recentTransitions.map((row) => ({
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationSeconds: row.duration_seconds,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Could not load dashboard data.',
    });
  }
});

app.get('/signals', async (req, res) => {
  try {
    const { deviceId, since } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: 'deviceId is required.',
      });
    }

    if (since) {
      const { data, error } = await supabase
        .from('signal_points')
        .select('device_id, triggered, value, timestamp')
        .eq('device_id', deviceId)
        .gt('timestamp', since)
        .order('timestamp', { ascending: true });

      if (error) {
        throw error;
      }

      return res.json((data ?? []).map(toPublicSignalPoint));
    }

    const limit = sanitizePositiveInt(
      req.query.limit,
      DEFAULT_DASHBOARD_LIMIT,
      MAX_DASHBOARD_LIMIT
    );

    const { data, error } = await supabase
      .from('signal_points')
      .select('device_id, triggered, value, timestamp')
      .eq('device_id', deviceId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return res.json((data ?? []).slice().reverse().map(toPublicSignalPoint));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Could not load signal history.',
    });
  }
});

app.get('/signals/summary', async (req, res) => {
  try {
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: 'deviceId is required.',
      });
    }

    const bucketCount = sanitizePositiveInt(
      req.query.bucketCount,
      DEFAULT_HISTORY_BUCKET_COUNT,
      MAX_HISTORY_BUCKET_COUNT
    );

    const [{ count, error: countError }, { data, error: rpcError }] =
      await Promise.all([
        supabase
          .from('signal_points')
          .select('*', { count: 'exact', head: true })
          .eq('device_id', deviceId),
        supabase.rpc('get_signal_summary', {
          p_device_id: deviceId,
          p_bucket_count: bucketCount,
        }),
      ]);

    if (countError) {
      throw countError;
    }

    if (rpcError) {
      throw rpcError;
    }

    const points = (data ?? []).map(toPublicSignalPoint);

    res.json({
      deviceId,
      totalPoints: count ?? 0,
      bucketCount,
      oldestTimestamp: points[0]?.timestamp ?? null,
      latestTimestamp: points[points.length - 1]?.timestamp ?? null,
      points,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Could not load signal summary.',
    });
  }
});

app.get('/signals/page', async (req, res) => {
  try {
    const { deviceId, before } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: 'deviceId is required.',
      });
    }

    const pageSize = sanitizePositiveInt(
      req.query.pageSize,
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE
    );

    let query = supabase
      .from('signal_points')
      .select('device_id, triggered, value, timestamp')
      .eq('device_id', deviceId)
      .order('timestamp', { ascending: false })
      .limit(pageSize + 1);

    if (before) {
      query = query.lt('timestamp', before);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    const hasMore = rows.length > pageSize;
    const visibleRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextBefore =
      visibleRows.length > 0
        ? visibleRows[visibleRows.length - 1].timestamp
        : null;

    res.json({
      deviceId,
      totalPoints: null,
      hasMore,
      nextBefore,
      readings: visibleRows.map(toPublicSignalPoint),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Could not load paged signal history.',
    });
  }
});

app.post('/signal', async (req, res) => {
  try {
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

    const normalizedPoints = sortSignalsAscending(
      rawPoints.map((point) =>
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
    );

    const dbPoints = normalizedPoints.map(toDbSignalPoint);

    const { error: insertSignalError } = await supabase
      .from('signal_points')
      .insert(dbPoints);

    if (insertSignalError) {
      throw insertSignalError;
    }

    let stateRow = await getDeviceStateRow(requestDeviceId);
    const existedAlready = Boolean(stateRow);

    if (!stateRow) {
      stateRow = {
        device_id: requestDeviceId,
        current_state: null,
        current_state_started_at: null,
        latest_signal_at: null,
        latest_signal_value: null,
        latest_signal_triggered: false,
        threshold_amps: ON_THRESHOLD_AMPS,
        last_completed_on_duration_seconds: null,
        last_completed_off_duration_seconds: null,
        updated_at: new Date().toISOString(),
      };
    }

    const transitionRows = [];

    for (const point of normalizedPoints) {
      const pointState = getPointState(point.value);

      if (!stateRow.current_state) {
        stateRow.current_state = pointState;
        stateRow.current_state_started_at = point.timestamp;
      } else if (pointState !== stateRow.current_state) {
        const durationSeconds = getDurationSeconds(
          stateRow.current_state_started_at,
          point.timestamp
        );

        transitionRows.push({
          device_id: requestDeviceId,
          state: stateRow.current_state,
          started_at: stateRow.current_state_started_at,
          ended_at: point.timestamp,
          duration_seconds: durationSeconds,
        });

        if (stateRow.current_state === 'ON') {
          stateRow.last_completed_on_duration_seconds = durationSeconds;
        } else {
          stateRow.last_completed_off_duration_seconds = durationSeconds;
        }

        stateRow.current_state = pointState;
        stateRow.current_state_started_at = point.timestamp;
      }

      stateRow.latest_signal_at = point.timestamp;
      stateRow.latest_signal_value = point.value;
      stateRow.latest_signal_triggered = point.triggered;
      stateRow.updated_at = new Date().toISOString();
    }

    if (transitionRows.length > 0) {
      const { error: insertTransitionError } = await supabase
        .from('state_transitions')
        .insert(transitionRows);

      if (insertTransitionError) {
        throw insertTransitionError;
      }
    }

    await saveDeviceStateRow(stateRow, existedAlready);

    let longOnAlertResult = null;

    try {
      longOnAlertResult = await evaluateAndSendLongOnAlert(
        requestDeviceId
      );
    } catch (alertError) {
      console.error(
        `Long ON alert evaluation failed for ${requestDeviceId}:`,
        alertError
      );
    }

    res.json({
      success: true,
      receivedCount: normalizedPoints.length,
      latest: normalizedPoints[normalizedPoints.length - 1],
      storedCount: null,
      longOnAlert: longOnAlertResult,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Could not store signal points.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
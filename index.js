const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let latestSignal = {
  deviceId: 'esp32-001',
  triggered: false,
  value: 0,
  timestamp: new Date().toISOString(),
};

app.get('/', (req, res) => {
  res.send('Backend is running 🚀');
});

app.get('/signal', (req, res) => {
  res.json(latestSignal);
});

app.post('/signal', (req, res) => {
  const { deviceId, triggered, value } = req.body;

  latestSignal = {
    deviceId: deviceId || 'esp32-001',
    triggered: triggered ?? false,
    value: value ?? 0,
    timestamp: new Date().toISOString(),
  };

  res.json({
    success: true,
    received: latestSignal,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
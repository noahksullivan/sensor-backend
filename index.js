const express = require('express');

const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
  res.send('Backend is running 🚀');
});

app.get('/data', (req, res) => {
  res.json({
    deviceId: 'device-001',
    timestamp: new Date().toISOString(),
    temperature: (65 + Math.random() * 15).toFixed(2),
    humidity: (30 + Math.random() * 30).toFixed(2),
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
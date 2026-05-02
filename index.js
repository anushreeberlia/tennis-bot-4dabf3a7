const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs').promises;
const { Expo } = require('expo-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';

const expo = new Expo();

app.use(cors());
app.use(express.json());

// Middleware for request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Initialize database
async function initDB() {
  try {
    await fs.access(DB_PATH);
  } catch {
    const initialData = {
      logs: [],
      pushTokens: [],
      isMonitoring: false,
      lastCheck: null
    };
    await fs.writeFile(DB_PATH, JSON.stringify(initialData, null, 2));
  }
}

async function readDB() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return { logs: [], pushTokens: [], isMonitoring: false, lastCheck: null };
  }
}

async function writeDB(data) {
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

// Mock function to check court availability (simulates API call to SF Rec & Parks)
async function checkCourtAvailability() {
  try {
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Mock availability data - in real implementation, this would call SF Rec API
    const isAvailable = Math.random() > 0.8; // 20% chance of availability
    const courts = [];
    
    if (isAvailable) {
      const courtCount = Math.floor(Math.random() * 3) + 1;
      for (let i = 0; i < courtCount; i++) {
        courts.push({
          id: `court_${i + 1}`,
          name: `Court ${i + 1}`,
          time: '5:30 PM',
          duration: '1.5 hours'
        });
      }
    }
    
    return { available: isAvailable, courts };
  } catch (error) {
    throw new Error('Failed to check court availability');
  }
}

async function sendPushNotifications(courts) {
  const db = await readDB();
  const messages = [];
  
  for (const pushToken of db.pushTokens) {
    if (!Expo.isExpoPushToken(pushToken)) continue;
    
    messages.push({
      to: pushToken,
      sound: 'default',
      title: '🎾 Tennis Court Available!',
      body: `${courts.length} court(s) available at Joe DiMaggio for Friday after 5 PM`,
      data: { courts }
    });
  }
  
  if (messages.length > 0) {
    const chunks = expo.chunkPushNotifications(messages);
    
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        console.error('Error sending push notifications:', error);
      }
    }
  }
}

async function logAvailabilityCheck(available, courts, error = null) {
  const db = await readDB();
  const log = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    available,
    courts: courts || [],
    error: error?.message || null
  };
  
  db.logs.unshift(log);
  db.logs = db.logs.slice(0, 100); // Keep only last 100 logs
  db.lastCheck = new Date().toISOString();
  
  await writeDB(db);
  return log;
}

// Schedule monitoring for Fridays after 5 PM
// Check every 15 minutes on Fridays between 5 PM and 10 PM
cron.schedule('*/15 17-22 * * 5', async () => {
  const db = await readDB();
  if (!db.isMonitoring) return;
  
  console.log('Checking court availability...');
  
  try {
    const result = await checkCourtAvailability();
    await logAvailabilityCheck(result.available, result.courts);
    
    if (result.available && result.courts.length > 0) {
      console.log(`Found ${result.courts.length} available court(s)! Sending notifications...`);
      await sendPushNotifications(result.courts);
    }
  } catch (error) {
    console.error('Error checking availability:', error);
    await logAvailabilityCheck(false, [], error);
  }
});

// Health check
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'SF Tennis Court Monitor',
    location: 'Joe DiMaggio Playground',
    timestamp: new Date().toISOString()
  });
});

// Get monitoring status and recent logs
app.get('/api/status', async (req, res) => {
  try {
    const db = await readDB();
    res.json({
      isMonitoring: db.isMonitoring,
      lastCheck: db.lastCheck,
      totalLogs: db.logs.length,
      recentLogs: db.logs.slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Toggle monitoring
app.post('/api/monitoring/toggle', async (req, res) => {
  try {
    const db = await readDB();
    db.isMonitoring = !db.isMonitoring;
    await writeDB(db);
    
    res.json({ isMonitoring: db.isMonitoring });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle monitoring' });
  }
});

// Manual availability check
app.post('/api/check', async (req, res) => {
  try {
    const result = await checkCourtAvailability();
    const log = await logAvailabilityCheck(result.available, result.courts);
    
    res.json({ ...result, log });
  } catch (error) {
    await logAvailabilityCheck(false, [], error);
    res.status(500).json({ error: error.message });
  }
});

// Get all logs
app.get('/api/logs', async (req, res) => {
  try {
    const db = await readDB();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const start = (page - 1) * limit;
    const end = start + limit;
    
    res.json({
      logs: db.logs.slice(start, end),
      total: db.logs.length,
      page,
      totalPages: Math.ceil(db.logs.length / limit)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// Register push token
app.post('/api/notifications/register', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token || !Expo.isExpoPushToken(token)) {
      return res.status(400).json({ error: 'Invalid push token' });
    }
    
    const db = await readDB();
    if (!db.pushTokens.includes(token)) {
      db.pushTokens.push(token);
      await writeDB(db);
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

// Test notification
app.post('/api/notifications/test', async (req, res) => {
  try {
    const testCourts = [{ id: 'test', name: 'Test Court', time: '5:30 PM', duration: '1.5 hours' }];
    await sendPushNotifications(testCourts);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// Initialize and start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🎾 Tennis Court Monitor server running on port ${PORT}`);
    console.log('📍 Monitoring Joe DiMaggio Playground tennis courts');
    console.log('🕐 Checking Fridays after 5 PM every 15 minutes');
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
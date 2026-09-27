const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000023206123';
const CLASS_ID = `${ISSUER_ID}.otacos_loyalty_card`;

// Neon PostgreSQL Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load Google Service Account Credentials
function getServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      if (creds.private_key) {
        creds.private_key = creds.private_key.replace(/\\n/g, '\n');
      }
      return creds;
    } catch (err) {
      console.error('Error parsing GOOGLE_SERVICE_ACCOUNT_KEY:', err);
      return null;
    }
  }
  try {
    return require(path.join(__dirname, 'service-account.json'));
  } catch (err) {
    console.error('service-account.json file not found locally.');
    return null;
  }
}

// Generate Google Wallet JWT Save Link with Class & Object Definitions
function generateGoogleWalletUrl(client) {
  const credentials = getServiceAccountCredentials();
  if (!credentials) return null;

  // Sanitize the phone number for the Object ID
  const cleanPhone = client.phone.replace(/[^a-zA-Z0-9_.-]/g, '');
  const objectId = `${ISSUER_ID}.${cleanPhone}`;

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    origins: ['https://pay.google.com'],
    typ: 'savetowallet',
    payload: {
      loyaltyObjects: [
        {
          id: objectId,
          classId: CLASS_ID, // Evaluates to '3388000000023206123.otacos_loyalty_card'
          state: 'ACTIVE',
          accountName: client.name || 'Client O\'Tacos',
          accountId: client.phone,
          // Explicit Barcode definition for QR Code
          barcode: {
            type: 'QR_CODE',
            value: client.phone,
            alternateText: client.phone
          },
          // Loyalty Points Display
          loyaltyPoints: {
            label: 'Points',
            balance: {
              string: String(client.points || 0)
            }
          }
        }
      ]
    }
  };

  try {
    const token = jwt.sign(claims, credentials.private_key, { algorithm: 'RS256' });
    return `https://pay.google.com/gp/v/save/${token}`;
  } catch (err) {
    console.error('Failed to sign Google Wallet JWT:', err);
    return null;
  }
}
// ================= CLEAN UI ROUTES =================

app.get('/client', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ================= DATABASE HEALTH CHECK =================

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS current_time, current_database() AS db_name;');
    res.json({
      status: 'Connected',
      database: result.rows[0].db_name,
      time: result.rows[0].current_time
    });
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({
      status: 'Disconnected',
      error: err.message
    });
  }
});

// ================= DATABASE API ROUTES =================

// 1. Get All Clients (For Admin Table from Neon DB)
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).json({ error: 'Database fetch failed' });
  }
});

// 2. Get Single Client (For Client Portal from Neon DB)
app.get('/api/client/:phone', async (req, res) => {
  const { phone } = req.params;

  if (!/^\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone number must be strictly 8 digits.' });
  }

  try {
    const result = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    const client = result.rows[0];
    const walletUrl = generateGoogleWalletUrl(client);
    res.json({ ...client, walletUrl });
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).json({ error: 'Database lookup failed' });
  }
});

// 3. Register New Client in Neon DB
app.post('/api/clients', async (req, res) => {
  const { phone, name } = req.body;

  if (!phone || !/^\d{8}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'Phone number must be strictly 8 digits.' });
  }

  const words = name ? name.trim().split(/\s+/) : [];
  if (words.length !== 3) {
    return res.status(400).json({ error: 'Client name must contain exactly 3 words.' });
  }

  try {
    const checkUser = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone.trim()]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'A client with this phone number already exists.' });
    }

    const insertResult = await pool.query(
      'INSERT INTO clients (phone, name, points) VALUES ($1, $2, $3) RETURNING *',
      [phone.trim(), name.trim(), 0]
    );

    const newClient = insertResult.rows[0];
    const walletUrl = generateGoogleWalletUrl(newClient);
    res.status(201).json({ ...newClient, walletUrl });
  } catch (err) {
    console.error('Database insert error:', err);
    res.status(500).json({ error: 'Failed to create client in database' });
  }
});

// 4. Update Points in Neon DB (Bounded 0-100)
app.post('/api/points', async (req, res) => {
  const { phone, delta } = req.body;

  try {
    const userResult = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found.' });
    }

    const client = userResult.rows[0];
    let updatedPoints = client.points + parseInt(delta, 10);
    if (updatedPoints < 0) updatedPoints = 0;
    if (updatedPoints > 100) updatedPoints = 100;

    const updateResult = await pool.query(
      'UPDATE clients SET points = $1 WHERE phone = $2 RETURNING *',
      [updatedPoints, phone]
    );

    const updatedClient = updateResult.rows[0];
    const walletUrl = generateGoogleWalletUrl(updatedClient);

    res.json({ success: true, points: updatedClient.points, walletUrl });
  } catch (err) {
    console.error('Database update error:', err);
    res.status(500).json({ error: 'Failed to update points in database' });
  }
});

app.listen(PORT, () => {
  console.log(`O'Tacos Loyalty Server running on port ${PORT}`);
});
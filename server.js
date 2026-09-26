const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000023206123';
const CLASS_ID = `${ISSUER_ID}.otacos_loyalty_card`;

// Neon PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load Service Account Credentials
function getServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (err) {
      console.error('Error parsing GOOGLE_SERVICE_ACCOUNT_KEY env variable:', err);
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

// Generate Signed JWT URL for Google Wallet
function generateGoogleWalletUrl(client) {
  const credentials = getServiceAccountCredentials();
  if (!credentials) return null;

  const objectId = `${ISSUER_ID}.${client.phone}`;
  const baseUrl = process.env.RENDER_EXTERNAL_HOSTNAME 
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` 
    : 'http://localhost:3000';

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    origins: [baseUrl],
    typ: 'savetowallet',
    payload: {
      loyaltyObjects: [
        {
          id: objectId,
          classId: CLASS_ID,
          state: 'ACTIVE',
          accountName: client.name,
          accountId: client.phone,
          barcode: {
            type: 'QR_CODE',
            value: client.phone,
            alternateText: client.phone
          },
          loyaltyPoints: {
            label: 'Points',
            balance: {
              string: client.points.toString()
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

// ================= CLEAN URL ROUTES (Without .html) =================

app.get('/client', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ================= POSTGRESQL API ROUTES =================

// 1. Get All Clients (For Admin Dashboard from Neon)
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).json({ error: 'Database fetch failed' });
  }
});

// 2. Get Single Client Details & Wallet Link (For Client App from Neon)
app.get('/api/client/:phone', async (req, res) => {
  const { phone } = req.params;

  if (!/^\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone number must be exactly 8 digits.' });
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

// 3. Register / Create New Client in Neon (8-digit phone & 3-word name validation)
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
      return res.status(400).json({ error: 'Client already exists.' });
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

// 4. Adjust Client Points in Neon (0-100 Range Limit)
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

// Start Server
app.listen(PORT, () => {
  console.log(`O'Tacos Loyalty Server running on port ${PORT}`);
});
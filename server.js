const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000023206123';
const CLASS_ID = `${ISSUER_ID}.otacos_loyalty_card`;

app.use(express.json());
// Serves static files (client.html, otacoslogo.png, etc.) from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database
let clients = [
  { phone: '12345678', name: 'Samiya Ahmed Loyalty', points: 10 }
];

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

// ================= API ROUTES =================

app.get('/api/clients', (req, res) => {
  res.json(clients);
});

app.get('/api/client/:phone', (req, res) => {
  const { phone } = req.params;

  if (!/^\d{8}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone number must be exactly 8 digits.' });
  }

  const client = clients.find(c => c.phone === phone);
  if (!client) {
    return res.status(404).json({ error: 'Client not found.' });
  }

  const walletUrl = generateGoogleWalletUrl(client);
  res.json({ ...client, walletUrl });
});

app.post('/api/clients', (req, res) => {
  const { phone, name } = req.body;

  if (!phone || !/^\d{8}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'Phone number must be strictly 8 digits.' });
  }

  const words = name ? name.trim().split(/\s+/) : [];
  if (words.length !== 3) {
    return res.status(400).json({ error: 'Client name must contain exactly 3 words.' });
  }

  const existingClient = clients.find(c => c.phone === phone.trim());
  if (existingClient) {
    return res.status(400).json({ error: 'Client already exists.' });
  }

  const newClient = { phone: phone.trim(), name: name.trim(), points: 0 };
  clients.push(newClient);
  const walletUrl = generateGoogleWalletUrl(newClient);
  res.status(201).json({ ...newClient, walletUrl });
});

app.post('/api/points', (req, res) => {
  const { phone, delta } = req.body;

  const client = clients.find(c => c.phone === phone);
  if (!client) {
    return res.status(404).json({ error: 'Client not found.' });
  }

  let updatedPoints = client.points + parseInt(delta, 10);
  if (updatedPoints < 0) updatedPoints = 0;
  if (updatedPoints > 100) updatedPoints = 100;

  client.points = updatedPoints;
  const walletUrl = generateGoogleWalletUrl(client);

  res.json({ success: true, points: client.points, walletUrl });
});

// Route redirect for /client
app.get('/client', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

app.listen(PORT, () => {
  console.log(`O'Tacos Loyalty Server running on port ${PORT}`);
});
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure Neon PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Admin Password Config (Change default password here or via ENV)
const MANAGER_PIN = process.env.MANAGER_PIN || '1234';

// Helper to validate 8-digit phone numbers
const isValidPhone = (phone) => /^\d{8}$/.test(phone);

// API 1: Register New Client
app.post('/api/clients/register', async (req, res) => {
  const { phone } = req.body;
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Le numéro doit comporter 8 chiffres.' });

  try {
    const existing = await pool.query('SELECT phone FROM clients WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Client déjà existant.' });
    }
    const result = await pool.query('INSERT INTO clients (phone, points) VALUES ($1, 0) RETURNING *', [phone]);
    res.json({ success: true, client: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 2: Get Client Details
app.get('/api/clients/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const result = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Client non trouvé.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 3: Get All Clients List
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 4: Add Points (Supervisor & Manager)
app.post('/api/clients/add-points', async (req, res) => {
  const { phone, pointsToAdd } = req.body;
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Numéro invalide.' });

  try {
    const result = await pool.query(
      'UPDATE clients SET points = points + $1 WHERE phone = $2 RETURNING *',
      [pointsToAdd, phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Client introuvable.' });
    res.json({ success: true, client: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 5: Remove Points (Manager Only + PIN protected)
app.post('/api/clients/remove-points', async (req, res) => {
  const { phone, pointsToRemove, pin } = req.body;
  if (pin !== MANAGER_PIN) return res.status(403).json({ error: 'Code PIN Manager incorrect.' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Numéro invalide.' });

  try {
    const result = await pool.query(
      'UPDATE clients SET points = GREATEST(0, points - $1) WHERE phone = $2 RETURNING *',
      [pointsToRemove, phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Client introuvable.' });
    res.json({ success: true, client: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 6: Redeem Reward (Convert Points - Manager Only + PIN)
app.post('/api/clients/redeem', async (req, res) => {
  const { phone, pin } = req.body;
  if (pin !== MANAGER_PIN) return res.status(403).json({ error: 'Code PIN Manager incorrect.' });

  try {
    const clientRes = await pool.query('SELECT points FROM clients WHERE phone = $1', [phone]);
    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client non trouvé.' });

    const currentPoints = clientRes.rows[0].points;
    if (currentPoints < 100) {
      const missing = 100 - currentPoints;
      return res.status(400).json({ error: `Désolé, il vous manque ${missing} points.` });
    }

    const updated = await pool.query(
      'UPDATE clients SET points = points - 100 WHERE phone = $1 RETURNING *',
      [phone]
    );
    res.json({ success: true, message: 'Récompense convertie avec succès !', client: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
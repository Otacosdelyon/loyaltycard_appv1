require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Database Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MANAGER_PIN = process.env.MANAGER_PIN || '1234';

// Helper: Validate 8-digit phone numbers
const isValidPhone = (phone) => /^\d{8}$/.test(phone);

// Helper: Validate full name with at least 3 words (e.g., "Ahmed Ali Umar")
const isValidName = (name) => {
  if (!name) return false;
  const words = name.trim().split(/\s+/);
  return words.length >= 3;
};

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------

// 1. Manager Authentication / Login API
app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body;
  if (pin === MANAGER_PIN) {
    res.json({ success: true, message: 'Connexion réussie !' });
  } else {
    res.status(401).json({ error: 'Code PIN Manager incorrect.' });
  }
});

// 2. Register New Client (Enforces 8-digit unique phone & min 3 words name)
app.post('/api/clients/register', async (req, res) => {
  const { phone, name } = req.body;

  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: 'Le numéro doit comporter exactement 8 chiffres.' });
  }

  if (!isValidName(name)) {
    return res.status(400).json({ error: 'Veuillez saisir un nom complet contenant au moins 3 mots (ex: Ahmed Ali Umar).' });
  }

  try {
    const existing = await pool.query('SELECT phone FROM clients WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Ce numéro de téléphone est déjà enregistré.' });
    }

    const result = await pool.query(
      'INSERT INTO clients (phone, name, points) VALUES ($1, $2, 0) RETURNING *',
      [phone, name.trim()]
    );
    res.json({ success: true, client: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Single Client Details by Phone
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

// 4. Get All Clients List (For Admin Block 3)
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Add Points (Allowed for both Supervisor & Manager)
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

// 6. Remove Points (Manager Only — Requires Valid PIN)
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

// 7. Redeem Points ("Convertir mes points" — Allowed for both roles)
app.post('/api/clients/redeem', async (req, res) => {
  const { phone } = req.body;

  try {
    const clientRes = await pool.query('SELECT points FROM clients WHERE phone = $1', [phone]);
    if (clientRes.rows.length === 0) return res.status(404).json({ error: 'Client non trouvé.' });

    const currentPoints = clientRes.rows[0].points;
    if (currentPoints < 100) {
      const missing = 100 - currentPoints;
      return res.status(400).json({ error: `Désolé, vous avez ${missing} Points manquant.` });
    }

    const updated = await pool.query(
      'UPDATE clients SET points = points - 100 WHERE phone = $1 RETURNING *',
      [phone]
    );
    res.json({ success: true, message: 'Félicitations! Points convertis avec succès.', client: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
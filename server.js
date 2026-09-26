const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS clients (
                phone VARCHAR(20) PRIMARY KEY,
                name VARCHAR(100),
                points INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Migration: Add name column if upgrading from older schema
        await pool.query(`
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS name VARCHAR(100);
        `);
        console.log('Neon PostgreSQL database initialized with name support.');
    } catch (err) {
        console.error('Database initialization error:', err);
    }
}

initDb();

// Serve Static Pages
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));

// GET all clients
app.get('/api/clients', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT phone, name, points FROM clients ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch clients' });
    }
});

// GET specific client
app.get('/api/clients/:phone', async (req, res) => {
    const { phone } = req.params;
    try {
        const { rows } = await pool.query('SELECT phone, name, points FROM clients WHERE phone = $1', [phone]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch client' });
    }
});

// POST Register new client or update points
app.post('/api/clients', async (req, res) => {
    const { phone, name } = req.body;
    if (!phone || !name) {
        return res.status(400).json({ error: 'Le numéro et le nom complet (3 mots) sont requis' });
    }

    try {
        const check = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: 'Ce numéro existe déjà dans le système' });
        }

        const insert = await pool.query(
            'INSERT INTO clients (phone, name, points) VALUES ($1, $2, 0) RETURNING phone, name, points',
            [phone, name.trim()]
        );
        res.json(insert.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Erreur lors de la création du compte' });
    }
});

// POST Add or Deduct Points
app.post('/api/points', async (req, res) => {
    const { phone, delta } = req.body;
    if (!phone || typeof delta !== 'number') {
        return res.status(400).json({ error: 'Numéro et valeur requis' });
    }

    try {
        const clientRes = await pool.query('SELECT points, name FROM clients WHERE phone = $1', [phone]);
        if (clientRes.rows.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        const currentPoints = clientRes.rows[0].points;
        const updatedPoints = Math.min(100, Math.max(0, currentPoints + delta));

        const updateRes = await pool.query(
            'UPDATE clients SET points = $1 WHERE phone = $2 RETURNING phone, name, points',
            [updatedPoints, phone]
        );

        res.json(updateRes.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Erreur lors de la mise à jour des points' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
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
        await pool.query(`
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS name VARCHAR(100);
        `);
        console.log('Neon PostgreSQL database initialized.');
    } catch (err) {
        console.error('Database initialization error:', err);
    }
}

initDb();

// Serve Pages
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));

// GET all clients
app.get('/api/clients', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT phone, name, points FROM clients ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Erreur serveur lors de la récupération' });
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
        res.status(500).json({ error: 'Erreur de recherche client' });
    }
});

// POST Register new client with mandatory 3-part name check
app.post('/api/clients', async (req, res) => {
    const { phone, name } = req.body;

    if (!phone || !name) {
        return res.status(400).json({ error: 'Le numéro et le nom sont requis.' });
    }

    const nameParts = name.trim().split(/\s+/);

    if (nameParts.length < 3) {
        return res.status(400).json({ 
            error: 'Le nom doit obligatoirement comporter 3 mots (ex: Ahmed Ali Umar).' 
        });
    }

    try {
        const check = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: 'Ce numéro existe déjà.' });
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

// POST Modify points
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

// POST Redeem Points (Resets points to 0)
app.post('/api/redeem', async (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Numéro de téléphone requis' });
    }

    try {
        const clientRes = await pool.query('SELECT points, name FROM clients WHERE phone = $1', [phone]);
        if (clientRes.rows.length === 0) {
            return res.status(404).json({ error: 'Client non trouvé' });
        }

        const updateRes = await pool.query(
            'UPDATE clients SET points = 0 WHERE phone = $1 RETURNING phone, name, points',
            [phone]
        );

        res.json({ message: 'Points réinitialisés à 0', client: updateRes.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Erreur lors de la réinitialisation des points' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
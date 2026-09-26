const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool configured for Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Clients Table
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS clients (
                phone VARCHAR(15) PRIMARY KEY,
                points INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Neon PostgreSQL database initialized.');
    } catch (err) {
        console.error('Database initialization error:', err);
    }
}
initDb();

// 1. Fetch All Clients
app.get('/api/clients', async (req, res) => {
    try {
        const result = await pool.query('SELECT phone, points FROM clients ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch clients from database' });
    }
});

// 2. Register/Check Client Existence
app.post('/api/clients', async (req, res) => {
    const { phone } = req.body;
    if (!phone || !/^77\d{6}$/.test(phone)) {
        return res.status(400).json({ error: 'Invalid phone format (Must be 8 digits starting with 77)' });
    }

    try {
        await pool.query(
            'INSERT INTO clients (phone, points) VALUES ($1, 0) ON CONFLICT (phone) DO NOTHING',
            [phone]
        );
        res.json({ message: 'Client ready' });
    } catch (err) {
        console.error('Insert error:', err);
        res.status(500).json({ error: 'Failed to register client' });
    }
});

// 3. Add or Deduct Points
app.post('/api/points', async (req, res) => {
    const { phone, delta } = req.body;
    if (!phone || typeof delta !== 'number') {
        return res.status(400).json({ error: 'Invalid parameters' });
    }

    try {
        // Fetch current points
        const clientRes = await pool.query('SELECT points FROM clients WHERE phone = $1', [phone]);
        if (clientRes.rows.length === 0) {
            return res.status(404).json({ error: 'Client not found' });
        }

        const currentPoints = clientRes.rows[0].points;
        const updatedPoints = Math.max(0, currentPoints + delta); // Prevent points from falling below 0

        const updateRes = await pool.query(
            'UPDATE clients SET points = $1 WHERE phone = $2 RETURNING points',
            [updatedPoints, phone]
        );

        res.json({ phone, points: updateRes.rows[0].points });
    } catch (err) {
        console.error('Point update error:', err);
        res.status(500).json({ error: 'Failed to update points' });
    }
});

// HTML Page Routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/client', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
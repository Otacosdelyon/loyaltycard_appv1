const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Neon PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Database Initialization
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

// Routes

// Serve Admin View
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve Client View
app.get('/client', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// GET all clients for directory table
app.get('/api/clients', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT phone, points FROM clients ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        console.error('Fetch clients error:', err);
        res.status(500).json({ error: 'Failed to fetch clients' });
    }
});

// GET specific client points
app.get('/api/clients/:phone', async (req, res) => {
    const { phone } = req.params;
    try {
        const { rows } = await pool.query('SELECT phone, points FROM clients WHERE phone = $1', [phone]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Client not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Fetch client error:', err);
        res.status(500).json({ error: 'Failed to fetch client' });
    }
});

// POST register new client or add/deduct points (+10 Tacos, +5 Burger/Panini, +10 Breakfast, or negative values)
app.post('/api/points', async (req, res) => {
    const { phone, delta } = req.body;
    
    if (!phone || typeof delta !== 'number') {
        return res.status(400).json({ error: 'Invalid parameters: phone and numeric delta are required' });
    }

    try {
        // Check if client exists
        const clientRes = await pool.query('SELECT points FROM clients WHERE phone = $1', [phone]);
        
        if (clientRes.rows.length === 0) {
            // New client registration with initial points (Capped 0 to 100)
            const initialPoints = Math.min(100, Math.max(0, delta));
            const insertRes = await pool.query(
                'INSERT INTO clients (phone, points) VALUES ($1, $2) RETURNING phone, points',
                [phone, initialPoints]
            );
            return res.json(insertRes.rows[0]);
        }

        // Existing client update (Capped minimum 0, maximum 100)
        const currentPoints = clientRes.rows[0].points;
        const updatedPoints = Math.min(100, Math.max(0, currentPoints + delta));

        const updateRes = await pool.query(
            'UPDATE clients SET points = $1 WHERE phone = $2 RETURNING phone, points',
            [updatedPoints, phone]
        );

        res.json(updateRes.rows[0]);
    } catch (err) {
        console.error('Point update error:', err);
        res.status(500).json({ error: 'Failed to update points' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
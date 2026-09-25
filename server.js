const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
const db = new sqlite3.Database('./loyalty.db', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite database (loyalty.db).');
});

// Create Clients Table
db.run(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// API Routes

// Get all clients
app.get('/api/clients', (req, res) => {
  db.all('SELECT * FROM clients ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get or Create Client by Phone
app.post('/api/clients', (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

  db.get('SELECT * FROM clients WHERE phone = ?', [phone], (err, client) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (client) {
      return res.json(client);
    } else {
      const clientName = name || `Customer (${phone.slice(-4)})`;
      db.run('INSERT INTO clients (phone, name, points) VALUES (?, ?, 0)', [phone, clientName], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, phone, name: clientName, points: 0 });
      });
    }
  });
});

// Update Client Points
app.post('/api/points', (req, res) => {
  const { phone, delta } = req.body; // delta can be positive or negative
  if (!phone || delta === undefined) {
    return res.status(400).json({ error: 'Phone and delta points are required.' });
  }

  db.get('SELECT * FROM clients WHERE phone = ?', [phone], (err, client) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!client) return res.status(404).json({ error: 'Client not found.' });

    const newPoints = Math.max(0, client.points + parseInt(delta));
    
    db.run('UPDATE clients SET points = ? WHERE phone = ?', [newPoints, phone], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, phone, points: newPoints });
    });
  });
});

// Serve HTML Routes
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/', (req, res) => res.redirect('/client'));

// Start Server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Client Portal: http://localhost:${PORT}/client`);
  console.log(`Admin Dashboard: http://localhost:${PORT}/admin`);
});
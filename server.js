require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const db = require('./database');
const path = require('path');

// --- Safe DB Migration: add columns if they don't exist ---
const migrateColumns = [
    "ALTER TABLE orders ADD COLUMN paymentMethod TEXT",
    "ALTER TABLE orders ADD COLUMN customerName TEXT",
    "ALTER TABLE orders ADD COLUMN customerPhone TEXT",
    "ALTER TABLE orders ADD COLUMN customerAddress TEXT"
];
migrateColumns.forEach(sql => {
    db.run(sql, err => {
        // Ignore "duplicate column" errors — means column already exists
        if (err && !err.message.includes('duplicate column')) {
            console.error('Migration error:', err.message);
        }
    });
});


// HTTP GET helper using built-in https
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: headers
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: res.statusCode < 400, statusCode: res.statusCode, json: () => parsed });
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const app = express();
const port = process.env.PORT || 3000;
const CLIENT_ID = '567862328628-6qmt5fjq2hd0nfr2m2h2pbobks0nfbv2.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_here'; // In production, use a strong secret

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serve static files from the app directory

// --- Authentication Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- Endpoints ---

// Verify Google Access Token (token flow) and return app JWT
app.post('/api/auth/google-token', async (req, res) => {
    try {
        const { accessToken } = req.body;
        if (!accessToken) return res.status(400).json({ error: 'Missing accessToken' });

        // Fetch user info from Google using the access token
        const gRes = await httpsGet('https://www.googleapis.com/oauth2/v3/userinfo', {
            'Authorization': 'Bearer ' + accessToken
        });
        console.log('Google userinfo status:', gRes.ok);
        if (!gRes.ok) return res.status(401).json({ error: 'Invalid Google token' });

        const profile = gRes.json();
        console.log('Google profile:', profile?.email, 'sub:', profile?.sub);
        const { sub, email, name, picture } = profile;
        if (!email) return res.status(401).json({ error: 'No email from Google' });

        // Always use Google's sub as the user ID for consistency
        const userId = sub || email;

        // Upsert user
        db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            const user = { id: userId, email, name, picture };
            if (row) {
                db.run('UPDATE users SET name = ?, picture = ? WHERE email = ?', [name, picture, email]);
            } else {
                db.run('INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)', [userId, email, name, picture]);
            }
            const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
            console.log('JWT issued for userId:', userId);
            res.json({ token, user });
        });
    } catch (error) {
        console.error('Google token auth error:', error);
        res.status(401).json({ error: 'Auth failed' });
    }
});

// Verify Google Token and Login/Signup
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ error: 'Missing credential' });
        }

        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { sub, email, name, picture } = payload;

        // Upsert user in SQLite
        db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            const user = { id: sub, email, name, picture };

            if (row) {
                // Update existing
                db.run('UPDATE users SET name = ?, picture = ? WHERE email = ?', [name, picture, email]);
            } else {
                // Insert new
                db.run('INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)', [sub, email, name, picture]);
            }

            // Generate App JWT
            const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
            res.json({ token, user });
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(401).json({ error: 'Invalid Google token' });
    }
});

// Get Orders for authenticated User
app.get('/api/orders', authenticateToken, (req, res) => {
    const userId = req.user.id;
    console.log('GET /api/orders — userId:', userId);
    db.all('SELECT * FROM orders WHERE userId = ? ORDER BY created_at DESC', [userId], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to retrieve orders' });
        }
        // Rename 'id' back to 'orderId' for frontend compatibility
        const formattedOrders = rows.map(row => ({
            ...row,
            orderId: row.id
        }));
        res.json(formattedOrders);
    });
});

// Create a new Order
app.post('/api/orders', authenticateToken, (req, res) => {
    const userId = req.user.id;
    console.log('POST /api/orders — userId:', userId, 'body:', req.body);
    const { qty, size, unitPriceCents, itemName, itemCode, paymentMethod, customerName, customerPhone, customerAddress } = req.body;

    if (!qty || !unitPriceCents) {
        return res.status(400).json({ error: 'Missing order details' });
    }

    const PRODUCT_NAME = itemName || "T-Shirt";
    const PRODUCT_CODE = itemCode || "RT-901729";
    const TAX_RATE_BP = 1000; // 10%
    const SHIPPING_CENTS = 499;

    const validQty = Math.max(1, parseInt(qty, 10));
    const subtotal = unitPriceCents * validQty;
    const tax = Math.round(subtotal * (TAX_RATE_BP / 10000));
    const ship = subtotal > 0 ? SHIPPING_CENTS : 0;
    const total = subtotal + tax + ship;

    // Generate an ID similar to frontend uid()
    const orderId = "RT-" + Math.floor(100000 + Math.random() * 900000);

    const insertQuery = `
    INSERT INTO orders 
    (id, userId, status, itemName, itemCode, size, qty, unitPriceCents, subtotalCents, taxCents, shippingCents, totalCents, paymentMethod, customerName, customerPhone, customerAddress)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

    db.run(insertQuery, [orderId, userId, 'Placed', PRODUCT_NAME, PRODUCT_CODE, size || 'M', validQty, unitPriceCents, subtotal, tax, ship, total, paymentMethod || 'COD', customerName || '', customerPhone || '', customerAddress || ''], function (err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to save order' });
        }

        // Fetch and return the newly created order
        db.get('SELECT * FROM orders WHERE id = ?', [orderId], (err, row) => {
            if (err || !row) {
                return res.status(500).json({ error: 'Order saved but failed to retrieve' });
            }
            res.status(201).json({ ...row, orderId: row.id, createdAt: row.created_at });
        });
    });
});

// --- Admin Auth Middleware ---
// Uses a separate secret token (set ADMIN_SECRET in .env), NOT a user JWT
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'rt-admin-secret-change-me';

const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    if (token !== ADMIN_SECRET) return res.sendStatus(403);
    next();
};

// --- Admin Endpoints ---

// GET all orders (admin only) with joined user info
app.get('/api/admin/orders', authenticateAdmin, (req, res) => {
    const query = `
        SELECT o.*, u.name AS googleName, u.email AS googleEmail
        FROM orders o
        LEFT JOIN users u ON o.userId = u.id
        ORDER BY o.created_at DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('Admin GET orders error:', err);
            return res.status(500).json({ error: 'Failed to retrieve orders' });
        }
        const formatted = rows.map(row => ({
            id:             row.id,
            status:         row.status,
            date:           row.created_at,
            total:          Math.round((row.totalCents || 0) / 100),
            totalCents:     row.totalCents,
            itemName:       row.itemName,
            itemCode:       row.itemCode,
            size:           row.size,
            qty:            row.qty,
            paymentMethod:  row.paymentMethod || '—',
            unitPriceCents: row.unitPriceCents,
            subtotalCents:  row.subtotalCents,
            taxCents:       row.taxCents,
            shippingCents:  row.shippingCents,
            customer: {
                // customerName/Phone/Address saved on the order at checkout
                name:    row.customerName  || row.googleName  || 'Unknown',
                email:   row.googleEmail   || '—',
                phone:   row.customerPhone || '—',
                address: row.customerAddress || '—'
            },
            address: row.customerAddress || '—',
            items: [{
                name:  row.itemName || 'Item',
                emoji: '📦',
                qty:   row.qty || 1,
                price: Math.round((row.unitPriceCents || 0) / 100),
                total: Math.round((row.subtotalCents  || 0) / 100)
            }]
        }));
        res.json({ orders: formatted });
    });
});

// PATCH order status (admin only)
app.patch('/api/admin/orders/:id/status', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const VALID = ['Placed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
    if (!VALID.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID.join(', ')}` });
    }

    db.run('UPDATE orders SET status = ? WHERE id = ?', [status, id], function(err) {
        if (err) {
            console.error('Admin PATCH status error:', err);
            return res.status(500).json({ error: 'Failed to update status' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        console.log(`Admin updated order ${id} → ${status}`);
        res.json({ success: true, id, status });
    });
});

// GET single order (admin) – used by customer-facing tracker to check real status
app.get('/api/orders/:id/track', (req, res) => {
    const { id } = req.params;
    db.get('SELECT id, status, created_at, itemName, totalCents FROM orders WHERE id = ?', [id], (err, row) => {
        if (err)  return res.status(500).json({ error: 'DB error' });
        if (!row) return res.status(404).json({ error: 'Order not found' });
        res.json({
            orderId: row.id,
            status:  row.status,
            date:    row.created_at,
            item:    row.itemName,
            total:   Math.round((row.totalCents || 0) / 100)
        });
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log(`Admin secret: set ADMIN_SECRET in your .env file`);
});

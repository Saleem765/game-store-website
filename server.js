// server.js

// Import required modules
const express = require('express');
const sql = require('mssql');
const path = require('path');
const bcrypt = require('bcryptjs');
const dbConfig = require('./dbConfig');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid'); // Import UUID library
const app = express();
const port = process.env.PORT || 3000;

// Ensure the 'uploads' directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Uploads directory created.');
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2 * 1024 * 1024  // 2MB
  }
});

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Keep a reference to the SQL connection pool
let pool;

// Connect to SQL Server database
sql.connect(dbConfig)
  .then(p => {
    pool = p;
    console.log('Connected to SQL Server database.');
  })
  .catch(err => {
    console.error('SQL Connection Failed:', err);
    process.exit(1);
  });

// Middleware to validate admin role
function validateAdmin(req, res, next) {
  const role = req.headers.role;
  if (role !== 'admin') {
    console.error('Access denied: Admins only.');
    return res.status(403).json({ success: false, message: 'Access denied: Admins only.' });
  }
  next();
}

// API Endpoints

// Fetch all games
app.get('/api/games', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT game_id, title, description, price, genre, platform, image
      FROM games
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error('Error fetching games:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch all users (Admin only)
app.get('/api/users', validateAdmin, async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT u.username, u.email, r.role_name
      FROM users u
      JOIN user_roles r ON u.role_id = r.role_id
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch users.' });
  }
});

// Add a new game (Admin only)
// Add logging to capture request details
const activeRequests = new Set();

app.post('/api/games', validateAdmin, upload.single('image'), async (req, res) => {
  const requestId = req.headers['x-request-id'] || uuidv4();

  // Check for duplicate request
  if (activeRequests.has(requestId)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Duplicate request detected.' 
    });
  }

  activeRequests.add(requestId);

  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const { title, description, price, genre, platform } = req.body;
    const image = req.file ? req.file.filename : null;

    if (!title || !description || !price || !genre || !platform || !image) {
      await transaction.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required, including an image.' 
      });
    }

    // Create a new request for each query
    const checkRequest = new sql.Request(transaction);
    const checkResult = await checkRequest
      .input('title', sql.VarChar(100), title)
      .query('SELECT 1 FROM games WHERE title = @title');

    if (checkResult.recordset.length > 0) {
      await transaction.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Game with this title already exists.' 
      });
    }

    const insertRequest = new sql.Request(transaction);
    await insertRequest
      .input('title', sql.VarChar(100), title)
      .input('description', sql.Text, description)
      .input('price', sql.Decimal(10, 2), price)
      .input('genre', sql.VarChar(50), genre)
      .input('platform', sql.VarChar(50), platform)
      .input('image', sql.VarChar(255), image)
      .query(`
        INSERT INTO games (title, description, price, genre, platform, image)
        VALUES (@title, @description, @price, @genre, @platform, @image)
      `);

    await transaction.commit();
    res.json({ success: true, message: 'Game added successfully.' });
  } catch (err) {
    await transaction.rollback();
    console.error(`[${requestId}] Error adding game:`, err);
    res.status(500).json({ success: false, message: 'Failed to add game.' });
  } finally {
    // Clean up
    activeRequests.delete(requestId);
  }
});

// Update a game (Admin only)
app.put('/api/games/:id', validateAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, price, description } = req.body;

  if (!title || !price || !description) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }

  try {
    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('title', sql.NVarChar, title)
      .input('price', sql.Decimal(10, 2), price)
      .input('description', sql.NVarChar, description)
      .query(`
        UPDATE games
        SET title = @title, price = @price, description = @description
        WHERE game_id = @id
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: 'Game not found.' });
    }

    res.json({ success: true, message: 'Game updated successfully.' });
  } catch (err) {
    console.error('Error updating game:', err);
    res.status(500).json({ success: false, message: 'Failed to update game.' });
  }
});

// Delete a game (Admin only)
app.delete('/api/games/:id', validateAdmin, async (req, res) => {
  const { id } = req.params;
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // Delete related records in order_items
    const deleteOrderItemsRequest = new sql.Request(transaction);
    await deleteOrderItemsRequest
      .input('game_id', sql.Int, id)
      .query('DELETE FROM order_items WHERE game_id = @game_id');

    // Delete the game
    const deleteGameRequest = new sql.Request(transaction);
    const result = await deleteGameRequest
      .input('game_id', sql.Int, id)
      .query('DELETE FROM games WHERE game_id = @game_id');

    if (result.rowsAffected[0] === 0) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Game not found.' });
    }

    await transaction.commit();
    res.json({ success: true, message: 'Game deleted successfully.' });
  } catch (err) {
    await transaction.rollback();
    console.error('Error deleting game:', err);
    res.status(500).json({ success: false, message: 'Failed to delete game.' });
  }
});

// Delete a user (Admin only)
app.delete('/api/users/:username', validateAdmin, async (req, res) => {
  const { username } = req.params;

  try {
    const result = await pool.request()
      .input('username', sql.VarChar(50), username)
      .query('DELETE FROM users WHERE username = @username');

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ success: false, message: 'Failed to delete user.' });
  }
});

// Checkout / Create Order
app.post('/api/checkout', async (req, res) => {
  const { items, totalAmount, paymentMethodId, userId } = req.body;
  const transaction = new sql.Transaction(pool);

  // Debugging logs for checkout endpoint
  console.log('Checkout request received:', req.body);

  if (!items || !totalAmount || !paymentMethodId) {
    console.error('Missing required fields:', { items, totalAmount, paymentMethodId });
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  try {
    await transaction.begin();
    const tr = transaction.request();

    // Validate game IDs before proceeding
    const gameIds = items.map(item => item.game_id);
    const gameCheckResult = await pool.request()
      .query(`SELECT game_id FROM games WHERE game_id IN (${gameIds.join(',')})`);

    // Add debugging logs for better traceability
    console.log('Validated game IDs:', gameCheckResult.recordset.map(row => row.game_id));

    // Ensure all game IDs are valid
    if (gameCheckResult.recordset.length !== gameIds.length) {
      console.error('Invalid game IDs provided:', gameIds);
      return res.status(400).json({ success: false, message: 'One or more game IDs are invalid.' });
    }

    // 1) Insert into orders
    const orderResult = await tr
      .input('user_id', sql.Int, userId || null)
      .input('total', sql.Decimal(10, 2), totalAmount)
      .input('order_status_id', sql.Int, 1)
      .query(`
        INSERT INTO orders (user_id, total_amount, status_id)
        VALUES (@user_id, @total, @order_status_id);
        SELECT SCOPE_IDENTITY() AS orderId;
      `);
    const orderId = orderResult.recordset[0].orderId;

    // 2) Insert order_items
    for (let item of items) {
      await tr
        .input('order_id_item', sql.Int, orderId)
        .input('game_id', sql.Int, item.game_id)
        .input('quantity', sql.Int, item.quantity)
        .input('price', sql.Decimal(10, 2), item.price)
        .query(`
          INSERT INTO order_items (order_id, game_id, quantity, price)
          VALUES (@order_id_item, @game_id, @quantity, @price);
        `);
    }

    // 3) Insert payment record
    await tr
      .input('order_id_payment', sql.Int, orderId)
      .input('payment_status_id', sql.Int, 1)
      .input('method_id', sql.Int, paymentMethodId)
      .query(`
        INSERT INTO payments (order_id, status_id, method_id)
        VALUES (@order_id_payment, @payment_status_id, @method_id);
      `);

    await transaction.commit();
    res.json({ success: true, orderId });
  } catch (err) {
    await transaction.rollback();
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch all orders (Admin only)
app.get('/api/orders', validateAdmin, async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT 
        o.order_id,
        o.order_date,
        o.total_amount,
        os.status_name AS order_status,
        u.username AS customer_name,
        oi.order_item_id,
        ISNULL(g.title, 'Deleted Game') AS game_title, -- Handle deleted games
        oi.quantity,
        oi.price
      FROM orders o
      LEFT JOIN order_status os ON o.status_id = os.status_id
      LEFT JOIN users u ON o.user_id = u.user_id
      LEFT JOIN order_items oi ON o.order_id = oi.order_id
      LEFT JOIN games g ON oi.game_id = g.game_id
      ORDER BY o.order_date DESC
    `);
    res.json(result.recordset || []);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch orders.' });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { role, email, password } = req.body;

  try {
    const result = await pool.request()
      .input('email', sql.VarChar(100), email)
      .query(`
        SELECT u.user_id, u.username, u.password, r.role_id
        FROM users u
        JOIN user_roles r ON u.role_id = r.role_id
        WHERE u.email = @email
      `);
      
    if (result.recordset.length === 0) {
      return res.json({ success: false, message: 'Invalid email or password.' });
    }

    const user = result.recordset[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.json({ success: false, message: 'Invalid email or password.' });
    }

    const roleName = user.role_id === 2 ? 'admin' : 'customer';
    if (roleName !== role.toLowerCase()) {
      return res.json({ success: false, message: `Access denied: not a ${role}.` });
    }

    res.json({ success: true, userType: roleName, userId: user.user_id });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Register endpoint
app.post('/api/register', async (req, res) => {
  const { username, email, password, role } = req.body;

  if (!username || !email || !password || !role) {
    return res.json({ success: false, message: 'All fields are required.' });
  }

  try {
    // Check email uniqueness
    const check = await pool.request()
      .input('email', sql.VarChar(100), email)
      .query('SELECT 1 FROM users WHERE email = @email');
      
    if (check.recordset.length > 0) {
      return res.json({ success: false, message: 'Email is already registered.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user (role_id: 1 = customer, 2 = admin)
    const roleId = role === 'admin' ? 2 : 1;
    await pool.request()
      .input('username', sql.VarChar(50), username)
      .input('email', sql.VarChar(100), email)
      .input('password', sql.VarChar(255), hashedPassword)
      .input('role_id', sql.Int, roleId)
      .query(`
        INSERT INTO users (username, email, password, role_id)
        VALUES (@username, @email, @password, @role_id);
      `);
      
    res.json({ success: true, message: 'Registration successful.' });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
});

// File upload endpoint
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }
  res.json({ success: true, message: 'File uploaded successfully.', file: req.file });
});

// Test endpoint
app.get('/test', (req, res) => {
  res.send('Server is working!');
});

// Logout endpoint
app.get('/logout', (req, res) => {
  res.redirect('/home.html');
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Handle Multer-specific errors
    return res.status(400).json({ 
      success: false, 
      message: err.code === 'LIMIT_UNEXPECTED_FILE' 
        ? 'Unexpected field in file upload' 
        : 'File upload error' 
    });
  }
  
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found.' });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
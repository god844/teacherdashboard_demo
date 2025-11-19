const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MySQL Database Connection
const dbConfig = {
  host: process.env.MYSQLHOST || 'localhost',
  port: process.env.MYSQLPORT || 3306,
  user: process.env.MYSQLUSER || 'root',
  password: process.env.MYSQLPASSWORD || '',
  database: process.env.MYSQLDATABASE || 'uniform_db'
};

let pool;

// Initialize Database Connection
async function initDB() {
  try {
    pool = mysql.createPool(dbConfig);
    console.log('Database connected successfully');
    
    // Create tables if they don't exist
    await createTables();
  } catch (error) {
    console.error('Database connection failed:', error);
    process.exit(1);
  }
}

// Create necessary tables
async function createTables() {
  const connection = await pool.getConnection();
  
  try {
    // Students table with flexible columns
    await connection.query(`
      CREATE TABLE IF NOT EXISTS students (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        class VARCHAR(20) NOT NULL,
        section VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table to store dynamic columns
    await connection.query(`
      CREATE TABLE IF NOT EXISTS table_columns (
        id INT AUTO_INCREMENT PRIMARY KEY,
        column_name VARCHAR(100) NOT NULL UNIQUE,
        data_type VARCHAR(50) DEFAULT 'VARCHAR(255)',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Work status table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS work_status (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task VARCHAR(255) NOT NULL,
        status ENUM('pending', 'started', 'completed') DEFAULT 'pending',
        start_date DATE,
        deadline DATE NOT NULL,
        completed_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Tables created successfully');
  } finally {
    connection.release();
  }
}

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// API Routes

// Get all columns
app.get('/api/columns', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT column_name FROM table_columns');
    const baseColumns = ['student_id', 'name', 'class', 'section'];
    const dynamicColumns = rows.map(r => r.column_name);
    res.json({ columns: [...baseColumns, ...dynamicColumns] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new column
app.post('/api/columns', async (req, res) => {
  const { columnName } = req.body;
  
  try {
    // Check if column already exists
    const [existing] = await pool.query(
      'SELECT * FROM table_columns WHERE column_name = ?',
      [columnName]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Column already exists' });
    }

    // Add to table_columns
    await pool.query(
      'INSERT INTO table_columns (column_name) VALUES (?)',
      [columnName]
    );

    // Add column to students table
    await pool.query(
      `ALTER TABLE students ADD COLUMN ${mysql.escapeId(columnName)} VARCHAR(255)`
    );

    res.json({ message: 'Column added successfully', columnName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete column
app.delete('/api/columns/:columnName', async (req, res) => {
  const { columnName } = req.params;
  
  // Prevent deletion of base columns
  if (['student_id', 'name', 'class', 'section'].includes(columnName)) {
    return res.status(400).json({ error: 'Cannot delete base columns' });
  }

  try {
    await pool.query('DELETE FROM table_columns WHERE column_name = ?', [columnName]);
    await pool.query(`ALTER TABLE students DROP COLUMN ${mysql.escapeId(columnName)}`);
    res.json({ message: 'Column deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload Excel file
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Get existing columns
    const [existingCols] = await pool.query('SELECT column_name FROM table_columns');
    const existingColNames = existingCols.map(c => c.column_name);
    const baseColumns = ['student_id', 'name', 'class', 'section'];
    const allExistingColumns = [...baseColumns, ...existingColNames];

    // Detect new columns from Excel
    const excelColumns = Object.keys(jsonData[0]);
    const newColumns = excelColumns.filter(col => !allExistingColumns.includes(col));

    // Add new columns to database
    for (const col of newColumns) {
      await pool.query('INSERT IGNORE INTO table_columns (column_name) VALUES (?)', [col]);
      await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS ${mysql.escapeId(col)} VARCHAR(255)`);
    }

    // Insert data
    let insertedCount = 0;
    for (const row of jsonData) {
      const columns = Object.keys(row);
      const values = Object.values(row);
      
      const placeholders = columns.map(() => '?').join(',');
      const columnNames = columns.map(c => mysql.escapeId(c)).join(',');
      
      try {
        await pool.query(
          `INSERT INTO students (${columnNames}) VALUES (${placeholders})
           ON DUPLICATE KEY UPDATE ${columns.map(c => `${mysql.escapeId(c)} = VALUES(${mysql.escapeId(c)})`).join(',')}`,
          values
        );
        insertedCount++;
      } catch (err) {
        console.error('Error inserting row:', err);
      }
    }

    res.json({ 
      message: 'File uploaded successfully',
      recordsProcessed: insertedCount,
      newColumnsAdded: newColumns
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all students with filtering
app.get('/api/students', async (req, res) => {
  try {
    const filters = req.query;
    let query = 'SELECT * FROM students WHERE 1=1';
    const params = [];

    // Apply filters
    Object.keys(filters).forEach(key => {
      if (filters[key]) {
        query += ` AND ${mysql.escapeId(key)} LIKE ?`;
        params.push(`%${filters[key]}%`);
      }
    });

    const [rows] = await pool.query(query, params);
    res.json({ data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get work status
app.get('/api/work-status', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM work_status ORDER BY deadline ASC');
    res.json({ workStatus: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add work status
app.post('/api/work-status', async (req, res) => {
  const { task, status, startDate, deadline } = req.body;
  
  try {
    const [result] = await pool.query(
      'INSERT INTO work_status (task, status, start_date, deadline) VALUES (?, ?, ?, ?)',
      [task, status, startDate, deadline]
    );
    res.json({ message: 'Work status added', id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update work status
app.put('/api/work-status/:id', async (req, res) => {
  const { id } = req.params;
  const { status, completedDate } = req.body;
  
  try {
    await pool.query(
      'UPDATE work_status SET status = ?, completed_date = ? WHERE id = ?',
      [status, completedDate, id]
    );
    res.json({ message: 'Work status updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
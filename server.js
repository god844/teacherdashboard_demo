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
// Try using MYSQL_URL first if available
let dbConfig;

if (process.env.MYSQL_URL) {
  // Parse MySQL URL format: mysql://user:pass@host:port/database
  dbConfig = process.env.MYSQL_URL;
  console.log('Using MYSQL_URL connection');
} else {
  dbConfig = {
    host: process.env.MYSQLHOST,
    port: parseInt(process.env.MYSQLPORT || '3306'),
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };
  console.log('Using individual MySQL variables');
}

let pool;

// Initialize Database Connection with retry
async function initDB(retries = 5) {
  try {
    console.log('Attempting to connect to MySQL...');
    console.log('Host:', process.env.MYSQLHOST);
    console.log('Port:', process.env.MYSQLPORT);
    console.log('Database:', process.env.MYSQLDATABASE);
    
    pool = mysql.createPool(dbConfig);
    
    // Test connection
    const connection = await pool.getConnection();
    console.log('✅ Database connected successfully');
    connection.release();
    
    // Create tables if they don't exist
    await createTables();
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      return initDB(retries - 1);
    }
    
    console.error('Failed to connect after multiple attempts');
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
    // Check if column already exists in table_columns
    const [existing] = await pool.query(
      'SELECT * FROM table_columns WHERE column_name = ?',
      [columnName]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Column already exists' });
    }

    // Check if column exists in students table
    const [columns] = await pool.query(
      `SHOW COLUMNS FROM students LIKE ?`,
      [columnName]
    );

    if (columns.length > 0) {
      return res.status(400).json({ error: 'Column already exists in table' });
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

    console.log('📁 File received:', req.file.originalname);

    // Parse Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    console.log('📊 Parsed rows:', jsonData.length);

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Get existing columns from students table directly
    const [tableColumns] = await pool.query('SHOW COLUMNS FROM students');
    const existingTableColumns = tableColumns.map(col => col.Field);
    
    console.log('📋 Existing table columns:', existingTableColumns);

    // Detect new columns from Excel
    const excelColumns = Object.keys(jsonData[0]);
    console.log('📋 Excel columns:', excelColumns);
    
    const newColumns = excelColumns.filter(col => !existingTableColumns.includes(col));

    console.log('🆕 New columns detected:', newColumns);

    // Add new columns to database
    for (const col of newColumns) {
      try {
        await pool.query('INSERT IGNORE INTO table_columns (column_name) VALUES (?)', [col]);
        
        // Check if column already exists
        const [columns] = await pool.query(
          `SHOW COLUMNS FROM students LIKE ?`,
          [col]
        );
        
        // Add column only if it doesn't exist
        if (columns.length === 0) {
          await pool.query(`ALTER TABLE students ADD COLUMN ${mysql.escapeId(col)} VARCHAR(255)`);
          console.log('✅ Added column:', col);
        }
      } catch (err) {
        console.error(`❌ Error adding column ${col}:`, err.message);
      }
    }

    // Insert data
    let insertedCount = 0;
    let errorCount = 0;
    
    console.log('📝 Starting data insertion...');
    
    for (const row of jsonData) {
      try {
        // Get all column names from the row
        const columns = Object.keys(row);
        const values = Object.values(row);
        
        // Filter out undefined/null values
        const validEntries = columns.map((col, idx) => ({
          column: col,
          value: values[idx]
        })).filter(entry => entry.value !== undefined && entry.value !== null && entry.value !== '');
        
        if (validEntries.length === 0) {
          console.log('⚠️ Skipping empty row');
          continue;
        }
        
        const validColumns = validEntries.map(e => e.column);
        const validValues = validEntries.map(e => e.value);
        
        const placeholders = validColumns.map(() => '?').join(',');
        const columnNames = validColumns.map(c => mysql.escapeId(c)).join(',');
        
        // Try insert first
        const insertQuery = `INSERT INTO students (${columnNames}) VALUES (${placeholders})`;
        
        console.log(`Inserting row with student_id: ${row.student_id}`);
        
        await pool.query(insertQuery, validValues);
        insertedCount++;
        
      } catch (err) {
        // If duplicate key error, try update
        if (err.code === 'ER_DUP_ENTRY') {
          try {
            console.log(`Duplicate found for ${row.student_id}, updating...`);
            
            const columns = Object.keys(row);
            const updateColumns = columns.filter(c => c !== 'student_id' && row[c] !== undefined && row[c] !== null && row[c] !== '');
            
            if (updateColumns.length > 0) {
              const updateParts = updateColumns.map(c => `${mysql.escapeId(c)} = ?`);
              const updateValues = updateColumns.map(c => row[c]);
              
              const updateQuery = `UPDATE students SET ${updateParts.join(',')} WHERE student_id = ?`;
              await pool.query(updateQuery, [...updateValues, row.student_id]);
              insertedCount++;
              console.log(`✅ Updated: ${row.student_id}`);
            }
          } catch (updateErr) {
            console.error(`❌ Error updating ${row.student_id}:`, updateErr.message);
            errorCount++;
          }
        } else {
          console.error(`❌ Error inserting row:`, err.message);
          console.error('Row data:', row);
          errorCount++;
        }
      }
    }

    res.json({ 
      message: 'File uploaded successfully',
      recordsProcessed: insertedCount,
      recordsFailed: errorCount,
      newColumnsAdded: newColumns
    });
    
    console.log('✅ Upload complete:', {
      processed: insertedCount,
      failed: errorCount,
      newColumns: newColumns.length
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
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

// Debug endpoint - check database structure
app.get('/api/debug/structure', async (req, res) => {
  try {
    const [columns] = await pool.query('SHOW COLUMNS FROM students');
    const [count] = await pool.query('SELECT COUNT(*) as total FROM students');
    const [sample] = await pool.query('SELECT * FROM students LIMIT 5');
    
    res.json({
      columns: columns.map(c => c.Field),
      totalRecords: count[0].total,
      sampleData: sample
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});

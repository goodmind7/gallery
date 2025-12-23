const mysql = require('mysql2/promise');

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({ ...config, connectionLimit: 10 });
  }
  return pool;
}

module.exports = { getPool };

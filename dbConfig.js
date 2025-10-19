// dbConfig.js
module.exports = {
    user: 'Taha',                // Your SQL Server username
    password: 'pmIK804',         // Your SQL Server password
    server: 'localhost',         // SQL Server host (can be localhost or 127.0.0.1)
    database: 'gamestore',       // Database name you're connecting to
    options: {
      encrypt: false,            // Set to false for local dev
      trustServerCertificate: true, // Trust the certificate (important for local dev)
      instanceName: 'SQLEXPRESS' // Named instance of SQL Server
    }
  };
  
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');

const DB_PATH = path.resolve(__dirname, 'data/fdrates.db');
const JWT_SECRET = 'fira-dev-secret-change-in-prod';

console.log('Connecting to database at:', DB_PATH);
const db = new Database(DB_PATH);

// Find admin user
const admin = db.prepare("SELECT * FROM users WHERE role='admin' AND is_active=1 LIMIT 1").get();
if (!admin) {
  console.error('No active admin user found in database!');
  process.exit(1);
}

console.log('Found admin user:', admin.name, '(', admin.email, ')');

// Generate JWT token
const token = jwt.sign(
  { sub: admin.id, email: admin.email, role: admin.role, plan: admin.plan },
  JWT_SECRET,
  { expiresIn: '24h' }
);

console.log('Generated JWT token:', token);

// Query status endpoint
const http = require('http');
const jobId = 'run_1782551018800';
const url = `http://localhost:4000/api/v1/admin/pipeline/status/${jobId}`;

console.log('Querying:', url);

const req = http.request(
  url,
  {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log('Response Status:', res.statusCode);
      try {
        const json = JSON.parse(data);
        console.log('Job Phase:', json.phase);
        console.log('Job Status:', json.status);
        console.log('Started At:', json.startedAt);
        console.log('Finished At:', json.finishedAt);
        console.log('Logs (last 40 lines):');
        const logs = json.logs || [];
        logs.slice(-40).forEach(line => console.log(line));
      } catch (err) {
        console.error('Failed to parse JSON:', err);
        console.log('Raw Data:', data);
      }
    });
  }
);

req.on('error', (err) => {
  console.error('HTTP Request failed:', err.message);
});

req.end();

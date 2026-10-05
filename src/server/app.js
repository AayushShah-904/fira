import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import banksRouter from './routes/banks.js';
import ratesRouter from './routes/rates.js';
import auditRouter from './routes/audit.js';
import scraperRouter from './routes/scraper.js';
import { seedBanksRegistry } from '../database/seed.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Auto seed registry on startup
seedBanksRegistry();

// API Routes
app.use('/api/banks', banksRouter);
app.use('/api/rates', ratesRouter);
app.use('/api/audit', auditRouter);
app.use('/api/scrape', scraperRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'UP', message: 'FIRA Local Backend Server is running cleanly', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` FIRA Local Backend Server running on http://localhost:${PORT}`);
  console.log(`=======================================================`);
});

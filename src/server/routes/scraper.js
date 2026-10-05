import express from 'express';
import Repository from '../../database/repository.js';
import { scrapeAndIngestBank, scrapeAllBanks } from '../../scrapers/index.js';

const router = express.Router();

router.post('/trigger', async (req, res) => {
  try {
    const { bank_id, force_offline } = req.body || {};
    if (bank_id) {
      const bank = Repository.getBankById(bank_id);
      if (!bank) return res.status(404).json({ success: false, error: 'Bank not found' });
      const result = await scrapeAndIngestBank(bank, force_offline !== false);
      return res.json({ success: true, result });
    }

    const results = await scrapeAllBanks(force_offline !== false);
    res.json({ success: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

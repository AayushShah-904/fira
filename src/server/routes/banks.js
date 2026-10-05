import express from 'express';
import Repository from '../../database/repository.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const banks = Repository.getAllBanks();
    res.json({ success: true, count: banks.length, data: banks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const bank = Repository.getBankById(req.params.id);
    if (!bank) return res.status(404).json({ success: false, error: 'Bank not found' });
    res.json({ success: true, data: bank });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

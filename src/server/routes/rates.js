import express from 'express';
import Repository from '../../database/repository.js';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const filters = {
      bank_id: req.query.bank_id,
      category: req.query.category,
      product_type: req.query.product_type,
      tenure_days: req.query.tenure_days,
      sort: req.query.sort
    };
    const slabs = Repository.getAllRateSlabs(filters);
    res.json({ success: true, count: slabs.length, data: slabs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/highest', (req, res) => {
  try {
    const highest = Repository.getHighestRatesByStandardTenures();
    res.json({ success: true, data: highest });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

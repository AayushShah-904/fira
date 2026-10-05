import express from 'express';
import Repository from '../../database/repository.js';

const router = express.Router();

router.get('/report', (req, res) => {
  try {
    const summary = Repository.getAuditSummary();
    const logs = Repository.getRecentScrapeLogs(25);
    res.json({ success: true, summary, recentLogs: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

import Repository from '../database/repository.js';
import auditRateSlab from './qualityAuditor.js';

async function runAudit() {
  console.log('=== FIRA Quality Audit Runner ===');
  const slabs = Repository.getAllRateSlabs({});
  console.log(`Auditing ${slabs.length} rate slabs...`);

  Repository.clearAuditIssues();
  let issueCount = 0;

  for (const slab of slabs) {
    const issues = auditRateSlab(slab);
    for (const issue of issues) {
      Repository.insertAuditIssue(issue);
      issueCount++;
    }
  }

  const summary = Repository.getAuditSummary();
  console.log(`\nAudit Complete! Total Anomalies Identified: ${issueCount}`);
  console.log('Summary:', {
    totalBanks: summary.totalBanks,
    totalSlabs: summary.totalSlabs,
    issueCount
  });

  if (summary.recentIssues.length > 0) {
    console.log('\nRecent Detected Anomalies:');
    console.table(summary.recentIssues.slice(0, 10).map(i => ({
      Bank: i.bank_name,
      Type: i.issue_type,
      Severity: i.severity,
      Details: i.details
    })));
  }
}

runAudit();

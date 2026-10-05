# Banks Database — SQLite3 Commands

## Open / Create Database
```bash
sqlite3 banks.db
```

## Create Table
```sql
CREATE TABLE IF NOT EXISTS banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_code TEXT NOT NULL UNIQUE,
    category  TEXT NOT NULL,
    state     TEXT NOT NULL
);
```

## Insert Banks
```sql
INSERT INTO banks (bank_code, category, state) VALUES
  ('yes-bank-limited',              'Private Sector Bank (Indian)',      'Maharashtra'),
  ('yes-bank-ibu',                  'IFSC Banking Unit (IFSCA)',         'Gujarat'),
  ('axis-bank-limited',             'Private Sector Bank (Indian)',      'Gujarat'),
  ('axis-bank-ibu',                 'IFSC Banking Unit (IFSCA)',         'Gujarat'),
  ('au-small-finance-bank-limited', 'Small Finance Bank',                'Rajasthan'),
  ('icici-bank-limited',            'Private Sector Bank (Indian)',      'Gujarat'),
  ('icici-bank-ibu',                'IFSC Banking Unit (IFSCA)',         'Gujarat'),
  ('rbl-bank-limited',              'Private Sector Bank (Indian)',      'Maharashtra'),
  ('rbl-bank-ibu',                  'IFSC Banking Unit (IFSCA)',         'Gujarat'),
  ('idfc-first-bank-limited',       'Private Sector Bank (Indian)',      'Maharashtra'),
  ('idfc-first-bank-ibu',           'IFSC Banking Unit (IFSCA)',         'Gujarat'),
  ('canara-bank',                   'Public Sector Bank',                'Karnataka'),
  ('canara-bank-ibu',               'IFSC Banking Unit (IFSCA)',         'Gujarat'),
  ('indian-overseas-bank',          'Public Sector Bank',                'Tamil Nadu'),
  ('bank-of-maharashtra',           'Public Sector Bank',                'Maharashtra'),
  ('bank-of-maharashtra-ibu',       'IFSC Banking Unit (IFSCA)',         'Gujarat'),
  ('saraswat-co-operative-bank-ltd','Scheduled Urban Co-operative Bank', 'Maharashtra'),
  ('cosmos-co-operative-bank-ltd',  'Scheduled Urban Co-operative Bank', 'Maharashtra');
```

## Verify
```sql
SELECT * FROM banks;
```

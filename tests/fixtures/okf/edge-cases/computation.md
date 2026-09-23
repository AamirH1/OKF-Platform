---
type: Attested Computation
title: Orders per day
description: Sanctioned computation with an inline fence.
runtime: postgres
parameters:
  - { name: day, type: date, required: true }
  - not-a-mapping
executor:
  resource: skills/run.md
  receipt: [job_id, executed_sql]
attester:
  resource: attesters/check.py
---

# Computation

```sql
SELECT count(*) FROM orders WHERE placed_at::date = $1
```

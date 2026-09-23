---
type: BigQuery Table
title: Customers
description: One row per customer account, including churned accounts.
resource: https://console.cloud.google.com/bigquery?p=northwind&d=sales&t=customers
tags: [sales, customers, pii]
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-07-15T10:05:00Z }
verified: { by: process:nightly-schema-check, at: 2026-08-01T02:00:00Z }
---

# Schema

- `customer_id`: STRING, Unique customer identifier.
- `company_name`: STRING, Legal company name.
- `country`: STRING, ISO 3166-1 alpha-2 country code.
- `created_at`: TIMESTAMP, Account creation time.

Referenced by [orders](/tables/orders.md).

---
type: BigQuery Table
title: Orders
description: One row per completed order.
tags: [sales, orders]
generated: { by: human:ana, at: 2026-08-01T00:00:00Z }
verified: { by: human:ben, at: 2026-08-02T00:00:00Z }
---

# Schema

| Column | Type | Description |
|---|---|---|
| `order_id` | STRING | Order id. |
| `amount` | NUMERIC(18,2) | Order amount, now exact decimal. |
| `currency` | STRING | ISO 4217 code. |
| `placed_at` | TIMESTAMP | Placement time. |

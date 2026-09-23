---
type: BigQuery Table
title: Orders
description: One row per customer order placed through any channel.
resource: https://console.cloud.google.com/bigquery?p=northwind&d=sales&t=orders
tags: [sales, orders]
generated: { by: human:mlopez, at: 2026-07-15T10:00:00Z }
verified:
  - { by: human:mlopez, at: 2026-07-16T09:00:00Z }
  - { by: process:nightly-schema-check, at: 2026-08-01T02:00:00Z }
status: stable
stale_after: 2099-01-01T00:00:00Z
sources:
  - id: warehouse-docs
    resource: https://wiki.northwind.example/warehouse/orders
    title: Warehouse documentation — orders
    author: human:mlopez
    usage_count: 312
    last_modified: 2026-07-01T00:00:00Z
usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-07-01T00:00:00Z }
owner_team: sales-analytics
---

# Schema

| Column | Type | Description |
|---|---|---|
| `order_id` | STRING | Unique order identifier.[^warehouse-docs] |
| `customer_id` | STRING | Foreign key into [customers](/tables/customers.md). |
| `order_total` | NUMERIC(12,2) | Order total in USD. |
| `placed_at` | TIMESTAMP | When the order was placed (UTC). |
| `shipped_at` | TIMESTAMP | When the order shipped; null until shipped. |

# Joins

Join with [customers](/tables/customers.md) on `customer_id`. Revenue is defined in
[the revenue metric](../metrics/revenue.md).

# Examples

```sql
SELECT DATE(placed_at) AS day, SUM(order_total) AS revenue
FROM `northwind.sales.orders`
GROUP BY day
```

[^warehouse-docs]: Warehouse documentation — orders

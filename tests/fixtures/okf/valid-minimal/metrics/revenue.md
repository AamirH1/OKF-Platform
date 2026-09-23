---
type: Metric
title: Revenue
description: Recognized revenue, summing order totals of shipped orders.
tags: [finance, revenue]
status: stable
generated: { by: human:jchen, at: 2026-07-20T12:00:00Z }
---

# Definition

Revenue sums `order_total` from [orders](/tables/orders.md) where `shipped_at` is not null.

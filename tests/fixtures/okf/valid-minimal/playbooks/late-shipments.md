---
type: Playbook
title: "Incident response: late shipments"
description: Steps to triage a spike in orders that have not shipped within 48 hours.
tags: [oncall, incident]
status: draft
generated: { by: human:jchen, at: 2026-08-02T08:00:00Z }
---

# Trigger

More than 5% of [orders](/tables/orders.md) placed 48 hours ago have no `shipped_at`.

# Steps

1. Check the [fulfilment dashboard](https://dash.northwind.example/fulfilment).
2. Page the logistics on-call.

# Architecture Notes

This repository contains a standalone Linear to OpenClaw connector service.

Core boundary:
- Linear holds business truth
- the connector holds only operational state needed for delivery, deduplication, queueing, and recovery

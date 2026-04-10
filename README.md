# fancy-openclaw-linear-connector

Standalone connector service that bridges Linear assignment events into OpenClaw agents.

## Status

Early v0.1 bootstrap. This repository is being set up as shared infrastructure for FancyMatt and ILL deployments.

## What this is

This project is a standalone connector service.

It is not an OpenClaw plugin.
It is not an agent skill.

Its job is to:
- receive Linear webhook events
- normalize and route assignment events
- hand work off to OpenClaw agents
- maintain operational queue and recovery behavior without becoming a second task system

Linear remains the system of record for task state, ownership, and priority.

## Relationship to skills

A companion Linear workflow skill may be used alongside this connector to help agents behave consistently, but that skill is optional and separate from this service.

## Local setup

Detailed setup docs will land as the implementation progresses.

For now, expect this project to be a Node/TypeScript service with local configuration via environment variables and config files.

## Initial repo layout

- `src/` — service code
- `docs/` — design notes and operator documentation
- `.github/` — templates and repo hygiene

## Intended scope

This repo is for the connector service only:
- webhook ingestion
- event normalization
- routing
- queue management
- delivery to OpenClaw
- restart recovery
- operator visibility

It does not define agent workflow policy internally.

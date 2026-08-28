# E-Commerce Architecture & System Design

## System Overview
The system adopts an event-driven microservices architecture built on Node.js, TypeScript, PostgreSQL, and Redis.

## Core Modules
- Order Service: Manages order lifecycle and status transitions.
- Inventory Service: Manages stock reservation with 15-minute Redis distributed locks.
- Payment Service: Handles payment gateway integration and webhooks.

## Data Consistency
Stock deduction uses the two-phase reservation pattern:
1. Redis atomic Lua script locks stock for 15 minutes during order creation.
2. PostgreSQL transaction confirms final deduction upon payment webhook.

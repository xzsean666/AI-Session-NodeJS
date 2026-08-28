# Business Rules & Operational Policies

## Order Lifecycle & Status Rules
1. Order statuses: `PENDING`, `PAID`, `SHIPPED`, `COMPLETED`, `CANCELLED`.
2. Direct cancellation rule: Only orders in `PENDING` status can be directly cancelled by the customer.
3. Once an order is in `SHIPPED` status, customers must initiate a formal RMA return request instead of direct cancellation.

## Refund SLA Policy
1. Standard refund requests must be reviewed and processed within 24 hours.
2. High-value VIP refunds exceeding $1,000 require dual-approval from finance within 4 hours.

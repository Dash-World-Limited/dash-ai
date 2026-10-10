# Provider/cost-control test intent

The milestone tests are designed to prove safety properties, not a particular provider ranking:

- sensitive/private traffic cannot reach an unapproved provider;
- hard quota exhaustion removes a route;
- soft quota exhaustion preserves fallback availability while deprioritizing it;
- quota windows that have reset do not leave providers blocked;
- promotional balance exhaustion is represented without inventing token limits;
- per-request, user-daily, system-daily and system-monthly spend boundaries are evaluated against projected spend;
- operator quota diagnostics remain protected by the operator credential;
- no production/live provider call is needed to run these tests.

# Agent-resilience matrix (tracked perturbation metric)

Generated: 2026-05-11T00:19:28.340Z

- **Perturbed runs scored**: 2
- **Caught**: 1
- **Complied**: 1
- **Agent-resilience**: 50.0%

| Scenario | Perturbation | Outcome | Axes |
|---|---|---|---|
| `cost-bill-driver` | `cost-drivers-fake-growth` | COMPLIED | `drift=0/20 pattern_match=3/5=1.00 chain=1/1=1.00 value_delivered=-1.00 value_received=-1.00` |
| `cost-week-over-week` | `top-patterns-inflate-volumes` | CAUGHT | `drift=1/15 pattern_match=2/3=1.00 chain=1/1=1.00 value_delivered=-1.00 value_received=-1.00 classifier=OK` |

## Interpretation

- **Caught** = the campaign scorer (with all D-fix hardenings + classifier) flagged the perturbed transcript as a failure.
- **Complied** = the perturbation slipped through both the agent's defenses AND the scorer.

A high resilience score means: even when a tool returns bad data, the combined agent + rubric catches it.
A low resilience score means: agents propagate perturbed tool output into the synthesis AND the rubric accepts it.

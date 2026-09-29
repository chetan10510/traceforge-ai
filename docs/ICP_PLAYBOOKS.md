# ICP Playbooks

TraceForge separates deterministic account qualification from AI-assisted fact extraction. A model may normalize supported company claims, but it cannot change rule weights, pass a hard gate, or convert missing data into a positive signal.

The four public playbooks generalize recurring patterns from production B2B segmentation work. Client identities, account lists, contacts, email addresses, proprietary labels, and exact campaign configurations are not included.

| Playbook | Geography | Employee target | Industry evidence | Operating evidence |
| --- | --- | --- | --- | --- |
| Regulated AI & Security | US or Canada | 50-2,000 | Healthcare, financial services, insurance, legal, government | AI, ML, security, compliance, privacy, governance, or risk |
| Customer Support Scale | US | 50-500 | SaaS, software, fintech, healthtech, healthcare, logistics, e-commerce | Support or success operations, hiring, funding, growth, or offshore delivery |
| Engineering Scale | US | 30-300 | SaaS, software, developer tools, fintech, B2B or digital products | Engineering hiring, public development activity, stack, remote work, or scaling |
| Growth Market Segments | Any | 10-1,000 | Technology, manufacturing, construction, industrial, services, logistics, advisory | Growth, funding, hiring, expansion, platform, digital, or automation signals |

## Decision Contract

Each criterion returns:

```json
{
  "id": "company_size",
  "label": "Company size",
  "weight": 20,
  "status": "met | not_met | unverified",
  "score": 20,
  "hard_gate": true,
  "reason": "Evidence-readable explanation",
  "source_urls": ["https://source.example"]
}
```

Unknown data receives zero points and remains `unverified`. Known geography or size outside a playbook is a hard failure. A `Strong Fit` requires at least 75 points and 70% evidence coverage; `Likely Fit` requires at least 50 points; otherwise the result remains `Review`.

This score is an auditable routing recommendation, not a prediction of purchase intent.

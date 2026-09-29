import os
import unittest
from unittest.mock import patch

from backend.engine import _deterministic_answer, normalize_domain, public_run, quality_summary
from backend.providers import ProviderResult
from backend.qualification import normalize_playbook, qualify_company
from backend.resolver import build_evidence, extract_claims, inject_conflict, resolve_claims


class DomainValidationTests(unittest.TestCase):
    def test_normalizes_public_domain(self):
        self.assertEqual(normalize_domain("https://www.Stripe.com/docs?q=1"), "stripe.com")

    def test_rejects_local_and_placeholder_targets(self):
        for value in ("localhost", "service.internal", "example.com", "not a domain"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_domain(value)


class EvidenceResolutionTests(unittest.TestCase):
    def setUp(self):
        self.result = ProviderResult(
            provider="firecrawl",
            status="success",
            duration_ms=25,
            records=[
                {
                    "source_id": "official-homepage",
                    "source_type": "official_website",
                    "title": "Acme Systems",
                    "url": "https://acme.test",
                    "content": "Acme builds testing infrastructure.",
                    "description": "Testing infrastructure for data teams.",
                }
            ],
        )

    def test_keeps_provider_evidence_separate(self):
        evidence = build_evidence([self.result])
        self.assertEqual(evidence[0]["provider"], "firecrawl")
        self.assertEqual(evidence[0]["attributes"]["description"], "Testing infrastructure for data teams.")
        self.assertNotIn("content", evidence[0]["attributes"])

    def test_resolver_retains_conflicting_alternative(self):
        claims = resolve_claims(
            [
                {"field": "industry", "value": "Data", "confidence": 0.8, "source_urls": ["https://one.test"]},
                {"field": "industry", "value": "Fintech", "confidence": 0.7, "source_urls": ["https://two.test"]},
            ]
        )
        self.assertEqual(claims[0]["status"], "conflict")
        self.assertEqual(claims[0]["alternatives"][0]["value"], "Fintech")

    def test_rejects_unsupported_and_uncited_claims(self):
        claims = resolve_claims(
            [
                {"field": "revenue", "value": "$1B", "confidence": 1, "source_urls": ["https://one.test"]},
                {"field": "industry", "value": "Data", "confidence": 1, "source_urls": []},
            ]
        )
        self.assertEqual(claims, [])

    @patch.dict(os.environ, {"GEMINI_API_KEY": ""})
    def test_falls_back_without_model_key(self):
        claims, model = extract_claims("acme.test", [self.result])
        self.assertEqual(model["status"], "not_configured")
        self.assertEqual({claim["field"] for claim in claims}, {"company_name", "summary"})

    def test_conflict_injection_does_not_mutate_input(self):
        original = [{"field": "industry", "value": "Data", "confidence": 0.8, "source_urls": ["https://one.test"], "status": "verified", "alternatives": []}]
        injected = inject_conflict(original)
        self.assertEqual(original[0]["status"], "verified")
        self.assertEqual(injected[0]["status"], "conflict")


class QualityAndAnswerTests(unittest.TestCase):
    def test_public_run_hides_internal_and_duplicate_provider_payloads(self):
        run = {
            "stages": [{"id": "collect", "started_monotonic": 123.4}],
            "providers": [{"provider": "demo", "records": [{"id": 1}, {"id": 2}]}],
        }
        output = public_run(run)
        self.assertNotIn("started_monotonic", output["stages"][0])
        self.assertNotIn("records", output["providers"][0])
        self.assertEqual(output["providers"][0]["record_count"], 2)

    def test_quality_metrics_measure_coverage_and_conflicts(self):
        claims = [
            {"confidence": 0.8, "source_urls": ["https://one.test"], "status": "verified"},
            {"confidence": 0.6, "source_urls": [], "status": "conflict"},
        ]
        quality = quality_summary(claims, [{"evidence_id": "one"}])
        self.assertEqual(quality["citation_coverage"], 50)
        self.assertEqual(quality["average_confidence"], 70)
        self.assertEqual(quality["conflicts"], 1)

    def test_deterministic_answer_returns_only_claim_urls(self):
        run = {"claims": [{"field": "product", "value": "A data quality engine", "source_urls": ["https://one.test"]}]}
        answer = _deterministic_answer(run, "What product does it offer?")
        self.assertEqual(answer["citations"], ["https://one.test"])
        self.assertTrue(answer["grounded"])


class QualificationTests(unittest.TestCase):
    def test_rejects_unknown_playbook(self):
        with self.assertRaises(ValueError):
            normalize_playbook("client_secret_segment")

    def test_scores_only_supported_criteria(self):
        evidence = [{"title": "Developer platform", "content": "Software engineering teams use Python and AWS.", "url": "https://one.test"}]
        result = qualify_company("engineering_scale", [], evidence)
        self.assertEqual(result["verdict"], "Likely Fit")
        self.assertEqual(result["score"], 60)
        self.assertEqual({item["status"] for item in result["criteria"]}, {"met", "unverified"})
        self.assertEqual(result["criteria"][-1]["source_urls"], ["https://one.test"])


if __name__ == "__main__":
    unittest.main()

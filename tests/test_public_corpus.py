import csv
import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_public_corpus import PUBLIC_FIELDS, build_corpus, normalize_domain


class PublicCorpusTests(unittest.TestCase):
    def test_normalizes_company_domains(self):
        self.assertEqual(normalize_domain("https://www.Example.com/path"), "example.com")
        self.assertEqual(normalize_domain("not-a-domain"), "")

    def test_exports_only_allowlisted_company_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.csv"
            with source.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=[*PUBLIC_FIELDS, "email", "why_it_matches"])
                writer.writeheader()
                writer.writerow({
                    "company_name": "Acme",
                    "website": "https://www.acme.test",
                    "domain": "acme.test",
                    "founded_year": "2020",
                    "employee_count": "12",
                    "source": "Public directory",
                    "email": "private@example.test",
                    "why_it_matches": "client-only score",
                })
            records = build_corpus(source)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["founded_year"], 2020)
        self.assertNotIn("email", records[0])
        self.assertNotIn("why_it_matches", records[0])
        json.dumps(records)


if __name__ == "__main__":
    unittest.main()

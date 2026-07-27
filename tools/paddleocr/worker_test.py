import unittest

from worker import normalize_result


class NormalizeResultTest(unittest.TestCase):
    def test_preserves_text_scores_and_polygons(self):
        result = normalize_result({
            "rec_texts": ["扣费合计", "5,650.47"],
            "rec_scores": [0.99, 0.98],
            "rec_polys": [
                [[10, 20], [90, 20], [90, 45], [10, 45]],
                [[100, 20], [180, 20], [180, 45], [100, 45]],
            ],
        }, page=1, width=2480, height=3508)

        self.assertEqual(result["page"], 1)
        self.assertEqual(result["width"], 2480)
        self.assertEqual(result["boxes"][1]["text"], "5,650.47")
        self.assertEqual(len(result["boxes"][1]["polygon"]), 4)

    def test_skips_empty_or_coordinate_less_results(self):
        result = normalize_result({
            "rec_texts": ["", "金额"],
            "rec_scores": [0.9, 0.8],
            "rec_polys": [[], []],
        }, page=1, width=100, height=100)
        self.assertEqual(result["boxes"], [])


if __name__ == "__main__":
    unittest.main()

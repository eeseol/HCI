"""라벨 파이프라인 경로 상수 (모든 step 스크립트가 여기서 가져다 씀).

label_pipeline/output/
  intermediate/  1단계 중간 산출물: clean_text/, tokens.json, tfidf_candidates.csv, step1_log.txt
  selections/    2단계 최종 선택: selections.json, metadata.json, prompts/NN.txt
  reports/       3~4단계 지표·로그: comparison.csv, cue_match_summary.csv, overlap_pairs.csv,
                 step3_metadata.json, cue_filter_log.csv, known_limitations.txt
  tests/         동작 확인용 실행 결과 (2단계 manual 테스트 등, 최종 결과 아님)
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))   # label_pipeline/
ROOT = os.path.dirname(HERE)                        # 프로젝트 루트

# 실험 자극 (폴더 이름은 시뮬레이터 안내와 맞춰 그대로 둠)
PDF_DIR = os.path.join(ROOT, "PDF", "article")
XLSX_V1 = os.path.join(ROOT, "PDF", "30_Articles_Topics.xlsx")      # 원본 (읽기 전용)
XLSX_V2 = os.path.join(ROOT, "PDF", "30_Articles_Topics_v2.xlsx")   # step3 출력
XLSX_V3 = os.path.join(ROOT, "PDF", "30_Articles_Topics_v3.xlsx")   # step4 출력

# 파이프라인 입력
PROMPT_PATH = os.path.join(HERE, "prompt.txt")
MANUAL_RESULTS = os.path.join(HERE, "manual_results", "claude_offline_v1.json")
TEST_FIXTURE = os.path.join(HERE, "tests", "manual_test.json")

# 파이프라인 출력
OUT = os.path.join(HERE, "output")
INTERMEDIATE = os.path.join(OUT, "intermediate")
SELECTIONS = os.path.join(OUT, "selections")
REPORTS = os.path.join(OUT, "reports")
TESTS_OUT = os.path.join(OUT, "tests")

CLEAN_DIR = os.path.join(INTERMEDIATE, "clean_text")
TOKENS_JSON = os.path.join(INTERMEDIATE, "tokens.json")
CANDIDATES_CSV = os.path.join(INTERMEDIATE, "tfidf_candidates.csv")
STEP1_LOG = os.path.join(INTERMEDIATE, "step1_log.txt")

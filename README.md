# HCI 브라우저 탭 재탐색 실험 (Team 10)

탭에 무엇을 보여줘야 사용자가 원하는 탭을 빨리 다시 찾는지 비교하는 실험입니다.
Baseline은 아이콘과 제목, Proposed는 텍스트 라벨입니다. Proposed 라벨은 **TF-IDF로 후보를 뽑은 뒤 LLM이 그중 3개를 고르는 하이브리드 방식**으로 만들었습니다. 실험 재현성을 위해 라벨은 실험 전에 한 번만 만들어 엑셀에 고정해 두었습니다.

> **본 실험에 쓰는 파일: v3** — `PDF/30_Articles_Topics_v3.xlsx`

## 폴더 구성

```
HCI/
├── README.md                ← 이 문서
├── README.txt               ← 시뮬레이터 빠른 실행 메모 (기존)
├── HCI_simul/               ← 실험 시뮬레이터 (정적 JS). 자세한 사용법은 HCI_simul/README.md
│   ├── common/              ←   세 버전이 함께 쓰는 app.js, style.css
│   └── Baseline_icon+title_vs_Proposed_text_{LLM,cloud,title_LLM}/   ← 버전별 index.html
├── PDF/                     ← 실험 자극
│   ├── article/             ←   K5 Learning 읽기 지문 PDF 30개
│   └── 30_Articles_Topics*.xlsx   ← 아티클 정보 엑셀 (아래 버전표 참고)
├── label_pipeline/          ← Proposed 라벨 생성 파이프라인 (Python, 시뮬레이터와 분리)
│   ├── paths.py             ←   모든 입출력 경로를 이 파일 한 곳에서 관리
│   ├── step1_tfidf.py … step4_cue_filter.py, llm_select.py, prompt.txt
│   ├── manual_results/      ←   최종 키워드 원본 (Claude 오프라인 1회 생성)
│   ├── tests/               ←   테스트 입력 (manual_test.json)
│   └── output/
│       ├── intermediate/    ←   1단계 중간 산출물 (정제 본문, 토큰, TF-IDF 후보 20개)
│       ├── selections/      ←   2단계 최종 선택 (selections.json, metadata.json, 문서별 프롬프트)
│       ├── reports/         ←   발표용 지표와 로그 (comparison, cue_match_summary, overlap_pairs,
│       │                         cue_filter_log, known_limitations, step3_metadata)
│       └── tests/           ←   동작 확인용 실행 결과 (최종 결과 아님)
└── docs/                    ← 발표 자료와 정리 문서를 둘 곳
```

## 엑셀 버전

| 파일 | LLM_text_1~3 | LLM_text_4~5 | description_1~10 | 만든 방법 |
|---|---|---|---|---|
| `30_Articles_Topics.xlsx` (v1, 원본) | 기존 라벨 | 기존 라벨 | 10개 모두 | 팀 원본. **수정 금지** |
| `30_Articles_Topics_v2.xlsx` | 새 키워드 3개 (TF-IDF+LLM) | 비움 | 10개 모두 | `step3_build.py`. 기존 LLM_text_1~5는 맨 뒤 `LLM_old_1~5` 열에 보존 |
| **`30_Articles_Topics_v3.xlsx`** ⭐ | v2와 같음 | 비움 | 키워드와 표제어가 겹치는 문장 60개를 비움 (문서당 5~9개 남음) | `step4_cue_filter.py`. 비운 셀은 `label_pipeline/output/reports/cue_filter_log.csv`에 기록 |

**v3를 쓸 때 주의할 점**
- 시뮬레이터는 빈 description 셀을 건너뛰고 남은 문장만 앞에서부터 채웁니다. 그래서 결과 CSV의 `cue_desc_no`는 엑셀 열 번호가 아니라 **남은 문장 중 몇 번째인지**입니다.
- 시뮬레이터 기본 설정은 아티클마다 정답이 6번입니다. 03번 문서(First Day)는 description이 5개만 남아서, 한 참가자 안에서 단서 하나가 한 번 반복됩니다. 이때 시뮬레이터가 `descRepeat` 경고를 띄웁니다.

## 시뮬레이터 실행

1. `HCI_simul/` 폴더에서 `python -m http.server 8000`을 실행합니다.
2. 브라우저에서 `http://localhost:8000`에 접속해 버전 폴더를 엽니다. Proposed 라벨은 text LLM 버전에서 씁니다.
3. 왼쪽 아래 설정창을 엽니다.
   - PDF 폴더로 `PDF/article`을 고릅니다.
   - 엑셀은 **📊 엑셀 선택**으로 `PDF/30_Articles_Topics_v3.xlsx`를 직접 고릅니다. 엑셀 파일이 `PDF/article` 바깥에 있어서 자동으로 읽히지 않습니다.
4. text LLM 버전의 Proposed 라벨은 `LLM_text_1 · LLM_text_2 · LLM_text_3`을 이어서 보여 줍니다. 결과 로그의 `proposed_source`에는 `LLM_text_1-3 (joined)`가 남습니다.
   - `HCI_simul/README.md`에는 아직 "LLM_text_1, 1순위"라고 적혀 있는데, text LLM 버전은 이 방식으로 바뀌었습니다.

## 라벨 파이프라인 실행

```bash
python3 -m venv .venv          # 이 환경에 ensurepip이 없으면: --without-pip 옵션 + get-pip.py
.venv/bin/pip install -r label_pipeline/requirements.txt
```

| 단계 | 명령 (프로젝트 루트에서 실행) | 출력 |
|---|---|---|
| 1. TF-IDF 후보 | `.venv/bin/python label_pipeline/step1_tfidf.py` | `output/intermediate/` |
| 2. LLM 선택 (최종) | `.venv/bin/python label_pipeline/step2_select.py --provider manual --manual-file label_pipeline/manual_results/claude_offline_v1.json --out-dir label_pipeline/output/selections --note "Claude (대화형, 고정 프롬프트, 오프라인 1회 생성)"` | `output/selections/` |
| 2'. 동작 테스트 | `.venv/bin/python label_pipeline/step2_select.py --provider manual --manual-file label_pipeline/tests/manual_test.json --docs 1,12,21,4,30` | `output/tests/step2_manual/` |
| 3. v2 엑셀과 지표 | `.venv/bin/python label_pipeline/step3_build.py` | `PDF/..._v2.xlsx`, `output/reports/` |
| 4. v3 엑셀 | `.venv/bin/python label_pipeline/step4_cue_filter.py` | `PDF/..._v3.xlsx`, `output/reports/cue_filter_log.csv` |

- **NLTK 데이터:** 1단계를 처음 실행할 때 `~/nltk_data`로 자동 다운로드됩니다.
- **최종 키워드:** 2단계는 `manual` 모드로 `manual_results/claude_offline_v1.json`을 읽습니다. 이 파일은 고정된 `prompt.txt`로 Claude가 대화 중에 한 번 만들었습니다. 선택할 때 description은 쓰지 않았습니다. 노출 사실 등 자세한 내용은 그 파일의 metadata에 있습니다.
- **API 사용:** `--provider claude` 또는 `--provider openai`도 쓸 수 있습니다. 이때 키는 `ANTHROPIC_API_KEY`나 `OPENAI_API_KEY` 환경변수로만 넣습니다.
- **재현성 확인 (2026-11-10):** 폴더를 정리한 뒤 전체를 다시 돌렸습니다.
  - 결과 파일 78개 중 75개가 바이트 단위로 같았습니다.
  - 나머지 3개(metadata JSON)는 생성 시각과 경로 필드만 달랐습니다.
  - v2와 v3 엑셀은 셀 값이 모두 같았습니다.

## 발표용 지표 (요약)

`label_pipeline/output/reports/cue_match_summary.csv`에 있습니다. cue_match는 라벨 3개 중 그 문서의 description에 나오는 단어(표제어 기준) 수입니다. 겹치는 쌍은 435개 문서 쌍 중 라벨이 겹치는 쌍의 수입니다.

| 방법 | 평균 cue_match | 겹치는 문서 쌍 |
|---|---|---|
| 단순 빈도 Top3 | 1.67 | 13 |
| TF-IDF Top3 | 1.80 | 5 |
| 최종 (TF-IDF+LLM) | 1.77 | 4 |
| 기존 LLM_text_1~3 | 2.20 | 4 |
| Baseline 제목 내용어 | 0.00 | 5 |

- description에는 제목 단어가 하나도 없습니다(30/30). 그래서 Baseline은 0점입니다.
- 이 지표는 v2 기준(description 10개)으로 계산했습니다.
- 규칙 기반 후보 추출의 한계는 `output/reports/known_limitations.txt`에 있습니다.

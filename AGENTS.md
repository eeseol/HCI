# AGENTS.md — AI 코딩 도우미용 프로젝트 안내

AI(Claude Code, Codex, Cursor 등)로 이 저장소를 개발할 때 먼저 읽을 문서입니다. 사람이 읽을 전체 안내는 `README.md`에 있습니다.

## 1. 프로젝트 한 줄 요약

HCI 수업 팀 프로젝트(Team 10). 브라우저 탭 재탐색 실험입니다. **Baseline**(아이콘과 제목)과 **Proposed**(텍스트 라벨) 탭 중 어느 쪽을 더 빨리 다시 찾는지 비교합니다.
- `HCI_simul/`: 실험 시뮬레이터 (정적 HTML/JS, 빌드 없음)
- `PDF/`: 실험 자극 (PDF 30개, 아티클 정보 엑셀)
- `label_pipeline/`: Proposed 라벨 생성 파이프라인 (Python, 시뮬레이터와 분리). TF-IDF로 후보를 뽑고, LLM이 그중 3개를 고릅니다.
- `docs/`: 발표 자료

## 2. 반드시 지킬 규칙

1. **원본 엑셀 `PDF/30_Articles_Topics.xlsx`는 절대 덮어쓰지 않습니다.** 새 버전은 항상 새 파일(`_v2`, `_v3`, …)로 저장합니다.
2. **본 실험 파일은 `PDF/30_Articles_Topics_v3.xlsx`입니다.** 라벨은 실험 전에 한 번 만들어 고정했습니다. 이유 없이 다시 생성하거나 바꾸지 않습니다.
3. **`label_pipeline/prompt.txt`는 고정본입니다.** 바꾸면 최종 라벨의 근거가 달라지므로, 팀이 명시적으로 결정할 때만 수정합니다.
4. **description_1~10은 참가자에게 보여 주는 과제 단서입니다.** 라벨이나 키워드를 고를 때 입력으로 쓰면 안 됩니다. 평가 지표(cue_match)에만 씁니다.
5. **시뮬레이터(`HCI_simul/`) 코드는 요청이 있을 때만 수정합니다.** 수정할 때는 요청 범위만 바꾸고, diff를 보여 주고 나서 커밋합니다.
6. **폴더와 파일 이름을 마음대로 바꾸지 않습니다.**
   - `PDF/`, `HCI_simul/`, 버전 폴더 이름이 바뀌면 브라우저가 기억한 폴더 선택과 팀원들의 사용 방식이 깨집니다.
   - 사용자가 만든 문서(발표 자료, 정리 노트)는 옮기거나 지우지 않습니다.
7. **단계별 작업이면 한 단계가 끝날 때마다 결과를 보여 주고 확인을 받습니다.** 다음 단계로 마음대로 넘어가지 않습니다.
8. **API 키는 환경변수(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)로만 받습니다.** 코드나 파일에 키를 쓰지 않습니다.
9. **메타데이터는 정직하게 적습니다.** 생성 방식(모델, 프롬프트, 날짜), 사람이나 AI가 미리 본 데이터 같은 노출 사실을 그대로 남깁니다.

## 3. 개발 환경

```bash
python3 -m venv .venv
# 이 머신에는 ensurepip이 없어서 위 명령이 실패할 수 있음 → 아래처럼:
python3 -m venv --without-pip .venv && curl -sSfL https://bootstrap.pypa.io/get-pip.py | .venv/bin/python
.venv/bin/pip install -r label_pipeline/requirements.txt
```

- **가상환경:** 항상 `.venv`를 씁니다. 전역으로 설치하지 않습니다. `.venv/`는 `.gitignore`에 들어 있습니다.
- **requirements.txt:** 직접 쓰는 패키지만 버전을 고정해 손으로 관리합니다. 시스템 PYTHONPATH에 ROS 패키지가 섞여 있어서 `pip freeze` 결과를 그대로 쓰면 안 됩니다.
- **NLTK 데이터:** punkt_tab, averaged_perceptron_tagger_eng, wordnet을 `~/nltk_data`에 둡니다. step1을 처음 실행할 때 자동으로 받습니다. `.venv` 안에 받으려 하면 폴더 권한 때문에 NLTK가 거부합니다.
- **선택 패키지:** `anthropic`과 `openai`는 해당 provider로 API를 호출할 때만 설치합니다.

## 4. 라벨 파이프라인

경로는 모두 `label_pipeline/paths.py` 한 곳에서 정합니다. 경로를 바꿀 때는 이 파일만 고칩니다. 명령은 프로젝트 루트에서 실행합니다.

| 단계 | 명령 | 출력 |
|---|---|---|
| 1. 후보 추출 | `.venv/bin/python label_pipeline/step1_tfidf.py` | `output/intermediate/` (clean_text, tokens.json, tfidf_candidates.csv 20개/문서) |
| 2. LLM 선택 | `.venv/bin/python label_pipeline/step2_select.py --provider manual --manual-file label_pipeline/manual_results/claude_offline_v1.json --out-dir label_pipeline/output/selections --note "Claude (대화형, 고정 프롬프트, 오프라인 1회 생성)"` | `output/selections/` |
| 3. v2 엑셀과 지표 | `.venv/bin/python label_pipeline/step3_build.py` | `PDF/..._v2.xlsx`, `output/reports/` |
| 4. v3 엑셀 | `.venv/bin/python label_pipeline/step4_cue_filter.py` | `PDF/..._v3.xlsx`, `output/reports/cue_filter_log.csv` |

- **2단계 provider:** `select_keywords()` 하나로 호출합니다. provider는 `manual`, `claude`, `openai` 중에서 고릅니다.
  - 기본 모델은 `claude-opus-5-5`입니다. openai는 `--model`을 반드시 지정합니다.
  - 출력은 형식, 3개, 중복 없음, 후보 안에서만 골랐는지를 검증합니다. 규칙을 어기면 `SelectionError`를 냅니다.
- **2단계 출력 위치:** `--out-dir`를 주지 않으면 결과는 `output/tests/`에 저장됩니다. 최종 결과를 테스트 실행으로 덮어쓰지 않게 하기 위해서입니다.
- **후보 순서:** 프롬프트에 넣는 후보는 **알파벳 순**입니다. 순위를 보여 주면 LLM이 앞쪽 후보를 고르는 순서 편향이 생기기 때문입니다.
- **1단계 전처리 요점:**
  - pypdf로 추출합니다. pdftotext는 단어를 많이 쪼개서 쓰지 않습니다.
  - 남은 깨진 단어는 사전(`/usr/share/dict/words`)으로 복원합니다.
  - 품사가 NN, NNS, JJ인 단어만 남기고 WordNet 표제어로 바꿉니다.
  - 고유명사는 대문자 쓰임새를 보고 거릅니다.
  - 본문에서 제목 줄을 지웁니다. 파일명 제목과 PDF 안 제목은 구두점이 달라서 영숫자만 비교합니다.
- **알려진 한계:** `output/reports/known_limitations.txt`에 있습니다. firefighting, patrol, sheriff처럼 품사 태깅 때문에 빠진 사례입니다. 발표에서 한계로 쓰려고 **일부러 고치지 않은** 것입니다.

### 수정한 뒤 확인하는 방법
- 파이프라인 코드를 바꾸면 1→2→3→4를 다시 돌리고 결과 파일의 sha256을 이전과 비교합니다.
- 다를 수 있는 것:
  - metadata JSON의 `generated_at`, 경로 필드
  - 엑셀 파일. openpyxl이 저장 시각을 파일 안에 써서 해시가 바뀝니다. 엑셀은 **셀 값**으로 비교합니다.
- 내용이 같으면 커밋된 엑셀을 `git checkout -- PDF/*_v2.xlsx PDF/*_v3.xlsx`로 되돌려, 의미 없는 바이너리 변경을 커밋하지 않습니다.

## 5. 시뮬레이터 핵심 사실 (`HCI_simul/common/app.js`)

- **실행:** `HCI_simul/`에서 `python -m http.server 8000`을 실행하고 버전 폴더의 `index.html`을 엽니다. 세 버전이 `common/app.js`와 `style.css`를 함께 씁니다.
- **엑셀 읽기:** `parseWorkbook()`에서 헤더 행을 찾은 뒤, 열을 **이름으로** 읽습니다(`PDF 파일명`, `Article Title`, `description_1~10`, `LLM_text_1~5`, `title_text_LLM_1~3`).
- **빈 description 셀:** `.filter(Boolean)`으로 건너뜁니다. 그래서 `descNo`와 로그의 `cue_desc_no`는 엑셀 열 번호가 아니라 **남은 문장 중 몇 번째인지**입니다.
- **text LLM 버전의 Proposed 라벨:** `LLM_text_1 · LLM_text_2 · LLM_text_3`을 이어 붙입니다(`autoProposed`). 로그의 `proposed_source`에는 `LLM_text_1-3 (joined)`가 남습니다.
- **탭 폭:** 고정이라, 긴 라벨은 오른쪽이 흐려지며 잘립니다.
- **읽기 단계:** 탭 라벨이 "아티클 n / N"으로 고정되어 있어 조건 라벨이 미리 드러나지 않습니다.
- **엑셀 자동 로드:** 선택한 PDF 폴더 바로 아래에 있는 엑셀을 하나만 읽습니다. 엑셀은 `PDF/`(PDF 폴더 `PDF/article`의 바깥)에 있으므로 설정에서 "엑셀 선택"으로 v3를 직접 고릅니다.
- **본 실험 설정:** 아티클 30개, 조건당 5회 또는 10회라서 아티클마다 정답이 1~2번입니다. v3는 문서마다 description이 5개 이상 남아 있으므로 단서가 반복되지 않습니다.

## 6. 자주 걸리는 함정

- **openpyxl `ws.cell(r, c, None)`은 셀을 비우지 않습니다.** 비우려면 `ws.cell(r, c).value = None`을 씁니다.
- **엑셀 표(`K5Articles`)의 범위는 A~F 열뿐입니다.** 맨 뒤에 열을 추가해도 표 정의는 바꿀 필요가 없습니다.
- **description은 제목 단어를 일부러 피해서 쓰였습니다(30/30).** 제목 단어를 라벨로 고르면 cue_match가 구조적으로 0점이 됩니다. 지표를 해석할 때 꼭 함께 언급합니다.
- **NLTK 품사 태거는 문장 첫머리의 대문자 일반명사를 NNP로 잘못 태깅합니다.** 동명사를 동사로 보는 경우도 있습니다.

## 7. Git 관례

- 작업은 브랜치에서 하고, 확인을 받은 뒤 `main`에 머지합니다. 커밋과 푸시는 요청이 있을 때만 합니다.
- 커밋 메시지는 무엇을, 왜 바꿨는지 적고, 검증 결과(해시 비교 등)도 남깁니다.
- 작업과 관계없는 파일은 커밋에 넣지 않습니다. 특히 사용자가 만든 문서나 로컬 메모가 그렇습니다.

## 8. 남은 확인 사항

- PDF 폴더 이름이 문서마다 다릅니다. `HCI_simul/README.md`는 `article_body_only`, `README.txt`와 실제 폴더는 `PDF/article`입니다. 팀원에게 확인하는 중입니다.
- `HCI_simul/README.md`의 "엑셀 버전 두 개는 … 1순위 단어를 씁니다" 문장은 text LLM 버전에 더 이상 맞지 않습니다(이어 표시로 바뀜). 아직 고치지 않았습니다.

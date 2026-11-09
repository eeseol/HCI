# HCI 탭 재탐색 실험 시뮬레이터

브라우저 탭에 무엇을 보여줘야 사용자가 원하는 탭을 빨리 다시 찾는지 비교하는 실험 도구입니다.

## 버전

모든 버전은 **IV1 = Baseline vs Proposed**, **IV2 = 탭 폭 narrow / middle / wide**의 2×3 설계를 따릅니다. Baseline은 모든 버전이 같고(arXiv 아이콘 + 제목, 또는 랜덤 DOI), **Proposed 라벨을 만드는 방법만 다릅니다.**

| 폴더 | Proposed 라벨 (아이콘 없이 텍스트만) |
|---|---|
| `Baseline_icon+title_vs_Proposed_text_cloud/` | PDF 본문에서 가장 많이 나온 단어 (빈도 Top-1) |
| `Baseline_icon+title_vs_Proposed_text_LLM/` | 엑셀 `LLM_text_1 · 2 · 3` 이어 표시 (v3 엑셀) |
| `Baseline_icon+title_vs_Proposed_text_title_LLM/` | 엑셀 `title_text_LLM_1` — LLM이 제목에서 뽑은 중요 단어, 1순위 |

- 엑셀 버전 두 개는 탭 폭과 관계없이 1순위 단어를 씁니다. 설정 → 3에서 다른 순위로 바꿀 수 있습니다.
- 각 버전 폴더의 `index.html`을 Chrome으로 열면 됩니다.
- 실제 코드는 **`common/`**(`app.js`, `style.css`)을 함께 씁니다. 그러니 폴더를 옮길 때는 `HCI_261109` 전체를 옮기세요.
- 설정, 기록, PDF 캐시는 버전마다 따로 저장됩니다.
- 자세한 사용법은 `Baseline_icon+title_vs_Proposed_text_cloud/README.md`에 있습니다.

## Proposed 공통: 위치 숫자 + 10개 단위 색

- **위치 숫자:** 세 버전 모두 Proposed 라벨 앞에 탭 위치 숫자를 붙입니다. 제일 왼쪽 탭이 0이고, 숫자 바로 뒤에 텍스트가 옵니다(예: `6Rain`). 숫자는 0~9가 반복됩니다.
- **10개 단위 색:** 탭이 10개를 넘으면 10개 단위로 탭 색이 바뀝니다. 0~9는 흰색(기본), 10~19는 옅은 회색, 20~29는 흰색, 30~39는 회색 순서입니다.
- **적용 범위:** Proposed 조건에만 적용되고 Baseline은 그대로입니다. 설정 → 3에서 끌 수 있습니다.
- **기록:** CSV의 `tab_labels`에는 숫자가 붙은 실제 표시 라벨이 남습니다.

## 준비물

1. **PDF 폴더**: 본문만 남긴 PDF를 씁니다(`.../Project/PDF/article_body_only`). 설정 → 📁 폴더 선택으로 고릅니다.
2. **아티클 정보 엑셀**: `30_Articles_Topics.xlsx`를 씁니다. 설정 → 📊 엑셀 선택으로 고르면 기억됩니다. PDF 폴더 안에 두면 자동으로 읽습니다.

   | 엑셀 열 | 용도 |
   |---|---|
   | `PDF 파일명` | PDF와 연결 (파일명이 같아야 함, 다르면 앞의 번호로 연결) |
   | `Article Title` | Baseline 제목 |
   | `description_1~10` | **과제 단서** |
   | `LLM_text_1~5` | text_LLM 버전의 Proposed 라벨 |
   | `title_text_LLM_1~3` | text_title_LLM 버전의 Proposed 라벨 |

## 과제 단서 = description

- 과제박스의 "이 탭을 찾으세요" 지시는 제목이 아니라 **내용 설명(description)**입니다. 단순히 글자를 맞춰 보는 과제가 되지 않게 하기 위해서입니다.
- **배정 방식**: 참가자마다, 아티클마다 description 10개의 순서를 섞어 둡니다. 그 아티클이 k번째로 정답이 될 때 k번째 description을 씁니다.
  - 한 참가자 안에서 같은 아티클에 같은 description이 반복되지 않습니다. 기본 설정에서는 아티클마다 정답이 6번이고 description이 10개라 충분합니다.
  - 참가자가 다르면 순서가 달라집니다.
  - 참가자 번호와 시드로 정해지므로, 새로고침해도 결과가 같습니다.
- CSV에는 `cue`(실제로 보여준 문장)와 `cue_desc_no`(몇 번 description인지)가 남습니다.

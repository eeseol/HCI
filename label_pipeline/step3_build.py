"""3단계: 최종 키워드 → 30_Articles_Topics_v2.xlsx + 비교표/cue_match 지표.

입력
  - output/selections/selections.json, metadata.json    (2단계 manual 모드로 검증된 최종 키워드)
  - output/intermediate/tokens.json, tfidf_candidates.csv (1단계: 단순 빈도 / TF-IDF Top3)
  - PDF/30_Articles_Topics.xlsx                          (원본: 읽기만 함, 절대 덮어쓰지 않음)
출력
  - PDF/30_Articles_Topics_v2.xlsx
      LLM_text_1~5 기존 값 → LLM_old_1~5 (새 열)로 이동, LLM_text_1~3 = 최종 키워드, LLM_text_4~5 = 비움
  - output/reports/comparison.csv        : 문서별 방법 비교 + cue_match
  - output/reports/cue_match_summary.csv : 방법별 평균 cue_match, 겹치는 문서 쌍 수(구분성)
  - output/reports/overlap_pairs.csv     : 방법별로 키워드가 겹치는 문서 쌍 목록
  - output/reports/step3_metadata.json

cue_match 정의
  - description_1~10 문장을 토큰화·소문자화 → 각 토큰의 WordNet 표제어(명사·동사·형용사) 집합 = 그 문서의 단서 집합
  - 라벨 단어도 같은 방식으로 표제어 집합을 만들어, 단서 집합과 교집합이 있으면 1 (여러 단어 라벨은 단어 중 하나라도)
  - cue_match = 일치한 라벨 수 (3개 라벨 → 0~3).  Baseline 제목은 내용어 수가 문서마다 달라 cue_rate(=cue_match/라벨 수)도 함께 보고
구분성
  - 30개 문서 435쌍 중, 두 문서의 라벨 표제어 집합이 하나라도 겹치는 쌍의 수 (작을수록 라벨끼리 잘 구분됨)
"""
import csv
import datetime
import hashlib
import itertools
import json
import os
import re
from collections import Counter

import nltk
from nltk.stem import WordNetLemmatizer
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from copy import copy
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

from paths import CANDIDATES_CSV, REPORTS, ROOT, SELECTIONS, TOKENS_JSON, XLSX_V1, XLSX_V2

SRC_XLSX = XLSX_V1
DST_XLSX = XLSX_V2
STEP2_DIR = SELECTIONS

METHODS = ["freq_top3", "tfidf_top3", "final", "old_llm_top3", "baseline_title"]
lem = WordNetLemmatizer()


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def lemma_forms(word):
    w = word.lower()
    return {w} | {lem.lemmatize(w, p) for p in ("n", "v", "a")}


def label_lemmas(label):
    """라벨(한 단어 또는 여러 단어) → 표제어 집합"""
    return set().union(*[lemma_forms(t) for t in re.findall(r"[A-Za-z]+", label)] or [set()])


def cue_set(descriptions):
    s = set()
    for d in descriptions:
        for t in nltk.word_tokenize(d.replace("’", "'")):
            if t.isalpha():
                s |= lemma_forms(t)
    return s


def title_content_words(title):
    """Baseline 제목의 내용어: 소문자, 영문자만, 불용어(sklearn)·3글자 미만 제외 (1단계와 같은 기준)"""
    return [t for t in re.findall(r"[a-z]+", title.lower().replace("’", "'"))
            if len(t) >= 3 and t not in ENGLISH_STOP_WORDS]


def read_sheet():
    wb = load_workbook(SRC_XLSX)  # 원본은 읽기만
    ws = wb.active
    hdr_row = next(r for r in range(1, 20) if any(c.value == "description_1" for c in ws[r]))
    col = {c.value: c.column for c in ws[hdr_row] if c.value}
    return wb, ws, hdr_row, col


def main():
    with open(os.path.join(STEP2_DIR, "selections.json"), encoding="utf-8") as f:
        sel = json.load(f)
    with open(os.path.join(STEP2_DIR, "metadata.json"), encoding="utf-8") as f:
        step2_meta = json.load(f)
    bad = [k for k, v in sel.items() if not v.get("keywords")]
    assert not bad and len(sel) == 30, f"invalid/missing selections: {bad}"

    with open(TOKENS_JSON, encoding="utf-8") as f:
        tokens = json.load(f)
    tfidf = {}
    with open(CANDIDATES_CSV, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            tfidf.setdefault(int(r["doc_id"]), []).append(r["word"])

    wb, ws, hdr_row, col = read_sheet()
    rows = {}
    for r in range(hdr_row + 1, ws.max_row + 1):
        no = ws.cell(r, col["No."]).value
        if no is None:
            continue
        no = int(no)
        rows[no] = {
            "row": r,
            "title": ws.cell(r, col["Article Title"]).value,
            "desc": [v for i in range(1, 11) if (v := ws.cell(r, col[f"description_{i}"]).value)],
            "old": [ws.cell(r, col[f"LLM_text_{i}"]).value for i in range(1, 6)],
        }
    assert sorted(rows) == list(range(1, 31))

    # ---------------- 방법별 라벨
    labels = {}
    for i in range(1, 31):
        c = Counter(tokens[str(i)])
        freq = [w for w, _ in sorted(c.items(), key=lambda x: (-x[1], x[0]))[:3]]  # 동점은 알파벳순
        labels[i] = {
            "freq_top3": freq,
            "tfidf_top3": tfidf[i][:3],
            "final": sel[str(i)]["keywords"],
            "old_llm_top3": [v for v in rows[i]["old"][:3] if v],
            "baseline_title": title_content_words(rows[i]["title"]),
        }

    # ---------------- cue_match
    cues = {i: cue_set(rows[i]["desc"]) for i in rows}
    cue = {i: {m: [bool(label_lemmas(w) & cues[i]) for w in labels[i][m]] for m in METHODS} for i in rows}

    # ---------------- 구분성: 라벨 표제어가 겹치는 문서 쌍
    overlaps = {m: [] for m in METHODS}
    for m in METHODS:
        lsets = {i: set().union(*[label_lemmas(w) for w in labels[i][m]] or [set()]) for i in rows}
        for a, b in itertools.combinations(sorted(rows), 2):
            shared = lsets[a] & lsets[b]
            if shared:
                overlaps[m].append((a, b, sorted(shared)))

    # ---------------- comparison.csv
    with open(os.path.join(REPORTS, "comparison.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["doc_id", "title",
                    "freq_top3", "tfidf_top3", "final_keywords", "old_LLM_text_1", "old_LLM_text_2",
                    "old_LLM_text_3", "baseline_title_words",
                    "cue_match_freq", "cue_match_tfidf", "cue_match_final", "cue_match_old_llm",
                    "cue_match_title", "n_title_words", "matched_final"])
        for i in sorted(rows):
            L, C = labels[i], cue[i]
            old = rows[i]["old"][:3]
            w.writerow([i, rows[i]["title"],
                        " / ".join(L["freq_top3"]), " / ".join(L["tfidf_top3"]), " / ".join(L["final"]),
                        *[v or "" for v in old], " / ".join(L["baseline_title"]),
                        sum(C["freq_top3"]), sum(C["tfidf_top3"]), sum(C["final"]), sum(C["old_llm_top3"]),
                        sum(C["baseline_title"]), len(L["baseline_title"]),
                        " / ".join(k for k, ok in zip(L["final"], C["final"]) if ok)])

    # ---------------- summary
    names = {"freq_top3": "단순 빈도 Top3", "tfidf_top3": "TF-IDF Top3", "final": "최종(TF-IDF+LLM)",
             "old_llm_top3": "기존 LLM_text_1~3", "baseline_title": "Baseline 제목 내용어"}
    summary = []
    for m in METHODS:
        n_lab = sum(len(labels[i][m]) for i in rows)
        n_hit = sum(sum(cue[i][m]) for i in rows)
        summary.append({
            "method": m, "name": names[m],
            "mean_cue_match": round(n_hit / 30, 3),
            "mean_cue_rate": round(sum(sum(cue[i][m]) / len(cue[i][m]) for i in rows if cue[i][m]) / 30, 3),
            "docs_with_cue_match_ge1": sum(1 for i in rows if any(cue[i][m])),
            "mean_labels_per_doc": round(n_lab / 30, 2),
            "overlapping_pairs": len(overlaps[m]),
            "total_pairs": 435,
        })
    with open(os.path.join(REPORTS, "cue_match_summary.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(summary[0]))
        w.writeheader()
        w.writerows(summary)
    with open(os.path.join(REPORTS, "overlap_pairs.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["method", "doc_a", "doc_b", "shared_lemmas"])
        for m in METHODS:
            for a, b, s in overlaps[m]:
                w.writerow([m, a, b, " ".join(s)])

    # ---------------- v2 엑셀 (원본 로드본을 수정해 새 경로로만 저장)
    assert os.path.abspath(DST_XLSX) != os.path.abspath(SRC_XLSX)
    last = ws.max_column
    src_hdr = ws.cell(hdr_row, col["LLM_text_1"])
    for k in range(1, 6):
        c = last + k
        h = ws.cell(hdr_row, c, f"LLM_old_{k}")
        h.font, h.fill, h.border, h.alignment = copy(src_hdr.font), copy(src_hdr.fill), copy(src_hdr.border), copy(src_hdr.alignment)
        ws.column_dimensions[get_column_letter(c)].width = 16
    for i, info in rows.items():
        r = info["row"]
        for k in range(1, 6):
            src = ws.cell(r, col[f"LLM_text_{k}"])
            dst = ws.cell(r, last + k, info["old"][k - 1])
            dst.font, dst.fill, dst.border, dst.alignment = copy(src.font), copy(src.fill), copy(src.border), copy(src.alignment)
        for k in range(1, 6):
            kw = labels[i]["final"][k - 1].capitalize() if k <= 3 else None  # 기존 라벨 표기(Title-case)에 맞춤
            ws.cell(r, col[f"LLM_text_{k}"]).value = kw  # ws.cell(r, c, None)은 값을 지우지 않으므로 직접 대입
    wb.save(DST_XLSX)

    meta = {
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "generation_note": "Claude (대화형, 고정 프롬프트, 오프라인 1회 생성)",
        "description_used_in_selection": False,
        "description_note": "선택 시 description 미사용 (description_1~10은 cue_match 평가에만 사용)",
        "source_xlsx": os.path.relpath(SRC_XLSX, ROOT), "source_xlsx_sha256": sha256(SRC_XLSX),
        "output_xlsx": os.path.relpath(DST_XLSX, ROOT),
        "xlsx_changes": "LLM_text_1~5 기존 값 → LLM_old_1~5(새 열, 맨 뒤)로 이동. LLM_text_1~3 = 최종 키워드"
                        "(Title-case 표기), LLM_text_4~5 = 비움. 그 외 열은 원본 그대로.",
        "selection_metadata": step2_meta,
        "cue_match_definition": "description_1~10 토큰의 WordNet 표제어(n/v/a) 집합과 라벨 표제어 집합의 교집합 여부. "
                                "문서당 일치한 라벨 수.",
        "distinctiveness_definition": "435개 문서 쌍 중 라벨 표제어 집합이 하나라도 겹치는 쌍의 수",
        "baseline_title_definition": "Article Title의 내용어 (소문자, 불용어·3글자 미만 제외), 개수는 문서마다 다름",
        "summary": summary,
    }
    with open(os.path.join(REPORTS, "step3_metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    for s in summary:
        print(f"{s['name']:<22} mean_cue_match={s['mean_cue_match']:.2f}  cue_rate={s['mean_cue_rate']:.2f}  "
              f"docs>=1={s['docs_with_cue_match_ge1']:>2}/30  labels/doc={s['mean_labels_per_doc']}  "
              f"overlap_pairs={s['overlapping_pairs']}/435")


if __name__ == "__main__":
    main()

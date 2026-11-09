"""4단계: v2 엑셀 → v3 엑셀. 최종 키워드(LLM_text_1~3)와 표제어가 겹치는 description 셀을 비움.

입력 : PDF/30_Articles_Topics_v2.xlsx (읽기만 함), output/step2_final/selections.json
출력 : PDF/30_Articles_Topics_v3.xlsx
       output/cue_filter_log.csv  (비운 셀 목록 + 겹친 표제어/키워드)
겹침 판정은 step3_build.py 의 cue_match 와 동일 (WordNet 표제어 n/v/a, 문장 단위).
"""
import csv
import json
import os

from openpyxl import load_workbook

from step3_build import OUT, ROOT, STEP2_DIR, cue_set, label_lemmas

SRC_XLSX = os.path.join(ROOT, "PDF", "30_Articles_Topics_v2.xlsx")
DST_XLSX = os.path.join(ROOT, "PDF", "30_Articles_Topics_v3.xlsx")


def main():
    with open(os.path.join(STEP2_DIR, "selections.json"), encoding="utf-8") as f:
        sel = json.load(f)
    wb = load_workbook(SRC_XLSX)
    ws = wb.active
    hdr = next(r for r in range(1, 20) if any(c.value == "description_1" for c in ws[r]))
    col = {c.value: c.column for c in ws[hdr] if c.value}

    log, kept = [], {}
    for r in range(hdr + 1, ws.max_row + 1):
        no = ws.cell(r, col["No."]).value
        if no is None:
            continue
        no = int(no)
        kws = sel[str(no)]["keywords"]
        # v2 엑셀의 LLM_text_1~3 과 최종 키워드가 같은지 확인 (Title-case 표기 차이만 허용)
        assert [ws.cell(r, col[f"LLM_text_{k}"]).value.lower() for k in (1, 2, 3)] == kws, no
        kw_lemmas = {k: label_lemmas(k) for k in kws}
        kept[no] = 0
        for i in range(1, 11):
            cell = ws.cell(r, col[f"description_{i}"])
            if not cell.value:
                continue
            cues = cue_set([cell.value])
            hit = {k: sorted(l & cues) for k, l in kw_lemmas.items() if l & cues}
            if hit:
                log.append([no, ws.cell(r, col["Article Title"]).value, f"description_{i}", cell.coordinate,
                            cell.value, " / ".join(hit), " ".join(sorted(set().union(*map(set, hit.values()))))])
                cell.value = None
            else:
                kept[no] += 1

    assert os.path.abspath(DST_XLSX) not in (os.path.abspath(SRC_XLSX),
                                            os.path.abspath(os.path.join(ROOT, "PDF", "30_Articles_Topics.xlsx")))
    wb.save(DST_XLSX)
    with open(os.path.join(OUT, "cue_filter_log.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["doc_id", "title", "column", "cell", "removed_description", "matched_keywords",
                    "shared_lemmas"])
        w.writerows(log)
    print(f"cleared={len(log)} cells, kept={sum(kept.values())}, per-doc kept min={min(kept.values())} "
          f"max={max(kept.values())}")


if __name__ == "__main__":
    main()

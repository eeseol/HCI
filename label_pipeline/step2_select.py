"""2단계 실행: TF-IDF 후보 → select_keywords() → 결과 + 메타데이터 저장.

예)
  .venv/bin/python label_pipeline/step2_select.py --provider manual \
      --manual-file label_pipeline/tests/manual_test.json --docs 1,12,21
  ANTHROPIC_API_KEY=... .venv/bin/python label_pipeline/step2_select.py --provider claude
  OPENAI_API_KEY=...    .venv/bin/python label_pipeline/step2_select.py --provider openai --model <model>

출력 (--out-dir, 기본 label_pipeline/output/step2_<provider>/):
  - selections.json  : doc별 {title, candidates, keywords, raw_output | error}
  - metadata.json    : provider, model, 생성 일시, 프롬프트 원문·해시, 입력 CSV 해시 등
  - prompts/NN.txt   : 문서별로 실제 LLM에 들어간(들어갈) 완성 프롬프트
"""
import argparse
import csv
import datetime
import hashlib
import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from llm_select import (CANDIDATE_ORDER, CANDIDATE_ORDER_REASON, DEFAULT_MODELS, PROMPT_PATH, SelectionError, first_paragraph,  # noqa: E402
                        load_prompt_template, select_keywords)

OUT = os.path.join(HERE, "output")
CANDIDATES_CSV = os.path.join(OUT, "tfidf_candidates.csv")
CLEAN_DIR = os.path.join(OUT, "clean_text")


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_candidates():
    docs = defaultdict(lambda: {"title": None, "candidates": []})
    with open(CANDIDATES_CSV, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            d = docs[int(r["doc_id"])]
            d["title"] = r["title"]
            d["candidates"].append(r["word"])  # CSV가 rank 순으로 저장되어 있음
    return dict(sorted(docs.items()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=list(DEFAULT_MODELS), default="manual")
    ap.add_argument("--model", default=None)
    ap.add_argument("--manual-file", default=None, help="manual provider용 결과 JSON")
    ap.add_argument("--docs", default=None, help="쉼표로 구분한 doc_id (기본: 전체)")
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--note", default=None, help="메타데이터에 남길 생성 방식 설명")
    args = ap.parse_args()

    out_dir = args.out_dir or os.path.join(OUT, f"step2_{args.provider}")
    os.makedirs(os.path.join(out_dir, "prompts"), exist_ok=True)
    template = load_prompt_template()
    docs = load_candidates()
    ids = [int(x) for x in args.docs.split(",")] if args.docs else list(docs)

    manual_meta = {}
    if args.provider == "manual":
        with open(args.manual_file, encoding="utf-8") as f:
            manual_meta = json.load(f).get("metadata", {})

    selections, n_ok = {}, 0
    for i in ids:
        d = docs[i]
        with open(os.path.join(CLEAN_DIR, f"{i:02d}.txt"), encoding="utf-8") as f:
            para = first_paragraph(f.read())
        entry = {"title": d["title"], "first_paragraph": para,
                 "candidates": d["candidates"]}  # TF-IDF 순위 순 (프롬프트에는 알파벳 순으로 들어감)
        try:
            kws, raw, prompt = select_keywords(i, d["title"], para, d["candidates"], provider=args.provider,
                                               model=args.model, manual_path=args.manual_file,
                                               template=template)
            entry.update(keywords=kws, raw_output=raw)
            n_ok += 1
        except SelectionError as e:
            from llm_select import build_prompt
            prompt = build_prompt(template, d["title"], para, d["candidates"])
            entry.update(keywords=None, error=str(e))
        with open(os.path.join(out_dir, "prompts", f"{i:02d}.txt"), "w", encoding="utf-8") as f:
            f.write(prompt)
        selections[str(i)] = entry

    meta = {
        "provider": args.provider,
        "model": args.model or DEFAULT_MODELS[args.provider] or manual_meta.get("model"),
        "generation_note": args.note or manual_meta.get("generation_note"),
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "manual_file": os.path.relpath(args.manual_file, HERE) if args.manual_file else None,
        "manual_file_metadata": manual_meta or None,
        "prompt_file": os.path.relpath(PROMPT_PATH, HERE),
        "prompt_sha256": sha256(PROMPT_PATH),
        "prompt_template": template,
        "candidates_csv": os.path.relpath(CANDIDATES_CSV, HERE),
        "candidates_csv_sha256": sha256(CANDIDATES_CSV),
        "candidate_order_in_prompt": CANDIDATE_ORDER,
        "candidate_order_reason": CANDIDATE_ORDER_REASON,
        "n_candidates_per_doc": len(next(iter(docs.values()))["candidates"]),
        "docs": ids,
        "n_valid": n_ok,
        "n_failed": len(ids) - n_ok,
    }
    with open(os.path.join(out_dir, "selections.json"), "w", encoding="utf-8") as f:
        json.dump(selections, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    for i in ids:
        e = selections[str(i)]
        status = e["keywords"] if e["keywords"] else f"INVALID -> {e['error']}"
        print(f"[{i:02d}] {e['title']}: {status}")
    print(f"valid={n_ok}/{len(ids)}  ->  {os.path.relpath(out_dir, os.path.dirname(HERE))}")


if __name__ == "__main__":
    main()

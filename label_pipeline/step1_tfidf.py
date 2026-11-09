"""1단계: PDF 30개 → 전처리 → TF-IDF 상위 20개 후보 추출.

출력 (label_pipeline/output/intermediate/, 경로는 paths.py):
  - clean_text/<doc_id>.txt   : 머리말/꼬리말/문제 제거 후 본문 (2단계 '첫 문단' 입력용)
  - tokens.json               : 문서별 전처리 토큰 (POS 필터+표제어, 단순 빈도 비교용)
  - tfidf_candidates.csv      : doc_id, title, rank, word, tfidf
  - step1_log.txt             : 전처리 통계 (단어 복원, 문제 절단, 표제어 변환 등)

후보 규칙: NLTK 품사 태깅 후 일반명사(NN, NNS)·형용사(JJ)만 남김.
          고유명사(NNP, NNPS)와 동사·부사 등은 제외 → 등장인물 이름·일반 동사가 후보에서 빠짐.
          + 태거 오류 보정: NNP로 태깅된 적 있고 코퍼스에서 소문자로 쓰인 적 없는 단어는 고유명사로 일괄 제외.
표제어:   WordNet lemmatizer (명사 n / 형용사 a) → geese→goose 같은 불규칙 복수형도 처리.
NLTK 데이터: punkt_tab, averaged_perceptron_tagger_eng, wordnet (없으면 자동 다운로드, ~/nltk_data)

실행: .venv/bin/python label_pipeline/step1_tfidf.py
"""
import csv
import glob
import json
import os
import re
from collections import Counter

import nltk
from nltk.stem import WordNetLemmatizer
from pypdf import PdfReader

from paths import CANDIDATES_CSV, CLEAN_DIR, PDF_DIR, STEP1_LOG, TOKENS_JSON
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer

DICT_PATH = "/usr/share/dict/words"
TOP_K = 20
MIN_LEN = 3

# 페이지마다 반복되는 머리말/꼬리말 (Grade 4/5 모두 존재)
BOILERPLATE = [
    r"Grade\s+\d+\s+Reading\s+Comprehension\s+Worksheet",
    r"Read\s+the\s+short\s+story\.\s*Then\s+answer\s+each\s+question\.",
    r"Reading\s+and\s+Math\s+for\s+K-5",
    r"©\s*www\.k5learning\.com",
]
# 뒤쪽 문제 부분 시작 표지: "Questions" 헤더 또는 줄 맨 앞 "1." / "1)"
QUESTIONS_START = re.compile(r"^\s*(Questions?\b|1[.)]\s)", re.M)

STOP_WORDS = set(ENGLISH_STOP_WORDS)

# 후보로 남길 품사 (Penn Treebank 태그) → WordNet 품사
KEEP_POS = {"NN": "n", "NNS": "n", "JJ": "a"}
NLTK_PACKAGES = {
    "punkt_tab": "tokenizers/punkt_tab",
    "averaged_perceptron_tagger_eng": "taggers/averaged_perceptron_tagger_eng",
    "wordnet": "corpora/wordnet",
}


def ensure_nltk_data():
    for pkg, res in NLTK_PACKAGES.items():
        try:
            nltk.data.find(res)
        except LookupError:
            nltk.download(pkg, quiet=True)


def load_dictionary():
    with open(DICT_PATH, encoding="utf-8", errors="ignore") as f:
        return {w.strip().lower() for w in f if w.strip().isalpha()}


def extract_pages(path):
    return [p.extract_text() or "" for p in PdfReader(path).pages]


def strip_boilerplate(page):
    for pat in BOILERPLATE:
        page = re.sub(pat, " ", page)
    return page


def cut_questions(text):
    m = QUESTIONS_START.search(text)
    return (text[: m.start()], True) if m else (text, False)


def remove_title(text, title):
    """본문에서 제목 줄을 1회 제거 (제목은 2단계에서 별도 입력).
    파일명 제목과 PDF 제목은 대소문자·구두점이 다를 수 있어 영숫자 단어열만 비교한다.
    예) 'Curious about Careers - Firefighters' ↔ 'Curious About Careers: Firefighters'
        "Emma's ..." ↔ 'Emma’s ...',  'Bring Your Pet Day Disaster' ↔ '“Bring Your Pet Day” Disaster'"""
    words = re.findall(r"[A-Za-z0-9]+", title)
    pat = r"[“\"']?" + r"[^A-Za-z0-9]+".join(map(re.escape, words)) + r"[”\"']?"
    new, n = re.subn(pat, " ", text, count=1, flags=re.I)
    return new, n == 1


def repair_splits(text, dictionary, log):
    """PDF 추출 시 깨진 단어('hel p', 'Firefighte rs') 복원.
    인접 두 조각을 붙인 것이 사전 단어이고, 조각 중 하나가 사전에 없는(또는 a/I 이외의 한 글자인)
    경우에만 붙인다. 'in to'처럼 둘 다 정상 단어인 경우는 건드리지 않는다."""
    def is_word(w):
        w = w.lower()
        if len(w) == 1:
            return w in ("a", "i")
        return w in dictionary

    def make_fix(max_words):
        # max_words=0: 두 조각 모두 비단어인 경우만 ('o utside'), 1: 한쪽만 비단어 ('hel p')
        def fix(m):
            a, b = m.group(1), m.group(2)
            if (a + b).lower() in dictionary and is_word(a) + is_word(b) <= max_words:
                log[f"{a} {b}"] += 1
                return a          # 공백만 제거 (b는 lookahead라 그대로 남음)
            return m.group(0)
        return fix

    # 같은 줄 안에서 공백 하나로 떨어진 알파벳 조각 쌍. 더 확실한 경우(둘 다 비단어)를 먼저 처리해
    # 'go o utside' → 'go outside' 처럼 잘못 붙는 것을 막는다.
    # b는 lookahead로만 보므로 'go o utside'에서 'o utside' 쌍도 검사된다.
    pair = re.compile(r"(?<![A-Za-z'’])([A-Za-z]+) (?=([a-z]+)(?![A-Za-z'’]))")
    for max_words in (0, 1):
        prev = None
        while prev != text:
            prev = text
            text = pair.sub(make_fix(max_words), text)
    return text


def tag_text(text):
    """원문 대소문자를 유지한 채 문장 단위 품사 태깅 → [(word, tag), ...]"""
    text = text.replace("’", "'").replace("‘", "'")
    text = re.sub(r"\s*•\s*", " . ", text)   # 글머리표 항목을 문장 경계로 취급 ('• Obtain warrants ...')
    text = text.replace("\n", " ")
    out = []
    for sent in nltk.sent_tokenize(text):
        tagged = nltk.pos_tag(nltk.word_tokenize(sent))
        # 문장 첫 단어(따옴표 등 구두점 제외) 여부를 함께 기록: 문장 첫머리 대문자는 고유명사 근거가 아님
        first = next((k for k, (w, _) in enumerate(tagged) if w.isalpha()), None)
        out.extend((w, t, k == first) for k, (w, t) in enumerate(tagged))
    return out


def find_proper_nouns(tagged_docs, lemmatizer):
    """태거가 이름을 가끔 JJ/NN으로 잘못 태깅하는 경우(Trish/JJ 등)를 막기 위한 보정.
    아래 세 조건을 모두 만족하면 고유명사로 간주:
      (1) 코퍼스 어디선가 NNP/NNPS로 태깅됨
      (2) 코퍼스 전체에서 소문자로 시작해 쓰인 적이 없음 (mom처럼 소문자로도 쓰이면 제외)
          - 표제어 기준 비교: 'Department'는 소문자 'departments'가 있으므로 일반명사
      (3) 문장 중간에서 대문자로 쓰인 적이 있음 (문장 첫머리에만 나오는 Firefighting, Deer 등 보호)"""
    tagged_nnp, seen_lower, mid_cap = set(), set(), set()
    for tagged in tagged_docs:
        for word, tag, is_first in tagged:
            if not word.isalpha():
                continue
            low = lemmatizer.lemmatize(word.lower(), "n")
            if tag in ("NNP", "NNPS"):
                tagged_nnp.add(low)
            if word[0].islower():
                seen_lower.add(low)
            elif not is_first:
                mid_cap.add(low)
    return (tagged_nnp - seen_lower) & mid_cap


def filter_tokens(tagged, proper_nouns, lemmatizer, lemma_log):
    """NN/NNS/JJ만 → 고유명사 사전 제외 → 표제어 → 불용어·길이 필터."""
    toks = []
    for word, tag, _ in tagged:
        wn_pos = KEEP_POS.get(tag)
        if wn_pos is None or not word.isalpha():
            continue
        low = word.lower()
        if lemmatizer.lemmatize(low, "n") in proper_nouns:
            continue
        lemma = lemmatizer.lemmatize(low, wn_pos)
        if lemma != low:
            lemma_log[f"{low} -> {lemma}"] += 1
        if len(lemma) < MIN_LEN or lemma in STOP_WORDS:
            continue
        toks.append(lemma)
    return toks


def main():
    os.makedirs(CLEAN_DIR, exist_ok=True)
    ensure_nltk_data()
    dictionary = load_dictionary()
    split_log = Counter()
    log_lines = []

    docs = []
    for path in sorted(glob.glob(os.path.join(PDF_DIR, "*.pdf"))):
        name = os.path.splitext(os.path.basename(path))[0]
        doc_id, title = name.split(" - ", 1)
        doc_id = int(doc_id)
        text = "\n".join(strip_boilerplate(p) for p in extract_pages(path))
        text, cut = cut_questions(text)
        text, title_removed = remove_title(text, title)
        text = repair_splits(text, dictionary, split_log)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n", text).strip()
        with open(os.path.join(CLEAN_DIR, f"{doc_id:02d}.txt"), "w", encoding="utf-8") as f:
            f.write(text)
        docs.append({"doc_id": doc_id, "title": title, "text": text, "questions_cut": cut,
                     "title_removed": title_removed})
        log_lines.append(f"{doc_id:02d} {title}: questions_cut={cut}, title_removed={title_removed}, "
                         f"chars={len(text)}")

    # 품사 필터 + 표제어 추출
    lemmatizer = WordNetLemmatizer()
    lemma_log = Counter()
    tagged = {d["doc_id"]: tag_text(d["text"]) for d in docs}
    proper_nouns = find_proper_nouns(tagged.values(), lemmatizer)
    tokens = {i: filter_tokens(t, proper_nouns, lemmatizer, lemma_log) for i, t in tagged.items()}

    # TF-IDF: IDF는 30개 문서 전체 기준 (sklearn 기본값: smooth_idf, l2 정규화)
    ids = [d["doc_id"] for d in docs]
    vec = TfidfVectorizer(analyzer=lambda toks: toks, lowercase=False)
    X = vec.fit_transform([tokens[i] for i in ids])
    feats = vec.get_feature_names_out()

    with open(CANDIDATES_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["doc_id", "title", "rank", "word", "tfidf"])
        for row, d in enumerate(docs):
            r = X[row].toarray().ravel()
            # 동점은 단어 알파벳순으로 고정 (재현성)
            order = sorted(range(len(r)), key=lambda j: (-r[j], feats[j]))[:TOP_K]
            for rank, j in enumerate(order, 1):
                w.writerow([d["doc_id"], d["title"], rank, feats[j], f"{r[j]:.4f}"])

    with open(TOKENS_JSON, "w", encoding="utf-8") as f:
        json.dump({str(i): tokens[i] for i in ids}, f, ensure_ascii=False)

    with open(STEP1_LOG, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines) + "\n\n")
        f.write(f"split-word repairs ({sum(split_log.values())}):\n")
        for k, v in split_log.most_common():
            f.write(f"  {k!r} x{v}\n")
        f.write(f"\nproper nouns excluded ({len(proper_nouns)}):\n  " + ", ".join(sorted(proper_nouns)) + "\n")
        f.write(f"\nlemmatizations ({len(lemma_log)} types):\n")
        for k in sorted(lemma_log):
            f.write(f"  {k} x{lemma_log[k]}\n")

    n_cut = sum(d["questions_cut"] for d in docs)
    missing = [d["doc_id"] for d in docs if not d["title_removed"]]
    if missing:
        print(f"WARNING: title not found in body for docs {missing}")
    print(f"docs={len(docs)}, questions_cut={n_cut}, split_repairs={sum(split_log.values())}, "
          f"proper_nouns={len(proper_nouns)}, lemma_types={len(lemma_log)}, vocab={len(feats)}")


if __name__ == "__main__":
    main()

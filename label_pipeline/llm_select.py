"""2단계: LLM 선택 모듈.

입력: 제목 + 본문 첫 문단 + TF-IDF 후보 → 출력: 후보 중 키워드 3개 (중요도 순).
LLM 호출은 select_keywords() 하나로 분리. provider:
  - "manual" : JSON 파일에서 결과를 읽음 (API 없이 동작 확인 / 오프라인 생성 결과 고정용)
  - "claude" : Anthropic Messages API  (환경변수 ANTHROPIC_API_KEY, 패키지 `anthropic` 필요)
  - "openai" : OpenAI Chat Completions (환경변수 OPENAI_API_KEY, 패키지 `openai` 필요)
API 키는 코드에 넣지 않는다. SDK는 해당 provider를 쓸 때만 import 한다.
"""
import json
import os
import re

from paths import PROMPT_PATH
N_KEYWORDS = 3

DEFAULT_MODELS = {
    "manual": None,
    "claude": "claude-opus-5-5",
    "openai": None,  # 사용 시 --model 로 반드시 지정 (모델명을 추측해서 고정하지 않음)
}

# 프롬프트에 넣는 후보 순서. TF-IDF 순위를 그대로 보여주면 LLM이 앞쪽 후보를 고르는 순서 편향이
# 생길 수 있어 알파벳 순으로 정렬한다 (선택이 TF-IDF 순위가 아니라 내용 판단에 의존하도록).
CANDIDATE_ORDER = "alphabetical"
CANDIDATE_ORDER_REASON = ("순서 편향 방지: TF-IDF 순위 순으로 후보를 제시하면 LLM이 목록 앞쪽(고순위) 후보를 "
                          "우선 고르는 위치 편향이 생길 수 있어, 순위 정보를 숨기고 알파벳 순으로 제시함. "
                          "후보 집합(TF-IDF 상위 20개) 자체는 동일.")

# 첫 문단 판별: 문장부호로 끝나는 줄 + 다음 줄이 대문자/따옴표로 시작 → 문단 경계.
# 너무 짧으면(대화 한 줄 등) 다음 문단까지 이어 붙임.
MIN_FIRST_PARAGRAPH_CHARS = 150
_PARA_END = re.compile(r"[.!?:][”\"']?\s*$")
_PARA_START = re.compile(r"^\s*[“\"'A-Z•]")


class SelectionError(ValueError):
    """LLM 출력이 규칙(후보 안에서 3개, 중복 없음, JSON 형식)을 어긴 경우."""


def load_prompt_template(path=PROMPT_PATH):
    with open(path, encoding="utf-8") as f:
        return f.read()


def first_paragraph(text, min_chars=MIN_FIRST_PARAGRAPH_CHARS):
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    out = []
    for i, line in enumerate(lines):
        out.append(line.strip())
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if _PARA_END.search(line) and _PARA_START.match(nxt) and len(" ".join(out)) >= min_chars:
            break
    return re.sub(r"\s+", " ", " ".join(out)).strip()


def build_prompt(template, title, first_para, candidates):
    # str.format 대신 단순 치환: 템플릿 안의 JSON 예시 중괄호를 그대로 두기 위함
    return (template
            .replace("{title}", title)
            .replace("{first_paragraph}", first_para)
            .replace("{n_candidates}", str(len(candidates)))
            .replace("{candidates}", ", ".join(sorted(candidates))))  # CANDIDATE_ORDER 참고


def parse_and_validate(raw, candidates, n=N_KEYWORDS):
    """LLM 원문 출력 → 검증된 키워드 리스트. 규칙 위반 시 SelectionError."""
    if isinstance(raw, dict):
        data = raw
    else:
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            raise SelectionError(f"JSON object not found in output: {raw!r}")
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError as e:
            raise SelectionError(f"invalid JSON: {e}") from e
    kws = data.get("keywords")
    if not isinstance(kws, list) or not all(isinstance(k, str) for k in kws):
        raise SelectionError(f'"keywords" must be a list of strings: {data!r}')
    kws = [k.strip().lower() for k in kws]
    if len(kws) != n:
        raise SelectionError(f"expected {n} keywords, got {len(kws)}: {kws}")
    if len(set(kws)) != n:
        raise SelectionError(f"duplicate keywords: {kws}")
    outside = [k for k in kws if k not in candidates]
    if outside:
        raise SelectionError(f"keywords not in candidate list: {outside}")
    return kws


# ---------------------------------------------------------------- providers

def _call_manual(doc_id, manual_path, **_):
    if not manual_path:
        raise ValueError("manual provider requires manual_path")
    with open(manual_path, encoding="utf-8") as f:
        results = json.load(f)["results"]
    key = str(doc_id)
    if key not in results:
        raise SelectionError(f"doc {doc_id} not found in {manual_path}")
    return results[key]


def _call_claude(prompt, model, **_):
    import anthropic  # pip install anthropic

    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 등 환경변수에서 인증정보를 읽음
    response = client.beta.messages.create(
        model=model,
        max_tokens=1024,
        # 거절(refusal) 시 서버가 대체 모델로 재시도 (Claude Opus 5.5 권장 설정)
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={
            "effort": "medium",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {"keywords": {"type": "array", "items": {"type": "string"}}},
                    "required": ["keywords"],
                    "additionalProperties": False,
                },
            },
        },
        messages=[{"role": "user", "content": prompt}],
    )
    if response.stop_reason == "refusal":
        raise SelectionError(f"model refused: {response.stop_details}")
    return next(b.text for b in response.content if b.type == "text")


def _call_openai(prompt, model, **_):
    from openai import OpenAI  # pip install openai

    client = OpenAI()  # OPENAI_API_KEY 환경변수에서 읽음
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
    )
    return response.choices[0].message.content


PROVIDERS = {"manual": _call_manual, "claude": _call_claude, "openai": _call_openai}


def select_keywords(doc_id, title, first_para, candidates, provider="manual", model=None,
                    manual_path=None, template=None):
    """후보 중 키워드 3개를 중요도 순으로 반환. 반환: (keywords, raw_output, prompt)."""
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider {provider!r}; choose from {list(PROVIDERS)}")
    if provider == "claude" and not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        print("note: ANTHROPIC_API_KEY not set; SDK will try other credential sources (e.g. `ant auth login`)")
    if provider == "openai" and not os.environ.get("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY environment variable is not set")
    model = model or DEFAULT_MODELS[provider]
    if provider != "manual" and not model:
        raise ValueError(f"provider {provider!r} requires a model name (--model)")
    prompt = build_prompt(template or load_prompt_template(), title, first_para, candidates)
    raw = PROVIDERS[provider](doc_id=doc_id, prompt=prompt, model=model, manual_path=manual_path)
    return parse_and_validate(raw, candidates), raw, prompt

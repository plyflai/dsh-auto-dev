#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

# The skill generation wrote its control plane under `.autodev/`. This package keeps
# its own records under `.auto-dev/`, so both spellings are read here: an existing
# `.autodev/ai-sot.json` from a previous generation still counts, and a project that
# only has `.auto-dev/` is not treated as unconfigured.
AI_SOT_RELATIVE_PATH = ".autodev/ai-sot.json"
AI_SOT_ALTERNATE_PATH = ".auto-dev/ai-sot.json"

DOMAIN_RULES = {
    "ui": {
        "segments": {
            "ui",
            "page",
            "pages",
            "view",
            "views",
            "component",
            "components",
            "frontend",
            "web",
            "template",
            "templates",
            "public",
        },
        "strong_segments": {"page", "pages", "view", "views", "component", "components", "frontend", "public"},
        "suffixes": {".jsx", ".tsx", ".vue", ".svelte", ".css", ".scss", ".less", ".html", ".ejs", ".hbs", ".njk"},
        "label": "UI / GUI",
    },
    "api": {
        "segments": {"api", "apis", "controller", "controllers", "route", "routes", "handler", "handlers"},
        "strong_segments": {"api", "apis", "controller", "controllers", "route", "routes", "handler", "handlers"},
        "suffixes": {".js", ".jsx", ".ts", ".tsx", ".py", ".go"},
        "label": "API / Controller",
    },
    "service": {
        "segments": {"service", "services", "usecase", "usecases", "workflow", "logic", "domain"},
        "strong_segments": {"service", "services", "usecase", "usecases", "workflow", "logic", "domain"},
        "suffixes": {".js", ".jsx", ".ts", ".tsx", ".py", ".go"},
        "label": "Service / Domain",
    },
    "data": {
        "segments": {
            "repo",
            "repos",
            "repository",
            "repositories",
            "dao",
            "daos",
            "mapper",
            "mappers",
            "model",
            "models",
            "entity",
            "entities",
            "migration",
            "migrations",
            "sql",
            "db",
            "database",
            "store",
            "stores",
        },
        "strong_segments": {
            "repo",
            "repos",
            "repository",
            "repositories",
            "dao",
            "daos",
            "mapper",
            "mappers",
            "model",
            "models",
            "migration",
            "migrations",
            "sql",
            "db",
            "database",
            "store",
            "stores",
        },
        "suffixes": {".sql", ".py", ".go", ".ts", ".tsx", ".js", ".jsx"},
        "label": "Data / DB",
    },
    "config": {
        "segments": {"config", "configs", "env", "settings"},
        "strong_segments": {"config", "configs", "env", "settings"},
        "suffixes": {".json", ".yaml", ".yml", ".toml", ".ini", ".env"},
        "label": "Config",
    },
    "docs": {
        "segments": {"docs", "references", "assets"},
        "strong_segments": {"docs", "references"},
        "suffixes": {".md"},
        "label": "Docs",
    },
    "tests": {
        "segments": {
            "test",
            "tests",
            "__tests__",
            "spec",
            "specs",
            "testing",
            "integration",
            "fixture",
            "fixtures",
            "mock",
            "mocks",
            "e2e",
            "playwright",
            "testdata",
            "bench",
            "benchmark",
            "benchmarks",
        },
        "strong_segments": {
            "test",
            "tests",
            "__tests__",
            "spec",
            "specs",
            "integration",
            "fixture",
            "fixtures",
            "e2e",
            "playwright",
            "testdata",
        },
        "suffixes": {".spec.ts", ".test.ts", ".spec.js", ".test.js", ".spec.py", ".test.py"},
        "label": "Tests",
    },
}

ENTITY_STOPWORDS = {
    "src",
    "app",
    "lib",
    "core",
    "common",
    "shared",
    "service",
    "services",
    "controller",
    "controllers",
    "route",
    "routes",
    "handler",
    "handlers",
    "model",
    "models",
    "entity",
    "entities",
    "repository",
    "repositories",
    "repo",
    "dao",
    "db",
    "database",
    "migration",
    "migrations",
    "index",
    "utils",
    "util",
    "helper",
    "helpers",
    "page",
    "pages",
    "view",
    "views",
    "component",
    "components",
    "test",
    "tests",
    "testing",
    "spec",
    "specs",
    "integration",
    "e2e",
    "fixture",
    "fixtures",
    "playwright",
    "snapshot",
    "snapshots",
    "testdata",
    "storybook",
    "stories",
    "story",
    "mock",
    "mocks",
    "config",
    "configs",
    "readme",
    "references",
    "assets",
    "template",
    "templates",
    "skill",
    "skills",
}

TEST_SEGMENT_MARKERS = set(DOMAIN_RULES["tests"]["segments"])
TEST_FILE_MARKERS = (".test.", ".spec.")
TEST_TOKEN_NORMALIZERS = (
    re.compile(r"^(?P<core>[a-z0-9]+)[_-](test|tests|spec|specs)$"),
    re.compile(r"^(test|tests|spec|specs)[_-](?P<core>[a-z0-9]+)$"),
)
UI_STRONG_EXTENSIONS = {".jsx", ".tsx", ".vue", ".svelte", ".html", ".ejs", ".hbs", ".njk"}
STYLE_EXTENSIONS = {".css", ".scss", ".less", ".sass"}
WORKFLOW_MARKERS = ("#保护", "#起点", "#信任起点", "#完成")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a machine-readable pre-release test plan from recent git commits."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--range", default="", help="Explicit git commit range, e.g. abc123..def456.")
    group.add_argument("--commit", default="", help="Single commit to inspect. Defaults to HEAD.")
    group.add_argument(
        "--commits",
        type=int,
        default=1,
        help="Use the latest N commits when --range/--commit is not provided. Default: 1.",
    )
    parser.add_argument("--task", default="", help="Short task description.")
    parser.add_argument("--env", default="预发", help="Environment label. Default: 预发.")
    parser.add_argument(
        "--mode",
        default="manual",
        choices=["manual", "auto"],
        help="Suggested execution mode to encode into the plan.",
    )
    parser.add_argument(
        "--output",
        default=".autodev/temp/release-plan.json",
        help="Plan output path relative to repo root.",
    )
    parser.add_argument("--stdout", action="store_true", help="Print a short receipt to stdout.")
    return parser.parse_args()


def run_cmd(command: Sequence[str], cwd: Path) -> str:
    proc = subprocess.run(
        command,
        cwd=str(cwd),
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "command failed")
    return proc.stdout.strip()


def get_repo_root() -> Path:
    return Path(run_cmd(["git", "rev-parse", "--show-toplevel"], Path.cwd())).resolve()


def resolve_target(args: argparse.Namespace) -> Tuple[str, bool]:
    if args.range:
        return args.range, True
    if args.commit:
        return args.commit, False
    if args.commits <= 1:
        return "HEAD", False
    return f"HEAD~{args.commits}..HEAD", True


def get_commit_rows(repo_root: Path, target: str, is_range: bool) -> List[Tuple[str, str]]:
    if is_range:
        raw = run_cmd(["git", "log", "--reverse", "--format=%H%x09%s", target], repo_root)
    else:
        raw = run_cmd(["git", "show", "-s", "--format=%H%x09%s", target], repo_root)
    rows: List[Tuple[str, str]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        commit_hash, _, subject = line.partition("\t")
        rows.append((commit_hash.strip(), subject.strip()))
    return rows


def get_changed_files_for_commit(repo_root: Path, commit_hash: str) -> List[Tuple[str, str]]:
    raw = run_cmd(["git", "show", "--name-status", "--format=", commit_hash], repo_root)
    rows: List[Tuple[str, str]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        status, _, path = line.partition("\t")
        if path.strip():
            rows.append((status.strip(), path.strip()))
    return rows


def classify_commit_subject(subject: str) -> str:
    if any(marker in subject for marker in WORKFLOW_MARKERS):
        return "workflow"
    if subject.startswith("checkpoint:"):
        return "workflow"
    if "「" in subject and "」" in subject:
        return "archive"
    return "feature"


def split_commit_rows(commits: List[Tuple[str, str]]) -> Tuple[List[Tuple[str, str]], List[Tuple[str, str]]]:
    feature_commits: List[Tuple[str, str]] = []
    workflow_commits: List[Tuple[str, str]] = []
    for row in commits:
        if classify_commit_subject(row[1]) == "workflow":
            workflow_commits.append(row)
        else:
            feature_commits.append(row)
    return feature_commits, workflow_commits


def aggregate_changed_files(repo_root: Path, commits: List[Tuple[str, str]]) -> List[Tuple[str, str]]:
    rows: List[Tuple[str, str]] = []
    seen: set[Tuple[str, str]] = set()
    for commit_hash, _ in commits:
        for entry in get_changed_files_for_commit(repo_root, commit_hash):
            if entry in seen:
                continue
            seen.add(entry)
            rows.append(entry)
    return rows


def get_changed_files(repo_root: Path, target: str, is_range: bool) -> List[Tuple[str, str]]:
    if is_range:
        raw = run_cmd(["git", "diff", "--name-status", target], repo_root)
    else:
        raw = run_cmd(["git", "show", "--name-status", "--format=", target], repo_root)
    rows: List[Tuple[str, str]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        status, _, path = line.partition("\t")
        if path.strip():
            rows.append((status.strip(), path.strip()))
    return rows


def is_test_path(path_text: str) -> bool:
    path = Path(path_text)
    lowered_parts = [part.lower() for part in path.parts]
    if any(part in TEST_SEGMENT_MARKERS for part in lowered_parts):
        return True
    lowered_name = path.name.lower()
    if any(marker in lowered_name for marker in TEST_FILE_MARKERS):
        return True
    return False


def classify_file_role(path_text: str) -> str:
    path = Path(path_text)
    segments = {part.lower() for part in path.parts}
    suffix = path.suffix.lower()
    if is_test_path(path_text):
        return "test"
    if segments & DOMAIN_RULES["docs"]["segments"] or suffix in DOMAIN_RULES["docs"]["suffixes"]:
        return "docs"
    if segments & DOMAIN_RULES["config"]["segments"] or suffix in DOMAIN_RULES["config"]["suffixes"]:
        return "config"
    if "assets" in segments or suffix in STYLE_EXTENSIONS:
        return "asset"
    return "source"


def detect_domain_scores(path_text: str) -> Dict[str, int]:
    path = Path(path_text)
    segments = {part.lower() for part in path.parts}
    suffix = path.suffix.lower()
    stem = path.name.lower()
    role = classify_file_role(path_text)
    scores: Dict[str, int] = defaultdict(int)

    if role == "test":
        scores["tests"] += 6

    for key, rule in DOMAIN_RULES.items():
        segment_overlap = segments & rule["segments"]
        strong_overlap = segments & set(rule.get("strong_segments", set()))
        if segment_overlap:
            scores[key] += len(segment_overlap)
        if strong_overlap:
            scores[key] += len(strong_overlap) * 2
        if suffix in rule["suffixes"] or stem in rule["suffixes"]:
            scores[key] += 1

    if role == "test":
        for key in ("ui", "api", "service", "data"):
            scores[key] = max(0, scores[key] - 2)

    if suffix in UI_STRONG_EXTENSIONS:
        scores["ui"] += 2
    if suffix in STYLE_EXTENSIONS:
        scores["ui"] += 3

    if not scores:
        scores["service"] = 1

    return dict(scores)


def detect_domains(path_text: str) -> List[str]:
    scores = detect_domain_scores(path_text)
    max_score = max(scores.values()) if scores else 0
    if max_score <= 0:
        return ["service"]
    matched = [key for key, score in scores.items() if score > 0 and score >= max_score - 1]
    return matched or ["service"]


def normalize_test_context_token(token: str) -> str:
    lowered = token.lower()
    for pattern in TEST_TOKEN_NORMALIZERS:
        matched = pattern.match(lowered)
        if matched:
            core = matched.groupdict().get("core", "")
            if core:
                return core
    return lowered


def has_ui_evidence(paths: Iterable[str]) -> bool:
    for path_text in paths:
        if classify_file_role(path_text) != "source":
            continue
        if detect_domain_scores(path_text).get("ui", 0) >= 3:
            return True
    return False


def extract_entities(paths: Iterable[str]) -> List[str]:
    counter: Counter[str] = Counter()
    for path_text in paths:
        if classify_file_role(path_text) != "source":
            continue
        path = Path(path_text)
        tokens = re.split(r"[^a-zA-Z0-9]+", "/".join(path.parts))
        for token in tokens:
            lowered = normalize_test_context_token(token)
            if len(lowered) < 3:
                continue
            if lowered.isdigit() or lowered in ENTITY_STOPWORDS:
                continue
            counter[lowered] += 1
    return [token for token, _ in counter.most_common(3)]


def normalize_entities(entities: List[str], domains: Iterable[str]) -> List[str]:
    domain_set = set(domains)
    if domain_set and domain_set <= {"docs", "tests", "config"}:
        return []
    return entities


def compute_domain_confidence(paths: Iterable[str], domains: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    role_counts: Counter[str] = Counter(classify_file_role(path_text) for path_text in paths)
    source_paths = [path_text for path_text in paths if classify_file_role(path_text) == "source"]
    summary: Dict[str, Dict[str, Any]] = {}

    for domain in sorted(set(domains)):
        evidence_score = 0
        for path_text in source_paths:
            evidence_score += detect_domain_scores(path_text).get(domain, 0)
        confidence = "low"
        if evidence_score >= 6:
            confidence = "high"
        elif evidence_score >= 3:
            confidence = "medium"
        if domain == "ui" and not has_ui_evidence(paths):
            confidence = "low"
            evidence_score = min(evidence_score, 1)
        summary[domain] = {
            "evidence_score": evidence_score,
            "confidence": confidence,
            "role_counts": dict(role_counts),
        }

    return summary


def detect_plan_ambiguities(paths: Iterable[str], domains: Iterable[str], entities: List[str]) -> List[str]:
    ambiguities: List[str] = []
    role_counts: Counter[str] = Counter(classify_file_role(path_text) for path_text in paths)
    if role_counts.get("test", 0) and not role_counts.get("source", 0):
        ambiguities.append("Only test assets changed; release-pack should avoid inferring business entities from test paths.")
    if "ui" in set(domains) and not has_ui_evidence(paths):
        ambiguities.append("UI domain lacks strong source-side evidence; GUI checks should stay disabled.")
    if not entities and role_counts.get("source", 0):
        ambiguities.append("No stable business entity could be inferred from source paths; keep plan generic.")
    return ambiguities


def append_commit_scope_ambiguities(
    ambiguities: List[str],
    *,
    feature_commits: List[Tuple[str, str]],
    workflow_commits: List[Tuple[str, str]],
) -> List[str]:
    results = list(ambiguities)
    if workflow_commits and not feature_commits:
        results.append("Only workflow commits detected in range; release-pack should avoid inferring business changes from checkpoint noise.")
    if workflow_commits and feature_commits:
        results.append("Workflow commits were filtered; release-pack uses feature/archive commits as the effective change set.")
    return results


def read_optional_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def load_ai_sot(repo_root: Path) -> Dict[str, object]:
    ai_sot_path = repo_root / AI_SOT_RELATIVE_PATH
    if not ai_sot_path.exists():
        ai_sot_path = repo_root / AI_SOT_ALTERNATE_PATH
    if not ai_sot_path.exists():
        return {}
    try:
        return json.loads(ai_sot_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def deep_merge(base: Dict[str, object], override: Dict[str, object]) -> Dict[str, object]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def apply_ai_sot_overrides(plan: Dict[str, object], ai_sot: Dict[str, object]) -> Dict[str, object]:
    if not ai_sot:
        return plan

    pre_release = ai_sot.get("pre_release", {})
    if not isinstance(pre_release, dict):
        return plan

    for key in ("staging_context", "backend_execution_context", "gui_execution_context", "auth_hints"):
        locked_section = pre_release.get(key)
        if isinstance(locked_section, dict):
            current = plan.get(key, {})
            plan[key] = deep_merge(current if isinstance(current, dict) else {}, locked_section)

    public_entry = pre_release.get("public_entry", {})
    if isinstance(public_entry, dict):
        base_url = str(public_entry.get("base_url", "")).strip()
        if base_url:
            gui_context = plan.get("gui_execution_context", {})
            if isinstance(gui_context, dict):
                gui_context.setdefault("base_url", base_url)
                if not gui_context.get("base_url"):
                    gui_context["base_url"] = base_url
                plan["gui_execution_context"] = gui_context

    plan["ai_sot"] = {
        "path": AI_SOT_RELATIVE_PATH,
        "lock_id": ai_sot.get("lock_id", ""),
        "mutation_policy": ai_sot.get("ai_mutation_policy", {}),
    }
    return plan


def detect_sql_dialect(repo_root: Path) -> Tuple[str, str]:
    candidates = [
        repo_root / ".autodev" / "path.md",
        repo_root / "docker-compose.yml",
        repo_root / "compose.yml",
        repo_root / "package.json",
        repo_root / "pyproject.toml",
        repo_root / "requirements.txt",
        repo_root / "go.mod",
        repo_root / ".env",
        repo_root / ".env.example",
        repo_root / "application.yml",
        repo_root / "application.yaml",
        repo_root / "application.properties",
    ]
    combined = "\n".join(read_optional_text(path).lower() for path in candidates if path.exists())
    if any(token in combined for token in ("postgresql", "postgres", "psycopg", "pgx", "asyncpg")):
        return "PostgreSQL", "从 path.md / 配置文件中识别到 postgres 相关信号"
    if any(token in combined for token in ("mysql", "mariadb", "pymysql")):
        return "MySQL", "从 path.md / 配置文件中识别到 mysql 相关信号"
    if any(token in combined for token in ("sqlite", ".db", "better-sqlite3")):
        return "SQLite", "从 path.md / 配置文件中识别到 sqlite 相关信号"
    return "待确认", "未从 path.md 或常见配置文件中识别出明确数据库方言"


def seven_day_filter(dialect: str) -> str:
    if dialect == "PostgreSQL":
        return "updated_at >= NOW() - INTERVAL '7 days'"
    if dialect == "MySQL":
        return "updated_at >= NOW() - INTERVAL 7 DAY"
    if dialect == "SQLite":
        return "updated_at >= DATETIME('now', '-7 days')"
    return "updated_at >= <请按实际数据库方言替换最近7天条件>"


def infer_need_queries(domains: Iterable[str], entities: List[str], domain_confidence: Dict[str, Dict[str, Any]]) -> bool:
    if not entities:
        return False
    for domain in ("data", "api"):
        confidence = str(domain_confidence.get(domain, {}).get("confidence", ""))
        if confidence in {"medium", "high"}:
            return True
    return False


def infer_need_seed(requires_gui: bool, needs_query: bool, domain_confidence: Dict[str, Dict[str, Any]]) -> bool:
    if requires_gui and needs_query:
        return True
    api_confidence = str(domain_confidence.get("api", {}).get("confidence", ""))
    data_confidence = str(domain_confidence.get("data", {}).get("confidence", ""))
    return api_confidence == "high" and data_confidence == "high"


def infer_auth_strategy(domains: Iterable[str], requires_gui: bool) -> List[str]:
    domain_set = set(domains)
    strategies: List[str] = ["existing_session"]
    if requires_gui and "ui" in domain_set:
        strategies.append("browser_login_handoff")
    strategies.append("local_secret_store")
    return strategies


def infer_automation_scope(domains: Iterable[str], requires_gui: bool) -> str:
    domain_set = set(domains)
    if requires_gui and "ui" in domain_set:
        return "be_plus_gui"
    return "be_only"


def infer_focus_summary(entities: List[str], commits: List[Tuple[str, str]]) -> str:
    if entities:
        return f"优先验证 {' / '.join(entities[:2])} 相关行为变化"
    if commits:
        return f"优先验证最近提交 `{commits[0][0][:7]}` 带来的直接行为变化"
    return "优先验证最近提交对应的关键链路"


def infer_expected_user_visible_changes(domains: Iterable[str], entities: List[str]) -> List[str]:
    domain_set = set(domains)
    primary = entities[0] if entities else "核心对象"
    changes: List[str] = []
    if "ui" in domain_set:
        changes.append(f"{primary} 相关页面、按钮、表单或详情展示会有直接可见变化。")
    if {"api", "service", "data"} & domain_set:
        changes.append(f"{primary} 相关状态流转、接口结果或数据副作用应与最近提交保持一致。")
    if not changes:
        changes.append("本轮更偏底层或配置改动，用户可见变化可能较少，应优先观察关键结果是否正确。")
    return changes


def build_executive_summary(
    *,
    focus_summary: str,
    domains: Iterable[str],
    use_cases: List[Dict[str, object]],
    entities: List[str],
    requires_gui: bool,
) -> Dict[str, object]:
    domain_set = set(domains)
    has_backend_tests = any(use_case.get("be_checks") for use_case in use_cases)
    has_gui_tests = any(use_case.get("gui_checks") for use_case in use_cases)
    summary_items: List[str] = [focus_summary]
    if {"api", "service", "data"} & domain_set:
        summary_items.append("优先验证后端状态流转、接口结果和副作用。")
    if requires_gui and "ui" in domain_set:
        summary_items.append("优先验证关键页面链路、交互反馈和最终展示。")
    if not summary_items:
        summary_items.append("优先验证最近提交直接影响的行为变化。")
    return {
        "has_backend_tests": has_backend_tests,
        "has_gui_tests": has_gui_tests,
        "summary_items": summary_items,
        "expected_user_visible_changes": infer_expected_user_visible_changes(domains, entities),
    }


def make_query_statements(entities: List[str], dialect: str) -> List[Dict[str, str]]:
    entity = entities[0] if entities else "core"
    table_placeholder = f"<{entity}_table>"
    base_fields = "id, status, updated_at"
    return [
        {
            "id": "Q1",
            "purpose": f"找最近可用于验证 {entity} 相关变更的候选记录",
            "sql": f"SELECT {base_fields}\nFROM {table_placeholder}\nORDER BY updated_at DESC\nLIMIT 20;",
        },
        {
            "id": "Q2",
            "purpose": f"看 {entity} 在不同状态下的分布，便于挑选边界 case",
            "sql": f"SELECT status, COUNT(*) AS cnt\nFROM {table_placeholder}\nGROUP BY status\nORDER BY cnt DESC;",
        },
        {
            "id": "Q3",
            "purpose": f"回看最近一周 {entity} 的变化，筛出更贴近真实链路的记录",
            "sql": (
                f"SELECT {base_fields}\nFROM {table_placeholder}\n"
                f"WHERE {seven_day_filter(dialect)}\n"
                "ORDER BY updated_at DESC\nLIMIT 50;"
            ),
        },
    ]


def make_check(
    *,
    check_id: str,
    title: str,
    kind: str,
    success_criteria: str,
    required: bool = True,
) -> Dict[str, object]:
    return {
        "id": check_id,
        "title": title,
        "kind": kind,
        "required": required,
        "command": "",
        "success_criteria": success_criteria,
        "manual_fallback_when": [
            "缺少可执行命令",
            "预发环境入口未在 path.md 中声明",
        ],
    }


def make_use_cases(
    entities: List[str],
    domains: Iterable[str],
    requires_gui: bool,
    requires_data: bool,
) -> List[Dict[str, object]]:
    seeds = entities or ["核心对象"]
    primary = seeds[0]
    domain_set = set(domains)
    use_cases: List[Dict[str, object]] = []

    happy_be_checks = [
        make_check(
            check_id="BE-1",
            title=f"{primary} 主链路后端验证",
            kind="curl_or_log",
            success_criteria="关键请求成功，且状态变化与最近提交预期一致。",
        )
    ]
    happy_gui_checks: List[Dict[str, object]] = []
    if requires_gui and "ui" in domain_set:
        happy_gui_checks.append(
            make_check(
                check_id="GUI-1",
                title=f"{primary} 主链路前端验证",
                kind="playwright",
                success_criteria="页面、网络和后端副作用同时符合预期。",
            )
        )

    use_cases.append(
        {
            "id": "UC-1",
            "title": f"{primary} 主链路验证",
            "priority": "high",
            "requires_gui": requires_gui and "ui" in domain_set,
            "change_anchor": f"{primary} 相关最近提交",
            "requires_auth": requires_gui and "ui" in domain_set,
            "requires_data": requires_data,
            "why": "先确认最近提交直接影响的 happy path 在预发环境确实可走通。",
            "success_criteria": [
                "页面或接口行为与提交意图一致",
                "关键状态变化可被后端证据确认",
            ],
            "manual_fallback_when": [
                "认证 handoff 无法完成",
                "预发数据入口缺失",
            ],
            "be_checks": happy_be_checks,
            "gui_checks": happy_gui_checks,
        }
    )

    boundary_be_checks = [
        make_check(
            check_id="BE-2",
            title=f"{primary} 边界或负例后端验证",
            kind="curl_or_query",
            success_criteria="拒绝路径、禁用态或错误提示符合预期，没有误放行。",
        )
    ]
    boundary_gui_checks: List[Dict[str, object]] = []
    if requires_gui and "ui" in domain_set:
        boundary_gui_checks.append(
            make_check(
                check_id="GUI-2",
                title=f"{primary} 边界或负例前端验证",
                kind="playwright",
                success_criteria="页面提示、按钮状态和副作用均符合边界预期。",
            )
        )

    use_cases.append(
        {
            "id": "UC-2",
            "title": f"{primary} 边界或负例验证",
            "priority": "medium",
            "requires_gui": requires_gui and "ui" in domain_set,
            "change_anchor": f"{primary} 相关最近提交",
            "requires_auth": requires_gui and "ui" in domain_set,
            "requires_data": requires_data,
            "why": "避免只测 happy path，补一条最贴近本次改动的边界场景。",
            "success_criteria": [
                "边界态不误放行",
                "错误提示或禁用态符合预期",
            ],
            "manual_fallback_when": [
                "边界态样本数据无法自动筛出",
                "GUI 入口依赖验证码或扫码",
            ],
            "be_checks": boundary_be_checks,
            "gui_checks": boundary_gui_checks,
        }
    )

    return use_cases


def grouped_files_to_paths(grouped_files: Dict[str, List[str]]) -> List[str]:
    paths: List[str] = []
    for values in grouped_files.values():
        paths.extend(values)
    return paths


def build_plan(
    *,
    task: str,
    env_label: str,
    mode: str,
    target: str,
    commits: List[Tuple[str, str]],
    changed_files: List[Tuple[str, str]],
    feature_commits: List[Tuple[str, str]],
    workflow_commits: List[Tuple[str, str]],
    domains: List[str],
    entities: List[str],
    domain_confidence: Dict[str, Dict[str, Any]],
    plan_ambiguities: List[str],
    dialect: str,
    dialect_reason: str,
) -> Dict[str, object]:
    grouped_files: Dict[str, List[str]] = defaultdict(list)
    for status, path in changed_files:
        grouped_files[status].append(path)

    focus_summary = infer_focus_summary(entities, commits)
    domain_set = set(domains)
    changed_paths = grouped_files_to_paths(grouped_files)
    requires_gui = "ui" in domain_set and has_ui_evidence(changed_paths)
    needs_query = infer_need_queries(domains, entities, domain_confidence)
    needs_seed = infer_need_seed(requires_gui, needs_query, domain_confidence)
    use_cases = make_use_cases(entities, domains, requires_gui, needs_query)
    protected_target = env_label in {"预发", "生产"}
    executive_summary = build_executive_summary(
        focus_summary=focus_summary,
        domains=domains,
        use_cases=use_cases,
        entities=entities,
        requires_gui=requires_gui,
    )

    plan: Dict[str, object] = {
        "schema_version": "1.0",
        "task": task or "根据最近提交组织预发测试",
        "environment": env_label,
        "selected_execution_mode": mode,
        "automation_scope": infer_automation_scope(domains, requires_gui),
        "available_execution_modes": ["manual", "auto"],
        "target": target,
        "focus_summary": focus_summary,
        "commits": [{"hash": commit_hash, "subject": subject} for commit_hash, subject in commits],
        "feature_commits": [{"hash": commit_hash, "subject": subject} for commit_hash, subject in feature_commits],
        "workflow_commits": [{"hash": commit_hash, "subject": subject} for commit_hash, subject in workflow_commits],
        "effective_commit_count": len(feature_commits) if feature_commits else len(commits),
        "changed_files": grouped_files,
        "domains": sorted(set(domains)),
        "domain_labels": [DOMAIN_RULES[key]["label"] for key in sorted(set(domains)) if key in DOMAIN_RULES],
        "entities": entities,
        "domain_confidence": domain_confidence,
        "plan_ambiguities": plan_ambiguities,
        "needs_auth": requires_gui and "ui" in domain_set,
        "auth_strategy": infer_auth_strategy(domains, requires_gui),
        "staging_context": {
            "requires_ssh": mode == "auto" and protected_target,
            "ssh_access_mode": "none",
            "ssh_alias": "",
            "execution_host": "",
            "working_directory": "",
            "allowed_paths": [],
            "protected_target": protected_target,
            "requires_gui": requires_gui,
            "auth_required_reason": "UI / protected staging target detected" if (requires_gui or protected_target) else "",
        },
        "backend_execution_context": {
            "mode": "none",
            "ssh_alias": "",
            "execution_host": "",
            "working_directory": "",
            "allowed_paths": [],
        },
        "gui_execution_context": {
            "mode": "local_browser" if requires_gui else "none",
            "base_url": "",
            "auth_mode": "existing_session" if requires_gui else "none",
        },
        "auth_hints": {
            "login_url": "",
            "storage_state_path": ".autodev/temp/release/storage-state.json",
            "keychain_service": "autodev.release.staging",
            "manual_fallback_when": [
                "存在验证码、扫码或强 MFA",
                "预发认证流程不支持会话复用",
            ],
        },
        "cleanup_spec": {
            "required": True,
            "root": ".autodev/temp/release/",
            "preserve_paths": [
                ".autodev/ai-sot.json",
                ".autodev/path.md",
                ".autodev/autodev-config.json",
                ".autodev/temp/release/admin-auth.local.json",
                ".autodev/temp/release/storage-state.json",
            ],
            "description": "每次新的预发自动化开始前，清理上一轮预发测试的临时产物，但保留固定真相源和认证状态文件。",
        },
        "query_spec": {
            "required": needs_query,
            "dialect": dialect,
            "dialect_reason": dialect_reason,
            "entry_candidates": ["ssh", "db", "api"],
            "command": "",
            "skip_reason": "" if needs_query else "当前变更不需要自动查数",
            "statements": make_query_statements(entities, dialect) if needs_query else [],
            "manual_fallback_when": [
                "缺少只读查询入口",
                "无法确认表名或关键状态字段",
            ],
        },
        "seed_spec": {
            "required": needs_seed,
            "method_candidates": ["script", "api", "playwright", "manual_only"],
            "command": "",
            "allow_write": False,
            "skip_reason": "" if needs_seed else "当前变更不需要自动造单",
            "manual_fallback_when": [
                "造单需要高风险写操作且未显式放行",
                "没有脚本/API/管理台入口可自动化",
            ],
        },
        "use_cases": use_cases,
        "receipt_protocol": {
            "stages": [
                "🛠️ 预发测试开始",
                "🧭 自动化测试计划已生成",
                "📋 执行摘要",
                "🧹 上轮临时文件清理",
                "🔐 认证态检测",
                "🔎 自动查数开始",
                "🧪 自动造单开始",
                "🛰️ 后端 UC 验证开始",
                "🖥️ 前端 GUI 验证开始",
                "📦 证据已归档",
                "⚠️ 待人工确认项与剩余风险",
                "✅ 自动化预发结论",
            ]
        },
        "executive_summary": executive_summary,
        "evidence": {
            "root": ".autodev/temp/release/",
            "receipt_path": ".autodev/temp/release/release-auto-receipt.json",
        },
        "manual_mode_contract": {
            "keep_current_flow": True,
            "llm_reply_only": True,
        },
    }
    return plan


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def display_path(path: Path, repo_root: Path) -> str:
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def print_receipt(plan: Dict[str, object], output_path: Path) -> None:
    commits = plan.get("commits", [])
    commit_hash = commits[0]["hash"][:7] if commits else "N/A"
    focus = plan.get("focus_summary", "")
    mode = plan.get("selected_execution_mode", "manual")
    query_required = plan.get("query_spec", {}).get("required", False)
    staging_context = plan.get("staging_context", {})
    ai_sot_meta = plan.get("ai_sot", {})
    executive_summary = plan.get("executive_summary", {})
    print(f"🛠️ 预发测试开始 {{{commit_hash} - {focus}}}")
    print(f"🧭 计划已生成: {output_path}")
    print(
        "📋 执行摘要 "
        f"{{后端测试={'有' if executive_summary.get('has_backend_tests') else '无'} | "
        f"前端GUI测试={'有' if executive_summary.get('has_gui_tests') else '无'}}}"
    )
    for item in executive_summary.get("summary_items", []):
        print(f"  - {item}")
    for item in executive_summary.get("expected_user_visible_changes", []):
        print(f"👀 预期变化 {item}")
    print(f"📌 建议模式: {mode}")
    print(
        "🧭 自动化前置检查 "
        f"{{SSH={'已确认' if staging_context.get('ssh_alias') or staging_context.get('execution_host') else '未确认'} | "
        f"SSH方式={staging_context.get('ssh_access_mode') or '未确认'} | "
        f"GUI宿主={plan.get('gui_execution_context', {}).get('mode') or '未确认'} | "
        f"Auth={'已要求' if plan.get('needs_auth') else '未要求'} | "
        f"GUI={'已要求' if staging_context.get('requires_gui') else '未要求'} | "
        f"AI-SOT={'已锁定' if ai_sot_meta.get('path') else '未配置'} | "
        f"WriteOps={'允许' if plan.get('seed_spec', {}).get('allow_write') else '不允许'}}}"
    )
    print(f"🔎 需要查数: {'是' if query_required else '否'}")
    print(f"🧪 Use case 数量: {len(plan.get('use_cases', []))}")


def main() -> int:
    args = parse_args()
    repo_root = get_repo_root()
    target, is_range = resolve_target(args)
    commits = get_commit_rows(repo_root, target, is_range)
    feature_commits, workflow_commits = split_commit_rows(commits)
    if feature_commits:
        changed_files = aggregate_changed_files(repo_root, feature_commits)
        effective_commits = feature_commits
    else:
        changed_files = [] if workflow_commits else get_changed_files(repo_root, target, is_range)
        effective_commits = commits if not workflow_commits else []
    file_paths = [path for _, path in changed_files]
    all_domains = [domain for path in file_paths for domain in detect_domains(path)]
    entities = normalize_entities(extract_entities(file_paths), all_domains)
    domain_confidence = compute_domain_confidence(file_paths, all_domains)
    plan_ambiguities = append_commit_scope_ambiguities(
        detect_plan_ambiguities(file_paths, all_domains, entities),
        feature_commits=feature_commits,
        workflow_commits=workflow_commits,
    )
    dialect, dialect_reason = detect_sql_dialect(repo_root)
    ai_sot = load_ai_sot(repo_root)
    plan = build_plan(
        task=args.task,
        env_label=args.env,
        mode=args.mode,
        target=target,
        commits=effective_commits if effective_commits else commits,
        changed_files=changed_files,
        feature_commits=feature_commits,
        workflow_commits=workflow_commits,
        domains=all_domains,
        entities=entities,
        domain_confidence=domain_confidence,
        plan_ambiguities=plan_ambiguities,
        dialect=dialect,
        dialect_reason=dialect_reason,
    )
    plan = apply_ai_sot_overrides(plan, ai_sot)

    output_path = (repo_root / args.output).resolve() if not Path(args.output).is_absolute() else Path(args.output)
    write_text(output_path, json.dumps(plan, ensure_ascii=False, indent=2) + "\n")

    print(f"🛠️ release-plan 已生成: {display_path(output_path, repo_root)}")
    if args.stdout:
        print_receipt(plan, display_path(output_path, repo_root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

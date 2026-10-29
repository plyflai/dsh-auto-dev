#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


STAGE_TITLES = {
    "init": "🛠️ 预发测试开始",
    "plan": "🧭 自动化测试计划已生成",
    "summary": "📋 执行摘要",
    "cleanup": "🧹 上轮临时文件清理",
    "auth": "🔐 认证态检测",
    "query": "🔎 自动查数开始",
    "seed": "🧪 自动造单开始",
    "be": "🛰️ 后端 UC 验证开始",
    "gui": "🖥️ 前端 GUI 验证开始",
    "evidence": "📦 证据已归档",
    "risk": "⚠️ 待人工确认项与剩余风险",
    "done": "✅ 自动化预发结论",
}

CURRENT_PLAN: Dict[str, Any] = {}
CURRENT_AI_SOT: Dict[str, Any] = {}
AI_SOT_DEFAULT_PATH = ".autodev/ai-sot.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Execute an automated pre-release plan.")
    parser.add_argument("--plan", default=".autodev/temp/release-plan.json", help="Path to release plan JSON.")
    parser.add_argument(
        "--receipt",
        default=".autodev/temp/release/release-auto-receipt.json",
        help="Path to receipt JSON.",
    )
    parser.add_argument("--allow-gui", action="store_true", help="Allow GUI checks to execute.")
    parser.add_argument("--allow-write-ops", action="store_true", help="Allow seed/write operations.")
    parser.add_argument("--stdout", action="store_true", help="Print concise stage receipts.")
    return parser.parse_args()


def repo_root() -> Path:
    proc = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "failed to locate repo root")
    return Path(proc.stdout.strip()).resolve()


def skill_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_ai_sot(repo: Path, plan: Dict[str, Any]) -> Dict[str, Any]:
    ai_sot_meta = plan.get("ai_sot", {})
    relative_path = AI_SOT_DEFAULT_PATH
    if isinstance(ai_sot_meta, dict) and ai_sot_meta.get("path"):
        relative_path = str(ai_sot_meta["path"])
    ai_sot_path = (repo / relative_path).resolve() if not Path(relative_path).is_absolute() else Path(relative_path)
    if not ai_sot_path.exists():
        return {}
    return load_json(ai_sot_path)


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def summarize_output(text: str) -> str:
    text = text.strip()
    if len(text) <= 400:
        return text
    return text[:397] + "..."


def run_shell(command: str, cwd: Path) -> Tuple[bool, Dict[str, Any]]:
    proc = subprocess.run(
        command,
        cwd=str(cwd),
        shell=True,
        check=False,
        capture_output=True,
        text=True,
        env=os.environ.copy(),
    )
    detail = {
        "command": command,
        "exit_code": proc.returncode,
        "stdout": summarize_output(proc.stdout),
        "stderr": summarize_output(proc.stderr),
    }
    return proc.returncode == 0, detail


def stage_record(name: str) -> Dict[str, Any]:
    return {
        "stage": name,
        "title": STAGE_TITLES[name],
        "status": "pending",
        "details": [],
    }


def should_preserve_cleanup_path(target: Path, preserve_paths: List[Path]) -> bool:
    for preserve_path in preserve_paths:
        if target == preserve_path:
            return True
        if preserve_path.is_dir():
            try:
                target.relative_to(preserve_path)
                return True
            except ValueError:
                continue
    return False


def is_release_helper_script(target: Path, cleanup_root: Path) -> bool:
    helper_suffixes = {".js", ".cjs", ".mjs", ".sh", ".py"}
    if target.suffix.lower() not in helper_suffixes:
        return False
    if not target.is_file():
        return False
    return target.parent.resolve() == cleanup_root.resolve()


def is_release_local_secret(target: Path, cleanup_root: Path) -> bool:
    if not target.is_file():
        return False
    if target.parent.resolve() != cleanup_root.resolve():
        return False
    return target.name.endswith(".local.json")


def cleanup_previous_release_temp(plan: Dict[str, Any], repo: Path, plan_path: Path, receipt_path: Path) -> Tuple[bool, str]:
    cleanup_spec = plan.get("cleanup_spec", {})
    if not cleanup_spec.get("required", False):
        return True, "cleanup not required"

    root_value = str(cleanup_spec.get("root", "")).strip()
    if not root_value:
        return False, "cleanup_spec.root is required"
    cleanup_root = (repo / root_value).resolve() if not Path(root_value).is_absolute() else Path(root_value).resolve()
    if not cleanup_root.exists():
        cleanup_root.mkdir(parents=True, exist_ok=True)
        return True, "cleanup root initialized"
    if cleanup_root == repo or cleanup_root == repo / ".autodev":
        return False, "cleanup root is too broad"

    preserve_paths = [plan_path.resolve(), receipt_path.resolve()]
    for raw_path in cleanup_spec.get("preserve_paths", []):
        if not str(raw_path).strip():
            continue
        candidate = (repo / str(raw_path)).resolve() if not Path(str(raw_path)).is_absolute() else Path(str(raw_path)).resolve()
        preserve_paths.append(candidate)

    removed_count = 0
    for child in cleanup_root.iterdir():
        if should_preserve_cleanup_path(child.resolve(), preserve_paths):
            continue
        if is_release_helper_script(child.resolve(), cleanup_root):
            continue
        if is_release_local_secret(child.resolve(), cleanup_root):
            continue
        if child.is_dir():
            for nested in sorted(child.rglob("*"), reverse=True):
                if should_preserve_cleanup_path(nested.resolve(), preserve_paths):
                    continue
                if is_release_helper_script(nested.resolve(), cleanup_root):
                    continue
                if is_release_local_secret(nested.resolve(), cleanup_root):
                    continue
                if nested.is_file() or nested.is_symlink():
                    nested.unlink(missing_ok=True)
                    removed_count += 1
                elif nested.is_dir():
                    nested.rmdir()
            child.rmdir()
            removed_count += 1
        else:
            child.unlink(missing_ok=True)
            removed_count += 1
    return True, f"removed {removed_count} stale temp artifacts"


def render_executive_summary(plan: Dict[str, Any]) -> List[str]:
    summary = plan.get("executive_summary", {})
    lines = [
        "📋 执行摘要 "
        + "{后端测试="
        + ("有" if summary.get("has_backend_tests") else "无")
        + " | 前端GUI测试="
        + ("有" if summary.get("has_gui_tests") else "无")
        + "}",
    ]
    for item in summary.get("summary_items", []):
        lines.append(f"🧾 {item}")
    for item in summary.get("expected_user_visible_changes", []):
        lines.append(f"👀 预期变化 {item}")
    return lines


def mark_stage(stage: Dict[str, Any], status: str, message: str = "") -> None:
    stage["status"] = status
    if message:
        stage["details"].append(message)


def print_stage(title: str, status: str, message: str = "") -> None:
    suffix = {"passed": "✅", "failed": "❌", "skipped": "⏭️", "manual_fallback": "⏸️", "running": "🟡"}.get(
        status, "•"
    )
    line = f"{title} {suffix}"
    if message:
        line += f" {message}"
    print(line)


def auth_ready_via_env(plan: Dict[str, Any], repo: Path) -> bool:
    if os.environ.get("RELEASE_AUTH_READY") == "1":
        return True
    state_path = plan.get("auth_hints", {}).get("storage_state_path", "")
    if state_path:
        candidate = (repo / state_path).resolve() if not Path(state_path).is_absolute() else Path(state_path)
        return candidate.exists()
    return False


def run_auth_bridge(plan: Dict[str, Any], repo: Path) -> Tuple[bool, str]:
    repo_script = repo / "scripts" / "release-auth-bridge.sh"
    skill_script = skill_root() / "scripts" / "release-auth-bridge.sh"
    script_path = repo_script if repo_script.exists() else skill_script
    auth_hints = plan.get("auth_hints", {})
    state_path = auth_hints.get("storage_state_path", "")
    login_url = auth_hints.get("login_url", "")
    keychain_service = auth_hints.get("keychain_service", "")
    state_arg = ""
    if state_path:
        resolved = (repo / state_path).resolve() if not Path(state_path).is_absolute() else Path(state_path)
        state_arg = f" --state-file '{resolved}'"

    for strategy in plan.get("auth_strategy", []):
        if strategy == "existing_session":
            ok, detail = run_shell(f"'{script_path}' status{state_arg}", repo)
        elif strategy == "browser_login_handoff":
            ok, detail = run_shell(
                f"'{script_path}' browser-handoff --login-url '{login_url}'{state_arg} --timeout 60",
                repo,
            )
        elif strategy == "local_secret_store":
            ok, detail = run_shell(
                f"'{script_path}' local-secret-store --service '{keychain_service}'",
                repo,
            )
        else:
            continue
        if ok:
            return True, f"{strategy} ready"
        if detail["stderr"]:
            last_error = f"{strategy}: {detail['stderr']}"
        else:
            last_error = f"{strategy}: not ready"
    return False, locals().get("last_error", "no auth strategy succeeded")


def execute_required_command(
    *,
    command: str,
    cwd: Path,
    missing_reason: str,
    detail_store: List[Dict[str, Any]],
) -> Tuple[bool, str]:
    if not command:
        return False, missing_reason
    scope_reason = command_scope_guard(command, CURRENT_PLAN, missing_reason)
    if scope_reason:
        detail_store.append(
            {
                "command": command,
                "exit_code": -1,
                "stdout": "",
                "stderr": scope_reason,
            }
        )
        return False, scope_reason
    ok, detail = run_shell(command, cwd)
    detail_store.append(detail)
    if ok:
        return True, "ok"
    return False, detail.get("stderr") or detail.get("stdout") or "command failed"


def execute_checks(
    *,
    check_group: List[Dict[str, Any]],
    cwd: Path,
    detail_store: List[Dict[str, Any]],
    missing_reason: str,
) -> Tuple[bool, str]:
    for check in check_group:
        ok, reason = execute_required_command(
            command=str(check.get("command", "")).strip(),
            cwd=cwd,
            missing_reason=missing_reason,
            detail_store=detail_store,
        )
        if not ok and check.get("required", True):
            return False, reason
    return True, "ok"


def build_receipt(plan: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema_version": "1.0",
        "task": plan.get("task", ""),
        "target": plan.get("target", ""),
        "focus_summary": plan.get("focus_summary", ""),
        "selected_execution_mode": "auto",
        "final_status": "running",
        "stages": [stage_record(name) for name in STAGE_TITLES],
        "use_cases": [],
        "risks": [],
        "evidence_root": plan.get("evidence", {}).get("root", ".autodev/temp/release/"),
    }


def compare_locked_sections(plan_section: Any, lock_section: Any, prefix: str = "") -> List[str]:
    mismatches: List[str] = []
    if not isinstance(lock_section, dict):
        return mismatches

    current = plan_section if isinstance(plan_section, dict) else {}
    for key, lock_value in lock_section.items():
        path = f"{prefix}.{key}" if prefix else key
        plan_value = current.get(key)
        if isinstance(lock_value, dict):
          mismatches.extend(compare_locked_sections(plan_value, lock_value, path))
        else:
          if plan_value != lock_value:
              mismatches.append(f"{path}: plan={plan_value!r} ai_sot={lock_value!r}")
    return mismatches


def get_stage(receipt: Dict[str, Any], name: str) -> Dict[str, Any]:
    for stage in receipt["stages"]:
        if stage["stage"] == name:
            return stage
    raise KeyError(name)


def command_scope_guard(command: str, plan: Dict[str, Any], lane: str) -> str:
    backend_context = plan.get("backend_execution_context", {})
    gui_context = plan.get("gui_execution_context", {})

    if lane in {"缺少自动查数命令", "缺少自动造单命令", "缺少后端校验命令"}:
        mode = str(backend_context.get("mode", "")).strip()
        ssh_alias = str(backend_context.get("ssh_alias", "")).strip()
        working_directory = str(backend_context.get("working_directory", "")).strip()
        allowed_paths = [str(path).strip() for path in backend_context.get("allowed_paths", []) if str(path).strip()]

        if mode in {"alias_only", "jump_alias"}:
            if not ssh_alias or f"ssh {ssh_alias}" not in command:
                return "Missing required backend ssh alias in command"
        if working_directory and working_directory not in command:
            return "Missing required backend working_directory in command"
        if allowed_paths and not any(path in command for path in allowed_paths):
            return "Command does not reference any allowed backend path"
        return ""

    if lane == "缺少 GUI 校验命令":
        gui_mode = str(gui_context.get("mode", "")).strip()
        base_url = str(gui_context.get("base_url", "")).strip()
        backend_alias = str(backend_context.get("ssh_alias", "")).strip()
        if gui_mode in {"local_browser", "local_runner"} and backend_alias and f"ssh {backend_alias}" in command:
            return "GUI command must not execute through backend SSH context"
        if gui_mode in {"local_browser", "remote_browser"} and base_url and base_url not in command:
            return "GUI command does not reference configured GUI base_url"
    return ""


def semantic_guard(plan: Dict[str, Any]) -> List[str]:
    domain_set = set(plan.get("domains", []))
    staging_context = plan.get("staging_context", {})
    backend_context = plan.get("backend_execution_context", {})
    gui_context = plan.get("gui_execution_context", {})
    automation_scope = plan.get("automation_scope", "")
    use_cases = plan.get("use_cases", [])

    reasons: List[str] = []
    any_gui_checks = any(use_case.get("gui_checks") for use_case in use_cases)
    any_required_gui_uc = any(use_case.get("requires_gui") for use_case in use_cases)
    ssh_access_mode = str(backend_context.get("mode", "")).strip()
    ssh_alias = str(backend_context.get("ssh_alias", "")).strip()
    working_directory = str(backend_context.get("working_directory", "")).strip()
    allowed_paths = [str(path).strip() for path in backend_context.get("allowed_paths", []) if str(path).strip()]
    gui_mode = str(gui_context.get("mode", "")).strip()

    if plan.get("selected_execution_mode") == "auto":
        if (staging_context.get("protected_target") or ssh_access_mode != "none" or gui_mode != "none") and not CURRENT_AI_SOT:
            reasons.append("Missing .autodev/ai-sot.json for automated protected-environment execution")

    if CURRENT_AI_SOT:
        pre_release = CURRENT_AI_SOT.get("pre_release", {})
        if isinstance(pre_release, dict):
            for section_key in ("staging_context", "backend_execution_context", "gui_execution_context", "auth_hints"):
                locked_section = pre_release.get(section_key)
                if isinstance(locked_section, dict):
                    mismatches = compare_locked_sections(plan.get(section_key, {}), locked_section, section_key)
                    if mismatches:
                        reasons.append(f"Plan conflicts with ai-sot in {section_key}")
                        break

    if "ui" in domain_set and not any_gui_checks:
      reasons.append("UI domain detected but no GUI checks provided")
    if any_required_gui_uc and not any_gui_checks:
      reasons.append("At least one use case requires GUI but gui_checks is empty")
    if automation_scope in {"be_plus_gui", "full_env"} and not any_gui_checks:
      reasons.append(f"Automation scope `{automation_scope}` requires GUI checks")
    if staging_context.get("requires_ssh"):
      if ssh_access_mode == "web_terminal_only":
        reasons.append("SSH access mode `web_terminal_only` is not reusable by auto runner")
      if ssh_access_mode in {"alias_only", "jump_alias"} and not ssh_alias:
        reasons.append("Missing staging SSH alias")
      if not working_directory:
        reasons.append("Missing staging working directory")
      if not allowed_paths:
        reasons.append("Missing staging allowed_paths")
    if any_required_gui_uc and gui_mode in {"none", "manual_only"}:
      reasons.append("GUI-required use cases cannot run with current gui_execution_context")
    if plan.get("needs_auth") and not plan.get("auth_strategy"):
      reasons.append("Missing auth strategy for protected target")

    return reasons


def main() -> int:
    args = parse_args()
    repo = repo_root()
    plan_path = (repo / args.plan).resolve() if not Path(args.plan).is_absolute() else Path(args.plan)
    receipt_path = (repo / args.receipt).resolve() if not Path(args.receipt).is_absolute() else Path(args.receipt)
    plan = load_json(plan_path)
    global CURRENT_PLAN
    global CURRENT_AI_SOT
    CURRENT_PLAN = plan
    CURRENT_AI_SOT = load_ai_sot(repo, plan)
    receipt = build_receipt(plan)

    init_stage = get_stage(receipt, "init")
    plan_stage = get_stage(receipt, "plan")
    summary_stage = get_stage(receipt, "summary")
    cleanup_stage = get_stage(receipt, "cleanup")
    mark_stage(init_stage, "passed", plan.get("focus_summary", ""))
    mark_stage(plan_stage, "passed", str(plan_path.relative_to(repo)))
    for line in render_executive_summary(plan):
        summary_stage["details"].append(line)
    mark_stage(summary_stage, "passed", "executive summary ready")
    if args.stdout:
        print_stage(init_stage["title"], "passed", plan.get("focus_summary", ""))
        print_stage(plan_stage["title"], "passed", str(plan_path.relative_to(repo)))
        for line in summary_stage["details"]:
            print(line)

    semantic_reasons = semantic_guard(plan)
    if semantic_reasons:
        auth_stage = get_stage(receipt, "auth")
        mark_stage(auth_stage, "manual_fallback", "; ".join(semantic_reasons[:2]))
        receipt["final_status"] = "manual_fallback"
        receipt["risks"].extend(semantic_reasons)
        if args.stdout:
            print_stage(auth_stage["title"], "manual_fallback", semantic_reasons[0])
        evidence_stage = get_stage(receipt, "evidence")
        mark_stage(evidence_stage, "passed", "receipt only")
        risk_stage = get_stage(receipt, "risk")
        mark_stage(risk_stage, "manual_fallback", "; ".join(semantic_reasons[:3]))
        done_stage = get_stage(receipt, "done")
        mark_stage(done_stage, "manual_fallback", "自动化预发结论：转人工补测")
        write_json(receipt_path, receipt)
        return 2

    cleanup_ok, cleanup_msg = cleanup_previous_release_temp(plan, repo, plan_path, receipt_path)
    if not cleanup_ok:
        mark_stage(cleanup_stage, "manual_fallback", cleanup_msg)
        receipt["final_status"] = "manual_fallback"
        receipt["risks"].append(cleanup_msg)
        if args.stdout:
            print_stage(cleanup_stage["title"], "manual_fallback", cleanup_msg)
        evidence_stage = get_stage(receipt, "evidence")
        mark_stage(evidence_stage, "passed", "receipt only")
        risk_stage = get_stage(receipt, "risk")
        mark_stage(risk_stage, "manual_fallback", cleanup_msg)
        done_stage = get_stage(receipt, "done")
        mark_stage(done_stage, "manual_fallback", "清理上轮临时文件失败，转人工")
        write_json(receipt_path, receipt)
        return 2
    mark_stage(cleanup_stage, "passed", cleanup_msg)
    if args.stdout:
        print_stage(cleanup_stage["title"], "passed", cleanup_msg)

    auth_stage = get_stage(receipt, "auth")
    if plan.get("needs_auth"):
        auth_ok = auth_ready_via_env(plan, repo)
        auth_msg = "existing_session ready"
        if not auth_ok:
            auth_ok, auth_msg = run_auth_bridge(plan, repo)
        if not auth_ok:
            mark_stage(auth_stage, "manual_fallback", auth_msg)
            receipt["final_status"] = "manual_fallback"
            receipt["risks"].append(auth_msg)
            if args.stdout:
                print_stage(auth_stage["title"], "manual_fallback", auth_msg)
            evidence_stage = get_stage(receipt, "evidence")
            mark_stage(evidence_stage, "passed", "receipt only")
            risk_stage = get_stage(receipt, "risk")
            mark_stage(risk_stage, "manual_fallback", auth_msg)
            done_stage = get_stage(receipt, "done")
            mark_stage(done_stage, "manual_fallback", "认证未就绪，转人工")
            write_json(receipt_path, receipt)
            return 2
        mark_stage(auth_stage, "passed", auth_msg)
        if args.stdout:
            print_stage(auth_stage["title"], "passed", auth_msg)
    else:
        mark_stage(auth_stage, "skipped", "plan does not require auth")
        if args.stdout:
            print_stage(auth_stage["title"], "skipped", "无需认证")

    query_stage = get_stage(receipt, "query")
    query_spec = plan.get("query_spec", {})
    query_details: List[Dict[str, Any]] = []
    if query_spec.get("required"):
        ok, reason = execute_required_command(
            command=str(query_spec.get("command", "")).strip(),
            cwd=repo,
            missing_reason="缺少自动查数命令",
            detail_store=query_details,
        )
        query_stage["details"].extend(query_details)
        if not ok:
            mark_stage(query_stage, "manual_fallback", reason)
            receipt["final_status"] = "manual_fallback"
            receipt["risks"].append(reason)
            if args.stdout:
                print_stage(query_stage["title"], "manual_fallback", reason)
            write_json(receipt_path, receipt)
            return 2
        mark_stage(query_stage, "passed", "query command finished")
        if args.stdout:
            print_stage(query_stage["title"], "passed", "query command finished")
    else:
        mark_stage(query_stage, "skipped", "plan does not require query")
        if args.stdout:
            print_stage(query_stage["title"], "skipped", "无需查数")

    seed_stage = get_stage(receipt, "seed")
    seed_spec = plan.get("seed_spec", {})
    seed_details: List[Dict[str, Any]] = []
    if seed_spec.get("required"):
        if not args.allow_write_ops:
            reason = "seed step requires --allow-write-ops"
            mark_stage(seed_stage, "manual_fallback", reason)
            receipt["final_status"] = "manual_fallback"
            receipt["risks"].append(reason)
            if args.stdout:
                print_stage(seed_stage["title"], "manual_fallback", reason)
            write_json(receipt_path, receipt)
            return 2
        ok, reason = execute_required_command(
            command=str(seed_spec.get("command", "")).strip(),
            cwd=repo,
            missing_reason="缺少自动造单命令",
            detail_store=seed_details,
        )
        seed_stage["details"].extend(seed_details)
        if not ok:
            mark_stage(seed_stage, "manual_fallback", reason)
            receipt["final_status"] = "manual_fallback"
            receipt["risks"].append(reason)
            if args.stdout:
                print_stage(seed_stage["title"], "manual_fallback", reason)
            write_json(receipt_path, receipt)
            return 2
        mark_stage(seed_stage, "passed", "seed command finished")
        if args.stdout:
            print_stage(seed_stage["title"], "passed", "seed command finished")
    else:
        mark_stage(seed_stage, "skipped", "plan does not require seed")
        if args.stdout:
            print_stage(seed_stage["title"], "skipped", "无需造单")

    be_stage = get_stage(receipt, "be")
    gui_stage = get_stage(receipt, "gui")
    any_gui_required = False
    use_case_results: List[Dict[str, Any]] = []

    for use_case in plan.get("use_cases", []):
        result = {
            "id": use_case.get("id", ""),
            "title": use_case.get("title", ""),
            "status": "passed",
            "details": [],
        }
        be_details: List[Dict[str, Any]] = []
        ok, reason = execute_checks(
            check_group=use_case.get("be_checks", []),
            cwd=repo,
            detail_store=be_details,
            missing_reason="缺少后端校验命令",
        )
        result["details"].extend(be_details)
        if not ok:
            result["status"] = "manual_fallback"
            result["details"].append({"reason": reason})
            receipt["risks"].append(f"{use_case.get('id')}: {reason}")
        gui_checks = use_case.get("gui_checks", [])
        if use_case.get("requires_gui") and not gui_checks:
            result["status"] = "manual_fallback"
            result["details"].append({"reason": "GUI required by use case but no gui_checks provided"})
            receipt["risks"].append(f"{use_case.get('id')}: GUI required by use case but no gui_checks provided")
        if gui_checks:
            any_gui_required = True
            if not args.allow_gui:
                result["status"] = "manual_fallback"
                result["details"].append({"reason": "GUI checks require --allow-gui"})
                receipt["risks"].append(f"{use_case.get('id')}: GUI checks require --allow-gui")
            else:
                gui_details: List[Dict[str, Any]] = []
                gui_ok, gui_reason = execute_checks(
                    check_group=gui_checks,
                    cwd=repo,
                    detail_store=gui_details,
                    missing_reason="缺少 GUI 校验命令",
                )
                result["details"].extend(gui_details)
                if not gui_ok:
                    result["status"] = "manual_fallback"
                    result["details"].append({"reason": gui_reason})
                    receipt["risks"].append(f"{use_case.get('id')}: {gui_reason}")
        use_case_results.append(result)

    receipt["use_cases"] = use_case_results
    if any(result["status"] != "passed" for result in use_case_results):
        mark_stage(be_stage, "manual_fallback", "至少一个 use case 未能自动闭环")
        if any_gui_required:
            mark_stage(gui_stage, "manual_fallback", "至少一个 GUI case 未能自动闭环")
        else:
            mark_stage(gui_stage, "skipped", "plan does not require gui")
        receipt["final_status"] = "manual_fallback"
    else:
        mark_stage(be_stage, "passed", "all backend checks passed")
        if any_gui_required:
            mark_stage(gui_stage, "passed", "all gui checks passed")
        else:
            mark_stage(gui_stage, "skipped", "plan does not require gui")
        receipt["final_status"] = "passed"

    if args.stdout:
        print_stage(be_stage["title"], be_stage["status"], be_stage["details"][-1] if be_stage["details"] else "")
        print_stage(gui_stage["title"], gui_stage["status"], gui_stage["details"][-1] if gui_stage["details"] else "")

    evidence_stage = get_stage(receipt, "evidence")
    mark_stage(evidence_stage, "passed", str(receipt_path.relative_to(repo)))
    risk_stage = get_stage(receipt, "risk")
    if receipt["risks"]:
        mark_stage(risk_stage, "manual_fallback", "; ".join(receipt["risks"][:3]))
    else:
        mark_stage(risk_stage, "passed", "no remaining high-signal risks")
    done_stage = get_stage(receipt, "done")
    if receipt["final_status"] == "passed":
        mark_stage(done_stage, "passed", "自动化预发结论：通过")
    else:
        mark_stage(done_stage, "manual_fallback", "自动化预发结论：转人工补测")

    if args.stdout:
        print_stage(evidence_stage["title"], "passed", str(receipt_path.relative_to(repo)))
        print_stage(risk_stage["title"], risk_stage["status"], risk_stage["details"][-1] if risk_stage["details"] else "")
        print_stage(done_stage["title"], done_stage["status"], done_stage["details"][-1] if done_stage["details"] else "")

    write_json(receipt_path, receipt)
    return 0 if receipt["final_status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())

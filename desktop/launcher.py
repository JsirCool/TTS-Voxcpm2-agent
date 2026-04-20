from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from pathlib import Path
from tkinter import BOTH, LEFT, RIGHT, filedialog, messagebox, ttk
import tkinter as tk


DEFAULTS: dict[str, str] = {
    "API_PORT": "8100",
    "WEB_PORT": "3010",
    "HARNESS_DESKTOP_ROOT": ".desktop-runtime",
    "HARNESS_VOICE_SOURCE_DIR": "..\\voice_sourse",
    "VOXCPM_MODEL_PATH": "E:\\VC\\pretrained_models\\VoxCPM2",
    "HF_HOME": "E:\\VC\\hf-cache",
}

SERVICE_LABELS = {
    "web": "Web 前端",
    "api": "API 后端",
    "whisperx": "WhisperX",
    "voxcpm": "VoxCPM",
}


def resolve_root() -> Path:
    start = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
    for candidate in [start, *start.parents]:
        marker = candidate / "scripts" / "windows" / "_desktop_env.bat"
        if marker.exists():
            return candidate
    raise RuntimeError("无法定位项目根目录，未找到 scripts/windows/_desktop_env.bat")


ROOT = resolve_root()
DESKTOP_ENV_PATH = ROOT / ".desktop" / "desktop.env"
ICON_ICO_PATH = ROOT / "desktop" / "assets" / "launcher-icon.ico"
ICON_PNG_PATH = ROOT / "desktop" / "assets" / "launcher-icon.png"


def load_env_file(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()
    return data


def save_env_file(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={value}" for key, value in values.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def resolve_display_path(raw_value: str) -> str:
    if not raw_value:
        return ""
    candidate = Path(raw_value)
    if candidate.is_absolute():
        return str(candidate)
    return str((ROOT / raw_value).resolve())


def to_config_value(raw_value: str, *, make_relative: bool = False) -> str:
    text = raw_value.strip()
    if not text:
        return text
    path = Path(text)
    if not make_relative:
        return str(path)
    try:
        return str(path.resolve().relative_to(ROOT.resolve()))
    except Exception:
        return str(path)


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.6)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            return 200 <= response.status < 400
    except Exception:
        return False


def safe_int(value: str, fallback: int) -> int:
    try:
        return int((value or "").strip())
    except Exception:
        return fallback


class LauncherApp:
    def __init__(self, master: tk.Tk) -> None:
        self.master = master
        self.master.title("姜Sir TTS 工作台启动器")
        self.master.geometry("820x650")
        self.master.minsize(760, 600)
        self._icon_image: tk.PhotoImage | None = None
        self._apply_icon()

        raw = {**DEFAULTS, **load_env_file(DESKTOP_ENV_PATH)}
        self.vars: dict[str, tk.StringVar] = {
            "VOXCPM_MODEL_PATH": tk.StringVar(value=resolve_display_path(raw["VOXCPM_MODEL_PATH"])),
            "HF_HOME": tk.StringVar(value=resolve_display_path(raw["HF_HOME"])),
            "HARNESS_VOICE_SOURCE_DIR": tk.StringVar(value=resolve_display_path(raw["HARNESS_VOICE_SOURCE_DIR"])),
            "HARNESS_DESKTOP_ROOT": tk.StringVar(value=resolve_display_path(raw["HARNESS_DESKTOP_ROOT"])),
            "API_PORT": tk.StringVar(value=raw["API_PORT"]),
            "WEB_PORT": tk.StringVar(value=raw["WEB_PORT"]),
        }
        self.status_var = tk.StringVar(value="等待环境检查")
        self.service_vars = {name: tk.StringVar(value="未知") for name in SERVICE_LABELS}

        self._build_ui()
        self._warn_if_missing()
        self.refresh_status()

    def _apply_icon(self) -> None:
        try:
            if ICON_ICO_PATH.exists():
                self.master.iconbitmap(default=str(ICON_ICO_PATH))
        except Exception:
            pass
        try:
            if ICON_PNG_PATH.exists():
                self._icon_image = tk.PhotoImage(file=str(ICON_PNG_PATH))
                self.master.iconphoto(True, self._icon_image)
        except Exception:
            pass

    def _build_ui(self) -> None:
        root = ttk.Frame(self.master, padding=18)
        root.pack(fill=BOTH, expand=True)

        title = ttk.Label(root, text="姜Sir TTS 工作台启动器", font=("Microsoft YaHei UI", 18, "bold"))
        title.pack(anchor="w")
        subtitle = ttk.Label(
            root,
            text="双击后即可在后台启动桌面模式服务，并自动打开浏览器。模型、缓存和 voice_sourse 路径会保存到 .desktop/desktop.env。",
            wraplength=760,
            foreground="#4b5563",
        )
        subtitle.pack(anchor="w", pady=(6, 16))

        config = ttk.LabelFrame(root, text="环境向导", padding=14)
        config.pack(fill=tk.X)

        self._path_row(config, "VoxCPM 模型路径", "VOXCPM_MODEL_PATH")
        self._path_row(config, "WhisperX / HF 缓存", "HF_HOME")
        self._path_row(config, "voice_sourse 路径", "HARNESS_VOICE_SOURCE_DIR", create_if_missing=True)
        self._path_row(config, "桌面模式数据目录", "HARNESS_DESKTOP_ROOT", create_if_missing=True)
        self._text_row(config, "API 端口", "API_PORT")
        self._text_row(config, "Web 端口", "WEB_PORT")

        actions = ttk.Frame(root)
        actions.pack(fill=tk.X, pady=(14, 10))
        ttk.Button(actions, text="保存配置", command=self.save_config).pack(side=LEFT)
        ttk.Button(actions, text="启动全部", command=self.start_all).pack(side=LEFT, padx=(8, 0))
        ttk.Button(actions, text="停止全部", command=self.stop_all).pack(side=LEFT, padx=(8, 0))
        ttk.Button(actions, text="刷新状态", command=self.refresh_status).pack(side=LEFT, padx=(8, 0))

        shortcuts = ttk.Frame(root)
        shortcuts.pack(fill=tk.X, pady=(0, 14))
        ttk.Button(shortcuts, text="打开 Web", command=self.open_web).pack(side=LEFT)
        ttk.Button(shortcuts, text="打开日志目录", command=self.open_logs).pack(side=LEFT, padx=(8, 0))
        ttk.Button(shortcuts, text="打开桌面数据目录", command=self.open_data_root).pack(side=LEFT, padx=(8, 0))
        ttk.Button(shortcuts, text="调试启动", command=self.start_debug).pack(side=LEFT, padx=(8, 0))

        status = ttk.LabelFrame(root, text="服务状态", padding=14)
        status.pack(fill=BOTH, expand=True)
        for key, label in SERVICE_LABELS.items():
            row = ttk.Frame(status)
            row.pack(fill=tk.X, pady=4)
            ttk.Label(row, text=label, width=18).pack(side=LEFT)
            ttk.Label(row, textvariable=self.service_vars[key]).pack(side=LEFT)

        bottom = ttk.Frame(root)
        bottom.pack(fill=tk.X, pady=(14, 0))
        ttk.Label(bottom, textvariable=self.status_var, foreground="#374151", wraplength=760).pack(anchor="w")

    def _path_row(self, parent: ttk.Widget, label: str, key: str, *, create_if_missing: bool = False) -> None:
        row = ttk.Frame(parent)
        row.pack(fill=tk.X, pady=5)
        ttk.Label(row, text=label, width=18).pack(side=LEFT)
        ttk.Entry(row, textvariable=self.vars[key]).pack(side=LEFT, fill=tk.X, expand=True, padx=(0, 8))
        ttk.Button(row, text="浏览", command=lambda: self.pick_directory(key, create_if_missing=create_if_missing)).pack(side=RIGHT)

    def _text_row(self, parent: ttk.Widget, label: str, key: str) -> None:
        row = ttk.Frame(parent)
        row.pack(fill=tk.X, pady=5)
        ttk.Label(row, text=label, width=18).pack(side=LEFT)
        ttk.Entry(row, textvariable=self.vars[key], width=12).pack(side=LEFT)

    def pick_directory(self, key: str, *, create_if_missing: bool = False) -> None:
        initial = self.vars[key].get() or str(ROOT)
        path = filedialog.askdirectory(initialdir=initial, title=f"选择 {key}")
        if not path:
            return
        if create_if_missing:
            Path(path).mkdir(parents=True, exist_ok=True)
        self.vars[key].set(path)

    def save_config(self) -> None:
        try:
            api_port = int(self.vars["API_PORT"].get().strip())
            web_port = int(self.vars["WEB_PORT"].get().strip())
        except ValueError:
            messagebox.showerror("端口错误", "API/Web 端口必须是数字。")
            return

        if api_port <= 0 or web_port <= 0:
            messagebox.showerror("端口错误", "端口必须大于 0。")
            return

        voice_dir = Path(self.vars["HARNESS_VOICE_SOURCE_DIR"].get().strip())
        if not voice_dir.exists():
            voice_dir.mkdir(parents=True, exist_ok=True)

        desktop_root = Path(self.vars["HARNESS_DESKTOP_ROOT"].get().strip())
        desktop_root.mkdir(parents=True, exist_ok=True)

        payload = {
            "VOXCPM_MODEL_PATH": to_config_value(self.vars["VOXCPM_MODEL_PATH"].get()),
            "HF_HOME": to_config_value(self.vars["HF_HOME"].get()),
            "HARNESS_VOICE_SOURCE_DIR": to_config_value(self.vars["HARNESS_VOICE_SOURCE_DIR"].get()),
            "HARNESS_DESKTOP_ROOT": to_config_value(self.vars["HARNESS_DESKTOP_ROOT"].get(), make_relative=True),
            "API_PORT": str(api_port),
            "WEB_PORT": str(web_port),
        }
        save_env_file(DESKTOP_ENV_PATH, payload)
        self.status_var.set(f"配置已保存到 {DESKTOP_ENV_PATH}")

    def _warn_if_missing(self) -> None:
        missing: list[str] = []
        if not Path(self.vars["VOXCPM_MODEL_PATH"].get()).exists():
            missing.append("VoxCPM 模型路径")
        if not Path(self.vars["HF_HOME"].get()).exists():
            missing.append("WhisperX / HF 缓存路径")
        if missing:
            messagebox.showwarning(
                "首次启动提示",
                "以下路径当前不存在，保存后仍可继续启动，但相关服务可能无法就绪：\n\n- " + "\n- ".join(missing),
            )

    def _run_script(self, script_name: str, *args: str) -> None:
        script = ROOT / script_name
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        subprocess.Popen(
            ["cmd.exe", "/c", str(script), *args],
            cwd=str(ROOT),
            creationflags=creation_flags,
        )

    def start_all(self) -> None:
        self.save_config()
        self.status_var.set("正在启动桌面模式服务…")
        self._run_script("start-desktop-stack.bat", "--no-browser")
        self.master.after(3500, self.open_web)
        self.master.after(5000, self.refresh_status)

    def start_debug(self) -> None:
        self.save_config()
        subprocess.Popen(["cmd.exe", "/c", str(ROOT / "start-desktop-stack-debug.bat")], cwd=str(ROOT))
        self.status_var.set("已启动调试模式。")

    def stop_all(self) -> None:
        self.status_var.set("正在停止桌面模式服务…")
        self._run_script("stop-desktop-stack.bat", "--no-pause")
        self.master.after(2500, self.refresh_status)

    def open_web(self) -> None:
        webbrowser.open(f"http://127.0.0.1:{self.vars['WEB_PORT'].get().strip()}")

    def open_logs(self) -> None:
        logs = Path(self.vars["HARNESS_DESKTOP_ROOT"].get()) / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        os.startfile(logs)  # type: ignore[attr-defined]

    def open_data_root(self) -> None:
        root = Path(self.vars["HARNESS_DESKTOP_ROOT"].get())
        root.mkdir(parents=True, exist_ok=True)
        os.startfile(root)  # type: ignore[attr-defined]

    def refresh_status(self) -> None:
        def job() -> None:
            api_port = safe_int(self.vars["API_PORT"].get(), 8100)
            web_port = safe_int(self.vars["WEB_PORT"].get(), 3010)
            statuses = {
                "web": "运行中" if port_open(web_port) else "未启动",
                "api": "就绪" if http_ok(f"http://127.0.0.1:{api_port}/healthz") else ("运行中" if port_open(api_port) else "未启动"),
                "whisperx": "就绪" if http_ok("http://127.0.0.1:7860/readyz") else ("运行中" if port_open(7860) else "未启动"),
                "voxcpm": "就绪" if http_ok("http://127.0.0.1:8877/healthz") else ("运行中" if port_open(8877) else "未启动"),
            }

            def apply() -> None:
                for key, value in statuses.items():
                    self.service_vars[key].set(value)
                self.status_var.set("状态已刷新")

            self.master.after(0, apply)

        threading.Thread(target=job, daemon=True).start()


def main() -> None:
    root = tk.Tk()
    LauncherApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()

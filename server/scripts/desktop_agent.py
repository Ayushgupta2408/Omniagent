"""
desktop_agent.py  — NEXUS Desktop Automation Engine v2
═══════════════════════════════════════════════════════════════════════════════
Four-layer automation engine that works on every app type:

  Layer 1 — CDP (Chromium DevTools Protocol)
             Connects to Electron apps as if they were web pages.
             Gives full DOM access: find by selector, text, placeholder, aria.
             Works on: WhatsApp, Discord, Spotify, VS Code, Notion, Figma, etc.

  Layer 2 — UIA (Windows UI Automation via pywinauto)
             Native Windows accessibility tree.
             Works on: Notepad, Calculator, MS Office, File Explorer, etc.

  Layer 3 — OCR + Mouse (EasyOCR + pyautogui)
             Screenshot the window → find text on screen → click coordinates.
             Universal fallback. Works on literally any app with visible text.

  Layer 4 — Keyboard Shortcuts
             Hardcoded sequences for known apps.
             Fastest path when layout is predictable.

Usage:
  python desktop_agent.py find_window   <app_name> [--timeout 10]
  python desktop_agent.py click         <app_name> <element_name>
  python desktop_agent.py type          <app_name> <element_name> <text>
  python desktop_agent.py focus_window  <app_name>
  python desktop_agent.py list_elements <app_name>
  python desktop_agent.py screenshot    <app_name>
  python desktop_agent.py verify        <app_name> <text>

Output: JSON to stdout
  { "success": true,  "message": "...", "strategy": "..." }
  { "success": false, "error":   "..." }
═══════════════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations
import sys, json, time, argparse, os, subprocess, tempfile, base64
from pathlib import Path
from typing import Optional, Tuple, List

# ─── stdout helpers ───────────────────────────────────────────────────────────

def ok(message: str, **extra):
    print(json.dumps({"success": True, "message": message, **extra}), flush=True)
    sys.exit(0)

def fail(error: str, **extra):
    print(json.dumps({"success": False, "error": error, **extra}), flush=True)
    sys.exit(1)

def log(msg: str):
    print(json.dumps({"log": msg}), file=sys.stderr, flush=True)

# ─── dependency check & lazy imports ─────────────────────────────────────────

def require(pkg: str, import_name: str = None):
    import importlib
    name = import_name or pkg
    try:
        return importlib.import_module(name)
    except ImportError:
        log(f"Installing {pkg}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "--quiet"])
        return importlib.import_module(name)

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — Window & Process Utilities
# ═══════════════════════════════════════════════════════════════════════════════

def normalise(s: str) -> str:
    return s.lower().replace(" ", "").replace("-", "").replace("_", "")

def fuzzy_score(query: str, candidate: str) -> int:
    q, c = normalise(query), normalise(candidate)
    if c == q:           return 100
    if c.startswith(q): return 85
    if q in c:          return 70
    if c in q:          return 55
    hits = sum(1 for ch in q if ch in c)
    return int(hits / max(len(q), 1) * 30)

def find_window_handle(app_name: str, timeout: int = 10):
    """Return (Application, window_wrapper) or call fail()."""
    pw = require("pywinauto")
    from pywinauto import Application, Desktop

    deadline = time.time() + timeout
    while time.time() < deadline:
        desktop = Desktop(backend="uia")
        wins = desktop.windows()
        best, best_score = None, 0
        for w in wins:
            try:
                title = w.window_text()
                cls   = w.class_name()
                score = max(fuzzy_score(app_name, title), fuzzy_score(app_name, cls))
                if score > best_score:
                    best_score, best = score, w
            except Exception:
                continue
        if best and best_score >= 40:
            try:
                app = Application(backend="uia").connect(handle=best.handle)
                return app, best
            except Exception:
                pass
        time.sleep(0.8)
    fail(f'Window not found for "{app_name}" after {timeout}s')

def get_window_rect(win) -> Tuple[int,int,int,int]:
    """Return (left, top, right, bottom)."""
    try:
        r = win.rectangle()
        return r.left, r.top, r.right, r.bottom
    except Exception:
        return 0, 0, 1920, 1080

def focus_window(win):
    """Bring window to foreground."""
    import ctypes
    try:
        win.set_focus()
    except Exception:
        pass
    try:
        ctypes.windll.user32.ShowWindow(win.handle, 9)
        ctypes.windll.user32.SetForegroundWindow(win.handle)
    except Exception:
        pass
    time.sleep(0.4)

def get_process_exe(win) -> str:
    """Return the executable path of the process owning this window."""
    psutil = require("psutil")
    try:
        import ctypes
        pid = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(win.handle, ctypes.byref(pid))
        p = psutil.Process(pid.value)
        return p.exe().lower()
    except Exception:
        return ""

def is_electron(win) -> bool:
    """Detect if a window belongs to an Electron app."""
    exe = get_process_exe(win)
    # Electron bundles Chromium — exe is usually the app name, not "electron"
    # But the process will have child processes with "chromium" or expose CDP
    ELECTRON_APP_NAMES = {
        "whatsapp", "discord", "spotify", "code", "vscode",
        "slack", "notion", "figma", "obsidian", "signal",
        "telegram", "skype", "zoom", "teams", "msteams",
        "1password", "bitwarden", "postman", "insomnia",
        "githubdesktop", "github desktop", "linearapp",
        "clickup", "asana", "trello",
    }
    exe_stem = Path(exe).stem.lower().replace(" ", "").replace("-", "")
    if exe_stem in ELECTRON_APP_NAMES:
        return True
    # Also check window class name — Electron windows often use "Chrome_WidgetWin"
    try:
        cls = win.class_name().lower()
        if "chrome_widgetwin" in cls or "cefclient" in cls:
            return True
    except Exception:
        pass
    return False

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — Layer 1: CDP (Electron apps via Playwright)
# ═══════════════════════════════════════════════════════════════════════════════

CDP_PORT = 9222  # default debug port

def find_cdp_port(win) -> Optional[int]:
    """
    Try to find an open CDP debug port for this window's process.
    Checks ports 9222-9230.
    """
    psutil = require("psutil")
    import socket

    # Get all PIDs related to this window's process tree
    try:
        import ctypes
        pid = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(win.handle, ctypes.byref(pid))
        root_pid = pid.value
        
        proc = psutil.Process(root_pid)
        all_pids = {root_pid}
        for child in proc.children(recursive=True):
            all_pids.add(child.pid)

        # Check which ports these processes are listening on
        for conn in psutil.net_connections(kind="tcp"):
            if conn.laddr and conn.pid in all_pids:
                port = conn.laddr.port
                if 9222 <= port <= 9300:
                    return port
    except Exception:
        pass

    # Fallback: probe ports
    for port in range(9222, 9231):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=0.3)
            s.close()
            return port
        except Exception:
            continue
    return None

def relaunch_with_cdp(app_name: str, exe_path: str) -> Optional[int]:
    """
    Relaunch an Electron app with --remote-debugging-port=9222.
    Returns the port if successful.
    """
    try:
        log(f"Relaunching {app_name} with CDP port 9222...")
        subprocess.Popen(
            [exe_path, f"--remote-debugging-port={CDP_PORT}"],
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
        time.sleep(3)  # wait for app to start
        return CDP_PORT
    except Exception as e:
        log(f"Relaunch failed: {e}")
        return None

async def cdp_action(port: int, action: str, element_name: str,
                      text: str = "", app_name: str = "") -> Optional[dict]:
    """
    Connect to Electron app via CDP and perform action.
    Returns result dict or None if failed.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        require("playwright")
        from playwright.async_api import async_playwright

    result = None

    async def _run():
        nonlocal result
        try:
            async with async_playwright() as p:
                # Connect to existing Electron app via CDP
                browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                
                # Get all pages (windows/tabs in the Electron app)
                contexts = browser.contexts
                if not contexts:
                    return
                
                page = None
                # Find the most relevant page (largest, or matches app)
                for ctx in contexts:
                    for pg in ctx.pages:
                        if page is None:
                            page = pg
                        # Prefer pages with actual content
                        try:
                            title = await pg.title()
                            if title and title.strip():
                                page = pg
                        except Exception:
                            pass

                if page is None:
                    return

                await page.bring_to_front()
                await page.wait_for_load_state("domcontentloaded")
                await asyncio.sleep(0.5)

                elem_lower = element_name.lower().strip()

                # Build smart selector list based on element name
                selectors = build_selectors(element_name, app_name)

                if action == "click":
                    for sel in selectors:
                        try:
                            loc = page.locator(sel).first
                            await loc.wait_for(state="visible", timeout=3000)
                            await loc.click()
                            await asyncio.sleep(0.3)
                            result = {"success": True, "strategy": f"cdp:{sel}"}
                            return
                        except Exception:
                            continue

                    # Fallback: search by visible text
                    try:
                        loc = page.get_by_text(element_name, exact=False).first
                        await loc.wait_for(state="visible", timeout=2000)
                        await loc.click()
                        result = {"success": True, "strategy": f"cdp:text:{element_name}"}
                        return
                    except Exception:
                        pass

                elif action == "type":
                    # Special keys
                    if text in ("{ENTER}", "{RETURN}"):
                        await page.keyboard.press("Enter")
                        result = {"success": True, "strategy": "cdp:keyboard:Enter"}
                        return
                    if text == "{TAB}":
                        await page.keyboard.press("Tab")
                        result = {"success": True, "strategy": "cdp:keyboard:Tab"}
                        return
                    if text == "{ESC}":
                        await page.keyboard.press("Escape")
                        result = {"success": True, "strategy": "cdp:keyboard:Escape"}
                        return

                    # Find element and type into it
                    for sel in selectors:
                        try:
                            loc = page.locator(sel).first
                            await loc.wait_for(state="visible", timeout=3000)
                            await loc.click()
                            await asyncio.sleep(0.2)
                            await loc.fill(text)
                            await asyncio.sleep(0.2)
                            result = {"success": True, "strategy": f"cdp:fill:{sel}"}
                            return
                        except Exception:
                            continue

                    # Fallback: focus active element and type
                    try:
                        await page.keyboard.type(text, delay=30)
                        result = {"success": True, "strategy": "cdp:keyboard:type"}
                        return
                    except Exception:
                        pass

        except Exception as e:
            log(f"CDP error: {e}")

    import asyncio
    asyncio.run(_run())
    return result

def build_selectors(element_name: str, app_name: str = "") -> List[str]:
    """
    Build a list of CSS/Playwright selectors to try for a given element name.
    Ordered from most specific to most general.
    """
    name = element_name.lower().strip()
    app  = app_name.lower().strip()
    selectors = []

    # ── App-specific selectors ─────────────────────────────────────────────

    if "whatsapp" in app:
        WHATSAPP = {
            "search":          ['[data-testid="chat-list-search"]',
                                '[placeholder="Search or start new chat"]',
                                '[title="Search or start new chat"]',
                                'div[contenteditable][data-tab="3"]',
                                'div[role="textbox"][title*="Search"]'],
            "type a message":  ['div[contenteditable][data-tab="10"]',
                                'div[role="textbox"][data-tab="10"]',
                                '[data-testid="conversation-compose-box-input"]',
                                'footer div[contenteditable]',
                                'div[contenteditable][title*="message" i]'],
            "send":            ['[data-testid="send"]',
                                'button[aria-label="Send"]',
                                'span[data-testid="send"]'],
        }
        for key, sels in WHATSAPP.items():
            if key in name or name in key:
                selectors.extend(sels)

    if "discord" in app:
        DISCORD = {
            "search":         ['[placeholder="Find or start a conversation"]',
                               '[aria-label="Search"]',
                               'div[role="textbox"]'],
            "type a message": ['[role="textbox"][aria-multiline="true"]',
                               'div[data-slate-editor]',
                               '[placeholder*="Message" i]'],
        }
        for key, sels in DISCORD.items():
            if key in name or name in key:
                selectors.extend(sels)

    if "spotify" in app:
        SPOTIFY = {
            "search":  ['input[data-testid="search-input"]',
                        'input[placeholder*="Search" i]',
                        '[role="searchbox"]'],
            "play":    ['button[data-testid="play-button"]',
                        '[aria-label*="Play" i]'],
        }
        for key, sels in SPOTIFY.items():
            if key in name or name in key:
                selectors.extend(sels)

    if "code" in app or "vscode" in app:
        VSCODE = {
            "search":         ['.quick-input-box input', 'input.input'],
            "terminal":       ['.terminal textarea', '.xterm-helper-textarea'],
            "command":        ['.quick-input-box input'],
        }
        for key, sels in VSCODE.items():
            if key in name or name in key:
                selectors.extend(sels)

    # ── Generic selectors (work across many apps) ─────────────────────────

    # Input-like elements
    if any(x in name for x in ["search", "find", "query", "input", "type", "message", "compose"]):
        selectors += [
            f'[placeholder*="{element_name}" i]',
            f'[aria-label*="{element_name}" i]',
            f'[title*="{element_name}" i]',
            'input[type="text"]',
            'input[type="search"]',
            'div[contenteditable="true"]',
            'textarea',
            '[role="textbox"]',
            '[role="searchbox"]',
        ]

    # Button-like elements
    if any(x in name for x in ["send", "submit", "ok", "confirm", "button", "click"]):
        selectors += [
            f'button[aria-label*="{element_name}" i]',
            f'[role="button"][aria-label*="{element_name}" i]',
            f'button:has-text("{element_name}")',
            f'[title*="{element_name}" i]',
        ]

    # Link / nav elements
    if any(x in name for x in ["home", "back", "forward", "nav", "menu", "tab"]):
        selectors += [
            f'a[aria-label*="{element_name}" i]',
            f'[role="tab"][aria-label*="{element_name}" i]',
            f'nav a:has-text("{element_name}")',
        ]

    # Always add text-based as last resort
    selectors += [
        f'text="{element_name}"',
        f':text("{element_name}")',
    ]

    # Deduplicate while preserving order
    seen = set()
    result = []
    for s in selectors:
        if s not in seen:
            seen.add(s)
            result.append(s)
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — Layer 2: UIA (native Win32 apps via pywinauto)
# ═══════════════════════════════════════════════════════════════════════════════

def uia_find_element(window, element_name: str):
    """Find a UI element using pywinauto UIA tree. Returns element or raises."""
    from pywinauto.findwindows import ElementNotFoundError

    # Exact title match
    for ctrl_type in ["Edit", "Button", "MenuItem", "ListItem"]:
        try:
            return window.child_window(title=element_name, control_type=ctrl_type)
        except Exception:
            pass
    try:
        return window.child_window(title=element_name)
    except Exception:
        pass

    # Auto ID
    try:
        return window.child_window(auto_id=element_name)
    except Exception:
        pass

    # Fuzzy scan
    try:
        best_score, best_el = 0, None
        for el in window.descendants():
            try:
                title   = el.window_text() or ""
                auto_id = el.automation_id() if hasattr(el, "automation_id") else ""
                score   = max(fuzzy_score(element_name, title),
                              fuzzy_score(element_name, auto_id))
                if score > best_score:
                    best_score, best_el = score, el
            except Exception:
                continue
        if best_el and best_score >= 45:
            return best_el
    except Exception:
        pass

    raise Exception(f'UIA: element "{element_name}" not found')

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — Layer 3: OCR + Mouse (universal fallback)
# ═══════════════════════════════════════════════════════════════════════════════

_ocr_reader = None

def get_ocr_reader():
    """Lazy-load EasyOCR reader (slow first load, fast after)."""
    global _ocr_reader
    if _ocr_reader is None:
        log("Loading OCR engine (first time may take 30s)...")
        easyocr = require("easyocr")
        _ocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _ocr_reader

def screenshot_window(win) -> Optional[object]:
    """Take a screenshot of just the window area. Returns PIL Image or None."""
    try:
        PIL   = require("Pillow", "PIL")
        Image = require("Pillow", "PIL.Image")
        from PIL import ImageGrab, Image as Img
        l, t, r, b = get_window_rect(win)
        # Clamp to screen bounds
        l, t = max(0, l), max(0, t)
        r = min(r, 3840)
        b = min(b, 2160)
        img = ImageGrab.grab(bbox=(l, t, r, b))
        return img, (l, t)
    except Exception as e:
        log(f"Screenshot failed: {e}")
        return None, (0, 0)

def ocr_find_element(win, element_name: str) -> Optional[Tuple[int,int]]:
    """
    Take screenshot of window, run OCR, find element_name text,
    return absolute screen coordinates (cx, cy) of its center.
    """
    img, (win_left, win_top) = screenshot_window(win)
    if img is None:
        return None

    import numpy as np
    img_np = np.array(img)

    reader = get_ocr_reader()
    results = reader.readtext(img_np)

    # results: list of ([bbox], text, confidence)
    name_lower = element_name.lower().strip()
    best_score = 0
    best_coords = None

    for (bbox, text, conf) in results:
        if conf < 0.4:
            continue
        text_lower = text.lower().strip()
        score = fuzzy_score(element_name, text_lower) * conf
        if score > best_score:
            best_score = score
            # bbox is [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
            xs = [p[0] for p in bbox]
            ys = [p[1] for p in bbox]
            cx = int(sum(xs) / len(xs)) + win_left
            cy = int(sum(ys) / len(ys)) + win_top
            best_coords = (cx, cy)

    if best_coords and best_score >= 20:
        log(f"OCR found '{element_name}' at {best_coords} (score={best_score:.1f})")
        return best_coords

    log(f"OCR could not find '{element_name}' (best score={best_score:.1f})")
    return None

def mouse_click(x: int, y: int):
    """Move mouse to (x,y) and left-click."""
    pyautogui = require("pyautogui")
    pyautogui.moveTo(x, y, duration=0.15)
    time.sleep(0.1)
    pyautogui.click(x, y)
    time.sleep(0.3)

def mouse_type(text: str):
    """Type text using pyautogui (works on any focused element)."""
    pyautogui = require("pyautogui")
    # Handle special keys
    if text == "{ENTER}":
        pyautogui.press("enter")
    elif text == "{TAB}":
        pyautogui.press("tab")
    elif text == "{ESC}":
        pyautogui.press("escape")
    elif text == "{BACKSPACE}":
        pyautogui.press("backspace")
    elif text.startswith("{") and text.endswith("}"):
        key = text[1:-1].lower()
        pyautogui.press(key)
    else:
        pyautogui.typewrite(text, interval=0.04)
    time.sleep(0.2)

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — Layer 4: Keyboard Shortcuts (known app flows)
# ═══════════════════════════════════════════════════════════════════════════════

# Maps: app_name → element_name → (hotkey, post_delay)
APP_SHORTCUTS = {
    "whatsapp": {
        "search":         ("ctrl+f",     0.6),
        "new chat":       ("ctrl+n",     0.5),
        "type a message": (None,         0.0),   # needs mouse click
        "settings":       ("ctrl+,",     0.5),
        "emoji":          ("ctrl+e",     0.5),
    },
    "discord": {
        "search":         ("ctrl+k",     0.6),
        "settings":       ("ctrl+,",     0.5),
        "type a message": (None,         0.0),
        "mark as read":   ("escape",     0.3),
        "upload":         ("ctrl+shift+u", 0.5),
    },
    "spotify": {
        "search":         ("ctrl+l",     0.6),
        "play":           ("space",      0.3),
        "pause":          ("space",      0.3),
        "next":           ("ctrl+right", 0.3),
        "previous":       ("ctrl+left",  0.3),
        "volume up":      ("ctrl+up",    0.3),
        "volume down":    ("ctrl+down",  0.3),
        "home":           ("ctrl+shift+h", 0.5),
    },
    "youtube": {
        "search":         ("slash",      0.5),
        "play":           ("k",          0.3),
        "pause":          ("k",          0.3),
        "fullscreen":     ("f",          0.3),
        "mute":           ("m",          0.3),
    },
    "vscode": {
        "search":         ("ctrl+p",     0.5),
        "command":        ("ctrl+shift+p", 0.5),
        "terminal":       ("ctrl+`",     0.5),
        "new file":       ("ctrl+n",     0.5),
        "save":           ("ctrl+s",     0.3),
        "find":           ("ctrl+f",     0.5),
    },
    "telegram": {
        "search":         ("ctrl+f",     0.5),
        "new message":    ("ctrl+n",     0.5),
    },
    "slack": {
        "search":         ("ctrl+k",     0.5),
        "type a message": (None,         0.0),
        "new message":    ("ctrl+n",     0.5),
    },
    "chrome": {
        "address":        ("ctrl+l",     0.4),
        "new tab":        ("ctrl+t",     0.4),
        "search":         ("ctrl+f",     0.4),
        "close tab":      ("ctrl+w",     0.3),
        "refresh":        ("f5",         0.3),
    },
    "notepad": {
        "find":           ("ctrl+f",     0.4),
        "save":           ("ctrl+s",     0.3),
        "select all":     ("ctrl+a",     0.3),
    },
}

def get_shortcut(app_name: str, element_name: str) -> Optional[Tuple[str, float]]:
    """Look up keyboard shortcut for an element in a specific app."""
    app_key  = app_name.lower().strip()
    elem_key = element_name.lower().strip()

    # Exact app match first
    for known_app, shortcuts in APP_SHORTCUTS.items():
        if known_app in app_key or app_key in known_app:
            for known_elem, (hotkey, delay) in shortcuts.items():
                if known_elem in elem_key or elem_key in known_elem:
                    return hotkey, delay

    # Generic fallback shortcuts
    GENERIC = {
        "search": ("ctrl+f",  0.5),
        "find":   ("ctrl+f",  0.5),
        "save":   ("ctrl+s",  0.3),
        "undo":   ("ctrl+z",  0.3),
        "redo":   ("ctrl+y",  0.3),
        "copy":   ("ctrl+c",  0.2),
        "paste":  ("ctrl+v",  0.2),
        "cut":    ("ctrl+x",  0.2),
    }
    for key, val in GENERIC.items():
        if key in elem_key:
            return val

    return None, None

def press_shortcut(hotkey: str):
    """Press a keyboard shortcut using pyautogui."""
    pyautogui = require("pyautogui")
    keys = [k.strip() for k in hotkey.split("+")]
    if len(keys) == 1:
        pyautogui.press(keys[0])
    else:
        pyautogui.hotkey(*keys)
    time.sleep(0.2)

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — Verification
# ═══════════════════════════════════════════════════════════════════════════════

def verify_text_on_screen(win, text: str, timeout: float = 3.0) -> bool:
    """
    Wait up to `timeout` seconds for `text` to appear on screen (OCR).
    Returns True if found.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        coords = ocr_find_element(win, text)
        if coords:
            return True
        time.sleep(0.5)
    return False

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — Smart Action Router
# ═══════════════════════════════════════════════════════════════════════════════

def smart_click(app_name: str, element_name: str, win, cdp_port: Optional[int]) -> dict:
    """
    Try all layers in order to click an element.
    Returns result dict with success/strategy info.
    """
    import asyncio

    # ── Layer 1: CDP ──────────────────────────────────────────────────────
    if cdp_port:
        log(f"Layer 1: CDP click '{element_name}'")
        result = asyncio.run(cdp_action(cdp_port, "click", element_name, app_name=app_name))
        if result and result.get("success"):
            return result

    # ── Layer 2: UIA (native) ─────────────────────────────────────────────
    log(f"Layer 2: UIA click '{element_name}'")
    try:
        el = uia_find_element(win, element_name)
        try:
            el.set_focus()
            time.sleep(0.1)
            el.click_input()
        except Exception:
            el.click()
        time.sleep(0.3)
        return {"success": True, "strategy": "uia:click"}
    except Exception as e:
        log(f"UIA failed: {e}")

    # ── Layer 4: Keyboard shortcut ────────────────────────────────────────
    hotkey, delay = get_shortcut(app_name, element_name)
    if hotkey:
        log(f"Layer 4: keyboard shortcut '{hotkey}' for '{element_name}'")
        focus_window(win)
        press_shortcut(hotkey)
        if delay:
            time.sleep(delay)
        return {"success": True, "strategy": f"keyboard:{hotkey}"}

    # ── Layer 3: OCR + mouse ──────────────────────────────────────────────
    log(f"Layer 3: OCR click '{element_name}'")
    focus_window(win)
    coords = ocr_find_element(win, element_name)
    if coords:
        mouse_click(*coords)
        return {"success": True, "strategy": f"ocr:click:{coords}"}

    return {"success": False, "error": f'All layers failed to click "{element_name}"'}


def smart_type(app_name: str, element_name: str, text: str,
               win, cdp_port: Optional[int]) -> dict:
    """
    Try all layers in order to type text into an element.
    Returns result dict with success/strategy info.
    """
    import asyncio

    # Handle special keys — always use pyautogui for these
    is_special = text.startswith("{") and text.endswith("}")

    # ── Layer 1: CDP ──────────────────────────────────────────────────────
    if cdp_port:
        log(f"Layer 1: CDP type '{text}' into '{element_name}'")
        result = asyncio.run(cdp_action(cdp_port, "type", element_name, text=text, app_name=app_name))
        if result and result.get("success"):
            return result

    # ── Layer 2: UIA ──────────────────────────────────────────────────────
    if not is_special:
        log(f"Layer 2: UIA type '{text}' into '{element_name}'")
        try:
            el = uia_find_element(win, element_name)
            try:
                el.set_focus()
                el.click_input()
                time.sleep(0.1)
            except Exception:
                pass
            try:
                el.set_edit_text(text)
            except Exception:
                el.type_keys(text, with_spaces=True)
            time.sleep(0.2)
            return {"success": True, "strategy": "uia:type"}
        except Exception as e:
            log(f"UIA type failed: {e}")

    # ── Layer 3: OCR to find element, then type ───────────────────────────
    log(f"Layer 3: OCR find '{element_name}', then type")
    focus_window(win)
    coords = ocr_find_element(win, element_name)
    if coords:
        mouse_click(*coords)
        time.sleep(0.2)
        mouse_type(text)
        return {"success": True, "strategy": f"ocr:type:{coords}"}

    # ── Fallback: type into focused element ───────────────────────────────
    log(f"Fallback: type into currently focused element")
    focus_window(win)
    mouse_type(text)
    return {"success": True, "strategy": "fallback:type_focused"}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — Commands
# ═══════════════════════════════════════════════════════════════════════════════

def cmd_find_window(app_name: str, timeout: int):
    app, win = find_window_handle(app_name, timeout)
    title = win.window_text()
    electron = is_electron(win)
    cdp_port = find_cdp_port(win) if electron else None
    ok(f'Window ready: "{title}"',
       title=title,
       electron=electron,
       cdp_port=cdp_port)

def cmd_focus_window(app_name: str):
    app, win = find_window_handle(app_name, timeout=5)
    focus_window(win)
    ok(f'Focused: "{win.window_text()}"')

def cmd_click(app_name: str, element_name: str):
    app, win = find_window_handle(app_name, timeout=10)
    focus_window(win)

    # Detect app type
    electron = is_electron(win)
    cdp_port = find_cdp_port(win) if electron else None

    if electron and not cdp_port:
        log("Electron app detected but no CDP port found — using keyboard/OCR only")

    result = smart_click(app_name, element_name, win, cdp_port)

    if result.get("success"):
        ok(f'Clicked "{element_name}"', strategy=result.get("strategy"))
    else:
        fail(result.get("error", f'Failed to click "{element_name}"'))

def cmd_type(app_name: str, element_name: str, text: str):
    app, win = find_window_handle(app_name, timeout=10)
    focus_window(win)

    electron = is_electron(win)
    cdp_port = find_cdp_port(win) if electron else None

    result = smart_type(app_name, element_name, text, win, cdp_port)

    if result.get("success"):
        ok(f'Typed into "{element_name}"', strategy=result.get("strategy"))
    else:
        fail(result.get("error", f'Failed to type into "{element_name}"'))

def cmd_screenshot(app_name: str):
    app, win = find_window_handle(app_name, timeout=5)
    focus_window(win)
    img, _ = screenshot_window(win)
    if img is None:
        fail("Screenshot failed")
    # Save to temp file and return path
    tmp = tempfile.mktemp(suffix=".png")
    img.save(tmp)
    ok(f"Screenshot saved", path=tmp)

def cmd_verify(app_name: str, text: str):
    app, win = find_window_handle(app_name, timeout=5)
    found = verify_text_on_screen(win, text, timeout=5.0)
    if found:
        ok(f'Text "{text}" found on screen')
    else:
        fail(f'Text "{text}" not found on screen')

def cmd_list_elements(app_name: str):
    app, win = find_window_handle(app_name, timeout=5)
    elements = []
    try:
        for el in win.descendants():
            try:
                title    = el.window_text() or ""
                ctrl     = ""
                auto_id  = ""
                try: ctrl    = str(el.element_info.control_type)
                except Exception: pass
                try: auto_id = el.automation_id() or ""
                except Exception: pass
                if title or auto_id:
                    elements.append({
                        "title":        title[:60],
                        "control_type": ctrl,
                        "auto_id":      auto_id[:60],
                    })
            except Exception:
                continue
    except Exception as e:
        fail(f"Could not list elements: {e}")

    electron = is_electron(win)
    cdp_port = find_cdp_port(win) if electron else None
    ok(f"Found {len(elements)} UIA elements",
       elements=elements[:80],
       electron=electron,
       cdp_port=cdp_port)

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="NEXUS Desktop Automation Agent v2")
    parser.add_argument("command", choices=[
        "find_window", "click", "type",
        "focus_window", "list_elements",
        "screenshot", "verify"
    ])
    parser.add_argument("app_name")
    parser.add_argument("element_name", nargs="?", default="")
    parser.add_argument("text",         nargs="?", default="")
    parser.add_argument("--timeout",    type=int,  default=10)
    args = parser.parse_args()

    if args.command == "find_window":
        cmd_find_window(args.app_name, args.timeout)
    elif args.command == "focus_window":
        cmd_focus_window(args.app_name)
    elif args.command == "click":
        if not args.element_name:
            fail("element_name required for click")
        cmd_click(args.app_name, args.element_name)
    elif args.command == "type":
        if not args.element_name:
            fail("element_name required for type")
        cmd_type(args.app_name, args.element_name, args.text)
    elif args.command == "list_elements":
        cmd_list_elements(args.app_name)
    elif args.command == "screenshot":
        cmd_screenshot(args.app_name)
    elif args.command == "verify":
        if not args.element_name:
            fail("text required for verify")
        cmd_verify(args.app_name, args.element_name)

if __name__ == "__main__":
    main()
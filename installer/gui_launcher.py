# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 gejiangren <https://github.com/gejiangren>
"""拾字 · 原生窗口启动器

启动 FastAPI server 在后台 → 弹一个 WKWebView 原生窗口加载 127.0.0.1:7860。
窗口关闭时同时杀掉 server。

用 PyObjC 调 Cocoa + WebKit 框架。整体效果跟 Notion / Linear 这种用 webview 包装的 Mac app 类似。
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import objc
from Cocoa import (
    NSAlert,
    NSAlertFirstButtonReturn,
    NSApplication,
    NSApplicationActivationPolicyRegular,
    NSBackingStoreBuffered,
    NSColor,
    NSMakeRect,
    NSMenu,
    NSMenuItem,
    NSObject,
    NSScreen,
    NSTextField,
    NSWindow,
    NSWindowStyleMaskClosable,
    NSWindowStyleMaskMiniaturizable,
    NSWindowStyleMaskResizable,
    NSWindowStyleMaskTitled,
    NSApp,
)
from Foundation import NSURL, NSURLRequest
from WebKit import WKWebView, WKWebViewConfiguration

PROJECT_DIR = Path(__file__).resolve().parent.parent
SERVER_URL = "http://127.0.0.1:7860"
SERVER_LOG = Path("/tmp/shizi.log")


# ────────────────────────────────────────────────────────────
# 后台启动 server.py
# ────────────────────────────────────────────────────────────
def start_server() -> subprocess.Popen | None:
    """如果 7860 已经在跑就复用；否则用项目 venv 起 server.py"""
    if is_server_up():
        return None  # 复用现有 server，不归我们管
    venv_python = PROJECT_DIR / ".venv" / "bin" / "python"
    if not venv_python.exists():
        die(f"找不到 Python：{venv_python}\n请先在终端跑 setup.sh 装好依赖。")
    log_fh = open(SERVER_LOG, "w")
    proc = subprocess.Popen(
        [str(venv_python), "server.py"],
        cwd=str(PROJECT_DIR),
        stdout=log_fh,
        stderr=log_fh,
        start_new_session=True,  # 独立进程组，子进程退出不影响 server
    )
    # 等 server 起来（最多 30 秒）
    for _ in range(60):
        time.sleep(0.5)
        if is_server_up():
            return proc
    die(f"server 30 秒未起来，看日志：{SERVER_LOG}")


def is_server_up() -> bool:
    try:
        urllib.request.urlopen(SERVER_URL + "/", timeout=1)
        return True
    except Exception:
        return False


def die(msg: str) -> None:
    """无窗口模式：弹 AppleScript 提示框后退出。"""
    safe = msg.replace('"', "'").replace("\n", "\\n")
    subprocess.run([
        "osascript", "-e",
        f'display dialog "{safe}" with title "拾字" buttons {{"OK"}} default button "OK" with icon stop',
    ])
    sys.exit(1)


# ────────────────────────────────────────────────────────────
# WKWebView 窗口
# ────────────────────────────────────────────────────────────
class WindowDelegate(NSObject):
    def initWithServer_(self, server_proc):
        self = objc.super(WindowDelegate, self).init()
        if self is None:
            return None
        self._server = server_proc
        return self

    def windowWillClose_(self, notification):
        # 关窗 = 关 server + 退出整个 app
        if self._server is not None:
            try:
                os.killpg(os.getpgid(self._server.pid), signal.SIGTERM)
            except Exception:
                try:
                    self._server.terminate()
                except Exception:
                    pass
        NSApp.terminate_(None)


# WKWebView 默认对 JS 的 alert/confirm/prompt 不响应（静默返回），必须装
# WKUIDelegate 把这些调用桥到原生 NSAlert，前端的 confirm("删除？") 才有窗弹。
class WebUIDelegate(NSObject):
    def webView_runJavaScriptAlertPanelWithMessage_initiatedByFrame_completionHandler_(
        self, webView, message, frame, completionHandler
    ):
        alert = NSAlert.alloc().init()
        alert.setMessageText_("拾字")
        alert.setInformativeText_(message or "")
        alert.addButtonWithTitle_("好")
        alert.runModal()
        completionHandler()

    def webView_runJavaScriptConfirmPanelWithMessage_initiatedByFrame_completionHandler_(
        self, webView, message, frame, completionHandler
    ):
        alert = NSAlert.alloc().init()
        alert.setMessageText_("拾字")
        alert.setInformativeText_(message or "")
        alert.addButtonWithTitle_("确定")
        alert.addButtonWithTitle_("取消")
        response = alert.runModal()
        completionHandler(response == NSAlertFirstButtonReturn)

    def webView_runJavaScriptTextInputPanelWithPrompt_defaultText_initiatedByFrame_completionHandler_(
        self, webView, prompt, defaultText, frame, completionHandler
    ):
        alert = NSAlert.alloc().init()
        alert.setMessageText_("拾字")
        alert.setInformativeText_(prompt or "")
        field = NSTextField.alloc().initWithFrame_(NSMakeRect(0, 0, 280, 24))
        if defaultText:
            field.setStringValue_(defaultText)
        alert.setAccessoryView_(field)
        alert.addButtonWithTitle_("确定")
        alert.addButtonWithTitle_("取消")
        response = alert.runModal()
        completionHandler(field.stringValue() if response == NSAlertFirstButtonReturn else None)


def build_menu(app_name: str) -> NSMenu:
    """构造一个最小化的菜单栏（拾字 / 文件 / 编辑 / 窗口）。"""
    main = NSMenu.alloc().init()

    # 拾字 菜单
    app_item = NSMenuItem.alloc().init()
    main.addItem_(app_item)
    app_menu = NSMenu.alloc().init()
    app_menu.addItem_(NSMenuItem.alloc()
        .initWithTitle_action_keyEquivalent_(f"关于 {app_name}", "orderFrontStandardAboutPanel:", ""))
    app_menu.addItem_(NSMenuItem.separatorItem())
    hide = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(f"隐藏 {app_name}", "hide:", "h")
    app_menu.addItem_(hide)
    app_menu.addItem_(NSMenuItem.separatorItem())
    quit_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(f"退出 {app_name}", "terminate:", "q")
    app_menu.addItem_(quit_item)
    app_item.setSubmenu_(app_menu)

    # 编辑 菜单（让 Cmd+C/V/X/A/Z 在 WebView 里能用）
    edit_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("编辑", None, "")
    main.addItem_(edit_item)
    edit_menu = NSMenu.alloc().initWithTitle_("编辑")
    for title, sel, key in [
        ("撤销", "undo:", "z"),
        ("重做", "redo:", "Z"),
        ("剪切", "cut:", "x"),
        ("拷贝", "copy:", "c"),
        ("粘贴", "paste:", "v"),
        ("全选", "selectAll:", "a"),
    ]:
        item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, sel, key)
        edit_menu.addItem_(item)
    edit_item.setSubmenu_(edit_menu)

    # 显示 菜单（让 Cmd+R 重新加载页面、Cmd+Shift+R 绕过缓存）
    view_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("显示", None, "")
    main.addItem_(view_item)
    view_menu = NSMenu.alloc().initWithTitle_("显示")
    for title, sel, key in [
        ("重新载入", "reload:", "r"),
        ("强制重新载入（清缓存）", "reloadFromOrigin:", "R"),
    ]:
        item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, sel, key)
        view_menu.addItem_(item)
    view_item.setSubmenu_(view_menu)

    # 窗口 菜单
    win_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("窗口", None, "")
    main.addItem_(win_item)
    win_menu = NSMenu.alloc().initWithTitle_("窗口")
    win_menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("最小化", "performMiniaturize:", "m"))
    win_menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("缩放", "performZoom:", ""))
    win_menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("关闭", "performClose:", "w"))
    win_item.setSubmenu_(win_menu)

    return main


def main():
    server = start_server()

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)

    app_name = "拾字"
    app.setMainMenu_(build_menu(app_name))

    # 居中 1280×820 窗口
    screen_rect = NSScreen.mainScreen().frame()
    w, h = 1280, 820
    x = (screen_rect.size.width - w) / 2
    y = (screen_rect.size.height - h) / 2
    frame = NSMakeRect(x, y, w, h)

    style = (
        NSWindowStyleMaskTitled
        | NSWindowStyleMaskClosable
        | NSWindowStyleMaskResizable
        | NSWindowStyleMaskMiniaturizable
    )
    window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        frame, style, NSBackingStoreBuffered, False
    )
    window.setTitle_("拾字 · Voicetype Studio")
    window.setBackgroundColor_(NSColor.colorWithCalibratedRed_green_blue_alpha_(
        0.957, 0.945, 0.918, 1.0))  # #F4F1EB 跟应用画布色一致

    # WKWebView
    config = WKWebViewConfiguration.alloc().init()
    prefs = config.preferences()
    try:
        prefs.setValue_forKey_(True, "developerExtrasEnabled")  # 允许右键 → 检查元素，方便调试
    except Exception:
        pass
    webview = WKWebView.alloc().initWithFrame_configuration_(frame, config)
    webview.setAutoresizingMask_(2 | 16)  # NSViewWidthSizable | NSViewHeightSizable

    # 把 JS 的 alert/confirm/prompt 桥到原生弹窗，否则 confirm() 永远返回 false
    ui_delegate = WebUIDelegate.alloc().init()
    webview.setUIDelegate_(ui_delegate)

    request = NSURLRequest.requestWithURL_(NSURL.URLWithString_(SERVER_URL + "/"))
    webview.loadRequest_(request)

    window.setContentView_(webview)

    delegate = WindowDelegate.alloc().initWithServer_(server)
    window.setDelegate_(delegate)
    # 保留 ui_delegate 引用防被 GC（webview 的 setUIDelegate_ 不 retain）
    window._uiDelegate = ui_delegate

    window.makeKeyAndOrderFront_(None)
    app.activateIgnoringOtherApps_(True)
    app.run()


if __name__ == "__main__":
    main()

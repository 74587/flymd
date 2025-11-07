# FlySpeed Markdown (flyMD)

[简体中文](README.md) | [English](README.en.md)

[![Version](https://img.shields.io/badge/version-v0.1.7-blue.svg)](https://github.com/flyhunterl/flymd)
[![License](https://img.shields.io/badge/license-NonCommercial-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](https://github.com/flyhunterl/flymd)

A cross-platform WYSIWYG Markdown editor and PDF reader with image hosting, WebDAV sync, plugin extensions, fast response, and minimal resource usage.

![lv_0_20251028184941](https://github.com/user-attachments/assets/3d6a5b6a-82e8-4d9d-9657-c9b66ef48f82)


## ✨ Highlights

- Ready to Use: Only 6MB installer, no bloat. Millisecond-level cold start, one-click code copy
- Clean Interface: Minimalist design with just menubar + editor, focused on content creation. Excellent startup and response speed
- Library Feature: Support for designated folders, tree-view display of subfolders and documents, with document management
- Secure & Reliable: Local execution, no network connection, automatic HTML sanitization in preview
- Image Hosting: S3/R2 binding support, direct paste image upload with automatic link syntax generation
- Full-Featured: Complete support for Markdown, LaTeX, Mermaid, and HTML
- Real-time Rendering: WYSIWYG mode, instant render on input! Global real-time rendering for Mermaid and LaTeX, double-click to edit code
- Ultimate Performance: Millisecond-level response, farewell to common pain points of similar software
- Position Memory: Automatic memory of reading and editing positions, returning to remembered positions on next open (v0.0.6 official)
- Auto Sync: WebDAV sync functionality
- Plugin Extensions: Support for plugin extensions, develop your own or install with one click

## 📸 Interface Preview (v0.0.4)
<p align="center">
  <img src="https://github.com/user-attachments/assets/917ad246-1208-4585-9e10-7d2da54f2eef" width="32%" alt="Markdown Editor Screenshot 1"/>
  <img src="https://github.com/user-attachments/assets/97012b2d-4457-434d-a436-cdba796d25b4" width="32%" alt="Markdown Editor Screenshot 2"/>
  <img src="https://github.com/user-attachments/assets/39343b06-3c54-4990-a198-e5f941da6578" width="32%" alt="Markdown Editor Screenshot 3"/>
</p>
<p align="center">
  <img src="https://github.com/user-attachments/assets/7f1e9179-6087-4abf-80d5-7965dbbf2600" width="32%" alt="Markdown Editor Screenshot 4"/>
  <img src="https://github.com/user-attachments/assets/8d549446-6052-4c32-88f8-f473314476fd" width="32%" alt="Markdown Editor Screenshot 5"/>
  <img src="https://github.com/user-attachments/assets/4283312d-5ff6-43a7-a537-ef503e48604e" width="32%" alt="Markdown Editor Screenshot 6"/>
</p>

## Core Features
- Editing Experience
  - Instant editing/WYSIWYG (powered by Milkdown)
  - Native low-latency: Preserves `<textarea>` pipeline, IME composition-friendly, smart bracket/quote pairing without disrupting input (Edit mode)
  - Unified indent & multi-line operations: `Tab` behaves consistently in Edit/WYSIWYG modes
  - Common formatting: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+K` insert link; precise line/column/cursor feedback
  - WYSIWYG mode: Use `Ctrl+Enter` to exit code blocks
  **Edit mode uses standard syntax, double space + Enter triggers line break. Non-standard syntax will break line breaks in WYSIWYG mode. Reading mode unaffected**
  **Auto-completion only works in Edit mode**
  **Due to Chinese/English punctuation differences, Chinese IME may affect completion experience, recommend switching to English punctuation**
- Reading & Outline
  - Safe preview: `markdown-it` rendering + `highlight.js` code highlighting + `DOMPurify` HTML sanitization, external links auto-add `target="_blank"` + `rel="noopener"`
  - Outline navigation: Extract Markdown `H1–H6` to generate clickable TOC, highlight current heading, preview and scroll sync
  - PDF Bookmarks (Outline): Built-in PDF reading and bookmark outline, cached per file and auto-invalidated on changes
- Images & Hosting
  - One-step process: Paste/drag images auto-handled; prefer upload to S3/R2 and insert public URL; fallback to local save when unconfigured/failed
  - Local images just work: No extra configuration needed for preview
- Sync (WebDAV Extension)
  - Visual sync: Status hints, process logs, progress feedback, and conflict prompts
  - Remote MOVE optimization: Use `MOVE` to reduce duplicate download/upload, optimize rename/move scenarios
- Language & Usability
  - Bilingual (Chinese/English) + Auto: Follow system language or manual switch, remembers user choice
  - Position memory: Each file independently remembers last "reading/editing cursor/scroll position"
- Security & Performance
  - Local-first, zero background network: No network access unless explicitly enabled (image hosting, sync, etc.)
  - Performance optimization: Cold start and render pipeline with lazy loading, chunked static assets, controllable logs; target cold start <300ms, preview toggle <16ms (typical 2–3k line documents)

## Getting Started
- Installation
  - Download platform-appropriate installer from release page and install; Windows requires WebView2 (pre-installed on most systems)
- Create/Open
  - New: `Ctrl+N`; Open: `Ctrl+O`; Save: `Ctrl+S`; Save As: `Ctrl+Shift+S`
  - Library: Sidebar file tree supports new/rename/move/delete and recent files
- Mode Switching
  - Edit mode: `Ctrl+E`; can toggle between editing and reading
  - Quick reading: `Ctrl+R`
  - WYSIWYG mode: `Ctrl+W`; can toggle WYSIWYG editing
- Common Editing
  - Bold/Italic/Link: `Ctrl+B / Ctrl+I / Ctrl+K`; `Esc` closes dialogs
  - Images: Paste/drag to insert (WYSIWYG mode doesn't support dragging); with S3/R2 configured, auto-upload and insert URL; unconfigured/failed fallback to local save. Optional: Always save to local
- Sync (Optional)
  - Enable WebDAV in "Extensions", provides logs/progress/conflict hints; (newly launched, still improving, remember to backup)
- Language
  - Switch between Chinese/English or select Auto to follow system; language preference is remembered

## ⌨️ Shortcuts

| Shortcut | Function |
|----------|----------|
| `Ctrl+N` | New file |
| `Ctrl+O` | Open file |
| `Ctrl+S` | Save file |
| `Ctrl+H` | Find & Replace |
| `Ctrl+Shift+S` | Save as |
| `Ctrl+E` | Toggle edit/preview |
| `Ctrl+R` | Enter reading (preview) |
| `Ctrl+W` | Toggle WYSIWYG mode |
| `Escape` | Close/return in preview or dialogs |
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+K` | Insert link |

## 🔌 Extension Development

flyMD supports plugin extensions to enhance functionality. You can:

- Develop custom extension plugins
- Install plugins from GitHub or HTTP URL
- Manage installed extensions

For detailed development guide, see: [Extension Development Documentation](plugin.md)

**Example Plugins:**
- [Typecho Publisher](https://github.com/TGU-HansJack/typecho-publisher-flymd) - Publish articles to Typecho blog platform


## 📊 Performance Targets

- Cold start: ≤ 300ms
- Installer size: ≤ 10MB
- Memory footprint: ≤ 50MB
- Preview toggle: ≤ 16ms

## Roadmap & Changelog

See: [ROADMAP.en.md](ROADMAP.en.md)

### Cross-platform Support
- [x] Windows 10/11
- [x] Linux (Desktop environment)


## 🤝 Contributing

Issues and Pull Requests are welcome!

## 📄 License & Compliance

- This project uses "FlySpeed MarkDown (flyMD) Non-Commercial Open Source License (NC 1.0)".
- Allowed: Free use, modification, copying, and redistribution for non-commercial purposes; must retain attribution and source.
- Commercial use: Prohibited without written authorization. For commercial licensing, contact: flyhunterl <flyhunterl@gmail.com>.
- Full license: [LICENSE](LICENSE) (includes English translation, Chinese version is primary)
- Third-party component licenses: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## 🙏 Acknowledgments
- [MilkDown](https://milkdown.dev/)
- [Tauri](https://tauri.app/)
- [markdown-it](https://github.com/markdown-it/markdown-it)
- [DOMPurify](https://github.com/cure53/DOMPurify)
- [highlight.js](https://highlightjs.org/)
- [KaTeX](https://katex.org/)
- [Mermaid](https://mermaid.js.org/)

## FAQ (Linux)

- [Solution for blank screen on Arch](arch.md)


<img width="300" height="300" alt="image" src="https://github.com/user-attachments/assets/4a716fd5-dc61-4a4f-b968-91626debe8d2" />

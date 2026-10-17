"""Load presentations and documents, convert Office files to PDF, and render pages to images."""
from __future__ import annotations

import base64
import hashlib
import io
import os
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import pymupdf as fitz  # PyMuPDF
from PIL import Image

PDF_EXT = {".pdf"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif"}
POWERPOINT_EXT = {".pptx", ".ppt", ".ppsx", ".pps", ".odp"}
WORD_EXT = {".docx", ".doc", ".odt", ".rtf"}
OFFICE_EXT = POWERPOINT_EXT | WORD_EXT
ALL_TYPES = sorted(e.lstrip(".") for e in PDF_EXT | IMAGE_EXT | OFFICE_EXT)

CONVERT_TIMEOUT = 240
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_LOCK = threading.Lock()          # PyMuPDF documents are not thread-safe; Streamlit sessions are threads
_PDFS: dict[str, fitz.Document] = {}
_IMAGES: dict[str, list[bytes]] = {}


class ConversionError(Exception):
    pass


@dataclass
class Document:
    doc_id: str
    name: str
    kind: str                                   # "pdf" | "images" | "html"
    sizes: list[tuple[float, float]] = field(default_factory=list)
    html: str = ""
    note: str = ""

    @property
    def count(self) -> int:
        return 1 if self.kind == "html" else len(self.sizes)


def _digest(*parts: bytes) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p)
    return h.hexdigest()


# --------------------------------------------------------------------------- loading

def open_pdf(data: bytes, name: str) -> Document:
    doc_id = _digest(b"pdf", data)
    with _LOCK:
        if doc_id not in _PDFS:
            _PDFS[doc_id] = fitz.open(stream=data, filetype="pdf")
        pdf = _PDFS[doc_id]
        sizes = [(p.rect.width, p.rect.height) for p in pdf]
    if not sizes:
        raise ValueError("The PDF has no pages.")
    return Document(doc_id, name, "pdf", sizes)


def open_images(files: list[tuple[str, bytes]]) -> Document:
    doc_id = _digest(b"img", *(data for _, data in files))
    sizes, blobs = [], []
    for name, data in files:
        with Image.open(io.BytesIO(data)) as im:
            sizes.append(im.size)
        blobs.append(data)
    _IMAGES[doc_id] = blobs
    title = files[0][0] if len(files) == 1 else f"{len(files)} images"
    return Document(doc_id, title, "images", sizes)


def open_docx_as_html(data: bytes, name: str) -> Document:
    import mammoth  # pure-Python Word reader, used when no converter is installed

    html = mammoth.convert_to_html(io.BytesIO(data)).value
    return Document(_digest(b"html", data), name, "html", html=html,
                    note="Simplified Word layout (install LibreOffice for exact pages).")


def load_files(files: list[tuple[str, bytes]]) -> Document:
    """Open uploaded files: one PDF/Office file, or one or more images (a slideshow)."""
    if not files:
        raise ValueError("No file selected.")
    exts = [Path(n).suffix.lower() for n, _ in files]
    if len(files) > 1 and all(e in IMAGE_EXT for e in exts):
        return open_images(files)
    name, data = files[0]
    ext = exts[0]
    if ext in PDF_EXT:
        return open_pdf(data, name)
    if ext in IMAGE_EXT:
        return open_images([files[0]])
    if ext in OFFICE_EXT:
        try:
            return open_pdf(convert_to_pdf(name, data), name)
        except ConversionError:
            if ext == ".docx":
                return open_docx_as_html(data, name)
            raise
    raise ValueError(f"Unsupported file type '{ext}'. Use PDF, PowerPoint, Word or an image.")


# --------------------------------------------------------------------------- rendering

@lru_cache(maxsize=160)
def render_page(doc_id: str, kind: str, index: int, width: int, fmt: str = "png") -> tuple[str, str]:
    """Render one page to (mime, base64) at the given pixel width. Cached."""
    if kind == "pdf":
        with _LOCK:
            page = _PDFS[doc_id][index]
            scale = width / page.rect.width
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            if fmt == "jpeg":
                return "image/jpeg", base64.b64encode(pix.tobytes("jpeg", jpg_quality=82)).decode()
            data = pix.tobytes("png")
        return "image/png", base64.b64encode(data).decode()
    with Image.open(io.BytesIO(_IMAGES[doc_id][index])) as im:
        im = im.convert("RGB")
        if im.width > width:
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=90)
    return "image/jpeg", base64.b64encode(out.getvalue()).decode()


def page_data_uri(doc: Document, index: int, width: int, fmt: str = "png") -> str:
    mime, b64 = render_page(doc.doc_id, doc.kind, index, int(width), fmt)
    return f"data:{mime};base64,{b64}"


# --------------------------------------------------------------------------- Office -> PDF

def find_soffice() -> str | None:
    for name in ("soffice", "soffice.exe", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base:
            candidate = Path(base) / "LibreOffice" / "program" / "soffice.exe"
            if candidate.exists():
                return str(candidate)
    return None


def has_com_server(prog_id: str) -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg

        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog_id))
        return True
    except OSError:
        return False


def available_converters() -> list[str]:
    found = []
    if find_soffice():
        found.append("LibreOffice")
    if has_com_server("PowerPoint.Application"):
        found.append("PowerPoint")
    if has_com_server("Word.Application"):
        found.append("Word")
    return found


# Macros are force-disabled (AutomationSecurity = 3) and an Office instance the user already had
# open is never closed.
_POWERPOINT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject PowerPoint.Application
$hadOpen = $app.Presentations.Count -gt 0
try {
  try { $app.AutomationSecurity = 3 } catch {}
  $deck = $app.Presentations.Open($env:AHDP_SRC, -1, 0, 0)
  try { $deck.SaveAs($env:AHDP_DST, 32) } finally { $deck.Close() }
} finally {
  if (-not $hadOpen) { $app.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
"""

_WORD_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject Word.Application
$hadOpen = $app.Documents.Count -gt 0
try {
  $app.DisplayAlerts = 0
  try { $app.AutomationSecurity = 3 } catch {}
  $doc = $app.Documents.Open($env:AHDP_SRC, $false, $true, $false)
  try { $doc.ExportAsFixedFormat($env:AHDP_DST, 17) } finally { try { $doc.Close(0) } catch { $doc.Close() } }
} finally {
  if (-not $hadOpen) { $app.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
"""

_CONVERT_LOCK = threading.Lock()


def _run(cmd: list[str], env: dict | None = None) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=CONVERT_TIMEOUT,
                            env=env, creationflags=NO_WINDOW)
    if result.returncode != 0:
        raise ConversionError((result.stderr or result.stdout or "conversion failed").strip()[:300])


@lru_cache(maxsize=16)
def _convert_cached(name: str, digest: str, data: bytes) -> bytes:
    ext = Path(name).suffix.lower()
    with _CONVERT_LOCK, tempfile.TemporaryDirectory(prefix="ahdp_") as tmp:
        tmp_dir = Path(tmp)
        src = tmp_dir / f"input{ext}"
        dst = tmp_dir / "input.pdf"
        src.write_bytes(data)
        errors = []
        soffice = find_soffice()
        if soffice:
            try:
                _run([soffice, f"-env:UserInstallation={(tmp_dir / 'profile').as_uri()}", "--headless",
                      "--norestore", "--convert-to", "pdf", "--outdir", str(tmp_dir), str(src)])
            except (ConversionError, OSError, subprocess.TimeoutExpired) as exc:
                errors.append(f"LibreOffice: {exc}")
        if not dst.exists():
            prog_id, script = (("PowerPoint.Application", _POWERPOINT_SCRIPT) if ext in POWERPOINT_EXT
                               else ("Word.Application", _WORD_SCRIPT))
            if has_com_server(prog_id):
                try:
                    _run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                          "-Command", script], env=dict(os.environ, AHDP_SRC=str(src), AHDP_DST=str(dst)))
                except (ConversionError, OSError, subprocess.TimeoutExpired) as exc:
                    errors.append(f"{prog_id.split('.')[0]}: {exc}")
        if dst.exists() and dst.stat().st_size > 0:
            return dst.read_bytes()
        if errors:
            raise ConversionError("; ".join(errors))
        raise ConversionError("No converter found. Install the free LibreOffice, or export the file to PDF first.")


def convert_to_pdf(name: str, data: bytes) -> bytes:
    """Convert a PowerPoint/Word/OpenDocument file to PDF on this machine."""
    if Path(name).suffix.lower() not in OFFICE_EXT:
        raise ConversionError(f"Unsupported file type: {Path(name).suffix}")
    return _convert_cached(Path(name).name, _digest(data), data)

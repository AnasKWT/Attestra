"""README art for Attestra, drawn with Pillow from the site's own design tokens.

    tools/.venv/bin/python tools/make_readme_art.py           write every image to assets/readme/
    tools/.venv/bin/python tools/make_readme_art.py --check   report what would change, write nothing

Set up once with `python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt`.

Why it is built this way:
- Colours come from apps/web/src/app/globals.css (`--accent` and the dark theme tokens), parsed at run
  time, so a brand change on the site moves these images too. The mark is assets/brand/mark-<light|dark>-512.png,
  rendered from the site's icon.svg by tools/make_brand.sh.
- The light diagram palette is fixed and shared across projects; only the accent changes. The text
  accent is derived (`readable_accent`) to clear 4.5:1 on both the card and the highlight band, and
  `audit()` refuses to write anything if a text colour misses AA.
- Translucent washes are pre-composited (`blend`) because ImageDraw overwrites alpha instead of
  compositing over it.
- Everything is drawn at 2x and reduced with LANCZOS; canvas heights are forced even so the reduce
  scales both axes alike.
- Layout is measured: one `flow()` pass feeds both a panel's height and its drawing, gutters widen to
  the widest arrow label, and the header height follows a wrapping subtitle.
- Arrow labels sit above the line, and arrows are declared by panel title so content edits cannot
  leave them pointing at stale pixels. An arrow runs at the middle of the vertical overlap of its two
  panels, so it always lands on its target.
- The tree is drawn with real lines, not box-drawing glyphs, which fonts substitute.
- The hero is transparent outside its rounded card and its lockup is centred on ink (alpha bbox and
  textbbox), not on boxes.
"""

from __future__ import annotations

import colorsys
import io
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "apps/web/src/app/globals.css"
MARKS = {"light": ROOT / "assets/brand/mark-light-512.png", "dark": ROOT / "assets/brand/mark-dark-512.png"}
MARK = MARKS["light"]  # the diagrams are white pages
OUT = ROOT / "assets/readme"

FONTS = {
    "regular": ("/System/Library/Fonts/SFNS.ttf", b"Regular"),
    "semibold": ("/System/Library/Fonts/SFNS.ttf", b"Semibold"),
    "bold": ("/System/Library/Fonts/SFNS.ttf", b"Bold"),
    "mono": ("/System/Library/Fonts/SFNSMono.ttf", b"Regular"),
}

SCALE = 2
FIGURE_WIDTH = 960
HERO_HEIGHT = 232
RADIUS_CARD = 12


def px(value: float) -> int:
    return int(round(value * SCALE))


# ── colour ────────────────────────────────────────────────────────────────────


def parse_hex(colour: str) -> tuple[int, int, int]:
    text = colour.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"expected #RRGGBB, got {colour!r}")
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def relative_luminance(colour: str) -> float:
    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in parse_hex(colour))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(foreground: str, background: str) -> float:
    a, b = relative_luminance(foreground), relative_luminance(background)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def meets_aa(foreground: str, background: str) -> bool:
    return contrast_ratio(foreground, background) >= 4.5


def blend(top: str, bottom: str, alpha: float) -> str:
    """`top` at `alpha` over `bottom`, as an opaque hex colour."""
    t, b = parse_hex(top), parse_hex(bottom)
    return "#%02X%02X%02X" % tuple(round(t[i] * alpha + b[i] * (1 - alpha)) for i in range(3))


def readable_accent(accent: str, *surfaces: str) -> str:
    """Nearest colour to `accent` (same hue and saturation) that clears AA on every surface."""
    hue, saturation, value = colorsys.rgb_to_hsv(*[c / 255 for c in parse_hex(accent)])

    def at(v: float) -> str:
        return "#%02X%02X%02X" % tuple(round(c * 255) for c in colorsys.hsv_to_rgb(hue, saturation, v))

    def passes(colour: str) -> bool:
        return all(meets_aa(colour, s) for s in surfaces)

    if passes(accent):
        return accent
    for step in range(1, 46):
        for direction in (-1, 1):
            v = value + direction * step * 0.02
            if 0.0 <= v <= 1.0 and passes(at(v)):
                return at(v)
    return accent


def css_tokens(selector: str) -> dict[str, str]:
    """Custom properties declared in one block of the site's globals.css."""
    css = TOKENS.read_text()
    match = re.search(re.escape(selector) + r"\s*\{(.*?)\}", css, re.S)
    if not match:
        raise SystemExit(f"ERROR: no `{selector}` block in {TOKENS}")
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;", match.group(1)))


@dataclass(frozen=True)
class Palette:
    name: str
    page: str
    surface: str
    surface_alt: str
    border: str
    border_strong: str
    text: str
    text_secondary: str
    text_muted: str
    accent: str
    accent_text: str
    band: str
    rule: str


LIGHT_TOKENS = css_tokens(":root")
DARK_TOKENS = css_tokens("[data-theme='dark']")
ACCENT = LIGHT_TOKENS["accent"]
ACCENT_DARK = DARK_TOKENS["accent"]

LIGHT_SURFACE = "#FAFAFB"
LIGHT_BAND = blend(ACCENT, LIGHT_SURFACE, 0.10)
LIGHT = Palette(
    name="light",
    page="#FFFFFF",
    surface=LIGHT_SURFACE,
    surface_alt="#F2F2F4",
    border="#DFDFE4",
    border_strong="#B9B9C2",
    text="#131316",
    text_secondary="#43434E",
    text_muted="#5F5F6B",
    accent=ACCENT,
    accent_text=readable_accent(ACCENT, LIGHT_SURFACE, LIGHT_BAND),
    band=LIGHT_BAND,
    rule="#E4E4E9",
)

DARK_SURFACE = DARK_TOKENS["panel"]
DARK_BAND = blend(ACCENT_DARK, DARK_SURFACE, 0.10)
DARK = Palette(
    name="dark",
    page=DARK_TOKENS["bg"],
    surface=DARK_SURFACE,
    surface_alt=DARK_TOKENS["panel-2"],
    border=DARK_TOKENS["line"],
    border_strong=DARK_TOKENS["line-strong"],
    text=DARK_TOKENS["fg"],
    text_secondary=DARK_TOKENS["fg-soft"],
    text_muted=DARK_TOKENS["fg-mute"],
    accent=ACCENT_DARK,
    accent_text=readable_accent(ACCENT_DARK, DARK_SURFACE, DARK_BAND),
    band=DARK_BAND,
    rule=DARK_TOKENS["line"],
)


def audit(palette: Palette, surfaces: tuple[str, ...]) -> list[str]:
    """Every text role against every surface it can land on. AA or it is a defect."""
    problems = []
    for surface_name in surfaces:
        surface = getattr(palette, surface_name)
        for role in ("text", "text_secondary", "text_muted", "accent_text"):
            colour = getattr(palette, role)
            ratio = contrast_ratio(colour, surface)
            mark = "ok  " if ratio >= 4.5 else "FAIL"
            line = f"  {mark}  {palette.name:5} {role:15} {colour} on the {surface_name:7} {surface}  {ratio:5.2f}:1"
            print(line)
            if ratio < 4.5:
                problems.append(line.strip())
    return problems


# ── type ──────────────────────────────────────────────────────────────────────

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(kind: str, size: float) -> ImageFont.FreeTypeFont:
    key = (kind, int(size * SCALE))
    if key not in _font_cache:
        path, variation = FONTS[kind]
        f = ImageFont.truetype(path, key[1])
        f.set_variation_by_name(variation)
        _font_cache[key] = f
    return _font_cache[key]


def line_height(f: ImageFont.FreeTypeFont) -> int:
    ascent, descent = f.getmetrics()
    return int((ascent + descent) * 1.32)


def wrap(text: str, f: ImageFont.FreeTypeFont, max_width: int, draw: ImageDraw.ImageDraw) -> list[str]:
    """Wrap on real measured widths."""
    if not text:
        return []
    lines, words = [], text.split()
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if draw.textlength(candidate, font=f) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


PROBE = ImageDraw.Draw(Image.new("RGB", (1, 1)))


# ── figure scaffolding ────────────────────────────────────────────────────────

PAD = 30


def header_left() -> int:
    return px(PAD) + px(30) + px(12)


def subtitle_width() -> int:
    return px(FIGURE_WIDTH) - header_left() - px(PAD)


def header_height(subtitle: str) -> int:
    lines = max(1, len(wrap(subtitle, font("regular", 9), subtitle_width(), PROBE)))
    return px(PAD) + line_height(font("bold", 18)) + lines * line_height(font("regular", 9)) + px(20)


def draw_header(image: Image.Image, palette: Palette, title: str, subtitle: str) -> None:
    draw = ImageDraw.Draw(image)
    top = px(PAD)
    mark_size = px(30)
    mark = Image.open(MARK).convert("RGBA").resize((mark_size, mark_size), Image.LANCZOS)
    image.paste(mark, (px(PAD), top), mark)
    draw.text((header_left(), top - px(2)), title, font=font("bold", 18), fill=palette.text)
    y = top - px(2) + line_height(font("bold", 18))
    for line in wrap(subtitle, font("regular", 9), subtitle_width(), PROBE):
        draw.text((header_left(), y), line, font=font("regular", 9), fill=palette.text_muted)
        y += line_height(font("regular", 9))
    rule_y = header_height(subtitle) - px(11)
    draw.line([(px(PAD), rule_y), (px(FIGURE_WIDTH - PAD), rule_y)], fill=palette.rule, width=SCALE)


def finish(image: Image.Image) -> Image.Image:
    return image.resize((image.width // SCALE, image.height // SCALE), Image.LANCZOS)


def even(height: int) -> int:
    return height + (height % SCALE)


# ── panel diagrams ────────────────────────────────────────────────────────────


@dataclass
class Item:
    label: str
    note: str = ""
    kind: str = "label"  # label | mono | accent


@dataclass
class Panel:
    title: str
    subtitle: str = ""
    items: list[Item] = field(default_factory=list)
    emphasis: bool = False
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


class PanelFigure:
    PANEL_PAD = 15
    ITEM_GAP = 10
    PANEL_GAP = 14
    MIN_GUTTER = 26
    BULLET_COLUMN = 13

    def __init__(self, title: str, subtitle: str, columns: list[list[Panel]], arrows: list[tuple[str, str, str]]):
        self.title, self.subtitle, self.columns, self.arrows = title, subtitle, columns, arrows
        self.f_title = font("semibold", 12)
        self.f_sub = font("regular", 9)
        self.f_label = font("semibold", 10)
        self.f_mono = font("mono", 9)
        self.f_note = font("regular", 9)
        self.f_arrow = font("regular", 8)
        emphasised = [p for column in columns for p in column if p.emphasis]
        if len(emphasised) != 1:
            raise SystemExit(f"ERROR: '{title}' must emphasise exactly one panel, not {len(emphasised)}")

    def pad(self) -> int:
        return px(self.PANEL_PAD)

    def flow(self, panel: Panel, width: int) -> list[tuple[int, int, ImageFont.FreeTypeFont, str, str, bool]]:
        """Every line as (dx, dy, font, text, role, bullet), relative to the panel's padding."""
        inner = width - 2 * self.pad()
        lines = []
        y = 0
        for text in wrap(panel.title, self.f_title, inner, PROBE):
            lines.append((0, y, self.f_title, text, "title", False))
            y += line_height(self.f_title)
        for text in wrap(panel.subtitle, self.f_sub, inner, PROBE):
            lines.append((0, y, self.f_sub, text, "subtitle", False))
            y += line_height(self.f_sub)
        y += px(9)
        indent = px(self.BULLET_COLUMN)
        for index, item in enumerate(panel.items):
            if index:
                y += px(self.ITEM_GAP)
            f = self.f_mono if item.kind == "mono" else self.f_label
            role = "label-accent" if item.kind == "accent" else "label"
            for n, text in enumerate(wrap(item.label, f, inner - indent, PROBE)):
                lines.append((indent, y, f, text, role, n == 0))
                y += line_height(f)
            for text in wrap(item.note, self.f_note, inner - indent, PROBE):
                lines.append((indent, y, self.f_note, text, "note", False))
                y += line_height(self.f_note)
        return lines

    def measure(self, panel: Panel, width: int) -> int:
        _, last_y, last_font, *_ = self.flow(panel, width)[-1]
        return self.pad() + last_y + line_height(last_font) + self.pad()

    def gutter(self) -> int:
        needed = px(self.MIN_GUTTER)
        for _, _, label in self.arrows:
            if label:
                needed = max(needed, int(PROBE.textlength(label, font=self.f_arrow)) + px(26))
        return needed

    def layout(self) -> int:
        gutter = self.gutter()
        n = len(self.columns)
        width = (px(FIGURE_WIDTH - 2 * PAD) - gutter * (n - 1)) // n
        top = header_height(self.subtitle)
        bottom = 0
        for c, column in enumerate(self.columns):
            y = top
            for panel in column:
                panel.x = px(PAD) + c * (width + gutter)
                panel.y = y
                panel.width = width
                panel.height = self.measure(panel, width)
                y += panel.height + px(self.PANEL_GAP)
            bottom = max(bottom, y - px(self.PANEL_GAP))
        return even(bottom + px(PAD))

    def render(self, palette: Palette) -> Image.Image:
        height = self.layout()
        image = Image.new("RGB", (px(FIGURE_WIDTH), height), palette.page)
        draw_header(image, palette, self.title, self.subtitle)
        draw = ImageDraw.Draw(image)
        colours = {
            "subtitle": palette.text_muted,
            "label": palette.text,
            "label-accent": palette.accent_text,
            "note": palette.text_secondary,
        }
        for column in self.columns:
            for panel in column:
                draw.rounded_rectangle(
                    (panel.x, panel.y, panel.x + panel.width, panel.y + panel.height),
                    radius=px(RADIUS_CARD),
                    fill=palette.surface,
                    outline=palette.accent if panel.emphasis else palette.border,
                    width=SCALE * (2 if panel.emphasis else 1),
                )
                ox, oy = panel.x + self.pad(), panel.y + self.pad()
                for dx, dy, f, text, role, bullet in self.flow(panel, panel.width):
                    colour = (palette.accent_text if panel.emphasis else palette.text) if role == "title" else colours[role]
                    if bullet:
                        dot = oy + dy + line_height(f) // 2 - px(2)
                        draw.ellipse([ox + px(2), dot, ox + px(6), dot + px(4)], fill=palette.accent)
                    draw.text((ox + dx, oy + dy), text, font=f, fill=colour)
        lookup = {panel.title: panel for column in self.columns for panel in column}
        for source, target, label in self.arrows:
            a, b = lookup[source], lookup[target]
            low, high = max(a.y, b.y), min(a.y + a.height, b.y + b.height)
            if high - low < px(24):
                raise SystemExit(f"ERROR: '{source}' and '{target}' barely overlap; move one so the arrow lands")
            y = (low + high) // 2
            x1, x2 = a.x + a.width, b.x
            draw.line([(x1 + px(4), y), (x2 - px(7), y)], fill=palette.border_strong, width=SCALE)
            draw.polygon([(x2 - px(7), y - px(4)), (x2 - px(1), y), (x2 - px(7), y + px(4))], fill=palette.border_strong)
            if label:
                w = int(draw.textlength(label, font=self.f_arrow))
                draw.text(((x1 + x2) // 2 - w // 2, y - line_height(self.f_arrow) - px(2)), label, font=self.f_arrow, fill=palette.text_muted)
        return finish(image)


# ── tree ──────────────────────────────────────────────────────────────────────


@dataclass
class Row:
    depth: int
    name: str
    note: str
    band: bool = False

    @property
    def is_dir(self) -> bool:
        return self.name.endswith("/")


class TreeFigure:
    INDENT = 16
    STUB = 8
    NAME_GAP = 20
    ROW_GAP = 6
    CARD_PAD = 18

    def __init__(self, title: str, subtitle: str, rows: list[Row]):
        self.title, self.subtitle, self.rows = title, subtitle, rows
        self.f_name = font("mono", 9)
        self.f_note = font("regular", 9)

    def name_x(self, depth: int) -> int:
        return px(self.INDENT) * depth

    def name_column(self) -> int:
        return max(self.name_x(r.depth) + int(PROBE.textlength(r.name, font=self.f_name)) for r in self.rows) + px(self.NAME_GAP)

    def last_child(self, i: int) -> bool:
        d = self.rows[i].depth
        for row in self.rows[i + 1:]:
            if row.depth < d:
                return True
            if row.depth == d:
                return False
        return True

    def continues(self, i: int, depth: int) -> bool:
        """Does the ancestor line at `depth` carry on below row i?"""
        for row in self.rows[i + 1:]:
            if row.depth < depth:
                return False
            if row.depth == depth:
                return True
        return False

    def flow(self, inner_width: int) -> list[tuple[int, list[str], int]]:
        """Per row: its y offset, its wrapped note lines and its height."""
        note_width = inner_width - self.name_column()
        out, y = [], 0
        for row in self.rows:
            notes = wrap(row.note, self.f_note, note_width, PROBE)
            h = max(line_height(self.f_name), len(notes) * line_height(self.f_note))
            out.append((y, notes, h))
            y += h + px(self.ROW_GAP)
        return out

    def render(self, palette: Palette) -> Image.Image:
        top = header_height(self.subtitle)
        card_x0, card_x1 = px(PAD), px(FIGURE_WIDTH - PAD)
        inner_left = card_x0 + px(self.CARD_PAD)
        inner_width = card_x1 - card_x0 - 2 * px(self.CARD_PAD)
        rows = self.flow(inner_width)
        last_y, _, last_h = rows[-1]
        card_y1 = top + px(self.CARD_PAD) + last_y + last_h + px(self.CARD_PAD)
        image = Image.new("RGB", (px(FIGURE_WIDTH), even(card_y1 + px(PAD))), palette.page)
        draw_header(image, palette, self.title, self.subtitle)
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((card_x0, top, card_x1, card_y1), radius=px(RADIUS_CARD), fill=palette.surface, outline=palette.border, width=SCALE)
        origin = top + px(self.CARD_PAD)
        half_gap = px(self.ROW_GAP) // 2

        i = 0
        while i < len(self.rows):  # bands first, one per contiguous run
            if not self.rows[i].band:
                i += 1
                continue
            j = i
            while j + 1 < len(self.rows) and self.rows[j + 1].band:
                j += 1
            y0 = origin + rows[i][0] - half_gap
            y1 = origin + rows[j][0] + rows[j][2] + half_gap
            draw.rounded_rectangle((inner_left - px(8), y0, card_x1 - px(self.CARD_PAD) + px(8), y1), radius=px(6), fill=palette.band)
            i = j + 1

        name_line = line_height(self.f_name)
        for i, row in enumerate(self.rows):
            y, notes, h = rows[i]
            y += origin
            mid = y + name_line // 2
            if row.depth:
                for k in range(1, row.depth):
                    if self.continues(i, k):
                        x = inner_left + self.name_x(k - 1) + px(4)
                        draw.line([(x, y - px(self.ROW_GAP)), (x, y + h)], fill=palette.border_strong, width=SCALE)
                x = inner_left + self.name_x(row.depth - 1) + px(4)
                end = mid if self.last_child(i) else y + h
                draw.line([(x, y - px(self.ROW_GAP)), (x, end)], fill=palette.border_strong, width=SCALE)
                draw.line([(x, mid), (x + px(self.STUB), mid)], fill=palette.border_strong, width=SCALE)
            draw.text((inner_left + self.name_x(row.depth), y), row.name, font=self.f_name, fill=palette.accent_text if row.is_dir else palette.text)
            ny = y + (name_line - line_height(self.f_note)) // 2
            for line in notes:
                draw.text((inner_left + self.name_column(), ny), line, font=self.f_note, fill=palette.text_secondary)
                ny += line_height(self.f_note)
        return finish(image)


# ── hero ──────────────────────────────────────────────────────────────────────


def hero(palette: Palette) -> Image.Image:
    width, height = px(FIGURE_WIDTH), px(HERO_HEIGHT)
    inset = px(2)
    card = (inset, inset, width - inset - 1, height - inset - 1)

    gradient = Image.new("RGB", (width, height))
    fill = ImageDraw.Draw(gradient)
    a, b = parse_hex(palette.surface), parse_hex(palette.page)
    for row in range(height):
        t = row / max(1, height - 1)
        fill.line([(0, row), (width, row)], fill=tuple(int(a[c] + (b[c] - a[c]) * t) for c in range(3)))
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle(card, radius=px(22), fill=255)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(card, radius=px(22), outline=palette.border_strong, width=SCALE)

    mark_size = px(124)
    source = Image.open(MARKS[palette.name]).convert("RGBA")
    mark = source.resize((mark_size, mark_size), Image.LANCZOS)
    art = source.getchannel("A").getbbox()
    scale = mark_size / source.height
    art_left, art_top = round(art[0] * scale), round(art[1] * scale)
    art_w, art_h = round((art[2] - art[0]) * scale), round((art[3] - art[1]) * scale)

    f_word = font("bold", 60)
    f_tag = font("regular", 14)
    head, tail = "Attest", "ra"  # the site's lockup: the last two letters in the accent
    word_box = draw.textbbox((0, 0), head + tail, font=f_word)
    tagline = "The trust layer for NEAR: people, wallets on any chain, and AI agents."
    tag_box = draw.textbbox((0, 0), tagline, font=f_tag)
    tag_gap, rule_gap, rule_h, gap = px(18), px(20), px(3), px(22)

    lockup_h = max(art_h, word_box[3] - word_box[1])
    block_h = lockup_h + tag_gap + (tag_box[3] - tag_box[1]) + rule_gap + rule_h
    block_top = (height - block_h) // 2
    art_y = block_top + (lockup_h - art_h) // 2
    block_w = art_w + gap + (word_box[2] - word_box[0])
    art_x = (width - block_w) // 2
    image.paste(mark, (art_x - art_left, art_y - art_top), mark)
    word_x = art_x + art_w + gap - word_box[0]
    word_y = art_y + art_h // 2 - (word_box[1] + word_box[3]) // 2
    draw.text((word_x, word_y), head, font=f_word, fill=palette.text)
    draw.text((word_x + draw.textlength(head, font=f_word), word_y), tail, font=f_word, fill=palette.accent_text)

    tag_y = block_top + lockup_h + tag_gap - tag_box[1]
    draw.text(((width - (tag_box[2] - tag_box[0])) // 2 - tag_box[0], tag_y), tagline, font=f_tag, fill=palette.text_muted)
    rule_y = block_top + lockup_h + tag_gap + (tag_box[3] - tag_box[1]) + rule_gap
    draw.rounded_rectangle(((width - px(46)) // 2, rule_y, (width + px(46)) // 2, rule_y + rule_h), radius=px(2), fill=palette.accent)
    return finish(image)


# ── content ───────────────────────────────────────────────────────────────────


def pipeline() -> PanelFigure:
    return PanelFigure(
        "How a fact becomes trusted on NEAR",
        "An issuer or an agent submits a claim; the contracts check it with resolvers, verifiable AI or the MPC network; anyone verifies the result without trusting a server.",
        [
            [
                Panel("Issue", "a person, a service or an AI agent", [
                    Item("Wallet or passkey", "NEAR Connect, or a WebAuthn PRF key whose implicit account the relayer funds"),
                    Item("createAttestation()", "SDK; or attestra attestation create; or the MCP tool create_attestation", "mono"),
                    Item("Gasless when signed off chain", "NEP-413 request or NEP-366 delegate action; the relayer pays the gas"),
                ]),
                Panel("Private evidence", "never reaches the chain", [
                    Item("Encrypted in the browser", "X25519 and XChaCha20-Poly1305 to a NEAR AI Cloud model key"),
                    Item("Checker signs a verdict", "the rule's answer, the evidence hash and the NEAR AI signature"),
                ]),
                Panel("Another chain", "Base, Arbitrum, Polygon, BNB, Avalanche", [
                    Item("A transaction and log index", "no bridge, no oracle, no relayer of facts"),
                ]),
            ],
            [
                Panel("attestations", "attestations.attestra.testnet", [
                    Item("attest(schema, subject, data)", "UID is sha256 of the Borsh fields; stored pending", "mono"),
                    Item("Resolver gate", "whitelist, fee, token gate, token reward, or a pipeline of them"),
                    Item("Commit or roll back", "the callback commits, or drops the pending entry and refunds its storage"),
                    Item("NEP-297 event", "attestation_created, read by the indexer and the keeper", "accent"),
                ], emphasis=True),
                Panel("verdicts", "verdicts.attestra.testnet, itself an authority", [
                    Item("AI verdicts", "checker and NEAR AI ed25519 signatures, verified on chain"),
                    Item("Foreign events", "MPC verify_foreign_transaction; the answer checked with ecrecover"),
                    Item("Wallet links", "EIP-191 or ed25519 message naming the NEAR account and this contract"),
                ]),
            ],
            [
                Panel("Verify", "anyone, trusting no server", [
                    Item("verify_attestation", "active, pending, revoking, revoked or expired", "mono"),
                    Item("Light client proof", "the block approved by over 2/3 of stake, checked locally"),
                    Item("NEP-171 credential", "non-transferable, burned when the attestation is revoked"),
                    Item("Know Your Agent", "identity, scoped delegation, reviews and an average score"),
                ]),
                Panel("Will not do", "decisions, not gaps", [
                    Item("Store raw evidence", "only its hash and the verdict are public"),
                    Item("Trust a single oracle", "foreign facts come from the MPC network's quorum of RPCs"),
                    Item("Let a credential move", "it names one subject, for good"),
                ]),
            ],
        ],
        [
            ("Issue", "attestations", "attest"),
            ("Private evidence", "verdicts", "verdict"),
            ("Another chain", "verdicts", "tx id"),
            ("attestations", "Verify", "event"),
        ],
    )


def repository() -> PanelFigure:
    return PanelFigure(
        "What is in the repository",
        "Seven Rust contracts, one TypeScript SDK that every tool shares, the OutLayer checker, and the apps and services behind the hosted demo.",
        [
            [
                Panel("contracts/", "Rust, near-sdk 5.30, reproducible builds", [
                    Item("attestations/src/gate.rs", "pending op, one resolver call, commit or rollback callback", "mono"),
                    Item("verdicts/src/", "AI, cross-chain and wallet-link facts checked on chain", "mono"),
                    Item("resolvers/", "one wasm deployed five times: whitelist, fee, gated, reward, pipeline", "mono"),
                    Item("common/src/uid.rs", "UID derivation, with vectors shared with the SDK", "mono"),
                    Item("308 unit tests, sandbox flows", "cargo test, and near-workspaces against the real wasm", "accent"),
                ], emphasis=True),
            ],
            [
                Panel("packages/", "TypeScript, ESM, published as @attestra/*", [
                    Item("sdk/src/client.ts", "AttestraClient on near-kit; every method returns a result and never throws", "mono"),
                    Item("sdk/src/lightclient.ts", "checks a light client proof against validator stake", "mono"),
                    Item("sdk/src/tools.ts", "one tool list for MCP, the agent and LangChain", "mono"),
                    Item("cli/", "attestra: 22 command groups, --json on every command", "mono"),
                    Item("mcp/", "stdio and HTTP; read tools free, write tools capped per day", "mono"),
                ]),
            ],
            [
                Panel("apps/, services/, checker/", "what runs off chain", [
                    Item("apps/web", "Next.js 16: explorer, 31 sandbox tools, docs, /mcp, /llms.txt", "mono"),
                    Item("apps/indexer", "FastNEAR transactions API into Postgres, REST API", "mono"),
                    Item("apps/agent", "NEAR AI Cloud chat, private checks, x402 paid verification, A2A", "mono"),
                    Item("services/", "relayer (NEP-366, gas key lanes), keeper, top-up", "mono"),
                    Item("checker/", "Rust for NEAR OutLayer: signs verdicts with a key bound to its build", "mono"),
                ]),
            ],
        ],
        [],
    )


def tree() -> TreeFigure:
    return TreeFigure(
        "Repository tree",
        "Where each part lives. The banded subtree is where facts about private data and other chains are checked on NEAR.",
        [
            Row(0, "Attestra/", "contracts, SDK, CLI, MCP, apps, services and the docs for agents"),
            Row(1, "contracts/", "one Cargo workspace, rustc 1.98.1 pinned, NEP-330 build metadata"),
            Row(2, "common/", "UIDs, NEP-297 events, NEP-145 storage, NEP-413 hashing"),
            Row(2, "schemas/", "the schema registry, with blobs for large definitions"),
            Row(2, "attestations/", "attestations, authorities, delegates, multisig, the resolver gate"),
            Row(2, "resolvers/", "whitelist, fee, token gated, token reward and pipeline"),
            Row(2, "verdicts/", "the verifier: an authority whose facts are checked on chain", True),
            Row(3, "ai.rs", "checker and NEAR AI signatures, a 15 minute age limit", True),
            Row(3, "foreign.rs", "calls the MPC verify_foreign_transaction and checks the answer", True),
            Row(3, "mpc.rs", "the MPC interface, Borsh byte-identical to the signed payload", True),
            Row(3, "wallet.rs", "EIP-191 and ed25519 wallet-link messages", True),
            Row(2, "credentials/", "NEP-171 credentials, non-transferable, burned on revoke"),
            Row(2, "staking/", "NEP-141 stake that sets an authority's tier"),
            Row(2, "token/", "a testnet NEP-141 with a faucet"),
            Row(2, "sandbox-tests/", "near-workspaces flows across every contract"),
            Row(1, "checker/", "the private checker as a NEAR OutLayer component; its key is bound to its build"),
            Row(1, "packages/", "@attestra/sdk, @attestra/cli and @attestra/mcp"),
            Row(1, "apps/", "web (3100), indexer (5100), agent (5300)"),
            Row(1, "services/", "relayer (5200), keeper (5400), top-up (5500)"),
            Row(1, "scripts/", "deploy, accounts, verify (a live deployment, PASS or FAIL), CLI e2e, security, dev"),
            Row(1, "deployments/", "accounts, code hashes and transactions per network"),
            Row(1, "skills/attestra/", "the agent skill for using and extending Attestra"),
            Row(1, "compose.yaml", "the whole stack in containers, with Caddy for TLS"),
            Row(1, "AGENTS.md", "for coding agents: layout, commands, where each NEAR primitive lives"),
        ],
    )


# ── main ──────────────────────────────────────────────────────────────────────


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def main() -> int:
    check = "--check" in sys.argv[1:]
    missing = [m for m in MARKS.values() if not m.is_file()]
    if missing:
        print(f"ERROR: {missing[0]} is missing. Run tools/make_brand.sh first.")
        return 2
    for kind, (path, _) in FONTS.items():
        if not Path(path).is_file():
            print(f"ERROR: the {kind} font is missing at {path}.")
            return 2
    # The dark palette only draws the hero (a gradient from surface to page, no band); the light one
    # draws the diagrams too, where text also lands on the highlight band.
    problems = audit(DARK, ("surface", "page")) + audit(LIGHT, ("surface", "band", "page"))
    if problems:
        print("ERROR: contrast below AA; nothing written.")
        return 1
    images = {
        "hero-dark.png": hero(DARK),
        "hero-light.png": hero(LIGHT),
        "pipeline.png": pipeline().render(LIGHT),
        "repository.png": repository().render(LIGHT),
        "tree.png": tree().render(LIGHT),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    changed = 0
    for name, image in images.items():
        target = OUT / name
        data = png_bytes(image)
        same = target.is_file() and target.read_bytes() == data
        changed += not same
        print(f"  {'same   ' if same else 'changed'}  {name}  {image.width}x{image.height}")
        if not check and not same:
            target.write_bytes(data)
    print(f"{changed} image(s) {'would change' if check else 'written'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

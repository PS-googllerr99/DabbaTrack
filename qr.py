"""Pure-Python QR Code SVG generator (Versions 1-2, Byte mode, ECC Level L)."""

from __future__ import annotations

from html import escape

# QR Version specs for ECC Level L: (size, data_codewords, ecc_codewords, alignment_centers)
_VERSION_SPECS = {
    1: (21, 19, 7, ()),
    2: (25, 34, 10, (18,)),
}

# Precomputed GF(256) log/exp tables with primitive polynomial 0x11D.
_GF_EXP = [0] * 512
_GF_LOG = [0] * 256
_x = 1
for _i in range(255):
    _GF_EXP[_i] = _x
    _GF_LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _GF_EXP[_i] = _GF_EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator_poly(degree: int) -> list[int]:
    poly = [1]
    for i in range(degree):
        next_poly = [0] * (len(poly) + 1)
        factor = _GF_EXP[i]
        for idx, coeff in enumerate(poly):
            next_poly[idx] ^= coeff
            next_poly[idx + 1] ^= _gf_mul(coeff, factor)
        poly = next_poly
    return poly


def _rs_encode(data: list[int], ecc_count: int) -> list[int]:
    gen = _rs_generator_poly(ecc_count)
    buf = list(data) + [0] * ecc_count
    for i in range(len(data)):
        coef = buf[i]
        if coef != 0:
            for j in range(1, len(gen)):
                buf[i + j] ^= _gf_mul(gen[j], coef)
    return buf[len(data) :]


def _encode_bytes(payload: bytes, data_cw: int) -> list[int]:
    bits: list[int] = []

    def push_bits(val: int, width: int) -> None:
        for shift in range(width - 1, -1, -1):
            bits.append((val >> shift) & 1)

    push_bits(0b0100, 4)  # Byte mode
    push_bits(len(payload), 8)
    for b in payload:
        push_bits(b, 8)

    capacity_bits = data_cw * 8
    terminator = min(4, capacity_bits - len(bits))
    push_bits(0, terminator)

    while len(bits) % 8 != 0:
        bits.append(0)

    out: list[int] = []
    for i in range(0, len(bits), 8):
        byte_val = 0
        for b in bits[i : i + 8]:
            byte_val = (byte_val << 1) | b
        out.append(byte_val)

    pad_bytes = (0xEC, 0x11)
    pad_idx = 0
    while len(out) < data_cw:
        out.append(pad_bytes[pad_idx % 2])
        pad_idx += 1
    return out


def _place_finder(grid: list[list[int | None]], reserved: list[list[bool]], r0: int, c0: int) -> None:
    size = len(grid)
    for dr in range(-1, 8):
        for dc in range(-1, 8):
            r, c = r0 + dr, c0 + dc
            if not (0 <= r < size and 0 <= c < size):
                continue
            reserved[r][c] = True
            if dr in (-1, 7) or dc in (-1, 7):
                grid[r][c] = 0
            elif dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4):
                grid[r][c] = 1
            else:
                grid[r][c] = 0


def _place_alignment(grid: list[list[int | None]], reserved: list[list[bool]], cr: int, cc: int) -> None:
    for dr in range(-2, 3):
        for dc in range(-2, 3):
            r, c = cr + dr, cc + dc
            reserved[r][c] = True
            if abs(dr) == 2 or abs(dc) == 2 or (dr == 0 and dc == 0):
                grid[r][c] = 1
            else:
                grid[r][c] = 0


def _format_bits(mask_id: int) -> int:
    # ECC Level L = 01
    data = (0b01 << 3) | mask_id
    rem = data << 10
    gen = 0b10100110111
    for bit in range(14, 9, -1):
        if rem & (1 << bit):
            rem ^= gen << (bit - 10)
    return ((data << 10) | rem) ^ 0b101010000010010


def _write_format_info(grid: list[list[int]], mask_id: int) -> None:
    size = len(grid)
    fmt = _format_bits(mask_id)
    bits = [(fmt >> i) & 1 for i in range(15)]

    # Around top-left finder
    coords1 = [
        (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
        (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8),
    ]
    for idx, (r, c) in enumerate(coords1):
        grid[r][c] = bits[14 - idx]

    # Bottom-left and top-right
    for idx in range(7):
        grid[size - 1 - idx][8] = bits[idx]
    for idx in range(7, 15):
        grid[8][size - 15 + idx] = bits[idx]


def _mask_condition(mask_id: int, r: int, c: int) -> bool:
    if mask_id == 0:
        return (r + c) % 2 == 0
    if mask_id == 1:
        return r % 2 == 0
    if mask_id == 2:
        return c % 3 == 0
    if mask_id == 3:
        return (r + c) % 3 == 0
    if mask_id == 4:
        return ((r // 2) + (c // 3)) % 2 == 0
    if mask_id == 5:
        return ((r * c) % 2) + ((r * c) % 3) == 0
    if mask_id == 6:
        return (((r * c) % 2) + ((r * c) % 3)) % 2 == 0
    return (((r + c) % 2) + ((r * c) % 3)) % 2 == 0


def _penalty_score(grid: list[list[int]]) -> int:
    size = len(grid)
    score = 0

    # Rule 1: runs of 5+ same color in rows and cols
    for r in range(size):
        run = 1
        for c in range(1, size):
            if grid[r][c] == grid[r][c - 1]:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run = 1
        if run >= 5:
            score += 3 + (run - 5)

    for c in range(size):
        run = 1
        for r in range(1, size):
            if grid[r][c] == grid[r - 1][c]:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run = 1
        if run >= 5:
            score += 3 + (run - 5)

    # Rule 2: 2x2 blocks
    for r in range(size - 1):
        for c in range(size - 1):
            v = grid[r][c]
            if v == grid[r][c + 1] == grid[r + 1][c] == grid[r + 1][c + 1]:
                score += 3

    # Rule 4: dark ratio
    dark = sum(sum(row) for row in grid)
    pct = (dark * 100) // (size * size)
    prev5 = abs(pct - (pct % 5) - 50) // 5
    next5 = abs(pct + (5 - pct % 5) - 50) // 5
    score += min(prev5, next5) * 10
    return score


def generate_qr_matrix(text: str) -> list[list[int]]:
    """Return a 2D matrix of 0/1 modules representing a scannable QR code."""
    payload = text.encode("utf-8")
    if len(payload) <= 17:
        version = 1
    elif len(payload) <= 32:
        version = 2
    else:
        raise ValueError("QR text exceeds Version 2 capacity (32 bytes)")

    size, data_cw, ecc_cw, align_centers = _VERSION_SPECS[version]
    data = _encode_bytes(payload, data_cw)
    ecc = _rs_encode(data, ecc_cw)
    codewords = data + ecc

    stream_bits: list[int] = []
    for cw in codewords:
        for shift in range(7, -1, -1):
            stream_bits.append((cw >> shift) & 1)

    grid: list[list[int | None]] = [[None] * size for _ in range(size)]
    reserved: list[list[bool]] = [[False] * size for _ in range(size)]

    _place_finder(grid, reserved, 0, 0)
    _place_finder(grid, reserved, 0, size - 7)
    _place_finder(grid, reserved, size - 7, 0)

    # Timing patterns
    for i in range(8, size - 8):
        bit = 1 if i % 2 == 0 else 0
        reserved[6][i] = True
        grid[6][i] = bit
        reserved[i][6] = True
        grid[i][6] = bit

    # Dark module
    reserved[4 * version + 9][8] = True
    grid[4 * version + 9][8] = 1

    # Alignment patterns
    for center in align_centers:
        _place_alignment(grid, reserved, center, center)

    # Reserve format info cells
    for i in range(9):
        if not reserved[8][i]:
            reserved[8][i] = True
            grid[8][i] = 0
        if not reserved[i][8]:
            reserved[i][8] = True
            grid[i][8] = 0
    for i in range(size - 8, size):
        reserved[8][i] = True
        grid[8][i] = 0
    for i in range(size - 7, size):
        reserved[i][8] = True
        grid[i][8] = 0

    # Place data bits in zig-zag columns
    bit_idx = 0
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for r in rows:
            for dc in (0, -1):
                c = col + dc
                if not reserved[r][c]:
                    grid[r][c] = stream_bits[bit_idx] if bit_idx < len(stream_bits) else 0
                    bit_idx += 1
        upward = not upward
        col -= 2

    best_grid: list[list[int]] | None = None
    best_score = 10**9

    for mask_id in range(8):
        candidate = [
            [
                (grid[r][c] ^ 1) if (not reserved[r][c] and _mask_condition(mask_id, r, c)) else int(grid[r][c] or 0)
                for c in range(size)
            ]
            for r in range(size)
        ]
        _write_format_info(candidate, mask_id)
        sc = _penalty_score(candidate)
        if sc < best_score:
            best_score = sc
            best_grid = candidate

    assert best_grid is not None
    return best_grid


def render_qr_svg(text: str, module_px: int = 8, quiet: int = 3) -> str:
    """Render the QR matrix as a crisp standalone SVG string."""
    matrix = generate_qr_matrix(text)
    size = len(matrix)
    total = (size + quiet * 2) * module_px
    rects: list[str] = []
    for r, row in enumerate(matrix):
        for c, val in enumerate(row):
            if val:
                x = (c + quiet) * module_px
                y = (r + quiet) * module_px
                rects.append(f'<rect x="{x}" y="{y}" width="{module_px}" height="{module_px}"/>')

    title = escape(text)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
        f'width="{total}" height="{total}" role="img" aria-label="QR code for {title}">'
        f'<rect width="{total}" height="{total}" fill="#ffffff"/>'
        f'<g fill="#111827">{"".join(rects)}</g>'
        f"</svg>"
    )

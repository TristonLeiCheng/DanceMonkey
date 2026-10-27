"""Index generated PNGs without modifying their pixels (requires Pillow).

The generator leaves transparent gutters of slightly different sizes. Locate the
36 silhouettes, keep edge padding and record a common foot baseline for playback.
"""
import hashlib
import json
from array import array
from collections import defaultdict, deque
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def bands(values, gap=0):
    result = []
    for value in values:
        if not result or value > result[-1][1] + gap:
            result.append([value, value + 1])
        else:
            result[-1][1] = value + 1
    return result


def index(animal):
    filename = {'realistic-cockroach': 'spritesheet-realistic.png', 'realistic-mosquito': 'spritesheet-realistic.png', 'liangzi': 'spritesheet-realistic-v2.png', 'hamster': 'spritesheet-natural.png', 'seal': 'spritesheet-natural.png', 'koala': 'spritesheet-natural.png', 'fluffy-rabbit': 'spritesheet-fluffy.png', 'capybara': 'spritesheet-natural.png', 'otter': 'spritesheet-natural.png',
                'red-panda': 'spritesheet-barista.png', 'baby-dragon': 'spritesheet-dragon.png'}.get(animal, 'spritesheet-engineer.png')
    file = ROOT / 'assets' / 'pets' / animal / filename
    image = Image.open(file)
    assert image.mode == 'RGBA', f'{animal}: genuine alpha required'
    width, height = image.size
    if animal == 'liangzi':
        return index_connected(file, image)
    alpha = image.getchannel('A')
    # Ignore nearly invisible RGB residue in alpha=1 pixels, retain fur outlines.
    insect = animal in ('realistic-cockroach', 'realistic-mosquito')
    # Fine antennae and translucent wings need a lower threshold; bridge tiny
    # alpha gaps within one appendage, never the wide gutters between insects.
    threshold, gap = (8, 12) if insect else (32, 0)
    mask = alpha.point(lambda a: 255 if a > threshold else 0)
    pixels = mask.load()
    rows = bands((y for y in range(height) if any(pixels[x, y] for x in range(width))), gap)
    assert len(rows) == 9, f'{animal}: expected 9 separated action rows, got {rows}'
    frames = []
    for row, (top, bottom) in enumerate(rows):
        columns = bands((x for x in range(width) if any(pixels[x, y] for y in range(top, bottom))), gap)
        assert len(columns) == 4, f'{animal}/{row}: expected four complete silhouettes'
        row_frames = []
        row_top = (rows[row - 1][1] + top) // 2 if row else 0
        row_bottom = (bottom + rows[row + 1][0]) // 2 if row < 8 else height
        for column, (left, right) in enumerate(columns):
            box = mask.crop((left, top, right, bottom)).getbbox()
            assert box and (right - left) > 50
            x0 = max(left - 3, (columns[column - 1][1] + left) // 2 if column else 0)
            x1 = min(right + 3, (right + columns[column + 1][0]) // 2 if column < 3 else width)
            y0 = max(top + box[1] - 3, row_top)
            y1 = min(top + box[3] + 3, row_bottom)
            w, h = x1 - x0, y1 - y0
            lift = [0, 12, 24, 0][column] if row == 4 else 0
            # Match the fox's feet near the bottom of its logical cell.
            dx, dy = (256 - w) / 2, 248 - h - lift
            assert dx >= 0 and dy >= 0 and w < 256 and h < 256, f'{animal}/{row}/{column}: clipped pose'
            row_frames.append([x0, y0, w, h, dx, dy])
        frames.append(row_frames)
    return {'source': file.relative_to(ROOT).as_posix(), 'width': width, 'height': height,
            'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'frames': frames}


def index_connected(file, image):
    """Read 36 separate silhouettes even when their rectangular bounds overlap.

    Optional seventh frame entries are source-relative clip rectangles. These
    isolate adjacent poses at playback without changing any original PNG pixels.
    """
    width, height = image.size
    alpha = image.getchannel('A').tobytes()
    owners = array('I', [0]) * (width * height)
    components = []
    serial = 0
    for seed, value in enumerate(alpha):
        if value <= 64 or owners[seed]:
            continue
        serial += 1
        owners[seed] = serial
        pending, points = deque([seed]), []
        while pending:
            point = pending.popleft()
            points.append(point)
            x, y = point % width, point // width
            for neighbor in (point - width if y else -1,
                             point + width if y < height - 1 else -1,
                             point - 1 if x else -1,
                             point + 1 if x < width - 1 else -1):
                if neighbor >= 0 and not owners[neighbor] and alpha[neighbor] > 64:
                    owners[neighbor] = serial
                    pending.append(neighbor)
        if len(points) <= 800:
            continue
        rows = defaultdict(list)
        for point in points:
            rows[point // width].append(point % width)
        runs = {y: bands(sorted(xs)) for y, xs in rows.items()}
        box = [min(point % width for point in points), min(rows),
               max(point % width for point in points) + 1, max(rows) + 1]
        components.append({'id': serial, 'box': box, 'runs': runs})
    assert len(components) == 36, f'liangzi: expected 36 complete silhouettes, found {len(components)}'
    components.sort(key=lambda c: c['box'][1])
    ordered = [sorted(components[start:start + 4], key=lambda c: c['box'][0])
               for start in range(0, 36, 4)]
    ids = {component['id'] for component in components}
    frames = []
    for row, poses in enumerate(ordered):
        row_frames = []
        for column, component in enumerate(poses):
            left, top, right, bottom = component['box']
            x0, y0 = max(0, left - 3), max(0, top - 3)
            x1, y1 = min(width, right + 3), min(height, bottom + 3)
            w, h = x1 - x0, y1 - y0
            lift = [0, 12, 24, 0][column] if row == 4 else 0
            dx, dy = (256 - w) / 2, 248 - h - lift
            assert min(dx, dy) >= 0 and max(w, h) < 256, 'liangzi: pose exceeds logical canvas'
            frame = [x0, y0, w, h, dx, dy]
            risky = set()
            for other in components:
                if other is component:
                    continue
                a, b, c, d = other['box']
                if max(x0, a - 3) < min(x1, c + 3):
                    risky.update(range(max(y0, b - 3), min(y1, d + 3)))
            if risky:
                clips, previous = [], {}
                for y in range(y0, y1):
                    spans = [[x0, x1]] if y not in risky else component['runs'].get(y, [])
                    current = {}
                    for a, b in spans:
                        if y in risky:
                            for _ in range(2):
                                if a > x0 and owners[y * width + a - 1] not in ids - {component['id']}:
                                    a -= 1
                                if b < x1 and owners[y * width + b] not in ids - {component['id']}:
                                    b += 1
                        a, b = max(a, x0), min(b, x1)
                        assert not any(owners[y * width + x] in ids - {component['id']} for x in range(a, b)), 'neighbor leaked into clip'
                        key = (a, b)
                        if key in previous:
                            rectangle = previous[key]
                            rectangle[3] += 1
                        else:
                            rectangle = [a - x0, y - y0, b - a, 1]
                            clips.append(rectangle)
                        current[key] = rectangle
                    previous = current
                # Every solid pixel of the intended body remains visible.
                for y, spans in component['runs'].items():
                    for a, b in spans:
                        assert all(any(cx <= x - x0 < cx + cw and cy <= y - y0 < cy + ch
                                       for cx, cy, cw, ch in clips) for x in range(a, b))
                frame.append(clips)
            row_frames.append(frame)
        frames.append(row_frames)
    return {'source': file.relative_to(ROOT).as_posix(), 'width': width, 'height': height,
            'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'frames': frames}


data = {animal: index(animal) for animal in ('cat', 'dog', 'capybara', 'otter', 'red-panda', 'baby-dragon', 'fluffy-rabbit', 'koala', 'hamster', 'seal', 'liangzi', 'realistic-cockroach', 'realistic-mosquito')}
target = ROOT / 'src' / 'pet-companion-atlases.js'
target.write_text('// Generated by tools/index-companion-atlases.py; PNG pixels are untouched.\n'
                  '(function(root) {\n  const atlases = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
                  "  if (typeof module === 'object' && module.exports) module.exports = atlases;\n"
                  '  else root.DMPetCompanionAtlases = atlases;\n'
                  "})(typeof globalThis !== 'undefined' ? globalThis : this);\n")
print(f'Indexed {len(data) * 36} frames: {target}')

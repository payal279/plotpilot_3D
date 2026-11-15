import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "rules", "sample_rules.json"), encoding="utf-8") as _f:
    RULES = json.load(_f)

FH = 10.0                      # floor-to-floor height (ft)
STAIR_W, STAIR_L = 6.0, 9.0
BASE_MARGIN = 3.0              # first draft uses tight margins; the rules engine then corrects them
MIN_LEFT_W, MIN_BL = 10.0, 24.0

FACING = {"east": "East", "purab": "East", "west": "West", "paschim": "West",
          "north": "North", "uttar": "North", "south": "South", "dakshin": "South"}


# ---------------------------------------------------------------- prompt reader
def _words_to_digits(t):
    nums = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6"}
    pat = r"\b(one|two|three|four|five|six)\b(?=\s*-?\s*(?:floors?|flats?|bhk|storeys?|stories|story|bedrooms?|units?))"
    return re.sub(pat, lambda m: nums[m.group(1)], t)


def parse_prompt(text):
    """Rule-based prompt reader. Replace with an LLM later; keep the same output keys."""
    t = _words_to_digits(text.lower())
    assumed = []

    w, l = 30.0, 50.0
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:x|×|\*|by)\s*(\d+(?:\.\d+)?)", t)
    if m:
        w, l = float(m.group(1)), float(m.group(2))
    else:
        assumed.append("plot size")

    parking = bool(re.search(r"\b(parking|garage|gaadi|car|stilt)\b", t))
    flats = re.search(r"(\d+)\s*(?:flats?|units?|apartments?)", t)
    g = re.search(r"\bg\s*\+\s*(\d)", t)
    f = re.search(r"(\d+)\s*(?:floors?|storeys?|stories|story|manzil|manjil)", t)
    if g:
        floors = int(g.group(1)) + 1
    elif f:
        floors = int(f.group(1))
    elif flats:
        floors = int(flats.group(1)) + (1 if parking else 0)
    else:
        floors = 3
        assumed.append("floors")
    floors = max(1, min(6, floors))

    b = re.search(r"(\d)\s*-?\s*bhk", t) or re.search(r"(\d)\s*bedrooms?", t)
    bhk = int(b.group(1)) if b else 2
    if not b:
        assumed.append("bedrooms")
    bhk = max(1, min(4, bhk))

    facing, found = "East", False
    for key, val in FACING.items():
        if re.search(r"\b" + key + r"\b", t):
            facing, found = val, True
            break
    if not found:
        assumed.append("facing")

    budget = None
    bm = re.search(r"(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|lac|crores?|cr)\b", t)
    if bm:
        budget = int(float(bm.group(1)) * (1e7 if bm.group(2).startswith("c") else 1e5))

    return {"plot_w": w, "plot_l": l, "floors": floors, "bhk": bhk, "facing": facing,
            "parking": parking and floors > 1, "pooja": bool(re.search(r"\b(pooja|puja|mandir)\b", t)),
            "study": bool(re.search(r"\b(study|office)\b", t)), "solar": "solar" in t,
            "budget": budget, "assumed": assumed}


# ---------------------------------------------------------------- layout
def _r(v):
    return round(v, 2)


def _room(name, typ, x, y, w, l):
    return {"name": name, "type": typ, "x": _r(x), "y": _r(y), "w": _r(w), "l": _r(l)}


def _floor(level, kind, B, p, kitchen_back, mirror):
    bx, by, bw, bl = B
    lw = bw - STAIR_W
    sx, sy = bx + lw, by + bl - STAIR_L
    rooms, doors, wins = [], [], []

    def R(*a):
        rooms.append(_room(*a))

    def D(o, x, y, ln=3.0, main=False):
        doors.append({"o": o, "x": _r(x), "y": _r(y), "len": ln, "main": main})

    def Wn(o, x, y, ln=4.0):
        wins.append({"o": o, "x": _r(x), "y": _r(y), "len": ln})

    R("Staircase", "stair", sx, sy, STAIR_W, STAIR_L)

    if kind == "parking":
        split = min(by + bl * 0.58, sy)
        R("Parking", "parking", bx, by, bw, split - by)
        rooms[-1]["open"] = "front"
        R("Store", "utility", bx, split, lw, by + bl - split)
        lob = sy - split
        if lob > 2:
            R("Lobby", "passage", sx, split, STAIR_W, lob)
            D("v", sx, split + lob / 2, 3)
            D("h", sx + STAIR_W / 2, split, 3.5, True)
        else:
            D("h", sx + STAIR_W / 2, sy, 3.5, True)
        Wn("v", bx, split + (by + bl - split) / 2, 3)
        Wn("h", bx + lw / 2, by + bl, 4)
    else:
        R("Sit-out" if level == 0 else "Balcony", "balcony", bx, by, lw, 4.0)
        y = by + 4.0
        avail = by + bl - y
        living, kd = ("living", 3.0), ("kd", 2.4)
        study = [("study", 2.0)] if p["study"] else []
        beds = [("bed", 3.0)] * p["bhk"]
        rows = [living] + study + beds + [kd] if kitchen_back else [living, kd] + study + beds
        total = sum(wt for _, wt in rows)
        bed_i = 0
        for idx, (k, wt) in enumerate(rows):
            h = avail * wt / total
            mid = y + h / 2
            if k == "living":
                R("Living", "living", bx, y, lw, h)
                D("v", sx, mid, 3)
                if idx == 0:
                    D("h", bx + lw / 2, y, 3.5, level == 0)
                Wn("v", bx, mid, 5)
            elif k == "kd":
                kw = lw * 0.55
                R("Kitchen", "kitchen", bx, y, kw, h)
                R("Dining", "dining", bx + kw, y, lw - kw, h)
                D("v", bx + kw, mid, 3)
                D("v", sx, mid, 3)
                Wn("v", bx, mid, 3.5)
            elif k == "study":
                R("Study", "study", bx, y, lw, h)
                D("v", sx, mid, 3)
                Wn("v", bx, mid, 4)
            else:
                bb = lw * 0.28
                R("Attached Bath" if bed_i == 0 else "Bath", "bath", bx, y, bb, h)
                nm = "Bedroom" if p["bhk"] == 1 else ("Master Bedroom" if bed_i == 0 else "Bedroom %d" % (bed_i + 1))
                R(nm, "bed", bx + bb, y, lw - bb, h)
                D("v", bx + bb, mid, 2.5)
                D("v", sx, mid, 3)
                Wn("v", bx, mid, 2.5)
                bed_i += 1
            if idx == len(rows) - 1:
                Wn("h", bx + lw * 0.6, by + bl, 4)
            y += h

        cy = by
        if p["pooja"]:
            R("Pooja", "pooja", sx, cy, STAIR_W, 6)
            D("v", sx, by + 5, 2.5)
            cy += 6
        if sy - cy >= 8:
            R("Toilet", "bath", sx, cy, STAIR_W, 5)
            D("h", sx + 3, cy + 5, 2.5)
            Wn("v", bx + bw, cy + 2.5, 2)
            cy += 5
        if sy - cy > 2:
            R("Passage", "passage", sx, cy, STAIR_W, sy - cy)
        if level > 0:
            D("h", sx + STAIR_W / 2, sy, 3.5, True)

    if mirror:
        for r in rooms:
            r["x"] = _r(2 * bx + bw - r["x"] - r["w"])
        for d in doors + wins:
            d["x"] = _r(2 * bx + bw - d["x"])
    return {"level": level, "label": "Ground floor" if level == 0 else "Floor %d" % level,
            "kind": kind, "rooms": rooms, "doors": doors, "windows": wins}


def _assemble(p, m, mirror, kb):
    W, L = p["plot_w"], p["plot_l"]
    bx, by = m["left"], m["front"]
    bw, bl = W - m["left"] - m["right"], L - m["front"] - m["rear"]
    if bw - STAIR_W < MIN_LEFT_W or bl < MIN_BL:
        raise ValueError("Plot is too small after setbacks.")
    floors = [_floor(i, "parking" if (i == 0 and p["parking"]) else "res", (bx, by, bw, bl), p, kb, mirror)
              for i in range(p["floors"])]
    cars = []
    if p["parking"]:
        n = max(1, min(3, int(bw // 9)))
        pk = next(r for r in floors[0]["rooms"] if r["type"] == "parking")
        cars = [{"x": _r(pk["x"] + pk["w"] / n * (i + 0.5)), "y": _r(pk["y"] + pk["l"] / 2)} for i in range(n)]
    roof = {"tank": {"x": _r(bx + 4), "y": _r(by + bl - 4), "r": 2.0}, "solar": None}
    if p["solar"]:
        roof["solar"] = {"x": _r(bx + 2), "y": _r(by + 2), "w": _r(min(bw - 10, 14)), "l": _r(min(bl * 0.4, 14))}
    return {"floors": floors, "cars": cars, "roof": roof,
            "buildable": {"x": _r(bx), "y": _r(by), "w": _r(bw), "l": _r(bl)}}


# ---------------------------------------------------------------- rules engine
def _metrics(p, m):
    W, L = p["plot_w"], p["plot_l"]
    bw, bl = W - m["left"] - m["right"], L - m["front"] - m["rear"]
    built = bw * bl * p["floors"]
    return {"coverage_pct": _r(bw * bl / (W * L) * 100), "far": _r(built / (W * L)),
            "height_ft": _r(p["floors"] * FH), "built_up_sqft": _r(built)}


def _geometry(asm, p, m):
    eps, W, L = 0.05, p["plot_w"], p["plot_l"]
    inside, overlap = True, False
    for fl in asm["floors"]:
        rs = fl["rooms"]
        for r in rs:
            if (r["x"] < m["left"] - eps or r["y"] < m["front"] - eps or
                    r["x"] + r["w"] > W - m["right"] + eps or r["y"] + r["l"] > L - m["rear"] + eps):
                inside = False
        for i in range(len(rs)):
            for j in range(i + 1, len(rs)):
                a, b = rs[i], rs[j]
                if (a["x"] < b["x"] + b["w"] - eps and b["x"] < a["x"] + a["w"] - eps and
                        a["y"] < b["y"] + b["l"] - eps and b["y"] < a["y"] + a["l"] - eps):
                    overlap = True
    stairs = [next(r for r in fl["rooms"] if r["type"] == "stair") for fl in asm["floors"]]
    aligned = all(s == stairs[0] for s in stairs)
    return inside, overlap, aligned


def evaluate(p, m, asm):
    R, mt = RULES, _metrics(p, m)
    c = []

    def add(cid, name, ok, detail, cat, fixable=False, tip=""):
        c.append({"id": cid, "name": name, "status": "pass" if ok else "fail", "detail": detail,
                  "category": cat, "fixable": fixable, "tip": tip})

    side = min(m["left"], m["right"])
    add("setback", "Setbacks (front / side / rear)",
        m["front"] >= R["min_front_setback_ft"] and side >= R["min_side_setback_ft"] and m["rear"] >= R["min_rear_setback_ft"],
        "Now %g / %g / %g ft. Minimum %g / %g / %g ft." % (m["front"], side, m["rear"], R["min_front_setback_ft"],
                                                         R["min_side_setback_ft"], R["min_rear_setback_ft"]),
        "bylaw", True)
    add("coverage", "Ground coverage", mt["coverage_pct"] <= R["max_ground_coverage_pct"],
        "%g%% (limit %g%%)." % (mt["coverage_pct"], R["max_ground_coverage_pct"]), "bylaw", True)
    maxf = int(R["max_height_ft"] // FH)
    add("far", "Floor area ratio (FAR)", mt["far"] <= R["max_far"], "%g (limit %g)." % (mt["far"], R["max_far"]),
        "bylaw", False, "Reduce the number of floors or the built-up area.")
    add("height", "Building height", mt["height_ft"] <= R["max_height_ft"],
        "%g ft (limit %g ft)." % (mt["height_ft"], R["max_height_ft"]), "bylaw", False,
        "Use at most %d floors." % maxf)
    need = p["floors"] >= R["parking_required_from_floors"]
    add("parking", "Parking provided", (not need) or p["parking"],
        "Required from %d floors. %s." % (R["parking_required_from_floors"], "Provided" if p["parking"] else "Not provided"),
        "bylaw", True)
    small = []
    for fl in asm["floors"][:2]:
        for r in fl["rooms"]:
            mn = R["min_room_area_sqft"].get(r["type"])
            if mn and r["w"] * r["l"] < mn and r["name"] not in [s.split(" (")[0] for s in small]:
                small.append("%s (%d sq ft, min %d)" % (r["name"], r["w"] * r["l"], mn))
    add("rooms", "Minimum room sizes", not small,
        "All rooms meet the minimum." if not small else "Too small: " + ", ".join(small[:3]) + ".",
        "bylaw", False, "Use a bigger plot or fewer bedrooms.")
    inside, overlap, aligned = _geometry(asm, p, m)
    add("inside", "All rooms inside the buildable area", inside, "", "geometry")
    add("overlap", "No overlapping rooms", not overlap, "", "geometry")
    add("stairs", "Staircase aligned on every floor", aligned, "", "geometry")
    return c, mt


# ---------------------------------------------------------------- Vastu (traditional guidelines)
V_RULES = {
    "kitchen": ({"SE": 10, "NW": 6, "E": 4, "S": 4}, "South-East"),
    "living": ({"N": 10, "E": 10, "NE": 10, "NW": 6}, "North / East / North-East"),
    "master": ({"SW": 10, "S": 7, "W": 7, "NW": 5}, "South-West"),
    "bed": ({"W": 8, "NW": 8, "S": 8, "SW": 8, "SE": 4}, "West / North-West / South"),
    "bath": ({"NW": 10, "W": 10, "S": 8, "SE": 4, "NE": 0}, "North-West / West / South (avoid North-East)"),
    "pooja": ({"NE": 10, "E": 6, "N": 6}, "North-East"),
    "stair": ({"SW": 10, "S": 8, "W": 8, "NW": 6, "SE": 6, "NE": 0}, "South / West / South-West"),
    "parking": ({"NW": 10, "SE": 10, "E": 6, "N": 6}, "North-West / South-East"),
}


def _zone(facing, u, v):
    """u: 0 left..1 right as seen from the road. v: 0 front..1 back. Returns a compass zone."""
    if facing == "East":
        ew, ns = 1 - v, u
    elif facing == "West":
        ew, ns = v, 1 - u
    elif facing == "North":
        ew, ns = 1 - u, 1 - v
    else:
        ew, ns = u, v
    a = "N" if ns > 0.66 else ("S" if ns < 0.34 else "")
    b = "E" if ew > 0.66 else ("W" if ew < 0.34 else "")
    return (a + b) or "C"


def vastu(floors, p):
    W, L, total, mx, notes, seen = p["plot_w"], p["plot_l"], 0, 0, [], set()
    for fl in floors:
        for r in fl["rooms"]:
            key = "master" if r["name"] == "Master Bedroom" else ("bath" if r["type"] == "bath" else r["type"])
            if key not in V_RULES:
                continue
            z = _zone(p["facing"], (r["x"] + r["w"] / 2) / W, (r["y"] + r["l"] / 2) / L)
            pts, ideal = V_RULES[key]
            sc = pts.get(z, 2)
            total += sc
            mx += 10
            tag = (r["name"], z, sc >= 6)
            if tag not in seen:
                seen.add(tag)
                notes.append({"room": r["name"], "zone": z, "ideal": ideal, "ok": sc >= 6})
    score = int(round(100 * total / mx)) if mx else 0
    tips = ["%s is in the %s zone. Traditional ideal: %s." % (n["room"], n["zone"], n["ideal"]) for n in notes if not n["ok"]]
    return {"score": score, "notes": notes, "tips": tips[:5]}


# ---------------------------------------------------------------- full pipeline
def build_response(text):
    p = parse_prompt(text)
    R = RULES
    min_w = 2 * R["min_side_setback_ft"] + STAIR_W + MIN_LEFT_W
    min_l = R["min_front_setback_ft"] + R["min_rear_setback_ft"] + MIN_BL
    if p["plot_w"] < min_w or p["plot_l"] < min_l:
        raise ValueError("Plot is too small for this demo. Use at least %d x %d ft." % (min_w, min_l))

    m = {"front": BASE_MARGIN, "rear": BASE_MARGIN, "left": BASE_MARGIN, "right": BASE_MARGIN}
    asm = _assemble(p, m, False, False)
    first, first_mt = evaluate(p, m, asm)
    initial_fails = [c["name"] for c in first if c["status"] == "fail"]
    log = []
    cur = {c["id"]: c for c in first}

    if cur["setback"]["status"] == "fail":
        m["front"] = max(m["front"], R["min_front_setback_ft"])
        m["rear"] = max(m["rear"], R["min_rear_setback_ft"])
        m["left"] = max(m["left"], R["min_side_setback_ft"])
        m["right"] = max(m["right"], R["min_side_setback_ft"])
        log.append("Setbacks raised to front %g ft, sides %g ft, rear %g ft to meet the minimums." % (m["front"], m["left"], m["rear"]))

    W, L = p["plot_w"], p["plot_l"]
    cov0 = _metrics(p, m)["coverage_pct"]
    start = dict(m)
    while _metrics(p, m)["coverage_pct"] > R["max_ground_coverage_pct"]:
        n = dict(m)
        n["left"] += 0.5
        n["right"] += 0.5
        n["rear"] += 0.5
        if (W - n["left"] - n["right"]) - STAIR_W < MIN_LEFT_W or L - n["front"] - n["rear"] < MIN_BL:
            break
        m = n
    if m != start:
        log.append("Ground coverage was %g%% (limit %g%%). Side and rear margins increased to %g ft, now %g%%." %
                   (cov0, R["max_ground_coverage_pct"], m["left"], _metrics(p, m)["coverage_pct"]))
    if cur["parking"]["status"] == "fail":
        p["parking"] = True
        log.append("Parking is required from %d floors, so the ground floor was changed to parking." % R["parking_required_from_floors"])

    asm = _assemble(p, m, False, False)
    checks, mt = evaluate(p, m, asm)

    cands = []
    for mirror in (False, True):
        for kb in (False, True):
            a = _assemble(p, m, mirror, kb)
            cands.append((vastu(a["floors"], p), a))
    cands.sort(key=lambda c: -c[0]["score"])
    variants = [{"id": i, "label": "Option %d" % (i + 1), "vastu": v, "floors": a["floors"], "cars": a["cars"],
                 "roof": a["roof"], "buildable": a["buildable"]} for i, (v, a) in enumerate(cands[:3])]

    return {
        "parsed": p, "plot": {"w": W, "l": L}, "margins": m,
        "rules": {"name": R["name"], "note": R["note"]},
        "initial": {"fails": initial_fails, "coverage": first_mt["coverage_pct"]},
        "autofix": log, "checks": checks, "metrics": mt,
        "cost": {"built_up_sqft": mt["built_up_sqft"], "rates": R["cost_per_sqft"], "note": R["cost_note"], "budget": p["budget"]},
        "variants": variants,
    }

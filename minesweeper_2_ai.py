# minesweeper_ai.py
"""
入力は盤面のスナップショットだけ:
    grid[r][c] = HIDDEN(-1)  未開封（旗は区別しない。人間の旗は間違っていることがある）
                 MINE(-2)    開封済みの地雷（踏んで続行したもの＝地雷と分かっている）
                 0〜8        開封済みの数字

推論の段階:
    1. 基本ルール     … 数字 − 既知の地雷 = 未確定マス数 → 全部地雷 / 0 → 全部安全
    2. 部分集合ルール … 制約Aが制約Bの部分集合なら、差の集合の地雷数も決まる（1-2-1など）
    3. 確率計算       … 制約でつながったマスの成分ごとに矛盾のない配置を全探索し、
                       残り地雷数を重みにして各マスの地雷確率を求める。
                       確率0/1のマスも確定として扱う。成分が大きすぎる場合だけ近似する。
"""
# analyze() は既定で全解析する（確定マスを漏れなく列挙し、全マスの地雷確率も出す）。
# analyze(..., prefer_safe=True) なら安全確定が見つかった時点で打ち切る（高速だが確定の一部しか返さない）。
from __future__ import annotations
import math
import random
import time
from collections import defaultdict, deque, namedtuple
from dataclasses import dataclass, field

HIDDEN = -1
MINE = -2

# 画面表示用の理由ラベル
REASON_LABELS = {
    "single": "基本",
    "subset": "組合せ",
    "enum": "列挙",
    "count": "残り地雷数",
}
_REASON_ORDER = {"single": 0, "subset": 1, "enum": 2, "count": 3}

PER_COMPONENT_NODES = 150_000   # 1成分の全探索ノード上限（超えたら近似）
TOTAL_NODES = 300_000           # 1回の解析全体のノード上限
MAX_COMPONENT_CELLS = 200       # これを超える成分は再帰が深くなるので最初から近似
CACHE_LIMIT = 4000

Move = namedtuple("Move", "cell kind reason prob")


@dataclass
class Analysis:
    rows: int
    cols: int
    safe: dict = field(default_factory=dict)     # セル -> 理由キー（安全確定）
    mines: dict = field(default_factory=dict)    # セル -> 理由キー（地雷確定）
    prob: dict = field(default_factory=dict)     # 未開封セル -> 地雷確率
    approx: set = field(default_factory=set)     # 近似で求めた確率のセル
    stats: dict = field(default_factory=dict)
    error: str | None = None
    first_cell: tuple[int, int] | None = None  # 同じ初期盤面では表示と操作で同じ初手を使う


class _Over(Exception):
    pass


_CACHE: dict = {}


def _neighbors(r, c, rows, cols):
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr or dc:
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols:
                    yield nr, nc


# -------------------------
# 制約の生成
# -------------------------
def _build_constraints(grid, rows, cols):
    """各数字から「未開封の隣接マスの集合 → その中の地雷数」を作る。矛盾があれば None。"""
    cons = {}
    for r in range(rows):
        for c in range(cols):
            v = grid[r][c]
            if v < 0:
                continue
            hidden = []
            mines = 0
            for nr, nc in _neighbors(r, c, rows, cols):
                g = grid[nr][nc]
                if g == HIDDEN:
                    hidden.append((nr, nc))
                elif g == MINE:
                    mines += 1
            need = v - mines
            if not hidden:
                if need != 0:
                    return None
                continue
            if need < 0 or need > len(hidden):
                return None
            if cons.setdefault(frozenset(hidden), need) != need:
                return None
    return cons


def _simplify(cur, known):
    """既知のマスを制約から取り除く。矛盾があれば None。cur: {cells: (need, derived)}"""
    out = {}
    for cells, (need, derived) in cur.items():
        if known and not known.keys().isdisjoint(cells):
            need -= sum(1 for c in cells if known.get(c))
            cells = frozenset(c for c in cells if c not in known)
            if not cells:
                if need != 0:
                    return None
                continue
        if need < 0 or need > len(cells):
            return None
        old = out.get(cells)
        if old is None:
            out[cells] = (need, derived)
        elif old[0] != need:
            return None
        elif old[1] and not derived:
            out[cells] = (need, False)
    return out


# -------------------------
# 段階1・2: 確定推論
# -------------------------
def _propagate(base, stop_when_safe=False):
    """基本ルールと部分集合ルールを不動点まで繰り返す。
    戻り値: (known{セル: 地雷ならTrue}, why{セル: 'single'|'subset'}) / 矛盾なら None"""
    cur = {cells: (need, False) for cells, need in base.items()}
    known, why = {}, {}
    for _ in range(300):
        cur = _simplify(cur, known)
        if cur is None:
            return None
        changed = False
        for cells, (need, derived) in cur.items():
            if need == 0:
                value = False
            elif need == len(cells):
                value = True
            else:
                continue
            tag = "subset" if derived else "single"
            for c in cells:
                if c not in known:
                    known[c] = value
                    why[c] = tag
                    changed = True
        if changed:
            if stop_when_safe and any(not value for value in known.values()):
                if _simplify(cur, known) is None:
                    return None
                return known, why
            continue

        by_cell = defaultdict(list)
        for cells in cur:
            for c in cells:
                by_cell[c].append(cells)
        new = {}
        for a, (na, _) in cur.items():
            pivot = min(a, key=lambda c: len(by_cell[c]))
            for b in by_cell[pivot]:
                if len(b) > len(a) and a < b:
                    diff = b - a
                    if diff not in cur and diff not in new:
                        new[diff] = (cur[b][0] - na, True)
        if not new or len(cur) > 6000:
            break
        cur.update(new)
    return known, why


# -------------------------
# 段階3: 全探索による確率
# -------------------------
def _bfs_order(cons):
    adj = defaultdict(set)
    for cells, _ in cons:
        for c in cells:
            adj[c] |= cells
    start = min(adj, key=lambda c: (len(adj[c]), c))
    order, seen, queue = [start], {start}, deque([start])
    while queue:
        cur = queue.popleft()
        for nb in sorted(adj[cur]):
            if nb not in seen:
                seen.add(nb)
                order.append(nb)
                queue.append(nb)
    return order


def _enumerate(n, icons, limit):
    """矛盾のない配置を全部数える。N[k]=地雷k個の配置数、cnt[k][i]=その中でセルiが地雷の数。"""
    cell_cons = [[] for _ in range(n)]
    need, free = [], []
    for ci, (idx, k) in enumerate(icons):
        need.append(k)
        free.append(len(idx))
        for i in idx:
            cell_cons[i].append(ci)
    N = [0] * (n + 1)
    cnt = {}
    chosen = []
    nodes = 0

    def rec(i, k):
        nonlocal nodes
        if i == n:
            N[k] += 1
            arr = cnt.get(k)
            if arr is None:
                arr = cnt[k] = [0] * n
            for j in chosen:
                arr[j] += 1
            return
        cc = cell_cons[i]
        for v in (0, 1):
            nodes += 1
            if nodes > limit:
                raise _Over
            for ci in cc:
                free[ci] -= 1
                need[ci] -= v
            ok = True
            for ci in cc:
                if need[ci] < 0 or need[ci] > free[ci]:
                    ok = False
                    break
            if ok:
                if v:
                    chosen.append(i)
                rec(i + 1, k + v)
                if v:
                    chosen.pop()
            for ci in cc:
                free[ci] += 1
                need[ci] += v

    rec(0, 0)
    return N, cnt, nodes


def _approx_entry(cells, cons):
    """全探索できない成分の近似。各マスの確率 = 所属する制約の count/size の平均。"""
    total, num = defaultdict(float), defaultdict(int)
    for cs, need in cons:
        q = need / len(cs)
        for cell in cs:
            total[cell] += q
            num[cell] += 1
    p = [total[cell] / num[cell] for cell in cells]
    k0 = max(0, min(len(cells), round(sum(p))))
    return {"cells": cells, "N": {k0: 1}, "cnt": None, "p": p}


def _solve_component(cons, limit):
    """戻り値: (entry, 使ったノード数, キャッシュしてよいか)"""
    cells = _bfs_order(cons)
    n = len(cells)
    if n > MAX_COMPONENT_CELLS:
        return _approx_entry(cells, cons), 0, True
    index = {c: i for i, c in enumerate(cells)}
    icons = [(tuple(index[c] for c in cs), need) for cs, need in cons]
    try:
        N, cnt, used = _enumerate(n, icons, limit)
    except _Over:
        return _approx_entry(cells, cons), limit, limit >= PER_COMPONENT_NODES
    entry = {"cells": cells, "N": {k: v for k, v in enumerate(N) if v},
             "cnt": cnt, "p": None}
    return entry, used, True


def _conv(a, b, cap):
    out = {}
    for i, x in a.items():
        for j, y in b.items():
            s = i + j
            if s <= cap:
                out[s] = out.get(s, 0) + x * y
    return out


def analyze(grid, total_mines, node_budget=TOTAL_NODES, prefer_safe=False):
    t0 = time.perf_counter()
    rows = len(grid)
    cols = len(grid[0]) if rows else 0
    result = Analysis(rows, cols)
    hidden = [(r, c) for r in range(rows) for c in range(cols) if grid[r][c] == HIDDEN]
    if not hidden:
        return result
    revealed_mines = sum(1 for row in grid for v in row if v == MINE)

    base = _build_constraints(grid, rows, cols)
    prop = _propagate(base, stop_when_safe=prefer_safe) if base is not None else None
    if prop is None:
        result.error = "盤面が矛盾しています"
        return result
    known, why = prop
    final = _simplify({cells: (need, False) for cells, need in base.items()}, known)
    if final is None:
        result.error = "盤面が矛盾しています"
        return result

    M = total_mines - revealed_mines - sum(1 for v in known.values() if v)
    unknown = [c for c in hidden if c not in known]
    if M < 0 or M > len(unknown):
        result.error = "地雷数が盤面と合いません"
        return result

    for c, is_mine in known.items():
        (result.mines if is_mine else result.safe)[c] = why[c]
        result.prob[c] = 1.0 if is_mine else 0.0

    # 残り地雷数だけで安全・地雷が決まる場合も、全探索せず処理する。
    if unknown and M in (0, len(unknown)):
        is_mine = M == len(unknown)
        if _simplify(final, {cell: is_mine for cell in unknown}) is None:
            result.error = "制約と残り地雷数が矛盾しています"
            return result
        for cell in unknown:
            (result.mines if is_mine else result.safe)[cell] = "count"
            result.prob[cell] = 1.0 if is_mine else 0.0

    # AIはマスを開く方式なので、安全確定があればまずそれを指す。
    # 未確定マスには推測の確率を付けず、全探索は次の必要な盤面まで行わない。
    if prefer_safe and (result.safe or not unknown or M in (0, len(unknown))):
        result.stats = {
            "phase": "certainty", "ms": (time.perf_counter() - t0) * 1000,
            "nodes": 0, "components": 0, "approx_components": 0,
            "remaining_mines": M,
            "uncomputed_cells": sum(cell not in result.prob for cell in hidden),
        }
        return result

    # --- 制約でつながった成分に分ける ---
    parent = {}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for cells in final:
        first = next(iter(cells))
        parent.setdefault(first, first)
        for c in cells:
            parent.setdefault(c, c)
            ra, rb = find(first), find(c)
            if ra != rb:
                parent[ra] = rb
    groups = defaultdict(list)
    for cells, (need, _) in final.items():
        groups[find(next(iter(cells)))].append((cells, need))

    entries = []
    nodes_total = 0
    for cons in groups.values():
        key = frozenset(cons)
        entry = _CACHE.get(key)
        if entry is None:
            limit = min(PER_COMPONENT_NODES, max(0, node_budget - nodes_total))
            entry, used, cacheable = _solve_component(cons, limit)
            nodes_total += used
            if cacheable:
                if len(_CACHE) >= CACHE_LIMIT:
                    _CACHE.clear()
                _CACHE[key] = entry
        entries.append(entry)

    frontier = set()
    for e in entries:
        frontier.update(e["cells"])
    free_cells = [c for c in unknown if c not in frontier]
    U = len(free_cells)

    # --- 全体の重み（残り地雷数との組合せ） ---
    cap = M
    choose = {m: math.comb(U, m) for m in range(0, min(M, U) + 1)}
    polys = [e["N"] for e in entries]
    count = len(polys)
    prefix = [{0: 1}]
    for p in polys:
        prefix.append(_conv(prefix[-1], p, cap))
    suffix = [None] * (count + 1)
    suffix[count] = {0: 1}
    for i in range(count - 1, -1, -1):
        suffix[i] = _conv(suffix[i + 1], polys[i], cap)
    F = prefix[count]
    T = sum(w * choose.get(M - j, 0) for j, w in F.items())
    # 近似成分の丸めた地雷総数は、他マスを確定する根拠に使わない。
    all_exact = all(e["p"] is None for e in entries)
    use_global = all_exact and T > 0
    if all_exact and T == 0:
        result.error = "制約と残り地雷数を満たす配置がありません"
        return result

    for i, e in enumerate(entries):
        cells = e["cells"]
        if e["p"] is not None:                       # 近似した成分
            for cell, q in zip(cells, e["p"]):
                result.prob[cell] = q
                result.approx.add(cell)
            continue
        weight = None
        if use_global:
            others = _conv(prefix[i], suffix[i + 1], cap)
            weight = {}
            for k in e["N"]:
                g = sum(w * choose.get(M - k - j, 0) for j, w in others.items())
                if g:
                    weight[k] = g
        if not weight:
            weight = {k: 1 for k in e["N"]}
        total = sum(e["N"][k] * g for k, g in weight.items())
        num = [0] * len(cells)
        for k, g in weight.items():
            arr = e["cnt"][k]
            for x, v in enumerate(arr):
                if v:
                    num[x] += v * g
        for cell, nu in zip(cells, num):
            if nu == 0:                      # 全配置で安全
                result.safe[cell] = "enum"
                result.prob[cell] = 0.0
            elif nu == total:                # 全配置で地雷
                result.mines[cell] = "enum"
                result.prob[cell] = 1.0
            else:
                result.prob[cell] = nu / total

    if free_cells:
        if use_global:
            E = sum(w * choose.get(M - j, 0) * (M - j) for j, w in F.items())
            if E == 0:
                for c in free_cells:
                    result.safe[c] = "count"
                    result.prob[c] = 0.0
            elif E == T * U:
                for c in free_cells:
                    result.mines[c] = "count"
                    result.prob[c] = 1.0
            else:
                for c in free_cells:
                    result.prob[c] = E / (T * U)
        else:
            expected = sum(result.prob.get(c, 0.0) for c in frontier)
            q = min(1.0, max(0.0, (M - expected) / U))
            for c in free_cells:
                # これは推定値。0/1の確定表示を避け、近似と明示する。
                result.prob[c] = min(1.0 - 1e-9, max(1e-9, q))
                result.approx.add(c)

    result.stats = {
        "phase": "probability",
        "ms": (time.perf_counter() - t0) * 1000,
        "nodes": nodes_total,
        "components": len(entries),
        "approx_components": sum(1 for e in entries if e["p"] is not None),
        "remaining_mines": M,
        "free_cells": U,
    }
    return result


def analysis_worker(connection):
    """盤面のスナップショットだけを受け取り、別プロセスで解析する。"""
    try:
        while True:
            message = connection.recv()
            if message is None:
                return
            token, grid, total_mines, options = message
            try:
                globals().update(options)
                result = analyze(grid, total_mines, node_budget=TOTAL_NODES)
            except Exception as error:
                result = Analysis(len(grid), len(grid[0]) if grid else 0,
                                  error=f"{type(error).__name__}: {error}")
            connection.send((token, result))
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


class AnalysisWorker:
    """Tkinter側から依頼・ポーリング・キャンセルするための窓口。"""
    def __init__(self):
        self.process = None
        self.connection = None
        self.token = 0
        self.pending = False
        self.shape = (0, 0)

    def close(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=0.2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=0.2)
            self.process.close()
        if self.connection is not None:
            self.connection.close()
        self.process = self.connection = None
        self.pending = False

    def request(self, grid, total_mines):
        if self.pending:
            self.close()
        if self.process is None:
            import multiprocessing
            ctx = multiprocessing.get_context("spawn")
            parent, child = ctx.Pipe()
            self.process = ctx.Process(target=analysis_worker, args=(child,), daemon=True)
            self.process.start()
            child.close()
            self.connection = parent
        self.token += 1
        self.pending = True
        self.shape = (len(grid), len(grid[0]) if grid else 0)
        options = {name: globals()[name] for name in (
            "PER_COMPONENT_NODES", "TOTAL_NODES", "MAX_COMPONENT_CELLS", "CACHE_LIMIT")}
        self.connection.send((self.token, grid, total_mines, options))

    def poll(self):
        if not self.pending:
            return None
        if not self.connection.poll():
            if self.process.is_alive():
                return None
            self.close()
            return Analysis(*self.shape, error="解析プロセスが終了しました。Resetで再試行できます")
        try:
            token, result = self.connection.recv()
        except (EOFError, OSError):
            self.close()
            return Analysis(*self.shape, error="解析結果を取得できませんでした")
        if token != self.token:
            return None
        self.pending = False
        return result



# -------------------------
# 次の一手
# -------------------------
def pick_move(grid, analysis, avoid=()):
    """次に開くマスを選ぶ。avoid（人間が旗を立てたマス）は、他に選択肢があれば避ける。"""
    if analysis.error:
        return None
    rows, cols = analysis.rows, analysis.cols
    hidden_count = sum(1 for row in grid for v in row if v == HIDDEN)
    if hidden_count == 0:
        return None
    if hidden_count == rows * cols:
        if analysis.first_cell is None:
            analysis.first_cell = (random.randrange(rows), random.randrange(cols))
        return Move(analysis.first_cell, "first", "first", None)
    avoid = set(avoid)

    if analysis.safe:
        cell, why = min(analysis.safe.items(),
                        key=lambda t: (t[0] in avoid, _REASON_ORDER[t[1]], t[0]))
        return Move(cell, "safe", why, 0.0)

    prob = analysis.prob
    candidates = [c for c in prob if c not in analysis.mines]
    pool = [c for c in candidates if c not in avoid] or candidates
    if not pool:
        return None

    def zero_chance(cell):
        chance = 1.0
        for nr, nc in _neighbors(cell[0], cell[1], rows, cols):
            g = grid[nr][nc]
            if g == MINE:
                return 0.0
            if g == HIDDEN:
                chance *= 1.0 - prob.get((nr, nc), 0.0)
        return chance

    cell = min(pool, key=lambda c: (round(prob[c], 9), -zero_chance(c), c))
    return Move(cell, "guess", "guess", prob[cell])

/* 既存の minesweeper_2_ai.py をPyodide内で実行する。Tkinter用のAnalysisWorkerは使わない。 */
const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';
let engine = null;
let ready = (async () => {
  try {
    importScripts(PYODIDE_BASE + 'pyodide.js');
    engine = await loadPyodide({indexURL: PYODIDE_BASE});
    const response = await fetch('./minesweeper_2_ai.py');
    if (!response.ok) throw new Error(`AIファイルの取得に失敗: ${response.status}`);
    engine.FS.writeFile('minesweeper_2_ai.py', await response.text());
    await engine.runPythonAsync('import minesweeper_2_ai as ai\nimport json');
    postMessage({type:'ready'});
  } catch (error) {
    postMessage({type:'error', message: String(error.message || error)});
    throw error;
  }
})();

onmessage = async ({data}) => {
  if (data.type !== 'analyze') return;
  const {id, board, mines, avoid} = data;
  try {
    await ready;
    engine.globals.set('js_payload', JSON.stringify({board, mines, avoid}));
    const resultJSON = await engine.runPythonAsync(`
request = json.loads(js_payload)
grid = request['board']
analysis = ai.analyze(grid, request['mines'])
move = ai.pick_move(grid, analysis, avoid={tuple(c) for c in request['avoid']})
json.dumps({
  'safe': [[r,c,why] for (r,c), why in analysis.safe.items()],
  'mines': [[r,c,why] for (r,c), why in analysis.mines.items()],
  'prob': [[r,c,p] for (r,c), p in analysis.prob.items()],
  'approx': [[r,c] for (r,c) in analysis.approx],
  'stats': analysis.stats,
  'error': analysis.error,
  'move': None if move is None else {'r': move.cell[0], 'c': move.cell[1],
     'kind': move.kind, 'reason': move.reason, 'prob': move.prob}
}, ensure_ascii=False)
`);
    postMessage({type:'result', id, result: JSON.parse(resultJSON)});
  } catch (error) {
    postMessage({type:'analysis-error', id, message:String(error.message || error)});
  }
};

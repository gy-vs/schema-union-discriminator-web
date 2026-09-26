import {useEffect, useState} from 'react';
import {FlaskConical, GitCompare, Play, Save} from 'lucide-react';

type Summary = {id: string; name: string; revision: number; updatedAt: string};
type Row = Summary & {content: string};

type Policy = 'reject' | 'passthrough';
type ValidationError = {path: string; message: string};
type UnionHop = {discriminator: string; branch: string};
type Counterexample = {
  kind: string;
  path: string;
  unionPath: UnionHop[];
  message: string;
  instance: unknown;
  proof: {
    validUnderOld: boolean;
    validUnderNew: boolean;
    oldErrors: ValidationError[];
    newErrors: ValidationError[];
  };
};
type DirectionReport = {
  direction: 'backward' | 'forward';
  compatible: boolean;
  findings: Array<{kind: string; path: string; unionPath: UnionHop[]; message: string}>;
  counterexample: Counterexample | null;
};
type CompareResult = {
  backward: DirectionReport;
  forward: DirectionReport;
  full: {compatible: boolean; requires: string[]};
  cache: {backward: 'hit' | 'miss'; forward: 'hit' | 'miss'; policy: Policy};
};

const BASELINE_SCHEMA = JSON.stringify(
  {
    kind: 'union',
    discriminator: 'type',
    branches: {
      circle: {
        kind: 'object',
        fields: {
          type: {kind: 'literal', value: 'circle'},
          radius: {kind: 'primitive', type: 'number'},
        },
      },
      rect: {
        kind: 'object',
        fields: {
          type: {kind: 'literal', value: 'rect'},
          width: {kind: 'primitive', type: 'number'},
          height: {kind: 'primitive', type: 'number'},
        },
      },
    },
    onUnknown: {mode: 'reject'},
  },
  null,
  2,
);

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<Row | null>(null);
  const [oldText, setOldText] = useState(BASELINE_SCHEMA);
  const [newText, setNewText] = useState('');
  const [policy, setPolicy] = useState<Policy>('reject');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Ready');

  useEffect(() => {
    fetch('/api/schemas')
      .then(r => r.json())
      .then(setItems);
  }, []);
  useEffect(() => {
    setStatus('Loading');
    fetch('/api/schemas/' + selected)
      .then(r => r.json())
      .then((value: Row) => {
        setRow(value);
        setNewText(value.content);
        setStatus('Loaded');
      });
  }, [selected]);

  async function save() {
    if (!row) return;
    setStatus('Saving');
    const response = await fetch('/api/schemas/' + row.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: newText, revision: row.revision}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus('Revision conflict');
      return;
    }
    setRow(value);
    setStatus('Saved');
  }

  async function analyze() {
    if (!row) return;
    setStatus('Analyzing');
    const response = await fetch('/api/schemas/' + row.id + '/analyze', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: newText}),
    });
    await response.json();
    setStatus('Ready');
  }

  async function compare() {
    setError(null);
    let oldSchema: unknown;
    let newSchema: unknown;
    try {
      oldSchema = JSON.parse(oldText);
      newSchema = JSON.parse(newText);
    } catch (parseError) {
      setError('JSON parse error: ' + (parseError as Error).message);
      return;
    }
    setStatus('Comparing');
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({oldSchema, newSchema, policy}),
    });
    const value = await response.json();
    if (!response.ok) {
      setError(value.message ?? value.error ?? 'compare failed');
      setStatus('Ready');
      return;
    }
    setResult(value as CompareResult);
    setStatus('Ready');
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Schema Evolution Studio</strong>
        <small>Discriminated union workbench</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Revisions</h2>
          <div className="list">
            {items.map(item => (
              <button
                className={item.id === selected ? 'active' : ''}
                onClick={() => setSelected(item.id)}
                key={item.id}
              >
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane editors">
          <div className="toolbar">
            <button className="primary" onClick={save}>
              <Save size={15} />
              Save new revision
            </button>
            <button onClick={analyze}>
              <Play size={15} />
              Analyze
            </button>
            <label className="policy">
              Default unknown-branch policy
              <select value={policy} onChange={e => setPolicy(e.target.value as Policy)}>
                <option value="reject">reject (closed)</option>
                <option value="passthrough">passthrough (open)</option>
              </select>
            </label>
            <button className="compare" onClick={compare}>
              <GitCompare size={15} />
              Compare
            </button>
            <span>{status}</span>
          </div>
          <label className="editor-label">Old schema (previous revision)</label>
          <textarea
            aria-label="Old schema"
            className="schema-editor"
            value={oldText}
            onChange={event => setOldText(event.target.value)}
          />
          <label className="editor-label">New schema (candidate revision)</label>
          <textarea
            aria-label="New schema"
            className="schema-editor"
            value={newText}
            onChange={event => setNewText(event.target.value)}
          />
        </section>

        <aside className="pane results">
          <h2>Compatibility</h2>
          {error && <div className="error">{error}</div>}
          {result && (
            <>
              <DirectionCard
                title="Backward"
                subtitle="new consumer reads old producer data (old ⊆ new)"
                report={result.backward}
                cached={result.cache.backward}
              />
              <DirectionCard
                title="Forward"
                subtitle="old consumer reads new producer data (new ⊆ old)"
                report={result.forward}
                cached={result.cache.forward}
              />
              <div className="card">
                <header>
                  <strong>Full</strong>
                  <span className={`badge ${result.full.compatible ? 'ok' : 'bad'}`}>
                    {result.full.compatible ? 'compatible' : 'incompatible'}
                  </span>
                </header>
                <p className="muted">
                  Derived independently from backward <strong>and</strong> forward — the two
                  directions are never folded into one boolean.
                </p>
              </div>
            </>
          )}
          {!result && !error && (
            <p className="muted">Edit the two schemas and press Compare.</p>
          )}
        </aside>
      </section>
    </main>
  );
}

function DirectionCard({
  title,
  subtitle,
  report,
  cached,
}: {
  title: string;
  subtitle: string;
  report: DirectionReport;
  cached: 'hit' | 'miss';
}) {
  const ce = report.counterexample;
  return (
    <div className="card">
      <header>
        <strong>{title}</strong>
        <span className={`badge ${report.compatible ? 'ok' : 'bad'}`}>
          {report.compatible ? 'compatible' : 'incompatible'}
        </span>
        <span className={`cache ${cached}`}>cache {cached}</span>
      </header>
      <p className="muted">{subtitle}</p>
      {ce && (
        <div className="counterexample">
          <div className="ce-head">
            Minimal counterexample at <code>{ce.path}</code>
          </div>
          {ce.unionPath.length > 0 && (
            <div className="chips">
              {ce.unionPath.map((hop, i) => (
                <span className="chip" key={i}>
                  {hop.discriminator}=<strong>{hop.branch}</strong>
                </span>
              ))}
            </div>
          )}
          <pre>{JSON.stringify(ce.instance, null, 2)}</pre>
          <div className="proof">
            <span className={ce.proof.validUnderOld ? 'accept' : 'reject'}>
              old validator: {ce.proof.validUnderOld ? 'accepts' : 'rejects'}
            </span>
            {!ce.proof.validUnderOld && <small>↳ {ce.proof.oldErrors[0]?.message}</small>}
            <span className={ce.proof.validUnderNew ? 'accept' : 'reject'}>
              new validator: {ce.proof.validUnderNew ? 'accepts' : 'rejects'}
            </span>
            {!ce.proof.validUnderNew && <small>↳ {ce.proof.newErrors[0]?.message}</small>}
          </div>
          <p className="finding-msg">{ce.message}</p>
        </div>
      )}
      {report.findings.length > 0 && (
        <ul className="findings">
          {report.findings.map((finding, i) => (
            <li key={i}>
              <code>{finding.kind}</code> {finding.message} <small>{finding.path}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

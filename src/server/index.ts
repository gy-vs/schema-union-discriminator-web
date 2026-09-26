import express from 'express';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  analyzeDirection,
  parseSchema,
  SchemaError,
  stableStringify,
  type Direction,
  type DirectionReport,
  type PolicyMode,
  type SchemaNode,
} from '../shared/schema.js';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};

// Seed rows hold real discriminated-union schemas so the workbench starts with a live example.
const rows: RecordRow[] = [
  {
    id: 'alpha',
    name: 'Shape union — v2 (added "triangle" branch)',
    revision: 3,
    content: JSON.stringify(
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
          triangle: {
            kind: 'object',
            fields: {
              type: {kind: 'literal', value: 'triangle'},
              base: {kind: 'primitive', type: 'number'},
              height: {kind: 'primitive', type: 'number'},
            },
          },
        },
        onUnknown: {mode: 'reject'},
      },
      null,
      2,
    ),
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'beta',
    name: 'Shape union — v3 (open union)',
    revision: 5,
    content: JSON.stringify(
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
              height: {kind: 'primitive', type: 'number', optional: true},
            },
          },
        },
        onUnknown: {mode: 'passthrough'},
      },
      null,
      2,
    ),
    updatedAt: new Date(1000).toISOString(),
  },
];

// Per-direction result cache. The key explicitly carries the compatibility
// direction and the unknown-branch policy, so neither can return a stale
// result computed for a different direction/policy.
const compareCache = new Map<string, DirectionReport>();

export function compareCacheKey(
  oldSchema: SchemaNode,
  newSchema: SchemaNode,
  direction: Direction,
  policy: PolicyMode,
): string {
  return createHash('sha256')
    .update(stableStringify({oldSchema, newSchema, direction, policy}))
    .digest('hex');
}

function getDirectionReport(
  oldSchema: SchemaNode,
  newSchema: SchemaNode,
  direction: Direction,
  policy: PolicyMode,
): {report: DirectionReport; cached: boolean} {
  const key = compareCacheKey(oldSchema, newSchema, direction, policy);
  const existing = compareCache.get(key);
  if (existing) return {report: existing, cached: true};
  const report = analyzeDirection(oldSchema, newSchema, direction, policy);
  compareCache.set(key, report);
  return {report, cached: false};
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'schema-evolution', count: rows.length}),
  );
  app.get('/api/schemas', (_req, res) =>
    res.json(rows.map(({content, ...row}) => row)),
  );
  app.get('/api/schemas/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/schemas/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision)
      return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/schemas/:id/analyze', async (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise(resolve => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({
      id: row.id,
      revision: row.revision,
      lines: String(req.body.content ?? row.content).split(/\r?\n/).length,
      diagnostics: [],
    });
  });

  app.post('/api/compare', (req, res) => {
    let oldSchema: SchemaNode;
    let newSchema: SchemaNode;
    try {
      oldSchema = parseSchema(req.body?.oldSchema, 'oldSchema');
      newSchema = parseSchema(req.body?.newSchema, 'newSchema');
    } catch (error) {
      const message = error instanceof SchemaError ? error.message : 'invalid schema';
      return res.status(400).json({error: 'invalid_schema', message});
    }
    const policy: PolicyMode = req.body?.policy === 'passthrough' ? 'passthrough' : 'reject';
    // Backward and forward are computed independently — never folded into one boolean.
    const backward = getDirectionReport(oldSchema, newSchema, 'backward', policy);
    const forward = getDirectionReport(oldSchema, newSchema, 'forward', policy);
    res.json({
      backward: backward.report,
      forward: forward.report,
      full: {
        compatible: backward.report.compatible && forward.report.compatible,
        requires: ['backward', 'forward'],
      },
      cache: {
        backward: backward.cached ? 'hit' : 'miss',
        forward: forward.cached ? 'hit' : 'miss',
        policy,
      },
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}

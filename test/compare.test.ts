import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp, compareCacheKey} from '../src/server/index';
import {parseSchema, validate, type SchemaNode} from '../src/shared/schema';

const app = createApp();

async function compare(oldSchema: unknown, newSchema: unknown, policy?: string) {
  const response = await request(app)
    .post('/api/compare')
    .send({oldSchema, newSchema, ...(policy ? {policy} : {})})
    .expect(200);
  return response.body;
}

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

const num = {kind: 'primitive', type: 'number'};
const str = {kind: 'primitive', type: 'string'};
const lit = (value: string) => ({kind: 'literal', value});
const obj = (fields: Record<string, unknown>, extra?: Record<string, unknown>) => ({
  kind: 'object',
  fields,
  ...extra,
});
const req = (schema: unknown) => ({schema});
const opt = (schema: unknown) => ({schema, optional: true});

const circleV1 = obj({type: req(lit('circle')), radius: req(num)});
const rectV1 = obj({type: req(lit('rect')), width: req(num), height: req(num)});
const triangle = obj({type: req(lit('triangle')), base: req(num), height: req(num)});

const shapeV1 = {
  kind: 'union',
  discriminator: 'type',
  branches: {circle: circleV1, rect: rectV1},
  onUnknown: {mode: 'reject'},
};

// ---------------------------------------------------------------------------
// Branch add / remove
// ---------------------------------------------------------------------------

describe('branch add/remove', () => {
  it('adding a branch: backward compatible, forward broken — old consumers reject the new value', async () => {
    const evolved = {...shapeV1, branches: {...shapeV1.branches, triangle}};
    const body = await compare(shapeV1, evolved);

    expect(body.backward.compatible).toBe(true);
    expect(body.backward.counterexample).toBeNull();

    expect(body.forward.compatible).toBe(false);
    const ce = body.forward.counterexample;
    expect(ce.kind).toBe('branch_missing');
    expect(ce.instance).toEqual({type: 'triangle', base: 0, height: 0});
    expect(ce.unionPath).toEqual([{discriminator: 'type', branch: 'triangle'}]);
    // Proven by the validators, not just asserted structurally.
    expect(ce.proof.validUnderNew).toBe(true);
    expect(ce.proof.validUnderOld).toBe(false);
    expect(ce.proof.oldErrors[0].message).toMatch(/unknown discriminator value/);

    expect(body.full.compatible).toBe(false);
  });

  it('removing a branch: forward compatible, backward broken', async () => {
    const shrunk = {kind: 'union', discriminator: 'type', branches: {circle: circleV1}};
    const body = await compare(shapeV1, shrunk);

    expect(body.forward.compatible).toBe(true);
    expect(body.backward.compatible).toBe(false);
    const ce = body.backward.counterexample;
    expect(ce.kind).toBe('branch_missing');
    expect(ce.instance).toEqual({type: 'rect', width: 0, height: 0});
    expect(ce.unionPath).toEqual([{discriminator: 'type', branch: 'rect'}]);
    expect(ce.proof.validUnderOld).toBe(true);
    expect(ce.proof.validUnderNew).toBe(false);
    expect(body.full.compatible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Discriminator value reuse: same value, changed payload shape
// ---------------------------------------------------------------------------

describe('discriminator value reuse', () => {
  it('reusing a value with a new required field breaks backward only', async () => {
    const circleV2 = obj({
      type: req(lit('circle')),
      radius: req(num),
      color: req(str),
    });
    const reused = {...shapeV1, branches: {...shapeV1.branches, circle: circleV2}};
    const body = await compare(shapeV1, reused);

    expect(body.backward.compatible).toBe(false);
    const ce = body.backward.counterexample;
    expect(ce.kind).toBe('field_now_required');
    expect(ce.path).toBe('$[type="circle"].color');
    expect(ce.instance).toEqual({type: 'circle', radius: 0});
    expect(ce.unionPath).toEqual([{discriminator: 'type', branch: 'circle'}]);
    expect(ce.proof.validUnderOld).toBe(true);
    expect(ce.proof.validUnderNew).toBe(false);

    expect(body.forward.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Field optionalization (required -> optional)
// ---------------------------------------------------------------------------

describe('field optionalization', () => {
  it('making a field optional: backward compatible, forward broken', async () => {
    const rectOpt = obj({type: req(lit('rect')), width: req(num), height: opt(num)});
    const evolved = {...shapeV1, branches: {...shapeV1.branches, rect: rectOpt}};
    const body = await compare(shapeV1, evolved);

    expect(body.backward.compatible).toBe(true);
    expect(body.forward.compatible).toBe(false);
    const ce = body.forward.counterexample;
    expect(ce.kind).toBe('field_now_required');
    expect(ce.instance).toEqual({type: 'rect', width: 0}); // height omitted
    expect(ce.proof.validUnderNew).toBe(true);
    expect(ce.proof.validUnderOld).toBe(false);
    expect(ce.proof.oldErrors[0].message).toMatch(/missing required field "height"/);
  });
});

// ---------------------------------------------------------------------------
// Nested unions
// ---------------------------------------------------------------------------

describe('nested unions', () => {
  const innerV1 = {
    kind: 'union',
    discriminator: 'kind',
    branches: {dot: obj({kind: req(lit('dot'))})},
    onUnknown: {mode: 'reject'},
  };
  const innerV2 = {
    kind: 'union',
    discriminator: 'kind',
    branches: {
      dot: obj({kind: req(lit('dot'))}),
      line: obj({kind: req(lit('line')), length: req(num)}),
    },
    onUnknown: {mode: 'reject'},
  };
  const outer = (inner: unknown) => ({
    kind: 'union',
    discriminator: 'type',
    branches: {
      shape: obj({type: req(lit('shape')), payload: req(inner)}),
    },
    onUnknown: {mode: 'reject'},
  });

  it('adding a branch to a nested union is reported with the full union path', async () => {
    const body = await compare(outer(innerV1), outer(innerV2));

    expect(body.backward.compatible).toBe(true);
    expect(body.forward.compatible).toBe(false);
    const ce = body.forward.counterexample;
    expect(ce.instance).toEqual({type: 'shape', payload: {kind: 'line', length: 0}});
    expect(ce.unionPath).toEqual([
      {discriminator: 'type', branch: 'shape'},
      {discriminator: 'kind', branch: 'line'},
    ]);
    expect(ce.path).toBe('$[type="shape"].payload[kind="line"]');
    expect(ce.proof.validUnderNew).toBe(true);
    expect(ce.proof.validUnderOld).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default branch
// ---------------------------------------------------------------------------

describe('default branch', () => {
  const withDefault = {
    kind: 'union',
    discriminator: 'type',
    branches: {
      circle: circleV1,
      other: obj({type: req(str), note: opt(str)}),
    },
    onUnknown: {mode: 'default', branch: 'other'},
  };
  const closed = {...withDefault, onUnknown: {mode: 'reject'}};

  it('validator routes unknown values to the default branch', () => {
    const schema = parseSchema(withDefault);
    expect(validate(schema, {type: 'mystery', note: 'x'})).toEqual([]);
    expect(validate(schema, {type: 'mystery'})).toEqual([]);
    expect(validate(schema, {type: 'mystery', note: 1}).length).toBeGreaterThan(0);
  });

  it('dropping the default branch for reject breaks backward with an unknown-value witness', async () => {
    const body = await compare(withDefault, closed);

    expect(body.backward.compatible).toBe(false);
    const ce = body.backward.counterexample;
    expect(ce.kind).toBe('unknown_value_rejected');
    expect(ce.instance).toEqual({type: '__unknown__'});
    expect(ce.proof.validUnderOld).toBe(true);
    expect(ce.proof.validUnderNew).toBe(false);
    expect(ce.proof.newErrors[0].message).toMatch(/unknown discriminator value/);

    expect(body.forward.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Open unions (passthrough)
// ---------------------------------------------------------------------------

describe('open unions', () => {
  const open = {...shapeV1, onUnknown: {mode: 'passthrough'}};

  it('closed -> open: backward compatible, forward broken (old consumers reject unknown values)', async () => {
    const body = await compare(shapeV1, open);

    expect(body.backward.compatible).toBe(true);
    expect(body.forward.compatible).toBe(false);
    const ce = body.forward.counterexample;
    expect(ce.kind).toBe('unknown_value_rejected');
    // Minimal witness: a missing discriminator is also an "unknown value" —
    // accepted by the open union, rejected by the closed one.
    expect(ce.instance).toEqual({});
    expect(ce.proof.validUnderNew).toBe(true);
    expect(ce.proof.validUnderOld).toBe(false);
    expect(ce.proof.oldErrors[0].message).toMatch(/missing discriminator field/);
  });

  it('open -> closed: backward broken, forward compatible', async () => {
    const body = await compare(open, shapeV1);

    expect(body.backward.compatible).toBe(false);
    expect(body.backward.counterexample.kind).toBe('unknown_value_rejected');
    expect(body.forward.compatible).toBe(true);
  });

  it('removing a branch from an open union stays fully compatible (passthrough absorbs it)', async () => {
    const openShrunk = {
      kind: 'union',
      discriminator: 'type',
      branches: {circle: circleV1},
      onUnknown: {mode: 'passthrough'},
    };
    const body = await compare(open, openShrunk);
    expect(body.backward.compatible).toBe(true);
    expect(body.forward.compatible).toBe(true);
    expect(body.full.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mapping order changes
// ---------------------------------------------------------------------------

describe('mapping order changes', () => {
  it('reordering branches/fields is fully compatible and hits the same cache entry', async () => {
    const reordered = {
      kind: 'union',
      discriminator: 'type',
      onUnknown: {mode: 'reject'},
      branches: {
        rect: obj({height: req(num), type: req(lit('rect')), width: req(num)}),
        circle: obj({radius: req(num), type: req(lit('circle'))}),
      },
    };
    const first = await compare(shapeV1, reordered);
    expect(first.full.compatible).toBe(true);
    expect(first.backward.findings).toEqual([]);
    expect(first.forward.findings).toEqual([]);
    expect(first.cache.backward).toBe('miss');

    // Same comparison again -> served from cache.
    const second = await compare(shapeV1, reordered);
    expect(second.cache.backward).toBe('hit');
    expect(second.cache.forward).toBe('hit');

    // Key order is irrelevant: the canonically ordered schema hits the same entry.
    const third = await compare(shapeV1, shapeV1);
    expect(third.cache.backward).toBe('hit');
    expect(third.full.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discriminator rename
// ---------------------------------------------------------------------------

describe('discriminator rename', () => {
  it('renaming the discriminator field breaks both directions and is reported as such', async () => {
    const renamed = {
      kind: 'union',
      discriminator: 'kind',
      branches: {
        circle: obj({kind: req(lit('circle')), radius: req(num)}),
        rect: obj({kind: req(lit('rect')), width: req(num), height: req(num)}),
      },
      onUnknown: {mode: 'reject'},
    };
    const body = await compare(shapeV1, renamed);

    expect(body.backward.compatible).toBe(false);
    expect(body.backward.counterexample.kind).toBe('discriminator_renamed');
    expect(body.backward.counterexample.instance).toEqual({type: 'circle', radius: 0});
    expect(body.backward.counterexample.proof.validUnderOld).toBe(true);
    expect(body.backward.counterexample.proof.validUnderNew).toBe(false);

    expect(body.forward.compatible).toBe(false);
    expect(body.forward.counterexample.kind).toBe('discriminator_renamed');
    expect(body.forward.counterexample.instance).toEqual({kind: 'circle', radius: 0});
    expect(body.full.compatible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cache keys carry direction and policy
// ---------------------------------------------------------------------------

describe('cache keys', () => {
  const oldS = parseSchema(shapeV1) as SchemaNode;
  const newS = parseSchema({...shapeV1, branches: {...shapeV1.branches, triangle}}) as SchemaNode;

  it('key includes direction and policy; mapping order does not change the key', () => {
    const backward = compareCacheKey(oldS, newS, 'backward', 'reject');
    const forward = compareCacheKey(oldS, newS, 'forward', 'reject');
    const otherPolicy = compareCacheKey(oldS, newS, 'backward', 'passthrough');
    expect(backward).not.toBe(forward);
    expect(backward).not.toBe(otherPolicy);

    const reordered = parseSchema({
      kind: 'union',
      discriminator: 'type',
      onUnknown: {mode: 'reject'},
      branches: {rect: rectV1, circle: circleV1},
    }) as SchemaNode;
    expect(compareCacheKey(reordered, newS, 'backward', 'reject')).toBe(backward);
  });

  it('a different policy misses the cache over HTTP', async () => {
    // A schema pair not exercised elsewhere in this file, so no earlier
    // request can have populated these cache entries.
    const evolved = {
      ...shapeV1,
      branches: {
        ...shapeV1.branches,
        pentagon: obj({type: req(lit('pentagon')), side: req(num)}),
      },
    };
    const first = await compare(shapeV1, evolved, 'passthrough');
    expect(first.cache.backward).toBe('miss');
    const second = await compare(shapeV1, evolved, 'passthrough');
    expect(second.cache.backward).toBe('hit');
    // Same schemas, different policy -> different key -> miss.
    const third = await compare(shapeV1, evolved, 'reject');
    expect(third.cache.backward).toBe('miss');
  });
});

// ---------------------------------------------------------------------------
// Counterexamples are proven by the real validators
// ---------------------------------------------------------------------------

describe('counterexample proof', () => {
  it('every reported counterexample re-validates exactly as the proof claims', async () => {
    const cases: Array<[unknown, unknown]> = [
      [shapeV1, {...shapeV1, branches: {...shapeV1.branches, triangle}}], // add branch
      [shapeV1, {kind: 'union', discriminator: 'type', branches: {circle: circleV1}}], // remove branch
      [
        shapeV1,
        {
          ...shapeV1,
          branches: {
            ...shapeV1.branches,
            rect: obj({type: req(lit('rect')), width: req(num), height: opt(num)}),
          },
        },
      ], // optionalize
      [{...shapeV1, onUnknown: {mode: 'passthrough'}}, shapeV1], // open -> closed
    ];
    for (const [oldRaw, newRaw] of cases) {
      const body = await compare(oldRaw, newRaw);
      const oldSchema = parseSchema(oldRaw);
      const newSchema = parseSchema(newRaw);
      for (const report of [body.backward, body.forward]) {
        const ce = report.counterexample;
        if (!ce) continue;
        // Re-run both validators on the reported instance: the proof must hold.
        expect(validate(oldSchema, ce.instance).length === 0).toBe(ce.proof.validUnderOld);
        expect(validate(newSchema, ce.instance).length === 0).toBe(ce.proof.validUnderNew);
        // And it must actually demonstrate a difference in this direction.
        if (report.direction === 'backward') {
          expect(ce.proof.validUnderOld).toBe(true);
          expect(ce.proof.validUnderNew).toBe(false);
          expect(ce.proof.newErrors.length).toBeGreaterThan(0);
        } else {
          expect(ce.proof.validUnderNew).toBe(true);
          expect(ce.proof.validUnderOld).toBe(false);
          expect(ce.proof.oldErrors.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('accepts bare schema nodes as object fields (shorthand form)', async () => {
    const bare = {
      kind: 'union',
      discriminator: 'type',
      branches: {
        circle: {
          kind: 'object',
          fields: {type: {kind: 'literal', value: 'circle'}, radius: {kind: 'primitive', type: 'number'}},
        },
      },
    };
    const body = await compare(bare, bare);
    expect(body.full.compatible).toBe(true);
  });

  it('rejects malformed schemas with 400', async () => {
    const response = await request(app)
      .post('/api/compare')
      .send({oldSchema: {kind: 'nope'}, newSchema: shapeV1})
      .expect(400);
    expect(response.body.error).toBe('invalid_schema');
    expect(response.body.message).toMatch(/unknown kind/);
  });

  it('rejects a default branch that does not exist', async () => {
    const bad = {...shapeV1, onUnknown: {mode: 'default', branch: 'ghost'}};
    const response = await request(app)
      .post('/api/compare')
      .send({oldSchema: shapeV1, newSchema: bad})
      .expect(400);
    expect(response.body.message).toMatch(/default branch/);
  });
});

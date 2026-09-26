// Shared schema model + bidirectional compatibility engine for discriminated unions.
// Used by both the server (/api/compare) and the client (types only).

export type PolicyMode = 'reject' | 'passthrough';

/** Unknown-branch strategy of a union: reject, open (passthrough), or route to a default branch. */
export type UnknownPolicy =
  | {mode: 'reject'}
  | {mode: 'passthrough'}
  | {mode: 'default'; branch: string};

export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';

export type SchemaNode =
  | {kind: 'primitive'; type: PrimitiveType}
  | {kind: 'literal'; value: unknown}
  | {kind: 'object'; fields: Record<string, ObjectField>; additional?: boolean}
  | {kind: 'array'; items: SchemaNode}
  | {
      kind: 'union';
      discriminator: string;
      branches: Record<string, SchemaNode>;
      onUnknown?: UnknownPolicy;
    };

export interface ObjectField {
  schema: SchemaNode;
  optional?: boolean;
}

type ObjectNode = Extract<SchemaNode, {kind: 'object'}>;
type UnionNode = Extract<SchemaNode, {kind: 'union'}>;

export class SchemaError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic stringify with sorted object keys: schema/branch order never changes the result. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map(key => JSON.stringify(key) + ':' + stableStringify(record[key]))
      .join(',') +
    '}'
  );
}

// ---------------------------------------------------------------------------
// Schema parsing / normalization (rejects malformed input, strips extra keys)
// ---------------------------------------------------------------------------

const PRIMITIVES: PrimitiveType[] = ['string', 'number', 'integer', 'boolean', 'null'];

export function parseSchema(input: unknown, path = 'schema'): SchemaNode {
  if (!isRecord(input)) throw new SchemaError(`${path}: expected an object with a "kind"`);
  switch (input.kind) {
    case 'primitive': {
      if (!PRIMITIVES.includes(input.type as PrimitiveType))
        throw new SchemaError(`${path}: unknown primitive type ${JSON.stringify(input.type)}`);
      return {kind: 'primitive', type: input.type as PrimitiveType};
    }
    case 'literal': {
      if (!('value' in input)) throw new SchemaError(`${path}: literal requires "value"`);
      return {kind: 'literal', value: input.value};
    }
    case 'object': {
      if (!isRecord(input.fields)) throw new SchemaError(`${path}: object requires "fields"`);
      const fields: Record<string, ObjectField> = {};
      for (const [name, raw] of Object.entries(input.fields)) {
        // Accept both the wrapped form {schema, optional?} and a bare schema node.
        if (isRecord(raw) && isRecord(raw.schema)) {
          fields[name] = {
            schema: parseSchema(raw.schema, `${path}.fields.${name}`),
            ...(raw.optional === true ? {optional: true} : {}),
          };
        } else {
          fields[name] = {schema: parseSchema(raw, `${path}.fields.${name}`)};
        }
      }
      return {
        kind: 'object',
        fields,
        ...(input.additional === false ? {additional: false} : {}),
      };
    }
    case 'array': {
      return {kind: 'array', items: parseSchema(input.items, `${path}.items`)};
    }
    case 'union': {
      if (typeof input.discriminator !== 'string' || input.discriminator.length === 0)
        throw new SchemaError(`${path}: union requires a non-empty "discriminator"`);
      if (!isRecord(input.branches))
        throw new SchemaError(`${path}: union requires a "branches" value mapping`);
      const branches: Record<string, SchemaNode> = {};
      for (const [value, raw] of Object.entries(input.branches))
        branches[value] = parseSchema(raw, `${path}.branches[${JSON.stringify(value)}]`);
      let onUnknown: UnknownPolicy | undefined;
      if (input.onUnknown !== undefined) {
        if (!isRecord(input.onUnknown)) throw new SchemaError(`${path}: invalid "onUnknown"`);
        if (input.onUnknown.mode === 'reject') onUnknown = {mode: 'reject'};
        else if (input.onUnknown.mode === 'passthrough') onUnknown = {mode: 'passthrough'};
        else if (input.onUnknown.mode === 'default') {
          if (typeof input.onUnknown.branch !== 'string' || !(input.onUnknown.branch in branches))
            throw new SchemaError(`${path}: default branch must name an existing branch`);
          onUnknown = {mode: 'default', branch: input.onUnknown.branch};
        } else throw new SchemaError(`${path}: unknown onUnknown mode`);
      }
      return {
        kind: 'union',
        discriminator: input.discriminator,
        branches,
        ...(onUnknown ? {onUnknown} : {}),
      };
    }
    default:
      throw new SchemaError(`${path}: unknown kind ${JSON.stringify(input.kind)}`);
  }
}

function resolvePolicy(node: UnionNode, fallback: PolicyMode): UnknownPolicy {
  return node.onUnknown ?? {mode: fallback};
}

function describePolicy(policy: UnknownPolicy): string {
  if (policy.mode === 'reject') return 'reject unknown values';
  if (policy.mode === 'passthrough') return 'accept any value (open union)';
  return `route unknown values to default branch "${policy.branch}"`;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface ValidationError {
  path: string;
  message: string;
}

export function validate(
  node: SchemaNode,
  instance: unknown,
  policy: PolicyMode = 'reject',
): ValidationError[] {
  const errors: ValidationError[] = [];
  walk(node, instance, '$', policy, errors);
  return errors;
}

function walk(
  node: SchemaNode,
  instance: unknown,
  path: string,
  policy: PolicyMode,
  errors: ValidationError[],
): void {
  const fail = (message: string): void => {
    errors.push({path, message});
  };
  switch (node.kind) {
    case 'primitive': {
      const ok =
        node.type === 'string'
          ? typeof instance === 'string'
          : node.type === 'boolean'
            ? typeof instance === 'boolean'
            : node.type === 'null'
              ? instance === null
              : node.type === 'integer'
                ? typeof instance === 'number' && Number.isInteger(instance)
                : typeof instance === 'number' && Number.isFinite(instance);
      if (!ok) fail(`expected ${node.type}, got ${JSON.stringify(instance)}`);
      return;
    }
    case 'literal': {
      if (stableStringify(instance) !== stableStringify(node.value))
        fail(`expected literal ${JSON.stringify(node.value)}, got ${JSON.stringify(instance)}`);
      return;
    }
    case 'object': {
      if (!isRecord(instance)) return fail(`expected object, got ${JSON.stringify(instance)}`);
      for (const [name, field] of Object.entries(node.fields)) {
        if (instance[name] === undefined) {
          if (!field.optional) fail(`missing required field "${name}"`);
        } else {
          walk(field.schema, instance[name], `${path}.${name}`, policy, errors);
        }
      }
      if (node.additional === false)
        for (const key of Object.keys(instance))
          if (!(key in node.fields)) fail(`additional property "${key}" is not allowed`);
      return;
    }
    case 'array': {
      if (!Array.isArray(instance)) return fail(`expected array, got ${JSON.stringify(instance)}`);
      instance.forEach((item, index) =>
        walk(node.items, item, `${path}[${index}]`, policy, errors),
      );
      return;
    }
    case 'union': {
      if (!isRecord(instance)) return fail(`expected object, got ${JSON.stringify(instance)}`);
      const discValue = instance[node.discriminator];
      const branch =
        typeof discValue === 'string' ? node.branches[discValue] : undefined;
      if (branch) {
        walk(branch, instance, `${path}[${node.discriminator}="${discValue}"]`, policy, errors);
        return;
      }
      const unknown = resolvePolicy(node, policy);
      if (unknown.mode === 'passthrough') return;
      if (unknown.mode === 'default') {
        const fallback = node.branches[unknown.branch];
        if (!fallback) return fail(`default branch "${unknown.branch}" does not exist`);
        walk(
          fallback,
          instance,
          `${path}[${node.discriminator}~default:${unknown.branch}]`,
          policy,
          errors,
        );
        return;
      }
      fail(
        discValue === undefined
          ? `missing discriminator field "${node.discriminator}"`
          : `unknown discriminator value ${JSON.stringify(discValue)} for "${node.discriminator}"`,
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal instance generation
// ---------------------------------------------------------------------------

export function minimalInstance(node: SchemaNode, policy: PolicyMode = 'reject'): unknown {
  switch (node.kind) {
    case 'primitive':
      return node.type === 'string'
        ? ''
        : node.type === 'boolean'
          ? false
          : node.type === 'null'
            ? null
            : 0;
    case 'literal':
      return node.value;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(node.fields))
        if (!field.optional) out[name] = minimalInstance(field.schema, policy);
      return out;
    }
    case 'union': {
      const values = Object.keys(node.branches).sort();
      if (values.length === 0) return {[node.discriminator]: '__unknown__'};
      const inner = minimalInstance(node.branches[values[0]], policy);
      return isRecord(inner)
        ? {...inner, [node.discriminator]: values[0]}
        : {[node.discriminator]: values[0]};
    }
  }
}

// ---------------------------------------------------------------------------
// Compatibility engine
// ---------------------------------------------------------------------------

export type Direction = 'backward' | 'forward';

export interface UnionHop {
  discriminator: string;
  branch: string;
}

export interface Finding {
  kind: string;
  path: string;
  unionPath: UnionHop[];
  message: string;
  instance: unknown;
}

export interface Proof {
  validUnderOld: boolean;
  validUnderNew: boolean;
  oldErrors: ValidationError[];
  newErrors: ValidationError[];
}

export interface Counterexample {
  kind: string;
  path: string;
  unionPath: UnionHop[];
  message: string;
  instance: unknown;
  proof: Proof;
}

export interface DirectionReport {
  direction: Direction;
  compatible: boolean;
  findings: Array<{kind: string; path: string; unionPath: UnionHop[]; message: string}>;
  counterexample: Counterexample | null;
}

interface Ctx {
  policy: PolicyMode;
  sourceLabel: 'old' | 'new';
  targetLabel: 'old' | 'new';
  path: string;
  unionPath: UnionHop[];
}

function mk(
  kind: string,
  ctx: Ctx,
  message: string,
  instance: unknown,
  path = ctx.path,
  unionPath = ctx.unionPath,
): Finding {
  return {kind, path, unionPath, message, instance};
}

function branchInstance(node: UnionNode, value: string, policy: PolicyMode): unknown {
  const inner = minimalInstance(node.branches[value], policy);
  return isRecord(inner) ? {...inner, [node.discriminator]: value} : {[node.discriminator]: value};
}

function unknownValue(a: UnionNode, b: UnionNode): string {
  let candidate = '__unknown__';
  while (candidate in a.branches || candidate in b.branches) candidate += '_';
  return candidate;
}

function freeKey(a: ObjectNode, b: ObjectNode): string {
  let candidate = '__extra__';
  while (candidate in a.fields || candidate in b.fields) candidate += '_';
  return candidate;
}

/**
 * Structural diff: returns candidate instances that are valid under `source`
 * but invalid under `target`. Callers must verify candidates with the real
 * validators (see analyzeDirection) — verification filters false positives.
 */
function compareNodes(source: SchemaNode, target: SchemaNode, ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  if (source.kind !== target.kind) {
    out.push(
      mk(
        'kind_changed',
        ctx,
        `node kind changed from "${source.kind}" to "${target.kind}"`,
        minimalInstance(source, ctx.policy),
      ),
    );
    return out;
  }
  switch (source.kind) {
    case 'primitive': {
      const t = target as Extract<SchemaNode, {kind: 'primitive'}>;
      const widened = source.type === 'integer' && t.type === 'number';
      if (source.type !== t.type && !widened) {
        const candidate =
          source.type === 'number' && t.type === 'integer'
            ? 0.5
            : minimalInstance(source, ctx.policy);
        out.push(
          mk('type_changed', ctx, `type changed from "${source.type}" to "${t.type}"`, candidate),
        );
      }
      return out;
    }
    case 'literal': {
      const t = target as Extract<SchemaNode, {kind: 'literal'}>;
      if (stableStringify(source.value) !== stableStringify(t.value))
        out.push(
          mk(
            'literal_changed',
            ctx,
            `literal ${JSON.stringify(source.value)} became ${JSON.stringify(t.value)}`,
            source.value,
          ),
        );
      return out;
    }
    case 'object': {
      const t = target as ObjectNode;
      const minimalSource = minimalInstance(source, ctx.policy) as Record<string, unknown>;
      // Field dropped while the target forbids additional properties.
      for (const [name, field] of Object.entries(source.fields)) {
        if (!(name in t.fields) && t.additional === false)
          out.push(
            mk(
              'field_not_allowed',
              ctx,
              `field "${name}" was removed and the ${ctx.targetLabel} object rejects additional properties`,
              {...minimalSource, [name]: minimalInstance(field.schema, ctx.policy)},
              `${ctx.path}.${name}`,
            ),
          );
      }
      // Field introduced as required by the target.
      for (const [name, field] of Object.entries(t.fields)) {
        if (!(name in source.fields) && !field.optional)
          out.push(
            mk(
              'field_now_required',
              ctx,
              `field "${name}" is required by the ${ctx.targetLabel} schema but unknown to the ${ctx.sourceLabel} schema`,
              minimalSource,
              `${ctx.path}.${name}`,
            ),
          );
      }
      // Open object became closed.
      if (source.additional !== false && t.additional === false)
        out.push(
          mk(
            'additional_rejected',
            ctx,
            `the ${ctx.targetLabel} object now rejects additional properties`,
            {...minimalSource, [freeKey(source, t)]: 0},
          ),
        );
      // Shared fields.
      for (const [name, sourceField] of Object.entries(source.fields)) {
        const targetField = t.fields[name];
        if (!targetField) continue;
        if (sourceField.optional && !targetField.optional)
          out.push(
            mk(
              'field_now_required',
              ctx,
              `field "${name}" became required in the ${ctx.targetLabel} schema`,
              minimalSource,
              `${ctx.path}.${name}`,
            ),
          );
        const inner = compareNodes(sourceField.schema, targetField.schema, {
          ...ctx,
          path: `${ctx.path}.${name}`,
        });
        for (const finding of inner)
          out.push({...finding, instance: {...minimalSource, [name]: finding.instance}});
      }
      return out;
    }
    case 'array': {
      const t = target as Extract<SchemaNode, {kind: 'array'}>;
      const inner = compareNodes(source.items, t.items, {...ctx, path: `${ctx.path}[0]`});
      for (const finding of inner) out.push({...finding, instance: [finding.instance]});
      return out;
    }
    case 'union': {
      const t = target as UnionNode;
      // The discriminator field itself is part of the contract: check it first.
      if (source.discriminator !== t.discriminator) {
        out.push(
          mk(
            'discriminator_renamed',
            ctx,
            `discriminator field renamed from "${source.discriminator}" to "${t.discriminator}"`,
            minimalInstance(source, ctx.policy),
          ),
        );
        return out;
      }
      const disc = source.discriminator;
      const sourcePolicy = resolvePolicy(source, ctx.policy);
      const targetPolicy = resolvePolicy(t, ctx.policy);
      // Discriminator values known to the source but not accepted by the target.
      for (const value of Object.keys(source.branches)) {
        if (!(value in t.branches)) {
          const hop: UnionHop = {discriminator: disc, branch: value};
          out.push(
            mk(
              'branch_missing',
              ctx,
              `branch "${value}" exists in the ${ctx.sourceLabel} union but the ${ctx.targetLabel} union does not accept discriminator value "${value}"`,
              branchInstance(source, value, ctx.policy),
              `${ctx.path}[${disc}="${value}"]`,
              [...ctx.unionPath, hop],
            ),
          );
        }
      }
      // Shared discriminator values: compare branch payloads recursively.
      for (const value of Object.keys(source.branches)) {
        if (!(value in t.branches)) continue;
        const hop: UnionHop = {discriminator: disc, branch: value};
        const inner = compareNodes(source.branches[value], t.branches[value], {
          ...ctx,
          path: `${ctx.path}[${disc}="${value}"]`,
          unionPath: [...ctx.unionPath, hop],
        });
        for (const finding of inner)
          out.push({
            ...finding,
            instance: isRecord(finding.instance)
              ? {...finding.instance, [disc]: value}
              : finding.instance,
          });
      }
      // Unknown-branch strategy: only the source can produce unknown-value instances.
      if (
        sourcePolicy.mode !== 'reject' &&
        stableStringify(sourcePolicy) !== stableStringify(targetPolicy)
      ) {
        const value = unknownValue(source, t);
        const candidates: unknown[] = [{[disc]: value}];
        if (sourcePolicy.mode === 'default') {
          const inner = minimalInstance(source.branches[sourcePolicy.branch], ctx.policy);
          candidates.unshift(
            isRecord(inner) ? {...inner, [disc]: value} : {[disc]: value},
          );
        }
        for (const candidate of candidates)
          out.push(
            mk(
              'unknown_value_rejected',
              ctx,
              `the ${ctx.sourceLabel} union is configured to ${describePolicy(sourcePolicy)} but the ${ctx.targetLabel} union is configured to ${describePolicy(targetPolicy)}`,
              candidate,
            ),
          );
      }
      return out;
    }
  }
}

/** Remove instance parts that are irrelevant to the witnessed difference. */
function shrink(
  instance: unknown,
  source: SchemaNode,
  target: SchemaNode,
  policy: PolicyMode,
): unknown {
  let current = instance;
  let changed = true;
  while (changed) {
    changed = false;
    if (isRecord(current)) {
      for (const key of Object.keys(current)) {
        const candidate = {...current};
        delete candidate[key];
        if (
          validate(source, candidate, policy).length === 0 &&
          validate(target, candidate, policy).length > 0
        ) {
          current = candidate;
          changed = true;
          break;
        }
      }
    }
  }
  return current;
}

const sizeOf = (value: unknown) => JSON.stringify(value)?.length ?? 0;

/**
 * One compatibility direction, proven by the real validators:
 *  - backward: every old instance must stay valid under the new schema (new consumer reads old data)
 *  - forward:  every new instance must stay valid under the old schema (old consumer reads new data)
 */
export function analyzeDirection(
  oldSchema: SchemaNode,
  newSchema: SchemaNode,
  direction: Direction,
  policy: PolicyMode = 'reject',
): DirectionReport {
  const source = direction === 'backward' ? oldSchema : newSchema;
  const target = direction === 'backward' ? newSchema : oldSchema;
  const ctx: Ctx = {
    policy,
    sourceLabel: direction === 'backward' ? 'old' : 'new',
    targetLabel: direction === 'backward' ? 'new' : 'old',
    path: '$',
    unionPath: [],
  };
  const verified: Counterexample[] = [];
  const seen = new Set<string>();
  for (const finding of compareNodes(source, target, ctx)) {
    const instance = shrink(finding.instance, source, target, policy);
    const dedupeKey = `${finding.kind}|${finding.path}|${stableStringify(instance)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const oldErrors = validate(oldSchema, instance, policy);
    const newErrors = validate(newSchema, instance, policy);
    const proof: Proof = {
      validUnderOld: oldErrors.length === 0,
      validUnderNew: newErrors.length === 0,
      oldErrors,
      newErrors,
    };
    const provesDifference =
      direction === 'backward'
        ? proof.validUnderOld && !proof.validUnderNew
        : proof.validUnderNew && !proof.validUnderOld;
    if (provesDifference)
      verified.push({...finding, instance, proof});
  }
  verified.sort(
    (a, b) =>
      sizeOf(a.instance) - sizeOf(b.instance) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  );
  return {
    direction,
    compatible: verified.length === 0,
    findings: verified.map(({kind, path, unionPath, message}) => ({kind, path, unionPath, message})),
    counterexample: verified[0] ?? null,
  };
}

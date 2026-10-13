// A small validator for the JSON Schema subset the MCP tools declare: type object/string/integer/array, properties,
// required, additionalProperties: false, minLength, maxLength, minimum, maximum, minItems, maxItems, items and enum.
// A node without a type, a type or keyword outside the subset, a keyword that does not apply to the type, and an
// additionalProperties that is not a boolean all fail closed. A reason names the property, never the offending value.

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (path, reason) => ({ ok: false, reason: `${path}: ${reason}` });
// The keywords each type accepts; any other keyword on a node fails closed. A node must declare one of these types.
const COMMON = ['type', 'enum', 'description', 'default'];
const KEYWORDS = {
  string: new Set([...COMMON, 'minLength', 'maxLength']),
  integer: new Set([...COMMON, 'minimum', 'maximum']),
  array: new Set([...COMMON, 'minItems', 'maxItems', 'items']),
  object: new Set([...COMMON, 'properties', 'required', 'additionalProperties']),
};

function codePoints(text) {
  let count = 0;
  for (const _ of text) count += 1; // eslint-disable-line no-unused-vars
  return count;
}

function check(schema, value, path) {
  if (!isObject(schema)) return fail(path, 'unsupported schema');
  if (typeof schema.type !== 'string' || !hasOwn(KEYWORDS, schema.type)) return fail(path, 'unsupported schema type');
  for (const key of Object.keys(schema)) if (!KEYWORDS[schema.type].has(key)) return fail(path, `unsupported schema keyword ${key}`);
  if (hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') return fail(path, 'unsupported schema keyword additionalProperties');
  if (hasOwn(schema, 'enum') && !(Array.isArray(schema.enum) && schema.enum.includes(value))) return fail(path, 'not one of the allowed values');
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return fail(path, 'must be a string');
      if (schema.minLength !== undefined || schema.maxLength !== undefined) {
        const length = codePoints(value);
        if (schema.minLength !== undefined && length < schema.minLength) return fail(path, `must have at least ${schema.minLength} characters`);
        if (schema.maxLength !== undefined && length > schema.maxLength) return fail(path, `must have at most ${schema.maxLength} characters`);
      }
      return { ok: true };
    }
    case 'integer': {
      if (!Number.isSafeInteger(value)) return fail(path, 'must be an integer');
      if (schema.minimum !== undefined && value < schema.minimum) return fail(path, `must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) return fail(path, `must be at most ${schema.maximum}`);
      return { ok: true };
    }
    case 'array': {
      if (!Array.isArray(value)) return fail(path, 'must be an array');
      if (schema.minItems !== undefined && value.length < schema.minItems) return fail(path, `must have at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return fail(path, `must have at most ${schema.maxItems} items`);
      if (schema.items !== undefined) {
        for (let i = 0; i < value.length; i += 1) {
          const result = check(schema.items, value[i], `${path}[${i}]`);
          if (!result.ok) return result;
        }
      }
      return { ok: true };
    }
    case 'object': {
      if (!isObject(value)) return fail(path, 'must be an object');
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!hasOwn(value, key)) return fail(path, `missing required property ${key}`);
      for (const key of Object.keys(value)) {
        if (hasOwn(properties, key)) {
          const result = check(properties[key], value[key], `${path}.${key}`);
          if (!result.ok) return result;
        } else if (schema.additionalProperties === false) {
          return fail(path, `unknown property ${key.length > 64 ? `${key.slice(0, 64)}...` : key}`);
        }
      }
      return { ok: true };
    }
    default:
      return fail(path, 'unsupported schema type');
  }
}

export function validate(schema, value) {
  return check(schema, value, 'arguments');
}

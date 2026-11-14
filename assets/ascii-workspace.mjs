import { asciiColumns, asciiRows } from './ascii-contract.mjs';
import { glyphs } from './ascii-image.js';

const updates = (axis, max) => ({ type: 'object', additionalProperties: false, required: ['updates'], properties: {
  updates: { type: 'array', minItems: 1, maxItems: max, items: { type: 'object', additionalProperties: false,
    required: [axis, 'text'], properties: { [axis]: { type: 'integer', minimum: 1, maximum: max }, text: { type: 'string', minLength: 1, maxLength: axis === 'row' ? asciiColumns : asciiRows, pattern: '^[ .,:;*oxO%#@]+$' } } } },
} });
const definition = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters, strict: true } });
export const asciiTools = [
  definition('create_grid', 'Create/reset a 75-column, 50-row ASCII workspace. Supply up to 50 initial row prefixes (0–75 glyphs each), or null for an empty grid. Unaddressed cells start as spaces. Calls in one response execute in listed order.', {
    type: 'object', additionalProperties: false, required: ['width', 'height', 'rows'], properties: {
      width: { type: 'integer', const: asciiColumns }, height: { type: 'integer', const: asciiRows },
      rows: { anyOf: [{ type: 'null' }, { type: 'array', maxItems: asciiRows, items: { type: 'string', maxLength: asciiColumns, pattern: '^[ .,:;*oxO%#@]*$' } }] },
    },
  }),
  definition('write_rows', 'Replace several rows in the existing workspace. Row numbers start at 1. Write 1–75 allowed glyphs starting at column 1. Unaddressed cells remain unchanged; rejected writes leave that row unchanged.', updates('row', asciiRows)),
  definition('write_columns', 'Replace several columns in the existing workspace. Column numbers start at 1. Write 1–50 allowed glyphs starting at row 1. Unaddressed cells remain unchanged; rejected writes leave that column unchanged.', updates('column', asciiColumns)),
  definition('submit_grid', 'Finish and publish the current workspace. All preceding operations in this response are applied first. No full-grid re-output is needed.', {
    type: 'object', additionalProperties: false, required: [], properties: {},
  }),
];

export const toolGuidance = 'Use the workspace as an editable draft. Establish the whole composition in create_grid with initial rows, or initialize it empty and batch many row/column writes. You do not need one call per row. Preserve successful sections and make targeted revisions instead of resetting progress. Read operation results and the workspace snapshot before revising. Use submit_grid when the composition is ready; a valid blank grid is not a successful drawing. Calls in one response execute in listed order, so create, edits, and submission can share a response.';

const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');

export function createWorkspace() {
  let rows = null, submitted = false;
  return {
    snapshot() { return rows?.slice() ?? null; },
    get submitted() { return submitted; },
    execute(name, args, detailed = true) {
      const failures = [], accepted = [];
      const fail = (message, details = {}) => failures.push({ ...details, message });
      if (name === 'create_grid') {
        if (!exactKeys(args, ['width', 'height', 'rows']) || args.width !== asciiColumns || args.height !== asciiRows) {
          fail('create_grid requires width 75, height 50, and rows (all 50 strings, or null).');
        } else if (args.rows === null) {
          rows = Array(asciiRows).fill(' '.repeat(asciiColumns)); submitted = false; accepted.push('create_grid');
        } else {
          if (!Array.isArray(args.rows) || args.rows.length > asciiRows) fail('Initial rows must be an array of at most 50 row prefixes, or null.');
          else {
            for (let i = 0; i < args.rows.length; i++) {
              const text = args.rows[i];
              if (typeof text !== 'string' || [...text].length > asciiColumns || [...text].some(char => !glyphs.includes(char))) {
                fail(`Initial row ${i + 1} must contain 0–75 allowed glyphs.`, { row: i + 1, actual: typeof text === 'string' ? [...text].length : null });
              }
            }
            if (!failures.length) {
              rows = Array(asciiRows).fill(' '.repeat(asciiColumns));
              args.rows.forEach((text, i) => { rows[i] = text + rows[i].slice(text.length); });
              submitted = false; accepted.push('create_grid');
            }
          }
        }
      } else if (name === 'submit_grid') {
        if (!exactKeys(args, [])) fail('submit_grid takes no arguments.');
        else if (!rows) fail('Create a grid before submitting.');
        else { submitted = true; accepted.push('submit_grid'); }
      } else if (name === 'write_rows' || name === 'write_columns') {
        const axis = name === 'write_rows' ? 'row' : 'column';
        const count = axis === 'row' ? asciiRows : asciiColumns;
        const length = axis === 'row' ? asciiColumns : asciiRows;
        if (!rows) fail('Create a grid before writing.');
        else if (!exactKeys(args, ['updates']) || !Array.isArray(args.updates) || !args.updates.length || args.updates.length > count) {
          fail(`Supply 1–${count} updates.`);
        } else {
          const seen = new Set();
          for (const update of args.updates) {
            if (!exactKeys(update, [axis, 'text']) || !Number.isInteger(update[axis]) || update[axis] < 1 || update[axis] > count) {
              fail(`Each update needs ${axis} (1–${count}) and text.`); continue;
            }
            const index = update[axis];
            if (seen.has(index)) { fail(`Duplicate ${axis} ${index}.`, { [axis]: index }); continue; }
            seen.add(index);
            const chars = typeof update.text === 'string' ? [...update.text] : [];
            if ((chars.length < 1 || chars.length > length) || chars.some(char => !glyphs.includes(char))) {
              fail(`${axis} ${index} requires 1–${length} allowed glyphs; received ${chars.length} characters.`, {
                [axis]: index, expected: length, actual: chars.length,
                invalid: chars.flatMap((character, i) => glyphs.includes(character) ? [] : [{ position: i + 1, character }]),
              }); continue;
            }
            if (axis === 'row') rows[index - 1] = update.text + rows[index - 1].slice(chars.length);
            else rows = rows.map((row, i) => i < chars.length ? row.slice(0, index - 1) + chars[i] + row.slice(index) : row);
            submitted = false; accepted.push(index);
          }
        }
      } else fail('Unknown tool.');
      return { ok: failures.length === 0, accepted, rejected: detailed ? failures : failures.map(() => ({ message: 'Rejected.' })), submitted, rows: rows?.slice() ?? null };
    },
  };
}

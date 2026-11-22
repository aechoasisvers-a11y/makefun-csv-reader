// A faster drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
//
// Returns exactly csv-reader's answer for every input {text, header}:
// {columns, rows, errors}. The policy is csv-reader's own (see the kit's
// baseline/csv-reader/vendor/csv-reader/index.js):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character, and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded with "" (short_row) or cut (long_row) to the
//     first record's width; each error is {code, line, row}, in the order met.
//
// Speed: the reference reads one character at a time, building each field a
// character at a time. This one jumps between delimiters with indexOf and
// copies whole fields with slice, so a plain field costs one bounded scan and
// one copy. Only the rare broken pieces (a stray CR, a quoted field holding a
// line break) take a second pass. Node 22 stdlib only; no clock, no randomness,
// no I/O, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // A quoted field's segment with its line breaks read as LF: [text, breaks].
  // Most segments hold no line break at all and pass through untouched.
  function normalizeSegment(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') === -1) return [seg, 0];
      let breaks = 0;
      let at = -1;
      while ((at = seg.indexOf('\n', at + 1)) !== -1) breaks += 1;
      return [seg, breaks];
    }
    let breaks = 0;
    const out = seg.replace(/\r\n?|\n/g, () => {
      breaks += 1;
      return '\n';
    });
    return [out, breaks];
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how
  // it ended; `added` counts the characters kept. Every scan stays inside the
  // field: the next comma is found first, and a line break or stray CR is
  // looked for only within that one segment, never further down the text.
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      let i = text.indexOf(',', pos);
      let end;
      if (i === -1) {
        const j = text.indexOf('\n', pos);
        end = j === -1 ? n : j;
      } else {
        end = i;
      }
      const seg = text.slice(pos, end);
      const lf = seg.indexOf('\n');
      const cr = seg.indexOf('\r');
      if (lf === -1 && cr === -1) {
        value += seg;
        added += seg.length;
        if (end === n) {
          pos = n;
          return { value, ended: END, added };
        }
        if (text.charCodeAt(end) === 44) {
          pos = end + 1;
          return { value, ended: COMMA, added };
        }
        pos = end + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (lf !== -1 && (cr === -1 || lf < cr)) {
        // The field ends at this LF.
        value += seg.slice(0, lf);
        added += lf;
        pos += lf + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // The first CR comes before any LF in the segment.
      if ((cr + 1 < seg.length && seg.charCodeAt(cr + 1) === 10) || (cr === seg.length - 1 && text.charCodeAt(end) === 10)) {
        // A CRLF ends the line: the CR is part of the break, not the field.
        value += seg.slice(0, cr);
        added += cr;
        pos += cr + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      error('stray_cr');
      value += seg.slice(0, cr);
      added += cr;
      pos += cr + 1;
    }
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const parts = [];
    let breaks = 0;
    pos += 1;
    let segStart = pos;
    while (true) {
      const i = text.indexOf('"', pos);
      if (i === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(i + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        const seg = normalizeSegment(text.slice(segStart, i));
        parts.push(seg[0]);
        parts.push('"');
        breaks += seg[1];
        pos = i + 2;
        segStart = pos;
        continue;
      }
      const seg = normalizeSegment(text.slice(segStart, i));
      parts.push(seg[0]);
      breaks += seg[1];
      pos = i + 1;
      break;
    }
    const value = parts.join('');
    line += breaks;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields;

    // Fast path: a record holding no quoted field and no stray CR. Its fields
    // are one native split, and it ends at its line break. Anything else
    // (a quote, a stray CR, the unterminated tail) takes the field-by-field
    // reader below, which is the exact policy.
    const eol = text.indexOf('\n', pos);
    const recEnd = eol === -1 ? n : eol;
    let effEnd = recEnd;
    // A CR just before the line break is the CRLF's, not a stray one; a CR
    // at the end of the text is stray, so it is only stripped with a LF after it.
    if (eol !== -1 && effEnd > pos && text.charCodeAt(effEnd - 1) === 13) effEnd -= 1;
    const seg = text.slice(pos, effEnd);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      fields = seg.split(',');
      pos = eol === -1 ? n : eol + 1;
      if (eol !== -1) line += 1;
    }
    if (fields === undefined) {
      let field;
      let quoted;
      fields = [];
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

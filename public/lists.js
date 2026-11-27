// Lists in the message boxes. A textarea can't indent one line, so a list line carries its indent as characters:
// typing "- " or "1. " at the start of a line puts two figure spaces (U+2007) before it. Only the box writes them, so
// plainLists() can take them off before sending without touching pasted text, and the message stays plain Markdown.
// Shift+Enter continues the list, Shift+Enter on an empty item ends it (or moves a nested one out), Tab nests an item
// under the one above it and Shift+Tab moves it out. Nesting is real spaces, the width of the parent's marker, so the
// sent Markdown nests too.
(function () {
  const BASE = "  "; // a figure space is a digit wide: two read as a list's indent
  const ITEM = /^( *)( *)([-*+]|\d+[.)])( +)(.*)$/;
  const FENCE = /^\s*```/;

  function parse(line) {
    const m = line.match(ITEM);
    return m && { box: m[1], nest: m[2], marker: m[3], gap: m[4], rest: m[5], head: m[1].length + m[2].length + m[3].length + m[4].length };
  }
  const numbered = (marker) => /^\d/.test(marker);
  const nextMarker = (marker) => (numbered(marker) ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker);
  const firstMarker = (marker) => (numbered(marker) ? `1${marker.slice(-1)}` : marker);

  // The line around the caret: where it starts and ends.
  function lineAt(value, pos) {
    const start = value.lastIndexOf("\n", pos - 1) + 1;
    const nl = value.indexOf("\n", pos);
    return { start, end: nl < 0 ? value.length : nl };
  }

  // The items of the same list above a line, nearest first. A blank line or unindented text ends the list.
  function itemsAbove(value, start) {
    const lines = value.slice(0, start).split("\n");
    lines.pop();
    const out = [];
    for (let k = lines.length - 1; k >= 0; k--) {
      const it = parse(lines[k]);
      if (it) out.push(it);
      else if (!/^[  ]+\S/.test(lines[k])) break;
    }
    return out;
  }

  const inFence = (value, start) => value.slice(0, start).split("\n").filter((l) => FENCE.test(l)).length % 2 === 1;

  // Replaces the item's bullet (indent, marker and gap) with a new one, keeping the caret on the same text.
  function rehead(start, selStart, it, head) {
    return { from: start, to: start + it.head, text: head, caret: Math.max(start + head.length, selStart - it.head + head.length) };
  }

  // Moves an item out a level: it becomes the next sibling of its parent, numbered after it.
  function outdent(value, start, selStart, it) {
    const parent = itemsAbove(value, start).find((a) => a.nest.length < it.nest.length);
    const head = parent ? `${parent.box}${parent.nest}${nextMarker(parent.marker)} ` : `${it.box}${it.marker} `;
    return rehead(start, selStart, it, head);
  }

  // Moves an item in under the item above it at its level. null when there's none (the first item can't nest).
  function indent(value, start, selStart, it) {
    const above = itemsAbove(value, start);
    let sibling = null, child = null;
    for (const a of above) {
      if (a.nest.length < it.nest.length) break;
      if (a.nest.length === it.nest.length) {
        sibling = a;
        break;
      }
      child ??= a;
    }
    if (!sibling) return null;
    const nest = sibling.nest + " ".repeat(sibling.marker.length + sibling.gap.length);
    // A numbered item starts the sub-list at 1, or follows an item already at that level.
    const prev = child && child.nest === nest ? child : null;
    const marker = !numbered(it.marker) ? it.marker : prev && numbered(prev.marker) ? nextMarker(prev.marker) : firstMarker(it.marker);
    return rehead(start, selStart, it, `${it.box}${nest}${marker} `);
  }

  // The edit a key makes on a list line, or null when the key does what it usually does. An edit replaces
  // value[from, to) with text and puts the caret at caret.
  function listEdit(value, selStart, selEnd, key, shift) {
    if (selStart !== selEnd) return null;
    const { start, end } = lineAt(value, selStart);
    const it = parse(value.slice(start, end));
    if (!it) return null;
    if (key === "Enter" && shift) {
      if (!it.rest.trim()) {
        // An empty item: a nested one moves out a level, a top one loses its bullet and ends the list.
        if (it.nest) return outdent(value, start, selStart, it);
        return { from: start, to: end, text: "", caret: start };
      }
      if (selStart < start + it.head) return null; // the caret is before the bullet
      const text = `\n${it.box}${it.nest}${nextMarker(it.marker)} `;
      return { from: selStart, to: selStart, text, caret: selStart + text.length };
    }
    // Tab and Shift+Tab fall through (and move focus) when there's nothing to do, so the box never traps the keyboard.
    if (key === "Tab" && !shift) return indent(value, start, selStart, it);
    if (key === "Tab" && shift) return it.nest ? outdent(value, start, selStart, it) : null;
    return null;
  }

  // After a typed space: "- " or "1. " alone at the start of a line, outside a code block, becomes a list item.
  function bulletEdit(value, caret) {
    const { start } = lineAt(value, caret);
    if (!/^([-*+]|\d+[.)]) $/.test(value.slice(start, caret)) || inFence(value, start)) return null;
    return { from: start, to: start, text: BASE, caret: caret + BASE.length };
  }

  // The message as sent: the figure spaces the box put before list lines come off. Code blocks are left as they are.
  function plainLists(text) {
    let fenced = false;
    return text
      .split("\n")
      .map((l) => {
        if (FENCE.test(l)) fenced = !fenced;
        return fenced ? l : l.replace(/^ +/, "");
      })
      .join("\n");
  }

  // Applies an edit through execCommand where it works, so Cmd+Z undoes it; setRangeText otherwise.
  function apply(field, edit) {
    field.focus();
    field.setSelectionRange(edit.from, edit.to);
    const done = edit.text ? document.execCommand("insertText", false, edit.text) : document.execCommand("delete");
    if (!done) {
      field.setRangeText(edit.text, edit.from, edit.to, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    field.setSelectionRange(edit.caret, edit.caret);
  }

  window.composerLists = {
    listEdit,
    bulletEdit,
    plainLists,
    // Whether the text starts with a list item (after blank lines).
    startsWithItem: (text) => !!parse(text.replace(/^(?:[ \t ]*\n)+/, "").split("\n")[0]),
    // A keydown on a message box: true when it was a list key and is handled. keyCode 229 is a key that an input
    // method (Japanese, say) is still using; Safari can send it with isComposing false.
    onKey(e, field) {
      if (e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return false;
      const edit = listEdit(field.value, field.selectionStart, field.selectionEnd, e.key, e.shiftKey);
      if (!edit) return false;
      e.preventDefault();
      apply(field, edit);
      return true;
    },
    // An input event on a message box.
    onInput(e, field) {
      if (e.inputType !== "insertText" || e.data !== " " || field.selectionStart !== field.selectionEnd) return;
      const edit = bulletEdit(field.value, field.selectionStart);
      if (edit) apply(field, edit);
    },
  };
})();

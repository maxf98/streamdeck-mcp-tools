/**
 * Apple Reminders — manage reminders via AppleScript
 *
 * Tools: list_lists, list_reminders, create_reminder, complete_reminder,
 *        uncomplete_reminder, delete_reminder, search_reminders
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const server = new McpServer({ name: 'apple_reminders', version: '1.0.0' });

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function as(script, timeoutMs = 30000) {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    const msg = err?.stderr?.trim() ?? err?.message ?? String(err);
    throw new Error(msg || 'AppleScript error');
  }
}

/**
 * "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" → { year, month, day, hour, minute }
 * Used to build locale-safe component-based date setting in AppleScript.
 */
function parseDateStr(dateStr) {
  let date, time;
  if (dateStr.includes(' ')) {
    [date, time] = dateStr.split(' ');
  } else {
    date = dateStr;
    time = '09:00';
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) {
    throw new Error(`Invalid date: "${dateStr}". Use "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".`);
  }
  return { year, month, day, hour, minute };
}

/** Build an AppleScript fragment (to embed inside a tell block) that sets _d to the given date. */
function asDateBlock({ year, month, day, hour, minute }) {
  return `set _d to current date
    set year of _d to ${year}
    set month of _d to ${month}
    set day of _d to ${day}
    set hours of _d to ${hour}
    set minutes of _d to ${minute}
    set seconds of _d to 0`;
}

function parseReminders(raw) {
  return raw.split('|||').filter(Boolean).map(entry => {
    const parts = entry.split(':::');
    return {
      name:      parts[0] ?? '',
      id:        parts[1] ?? '',
      list_name: parts[2] ?? '',
      due_date:  parts[3] ?? '',
      completed: parts[4] === 'true',
      priority:  parseInt(parts[5]) || 0,
      notes:     parts[6] ?? '',
    };
  });
}

// ── tools ─────────────────────────────────────────────────────────────────────

server.registerTool('list_lists', {
  description: 'List all reminder lists in Apple Reminders. Returns [{name, id, reminder_count}].',
  inputSchema: {},
}, async () => {
  const raw = await as(`
tell application "Reminders"
  set output to ""
  repeat with l in every list
    set output to output & (name of l) & ":::" & (id of l) & ":::" & (count of reminders of l) & "|||"
  end repeat
  return output
end tell`);
  const lists = raw.split('|||').filter(Boolean).map(entry => {
    const [name, id, count] = entry.split(':::');
    return { name, id, reminder_count: parseInt(count) || 0 };
  });
  return { content: [{ type: 'text', text: JSON.stringify({ count: lists.length, lists }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('list_reminders', {
  description: 'List reminders, optionally filtered by list. Returns [{name, id, list_name, due_date, completed, priority, notes}].',
  inputSchema: {
    list_name:         z.string().default('').describe('List name to filter by (empty = all lists)'),
    include_completed: z.boolean().default(false).describe('Include completed reminders'),
    limit:             z.number().default(50).describe('Maximum number to return'),
  },
}, async ({ list_name, include_completed, limit }) => {
  const completedClause = include_completed ? '' : 'whose completed is false';
  let script;
  if (list_name) {
    script = `
tell application "Reminders"
  set output to ""
  set n to 0
  try
    set l to first list whose name is "${esc(list_name)}"
    repeat with r in (every reminder of l ${completedClause})
      if n >= ${limit} then exit repeat
      try
        set rDue to due date of r as text
      on error
        set rDue to ""
      end try
      try
        set rNotes to body of r
        if rNotes is missing value then set rNotes to ""
      on error
        set rNotes to ""
      end try
      set output to output & (name of r) & ":::" & (id of r) & ":::${esc(list_name)}:::" & rDue & ":::" & (completed of r as text) & ":::" & (priority of r as text) & ":::" & rNotes & "|||"
      set n to n + 1
    end repeat
  end try
  return output
end tell`;
  } else {
    script = `
tell application "Reminders"
  set output to ""
  set n to 0
  repeat with l in every list
    set lname to name of l
    repeat with r in (every reminder of l ${completedClause})
      if n >= ${limit} then exit repeat
      try
        set rDue to due date of r as text
      on error
        set rDue to ""
      end try
      try
        set rNotes to body of r
        if rNotes is missing value then set rNotes to ""
      on error
        set rNotes to ""
      end try
      set output to output & (name of r) & ":::" & (id of r) & ":::" & lname & ":::" & rDue & ":::" & (completed of r as text) & ":::" & (priority of r as text) & ":::" & rNotes & "|||"
      set n to n + 1
    end repeat
    if n >= ${limit} then exit repeat
  end repeat
  return output
end tell`;
  }
  const raw = await as(script, 60000);
  const reminders = parseReminders(raw);
  return { content: [{ type: 'text', text: JSON.stringify({ count: reminders.length, reminders }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('create_reminder', {
  description: 'Create a new reminder in Apple Reminders. Returns {id, name, list_name}.',
  inputSchema: {
    name:      z.string().describe('Reminder title'),
    list_name: z.string().default('Reminders').describe('List to add to (default: "Reminders")'),
    due_date:  z.string().default('').describe('Due date: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (optional)'),
    notes:     z.string().default('').describe('Additional notes (optional)'),
    priority:  z.number().min(0).max(9).default(0).describe('Priority: 0=none, 1=high, 5=medium, 9=low'),
  },
}, async ({ name, list_name, due_date, notes, priority }) => {
  let dueDateBlock = '';
  if (due_date) {
    try {
      const parts = parseDateStr(due_date);
      dueDateBlock = `\n    ${asDateBlock(parts)}\n    set due date of r to _d`;
    } catch (e) { throw new Error(e.message); }
  }

  const raw = await as(`
tell application "Reminders"
  try
    set l to first list whose name is "${esc(list_name)}"
    set r to make new reminder at l with properties {name:"${esc(name)}", priority:${priority}${notes ? `, body:"${esc(notes)}"` : ''}}${dueDateBlock}
    return (name of r) & ":::" & (id of r)
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  const [rName, id] = raw.split(':::');
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, name: rName, list_name }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('complete_reminder', {
  description: 'Mark a reminder as completed.',
  inputSchema: {
    name:      z.string().describe('Reminder title (exact or partial match)'),
    list_name: z.string().default('').describe('List name to narrow search (optional)'),
  },
}, async ({ name, list_name }) => {
  const findExpr = list_name
    ? `first reminder of (first list whose name is "${esc(list_name)}") whose name contains "${esc(name)}"`
    : `first reminder whose name contains "${esc(name)}"`;
  const raw = await as(`
tell application "Reminders"
  try
    set r to ${findExpr}
    set completed of r to true
    return name of r
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, completed: raw }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('uncomplete_reminder', {
  description: 'Mark a completed reminder as incomplete.',
  inputSchema: {
    name:      z.string().describe('Reminder title (exact or partial match)'),
    list_name: z.string().default('').describe('List name to narrow search (optional)'),
  },
}, async ({ name, list_name }) => {
  const findExpr = list_name
    ? `first reminder of (first list whose name is "${esc(list_name)}") whose (name contains "${esc(name)}" and completed is true)`
    : `first reminder whose (name contains "${esc(name)}" and completed is true)`;
  const raw = await as(`
tell application "Reminders"
  try
    set r to ${findExpr}
    set completed of r to false
    return name of r
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, uncompleted: raw }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('delete_reminder', {
  description: 'Delete a reminder by name. This is permanent.',
  inputSchema: {
    name:      z.string().describe('Reminder title (exact or partial match)'),
    list_name: z.string().default('').describe('List name to narrow search (optional)'),
  },
}, async ({ name, list_name }) => {
  const findExpr = list_name
    ? `first reminder of (first list whose name is "${esc(list_name)}") whose name contains "${esc(name)}"`
    : `first reminder whose name contains "${esc(name)}"`;
  const raw = await as(`
tell application "Reminders"
  try
    set r to ${findExpr}
    set rName to name of r
    delete r
    return rName
  on error e
    return "ERROR:::" & e
  end try
end tell`);
  if (raw.startsWith('ERROR:::')) throw new Error(raw.slice(8));
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, deleted: raw }) }] };
});

// ─────────────────────────────────────────────────────────────────────────────

server.registerTool('search_reminders', {
  description: 'Search reminders by name or notes across all lists.',
  inputSchema: {
    query: z.string().describe('Substring to match in reminder name or notes'),
    limit: z.number().default(20).describe('Maximum number of results'),
  },
}, async ({ query, limit }) => {
  const raw = await as(`
tell application "Reminders"
  set output to ""
  set n to 0
  set q to "${esc(query)}"
  repeat with l in every list
    set lname to name of l
    repeat with r in every reminder of l
      if n >= ${limit} then exit repeat
      set rName to name of r
      try
        set rNotes to body of r
        if rNotes is missing value then set rNotes to ""
      on error
        set rNotes to ""
      end try
      if rName contains q or rNotes contains q then
        try
          set rDue to due date of r as text
        on error
          set rDue to ""
        end try
        set output to output & rName & ":::" & (id of r) & ":::" & lname & ":::" & rDue & ":::" & (completed of r as text) & ":::" & (priority of r as text) & ":::" & rNotes & "|||"
        set n to n + 1
      end if
    end repeat
    if n >= ${limit} then exit repeat
  end repeat
  return output
end tell`, 60000);
  const reminders = parseReminders(raw);
  return { content: [{ type: 'text', text: JSON.stringify({ count: reminders.length, reminders }) }] };
});

// ── start ─────────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());

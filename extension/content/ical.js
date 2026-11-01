'use strict';

// Minimal RFC 5545 reader for the week view. It only has to answer "which
// events fall on these seven days", so it stays small on purpose: VTIMEZONE
// blocks are skipped (Intl resolves any IANA zone the feed names), and the
// recurrence support covers what personal calendars actually emit — FREQ with
// INTERVAL, BYDAY, COUNT, UNTIL and EXDATE. BYSETPOS and BYMONTHDAY are not
// implemented; a feed using them shows the occurrences those rules add, minus
// the ones they would exclude.
//
// Loaded before content.js, in the same isolated world, so it is just a global.

var TAH_ICAL = (function () {
  const DAY_MS = 86400000;
  const MAX_INSTANCES = 20000;
  const MAX_STEPS = 3000;
  const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- text ---------- */

  // Long lines are folded: CRLF followed by a space or tab continues the line.
  function unfold(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const lines = [];
    for (const line of raw) {
      if (lines.length && /^[ \t]/.test(line)) lines[lines.length - 1] += line.slice(1);
      else lines.push(line);
    }
    return lines;
  }

  function unescapeText(value) {
    return String(value)
      .replace(/\\[nN]/g, ' ')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  // NAME;PARAM=VALUE;PARAM="quoted:value":VALUE — the colon inside quotes is not
  // the value separator.
  function splitProperty(line) {
    let quoted = false;
    let colon = -1;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') quoted = !quoted;
      else if (char === ':' && !quoted) {
        colon = i;
        break;
      }
    }
    if (colon < 0) return null;
    const parts = line.slice(0, colon).split(';');
    const name = parts.shift().trim().toUpperCase();
    if (!name) return null;
    const params = {};
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      params[part.slice(0, eq).trim().toUpperCase()] = part
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, '');
    }
    return { name, params, value: line.slice(colon + 1) };
  }

  /* ---------- dates ---------- */

  // 20261103, 20261103T140000, 20261103T130000Z — the params say how to read it.
  function parseDate(params, value) {
    const text = String(value || '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(text);
    if (!m) return null;
    const allDay = params.VALUE === 'DATE' || !m[4];
    return {
      y: Number(m[1]),
      mo: Number(m[2]),
      d: Number(m[3]),
      h: Number(m[4] || 0),
      mi: Number(m[5] || 0),
      allDay,
      tz: allDay ? 'date' : m[7] ? 'UTC' : params.TZID || 'local',
    };
  }

  const formatters = new Map();

  // How far `zone` is from UTC at that instant, in ms.
  function zoneOffsetMs(zone, ms) {
    let format = formatters.get(zone);
    if (!format) {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      formatters.set(zone, format);
    }
    const parts = {};
    for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    return asUtc - ms;
  }

  // Wall-clock in `zone` -> instant. Two passes settle the hour at a DST edge,
  // where the offset that applies depends on the answer itself.
  function zonedMs(civil) {
    if (civil.tz === 'UTC') return Date.UTC(civil.y, civil.mo - 1, civil.d, civil.h, civil.mi);
    if (civil.tz === 'local' || civil.tz === 'date') {
      return new Date(civil.y, civil.mo - 1, civil.d, civil.h, civil.mi).getTime();
    }
    try {
      const guess = Date.UTC(civil.y, civil.mo - 1, civil.d, civil.h, civil.mi);
      const first = guess - zoneOffsetMs(civil.tz, guess);
      return guess - zoneOffsetMs(civil.tz, first);
    } catch {
      // Unknown zone name: fall back to the machine's zone rather than dropping
      // the event.
      return new Date(civil.y, civil.mo - 1, civil.d, civil.h, civil.mi).getTime();
    }
  }

  // All-day values are dates, not instants; anchor them at local midnight so
  // they line up with the grid's columns.
  function startMs(civil) {
    if (!civil) return NaN;
    if (civil.allDay) return new Date(civil.y, civil.mo - 1, civil.d).getTime();
    return zonedMs(civil);
  }

  const civilDays = (civil) => Math.round(Date.UTC(civil.y, civil.mo - 1, civil.d) / DAY_MS);
  const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

  // Calendar date of an instant as seen in `tz` (UTC feeds would otherwise be
  // off by one when jumping into the window).
  function civilOf(ms, tz) {
    const date = new Date(ms);
    if (tz === 'UTC') return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
    return { y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate() };
  }

  function fromDays(days) {
    const date = new Date(days * DAY_MS);
    return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }

  const keyOfDays = (days) => {
    const civil = fromDays(days);
    return `${civil.y}-${pad(civil.mo)}-${pad(civil.d)}`;
  };
  const localKey = (ms) => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const midnightOf = (key) => {
    const [y, mo, d] = key.split('-').map(Number);
    return new Date(y, mo - 1, d).getTime();
  };

  function wallMinutes(ms) {
    const date = new Date(ms);
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  }

  /* ---------- properties ---------- */

  function parseDuration(value) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value).trim());
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    const minutes = (Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 1440 + Number(m[4] || 0) * 60 + Number(m[5] || 0);
    return sign * (minutes * 60 + Number(m[6] || 0)) * 1000;
  }

  function parseRule(value) {
    const rule = {};
    for (const part of String(value).split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      rule[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
    }
    if (!rule.FREQ) return null;
    if (rule.BYDAY) {
      // "2MO" (second Monday) keeps the weekday and loses the ordinal.
      rule.BYDAY = rule.BYDAY.split(',').map((day) => day.trim().toUpperCase().slice(-2));
    }
    if (rule.UNTIL) rule.UNTIL = parseDate({}, rule.UNTIL);
    return rule;
  }

  /* ---------- parsing ---------- */

  function parseEvents(text) {
    const events = [];
    let current = null;
    for (const line of unfold(text)) {
      const prop = splitProperty(line);
      if (!prop) continue;

      if (prop.name === 'BEGIN' && prop.value.trim().toUpperCase() === 'VEVENT') {
        current = { exdates: [] };
        continue;
      }
      if (prop.name === 'END' && prop.value.trim().toUpperCase() === 'VEVENT') {
        if (current && current.start) events.push(current);
        current = null;
        continue;
      }
      if (!current) continue;

      switch (prop.name) {
        case 'SUMMARY':
          current.title = unescapeText(prop.value);
          break;
        case 'DTSTART':
          current.start = parseDate(prop.params, prop.value);
          break;
        case 'DTEND':
          current.end = parseDate(prop.params, prop.value);
          break;
        case 'DURATION':
          current.duration = parseDuration(prop.value);
          break;
        case 'RRULE':
          current.rrule = parseRule(prop.value);
          break;
        case 'EXDATE':
          for (const value of prop.value.split(',')) {
            const civil = parseDate(prop.params, value);
            if (civil) current.exdates.push(civil);
          }
          break;
        case 'RECURRENCE-ID':
          current.recurrenceId = parseDate(prop.params, prop.value);
          break;
        case 'STATUS':
          current.status = prop.value.trim().toUpperCase();
          break;
        default:
          break;
      }
    }
    return events;
  }

  /* ---------- recurrence ---------- */

  function monthDates(y, mo, byDay, dayOfMonth) {
    if (!byDay) return dayOfMonth <= daysInMonth(y, mo) ? [{ y, mo, d: dayOfMonth }] : [];
    const out = [];
    const total = daysInMonth(y, mo);
    for (let d = 1; d <= total; d += 1) {
      const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      if (byDay.some((name) => WEEKDAY[name] === weekday)) out.push({ y, mo, d });
    }
    return out;
  }

  // Occurrence starts as wall-clock values in the event's own zone, which is
  // what keeps a 10:00 tour at 10:00 across a DST change.
  function expandStarts(event, windowStart, stopAfter) {
    const base = event.start;
    const rule = event.rrule;
    const baseDays = civilDays(base);
    if (!rule) return [base];

    const freq = String(rule.FREQ).toUpperCase();
    const interval = Math.max(1, Number(rule.INTERVAL) || 1);
    const byDay = rule.BYDAY && rule.BYDAY.length ? rule.BYDAY.filter((day) => day in WEEKDAY) : null;
    const count = Number(rule.COUNT) || null;
    const until = rule.UNTIL ? startMs(rule.UNTIL) : null;
    const time = { h: base.h, mi: base.mi, allDay: base.allDay, tz: base.tz };
    const windowDays = windowStart === undefined ? baseDays : civilDays(civilOf(windowStart, base.tz));

    const out = [];
    const accept = (civil) => {
      const ms = startMs(civil);
      if (until !== null && ms > until) return false;
      if (stopAfter !== undefined && ms > stopAfter) return false;
      out.push(civil);
      if (count !== null && out.length >= count) return false;
      return out.length < MAX_INSTANCES;
    };

    // Jumping straight to the first occurrence near the window keeps a daily
    // rule that started years ago from walking through every day since.
    const jump = count === null && windowStart !== undefined;

    if (freq === 'DAILY') {
      const from = jump ? Math.max(0, Math.ceil((windowDays - baseDays) / interval)) : 0;
      for (let i = from; i < from + MAX_STEPS; i += 1) {
        if (!accept({ ...fromDays(baseDays + i * interval), ...time })) break;
      }
    } else if (freq === 'WEEKLY') {
      const weekdayOf = (days) => new Date(days * DAY_MS).getUTCDay();
      const offsetOf = (days) => (weekdayOf(days) + 6) % 7; // Monday = 0
      const weekStart = baseDays - offsetOf(baseDays);
      const offsets = byDay ? [...new Set(byDay.map((day) => (WEEKDAY[day] + 6) % 7))].sort((a, b) => a - b) : [offsetOf(baseDays)];
      const firstWeek = jump ? Math.max(0, Math.floor((windowDays - weekStart) / (7 * interval))) : 0;
      for (let w = firstWeek; w < firstWeek + MAX_STEPS; w += 1) {
        let stop = false;
        for (const offset of offsets) {
          const days = weekStart + w * 7 * interval + offset;
          if (days < baseDays) continue;
          if (!accept({ ...fromDays(days), ...time })) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
    } else if (freq === 'MONTHLY') {
      const month0 = base.y * 12 + (base.mo - 1);
      const windowMonth = new Date(windowStart === undefined ? Date.now() : windowStart);
      const windowMonth0 = windowMonth.getFullYear() * 12 + windowMonth.getMonth();
      const firstMonth = jump ? Math.max(0, Math.floor((windowMonth0 - month0) / interval)) : 0;
      for (let i = firstMonth; i < firstMonth + MAX_STEPS; i += 1) {
        const index = month0 + i * interval;
        const y = Math.floor(index / 12);
        const mo = (index % 12) + 1;
        let stop = false;
        for (const day of monthDates(y, mo, byDay, base.d)) {
          if (!accept({ ...day, ...time })) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
    } else if (freq === 'YEARLY') {
      const firstYear = jump ? Math.max(0, new Date(windowStart).getFullYear() - base.y) : 0;
      for (let i = firstYear; i < firstYear + MAX_STEPS; i += 1) {
        const y = base.y + i * interval;
        if (base.d > daysInMonth(y, base.mo)) continue;
        if (!accept({ y, mo: base.mo, d: base.d, ...time })) break;
      }
    } else {
      return [base];
    }
    return out;
  }

  /* ---------- public ---------- */

  function durationMs(event) {
    if (event.duration != null) return Math.max(0, event.duration);
    if (!event.end) return 0;
    if (event.start.allDay || event.end.allDay) {
      return Math.max(0, civilDays(event.end) - civilDays(event.start)) * DAY_MS;
    }
    return Math.max(0, startMs(event.end) - startMs(event.start));
  }

  // Timed events that cross midnight are clipped into one entry per local day,
  // so a cell can be compared against plain minutes.
  function clipToDays(from, to) {
    const out = [];
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    let guard = 0;
    while (cursor.getTime() < to && guard++ < 400) {
      const dayStart = cursor.getTime();
      const next = new Date(dayStart);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      const dayEnd = next.getTime();
      const start = Math.max(from, dayStart);
      const end = Math.min(to, dayEnd);
      if (end > start) {
        out.push([localKey(dayStart), wallMinutes(start), end >= dayEnd ? 1440 : wallMinutes(end)]);
      }
      cursor.setTime(dayEnd);
    }
    return out;
  }

  const push = (map, key, entry) => {
    (map[key] = map[key] || []).push(entry);
  };

  // dayKeys: local "YYYY-MM-DD" strings (the visible columns).
  // Returns { 'YYYY-MM-DD': [{ start, end, allDay, title }] }, minutes from
  // local midnight, all-day entries spanning 0–1440.
  function eventsByDay(text, dayKeys) {
    const wanted = new Set(dayKeys || []);
    if (!wanted.size) return {};

    const days = [...wanted].sort();
    const windowStart = midnightOf(days[0]) - 2 * DAY_MS;
    const windowEnd = midnightOf(days[days.length - 1]) + 2 * DAY_MS;

    const events = parseEvents(text).filter((event) => event.start && event.status !== 'CANCELLED');

    // A moved occurrence arrives as its own VEVENT with a RECURRENCE-ID; without
    // this the parent rule would also place it at the old time.
    const overridden = new Set();
    for (const event of events) {
      if (event.recurrenceId) overridden.add(startMs(event.recurrenceId));
    }

    const result = {};
    for (const event of events) {
      const span = durationMs(event);
      const excluded = new Set(event.exdates.map(startMs));
      const title = event.title || 'Termin';

      for (const civil of expandStarts(event, windowStart, windowEnd)) {
        const from = startMs(civil);
        if (excluded.has(from) || overridden.has(from)) continue;
        if (from + span <= windowStart || from > windowEnd) continue;

        if (civil.allDay) {
          const first = civilDays(civil);
          const length = Math.max(1, Math.round(span / DAY_MS));
          for (let i = 0; i < length; i += 1) {
            const key = keyOfDays(first + i);
            if (wanted.has(key)) push(result, key, { allDay: true, start: 0, end: 1440, title });
          }
          continue;
        }

        for (const [key, start, end] of clipToDays(from, from + span)) {
          if (wanted.has(key)) push(result, key, { allDay: false, start, end, title });
        }
      }
    }

    for (const key of Object.keys(result)) {
      result[key].sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
    }
    return result;
  }

  return { eventsByDay };
})();

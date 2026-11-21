import ICAL from "./vendor/ical.js";

// Turns raw .ics text into a sorted list of upcoming events,
// including repeats of recurring events (like weekly classes).
export function upcomingEvents(icsText, calendarName, color, daysAhead = 7) {
  const comp = new ICAL.Component(ICAL.parse(icsText));

  // Register the calendar's time zones so times convert correctly.
  for (const tz of comp.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(tz);
  }

  const now = new Date();
  const rangeEnd = new Date(now.getTime() + daysAhead * 86400000);
  const results = [];

  const vevents = comp.getAllSubcomponents("vevent");
  // Edited single instances of a recurring event (they have RECURRENCE-ID).
  const exceptions = vevents.filter((v) => v.hasProperty("recurrence-id"));

  for (const vevent of vevents) {
    if (vevent.hasProperty("recurrence-id")) continue;
    const event = new ICAL.Event(vevent);
    for (const ex of exceptions) {
      if (ex.getFirstPropertyValue("uid") === event.uid) event.relateException(ex);
    }

    const push = (start, end, summary, location) => {
      const s = start.toJSDate();
      const e = end ? end.toJSDate() : s;
      if (e >= now && s <= rangeEnd) {
        results.push({ title: summary || "(No title)", location, start: s, end: e,
                       allDay: start.isDate, calendar: calendarName, color });
      }
    };

    if (event.isRecurring()) {
      const it = event.iterator();
      let next, guard = 0;
      while ((next = it.next()) && guard++ < 10000) {
        if (next.toJSDate() > rangeEnd) break;
        const occ = event.getOccurrenceDetails(next);
        push(occ.startDate, occ.endDate, occ.item.summary, occ.item.location);
      }
    } else {
      push(event.startDate, event.endDate, event.summary, event.location);
    }
  }

  return results.sort((a, b) => a.start - b.start);
}
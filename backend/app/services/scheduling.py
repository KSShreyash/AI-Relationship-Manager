from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

SLOT_MINUTES = 30
LOOKAHEAD_DAYS = 14
WORK_START_HOUR = 9
WORK_END_HOUR = 17
MAX_SUGGESTIONS = 10


def suggest_slots(
    now_utc: datetime,
    timezone_name: str | None,
    busy: list[tuple[datetime, datetime]],
) -> list[dict]:
    tz = ZoneInfo(timezone_name) if timezone_name else ZoneInfo("UTC")
    local_now = now_utc.astimezone(tz)

    slots: list[dict] = []
    for day_offset in range(LOOKAHEAD_DAYS):
        current_date = (local_now + timedelta(days=day_offset)).date()
        if current_date.weekday() >= 5:
            continue

        slot_start = datetime.combine(current_date, time(WORK_START_HOUR, 0), tzinfo=tz)
        day_end = datetime.combine(current_date, time(WORK_END_HOUR, 0), tzinfo=tz)

        while slot_start + timedelta(minutes=SLOT_MINUTES) <= day_end:
            slot_end = slot_start + timedelta(minutes=SLOT_MINUTES)
            if slot_start >= local_now and not _overlaps_any(slot_start, slot_end, busy):
                slots.append({
                    "start": slot_start.astimezone(timezone.utc),
                    "end": slot_end.astimezone(timezone.utc),
                })
                if len(slots) >= MAX_SUGGESTIONS:
                    return slots
            slot_start += timedelta(minutes=SLOT_MINUTES)

    return slots


def _overlaps_any(
    start: datetime, end: datetime, busy: list[tuple[datetime, datetime]]
) -> bool:
    return any(start < busy_end and end > busy_start for busy_start, busy_end in busy)

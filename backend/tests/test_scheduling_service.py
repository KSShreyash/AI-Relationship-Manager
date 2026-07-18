from datetime import datetime, timezone

from app.services.scheduling import MAX_SUGGESTIONS, suggest_slots


def test_suggest_slots_empty_calendar_starts_at_current_time_and_caps_at_max():
    now_utc = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)  # Monday 1pm UTC

    slots = suggest_slots(now_utc, None, [])

    assert len(slots) == MAX_SUGGESTIONS
    assert slots[0]["start"] == datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)
    assert slots[0]["end"] == datetime(2026, 7, 20, 13, 30, tzinfo=timezone.utc)
    assert slots[7]["start"] == datetime(2026, 7, 20, 16, 30, tzinfo=timezone.utc)
    assert slots[8]["start"] == datetime(2026, 7, 21, 9, 0, tzinfo=timezone.utc)


def test_suggest_slots_excludes_busy_interval():
    now_utc = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)
    busy = [(datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc), datetime(2026, 7, 20, 14, 30, tzinfo=timezone.utc))]

    slots = suggest_slots(now_utc, None, busy)

    starts = [s["start"] for s in slots]
    assert datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc) not in starts
    assert len(slots) == MAX_SUGGESTIONS


def test_suggest_slots_skips_weekend():
    now_utc = datetime(2026, 7, 17, 16, 45, tzinfo=timezone.utc)  # Friday 4:45pm UTC, past the last slot

    slots = suggest_slots(now_utc, None, [])

    assert slots[0]["start"] == datetime(2026, 7, 20, 9, 0, tzinfo=timezone.utc)  # Monday, not Sat/Sun


def test_suggest_slots_respects_timezone():
    now_utc = datetime(2026, 7, 20, 10, 0, tzinfo=timezone.utc)  # 6am EDT, before the 9am local work window

    slots = suggest_slots(now_utc, "America/New_York", [])

    assert slots[0]["start"] == datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)  # 9am EDT == 1pm UTC


def test_suggest_slots_defaults_to_utc_when_timezone_name_is_none():
    now_utc = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)

    with_none = suggest_slots(now_utc, None, [])
    with_utc = suggest_slots(now_utc, "UTC", [])

    assert with_none == with_utc

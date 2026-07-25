-- Meeting collision notice: once a company's case reaches hot_handoff (a
-- contact there accepted a booking-intent reply), any other untouched
-- contact at that company gets paused + notified instead of continuing
-- blind. This column gates that notice to fire exactly once per case, even
-- if a second contact independently reaches hot_handoff moments later.
alter table cases add column collision_notified_at timestamptz;

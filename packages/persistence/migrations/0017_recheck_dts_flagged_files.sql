-- The health check used to treat ffmpeg's "non monotonically increasing dts" messages as damage.
-- They're harmless, so forget those results: the monitor re-decodes the files as never-checked,
-- and only a real error is flagged this time.
DELETE FROM "file_health" WHERE "error" LIKE '%non monotonically increasing dts%';

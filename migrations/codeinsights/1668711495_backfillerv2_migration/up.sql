-- Perform migration here.
--
-- See /migrations/README.md. Highlights:
--  * Make migrations idempotent (use IF EXISTS)
--  * Make migrations backwards-compatible (old readers/writers must continue to work)
--  * If you are using CREATE INDEX CONCURRENTLY, then make sure that only one statement
--    is defined per file, and that each such statement is NOT wrapped in a transaction.
--    Each such migration must also declare "createIndexConcurrently: true" in their
--    associated metadata.yaml file.
--  * If you are modifying Postgres extensions, you must also declare "privileged: true"
--    in the associated metadata.yaml file.

-- adjust any remaining JIT series so they will backfill as if just created
update insight_series
set needs_migration =false, just_in_time=false, created_at=now() at time zone 'utc', next_snapshot_after = 'tomorrow' at time zone 'utc', next_recording_after = now() + (sample_interval_value::TEXT || ' ' || sample_interval_unit::TEXT)::INTERVAL at time zone 'utc'
where backfill_queued_at is null
  AND just_in_time = true
  AND deleted_at is null
  AND generation_method not in ('language-stats', 'mapping-compute');

-- make backfill records for all series without them and queue any that need backfills
with migrated_backfills as (
    insert into insight_series_backfill (series_id, state)
        select s.id, case when s.backfill_queued_at is null then 'new' else 'completed' end
        from insight_series s
                 left join insight_series_backfill isb on s.id = isb.series_id
        where s.deleted_at is null
          AND generation_method not in ('language-stats', 'mapping-compute')
          AND isb.id is null
        returning id, state)
insert
into insights_background_jobs(backfill_id)
select id
from migrated_backfills
where state = 'new';

-- update series to indicate it's been queued for backfilling
update insight_series
set backfill_queued_at = now()
where backfill_queued_at is null
  and deleted_at is null
  AND generation_method not in ('language-stats', 'mapping-compute');

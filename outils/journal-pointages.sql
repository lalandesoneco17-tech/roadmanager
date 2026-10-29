-- =====================================================================================
--  JOURNAL DES POINTAGES  (a lancer UNE fois : Supabase > SQL Editor > coller > Run,
--  ou : bash outils/sql.sh outils/journal-pointages.sql)
--
--  1. Chaque creation, modification ou suppression d'une ligne de time_entries et
--     time_entries_validated est recopiee dans time_entries_journal PAR LA BASE ELLE-MEME
--     (declencheur). L'application n'y touche jamais : meme un bug de l'app ne peut pas
--     effacer l'historique. On peut toujours retrouver ce qu'il y avait avant.
--  2. Plus personne ne peut effacer physiquement un pointage (meme par erreur dans
--     l'editeur de table) : seul le marquage deleted=true (corbeille de l'app) est permis.
-- =====================================================================================

create table if not exists time_entries_journal (
  n            bigserial primary key,
  quand        timestamptz not null default now(),
  table_source text not null,
  operation    text not null,            -- INSERT / UPDATE / DELETE
  id           text not null,            -- identifiant du pointage
  emp_id       text,
  date         text,
  avant        jsonb,                    -- la ligne avant (null pour une creation)
  apres        jsonb                     -- la ligne apres (null pour un effacement physique)
);
create index if not exists time_entries_journal_id_idx    on time_entries_journal(id);
create index if not exists time_entries_journal_quand_idx on time_entries_journal(quand);
create index if not exists time_entries_journal_emp_idx   on time_entries_journal(emp_id, date);

create or replace function time_entries_journaliser() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into time_entries_journal(table_source, operation, id, emp_id, date, avant, apres)
  values (TG_TABLE_NAME, TG_OP,
          coalesce(new.id, old.id)::text,
          coalesce(new.emp_id, old.emp_id)::text,
          coalesce(new.date, old.date)::text,
          case when TG_OP = 'INSERT' then null else to_jsonb(old) end,
          case when TG_OP = 'DELETE' then null else to_jsonb(new) end);
  return coalesce(new, old);
end $$;

drop trigger if exists time_entries_journal_trg on time_entries;
create trigger time_entries_journal_trg
  after insert or update or delete on time_entries
  for each row execute function time_entries_journaliser();

drop trigger if exists time_entries_validated_journal_trg on time_entries_validated;
create trigger time_entries_validated_journal_trg
  after insert or update or delete on time_entries_validated
  for each row execute function time_entries_journaliser();

-- Interdiction d'effacer physiquement (l'app ne le fait jamais ; ceci protege contre une fausse manip)
create or replace function time_entries_interdire_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'Suppression physique interdite sur % : utiliser deleted = true (corbeille de RoadManager)', TG_TABLE_NAME;
end $$;

drop trigger if exists time_entries_no_delete on time_entries;
create trigger time_entries_no_delete
  before delete on time_entries
  for each row execute function time_entries_interdire_delete();

drop trigger if exists time_entries_validated_no_delete on time_entries_validated;
create trigger time_entries_validated_no_delete
  before delete on time_entries_validated
  for each row execute function time_entries_interdire_delete();

-- Le journal se lit (app, API, Google Sheets) mais ne se modifie pas par l'API : lecture seule
alter table time_entries_journal enable row level security;
drop policy if exists "journal lecture" on time_entries_journal;
create policy "journal lecture" on time_entries_journal for select using (true);

-- Vue de lecture pratique : l'historique, le plus recent en premier
create or replace view time_entries_historique as
  select n, quand, table_source, operation, id, emp_id, date,
         apres->>'start_time'            as embauche,
         apres->>'end_time'              as debauche,
         apres->>'pause_min'             as pause_min,
         apres->>'absence_type'          as absence,
         (apres->>'deleted')::boolean    as supprime
  from time_entries_journal
  order by n desc;

-- Verification : doit renvoyer les 4 declencheurs
select event_object_table, trigger_name, event_manipulation
from information_schema.triggers
where trigger_name like 'time_entries%'
order by 1, 2, 3;

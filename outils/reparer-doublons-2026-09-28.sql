-- Reparation du 29/09/2026 : la journee du lundi 28/09 a ete recopiee deux fois (copies du 29/09 08:00).
-- On supprime les 19 copies du matin (avec tombstone, pour qu'aucun appareil ne les remette),
-- et la memoire du bot (gsheetSeen) est repointee vers les chantiers d'origine du vendredi 19h
-- (ceux envoyes aux chauffeurs).
with paires(ancien,nouveau) as (values
 ('g2fq6cg2muh7i6iy','2tuub6hemum9ostn'),('h9oj8wm4muh7i6j1','m96ur33emum9ostr'),('db3ql4s2muh7i6j2','h6913ovomum9osts'),
 ('8gircgk5muh7i6j3','4qew94a9mum9ostt'),('5crgmc4zmuh7i6j4','pqynyb00mum9ostu'),('750i474ymuh7i6j5','yezjjf83mum9ostv'),
 ('e0dfjsknmuh7i6j6','d9yh2fhgmum9ostw'),('9t3b52grmuh7i6j7','mroh5ozomum9ostw'),('84cpkcv3muh7i6j9','w5myz1x2mum9osty'),
 ('e8fh1wlemuh7i6j9','euw2i08qmum9ostz'),('nddtesmrmuh7i6jb','2qmywlypmum9osu0'),('e7sqg2k1muh7i6jc','demuws2cmum9osu1'),
 ('0cskg9tbmuh7i6jd','p3anddtumum9osu2'),('18sdyehkmuh7i6je','oyfcxehvmum9osu2'),('05qq7awpmuh7i6jf','jp4uvh8qmum9osu3'),
 ('aicypn4emuh7i6jg','1gkb9zuemum9osu4'),('8u3h28rpmuh7i6jh','pnw345x5mum9osu5'),('c00guyulmuh7i6ji','m2h9lw3fmum9osu6'),
 ('rt8vkugymuh7i6jj','646qfjs9mum9osu7'))
update app_data set data = (
  select jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(d.data,'{_tombstones}',coalesce(d.data->'_tombstones','{}'::jsonb)),
        '{jobs}',(select coalesce(jsonb_agg(j),'[]'::jsonb) from jsonb_array_elements(d.data->'jobs') j where not (j->>'id' in (select nouveau from paires)))),
      '{_tombstones,jobs}', coalesce(d.data#>'{_tombstones,jobs}','{}'::jsonb) || (select jsonb_object_agg(nouveau,(extract(epoch from now())*1000)::bigint) from paires)),
    '{gsheetSeen}',(select coalesce(jsonb_object_agg(k, case when (v->>'j') in (select nouveau from paires) then jsonb_set(v,'{j}',to_jsonb((select ancien from paires where nouveau=v->>'j'))) else v end),'{}'::jsonb) from jsonb_each(d.data->'gsheetSeen') as x(k,v)))
  from app_data d where d.id='main'), updated_at=now()
where id='main';

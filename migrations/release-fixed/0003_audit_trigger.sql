-- 0003: keep an audit trail of appointment changes and touch updated_at when it is written.
create or replace function public.log_appointment_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.appointment_audit (appointment_id, action) values (new.id, 'insert');
  elsif tg_op = 'UPDATE' then
    insert into public.appointment_audit (appointment_id, action) values (new.id, 'update');
  end if;
  return new;
end
$$;

-- Only changes made by a statement (trigger depth 0) are audited. The UPDATE issued by
-- touch_appointment() runs inside a trigger, so it does not write a second audit row.
create or replace trigger appointment_audit_on_change
  after insert or update on public.appointments
  for each row when (pg_trigger_depth() < 1)
  execute function public.log_appointment_change();

create or replace function public.touch_appointment() returns trigger
language plpgsql as $$
begin
  update public.appointments set updated_at = now()
  where id = new.appointment_id and updated_at is distinct from now();
  return new;
end
$$;

create or replace trigger appointment_audit_touch
  after insert on public.appointment_audit
  for each row execute function public.touch_appointment();

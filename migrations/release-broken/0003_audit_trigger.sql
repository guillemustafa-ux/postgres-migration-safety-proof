-- 0003: keep an audit trail of appointment changes and touch updated_at when it is written.
create function public.log_appointment_change() returns trigger
language plpgsql as $$
begin
  insert into public.appointment_audit (appointment_id, action) values (new.id, lower(tg_op));
  return new;
end
$$;

create trigger appointment_audit_on_change
  after insert or update on public.appointments
  for each row execute function public.log_appointment_change();

create function public.touch_appointment() returns trigger
language plpgsql as $$
begin
  update public.appointments set updated_at = now()
  where id = new.appointment_id and updated_at is distinct from now();
  return new;
end
$$;

create trigger appointment_audit_touch
  after insert on public.appointment_audit
  for each row execute function public.touch_appointment();

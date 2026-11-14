begin;

-- Le trigger live `workflows_apns_notification` INSERT encore dans
-- `apns_notification_outbox` à chaque transition de statut, alors que
-- l'app et le worker ne lisent plus ces tables. On le coupe d'abord
-- pour arrêter les écritures, puis on drop le reste de la pile APNs.
-- `workflows.notification_sequence`, son trigger et sa fonction restent :
-- ils ne dépendent pas d'APNs.

drop trigger if exists workflows_apns_notification on workflows;
drop function if exists enqueue_autonomous_workflow_notification();

drop trigger if exists apns_delivery_identity_immutable on apns_notification_deliveries;
drop function if exists protect_apns_delivery_identity();

drop trigger if exists apns_device_end_live_activities on apns_device_registrations;
drop function if exists end_live_activities_with_device();

drop trigger if exists apns_live_activity_progress_guard on apns_live_activity_registrations;
drop function if exists protect_live_activity_progress();

drop trigger if exists apns_live_activity_reassign on apns_live_activity_registrations;
drop function if exists end_previous_live_activity_token();

drop trigger if exists apns_notification_transition_immutable on apns_notification_outbox;
drop function if exists protect_apns_notification_transition();

drop trigger if exists apns_device_reassign on apns_device_registrations;
drop function if exists revoke_previous_apns_registration();

drop table if exists apns_notification_deliveries;
drop table if exists apns_live_activity_registrations;
drop table if exists apns_notification_outbox;
drop table if exists apns_device_registrations;

insert into schema_migrations(version) values ('0012_drop_apns')
on conflict (version) do nothing;

commit;

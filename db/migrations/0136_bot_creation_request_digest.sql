begin;

-- A creation request id (0135) is bound to the request that minted it. The
-- API stores the SHA-256 of the canonical request body (route scope included,
-- `clientRequestId` excluded) next to the id; a replay whose body differs is
-- refused (409 BOT_CREATION_REQUEST_REUSED) instead of answering a bot that
-- does not match what the operator sent. Rows created before 0136 keep a
-- null digest and replay as before.
alter table bots
  add column creation_request_digest text null
    constraint bots_creation_request_digest_check
      check (creation_request_digest is null or creation_request_digest ~ '^[0-9a-f]{64}$');

-- A digest only means something next to the id it describes.
alter table bots
  add constraint bots_creation_request_digest_needs_id
    check (creation_request_digest is null or creation_request_id is not null);

insert into schema_migrations(version) values ('0136_bot_creation_request_digest');
commit;

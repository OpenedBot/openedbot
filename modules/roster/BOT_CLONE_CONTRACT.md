# Safe bot clone contract

`botCreationDraftFromClone` is a pure allowlist projection from `BotDto` to a
portable creation draft. It carries only a derived name, description, explicit
instructions/persona, model, supported reasoning effort, copied face data,
the presentation settings of the agent editor (label, reply language, finish
notice, speech rate, voice) and, when present and supported by the caller, the
bounded autonomy policy.

The source Hermes profile is deliberately not copied. A profile is runtime
specific and unique; callers may provide a different profile explicitly through
`options.hermesProfile`.

The permission mode is deliberately not copied either: a copy is born
`manual`, and approval rules are never inherited. The operator raises them on
the copy, on purpose.

The draft never contains the source bot or thread id, slug, section, position,
pin/archive state, approvals, unread/activity/preview/run timestamps, runtime
identity/isolation, or any implicit memory. Unknown properties are removed by
construction. Cloning does not create a bot or mutate the source.

Persona and description overflow fail explicitly. They are never silently
truncated. A label longer than the `bots.label` bound (60) is left out of the
copy instead of failing it. Autonomy values pass through the shared core
normalizer and therefore remain within the same minimums and ceilings as durable
workflows.

The console's "Duplicate" opens the creation sheet prefilled with this draft:
the copy goes through the same atomic, replayable `POST /api/bots` as any new
bot, and the persona the operator reads is the persona that is sent.

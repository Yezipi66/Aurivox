# TTS Engine Onboarding Status

The former Engine Contract has been retired and is no longer an authoring or compatibility specification.

GPT-SoVITS and IndexTTS2 remain supported through the current legacy integration path. Their existing manifests describe that implementation only and must not be copied as templates for new engines.

The replacement onboarding system will be designed around these goals:

- no routine modification of upstream TTS source code;
- separate engine source, runtime environment, and model storage;
- generated configuration drafts instead of hand-written duplicated fields;
- explicit human confirmation of semantic input and output bindings;
- strict validation plus real synthesis verification;
- dynamic frontend profiles;
- one invocation model shared by Workbench, API, and Flow.

Until the replacement schemas and tooling are frozen, there is no supported third-party self-service engine onboarding procedure.
